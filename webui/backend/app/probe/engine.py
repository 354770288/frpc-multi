"""frps 验收测试引擎（纯标准库，不依赖网络外的任何状态）。

移植自 FRPC穿透测试/test_frpc_connectivity.py，主要调整：
- CLI 彩色打印改为进度回调（on_step / on_progress），供 Web 任务运行器消费；
- 测速数据源改为流式生成固定块，不再依赖打包 200MB 文件；
- 等待隧道由「盲等 8 秒」改为解析 frpc 日志（login/start proxy success|failed），
  失败快速返回并携带日志摘录；
- 端口、二进制路径、时长等全部走 ProbeOptions 注入（由 settings 提供）；
- 长循环内插入协作取消检查点（cancel 回调），支持跳过/停止批量任务。
"""

from __future__ import annotations

import socket
import subprocess
import tempfile
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# 进度/步骤回调：文本由调用方决定如何展示
StepCallback = Callable[[str], None]
ProgressCallback = Callable[[str], None]
# 返回 True 表示调用方要求尽快中止当前测试
CancelCheck = Callable[[], bool]

# 流式测速的填充块（可压缩数据会被中间层压缩导致测速失真，用伪随机 pattern）
_PAYLOAD_BLOCK = bytes((i * 31 + 7) % 251 for i in range(65536))

# frpc 日志关键词（v0.5x+ 格式，日志走 stdout）
_LOG_LOGIN_OK = "login to server success"
_LOG_LOGIN_FAIL = "login to server failed"
_LOG_PROXY_OK = "start proxy success"
_LOG_PROXY_FAIL = "proxy start error"


def speed_mbps(bytes_per_sec: float) -> float:
    return bytes_per_sec * 8 / (1024 * 1024)


def speed_mbs(bytes_per_sec: float) -> float:
    return bytes_per_sec / (1024 * 1024)


def format_size(size_bytes: float) -> str:
    if size_bytes >= 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 ** 3):.2f} GB"
    if size_bytes >= 1024 * 1024:
        return f"{size_bytes / (1024 ** 2):.2f} MB"
    if size_bytes >= 1024:
        return f"{size_bytes / 1024:.2f} KB"
    return f"{size_bytes:.0f} B"


def format_speed(bytes_per_sec: float) -> str:
    return f"{speed_mbps(bytes_per_sec):.2f} Mbps ({speed_mbs(bytes_per_sec):.2f} MB/s)"


@dataclass
class ProbeOptions:
    """引擎运行参数。由 settings 构造默认值，测试里可注入小超时。"""

    frpc_bin: str = "/usr/local/bin/frpc"
    frps_port: int = 7000
    # 本地/远端端口组：连通性 = base，下载 = base+1，上传 = base+2
    local_base_port: int = 11561
    remote_base_port: int = 11561
    tcping_timeout: float = 5.0
    tcping_retries: int = 2
    tunnel_wait: float = 8.0
    speed_duration: float = 30.0
    # 单次传输 socket 的整体超时（兜底，正常由 speed_duration 截止）
    speed_socket_timeout: float = 120.0
    # 本地服务线程的硬上限，防止客户端异常断开后线程滞留
    serve_hard_limit: float = 180.0
    # 并行 worker 数：连通性探测无带宽占用可较高；速率测试受本机带宽约束宜低
    conn_concurrency: int = 6
    speed_concurrency: int = 2
    # 临时 frpc 配置落盘目录；None 时用系统临时目录
    work_dir: Path | None = None
    extra: dict = field(default_factory=dict)

    @property
    def conn_local_port(self) -> int:
        return self.local_base_port

    @property
    def conn_remote_port(self) -> int:
        return self.remote_base_port

    @property
    def dl_local_port(self) -> int:
        return self.local_base_port + 1

    @property
    def dl_remote_port(self) -> int:
        return self.remote_base_port + 1

    @property
    def ul_local_port(self) -> int:
        return self.local_base_port + 2

    @property
    def ul_remote_port(self) -> int:
        return self.remote_base_port + 2


# ────────────── tcping ──────────────


def tcping(host: str, port: int, timeout: float = 5.0) -> tuple[bool, str]:
    """socket 模拟 tcping。返回 (是否成功, 延迟 ms 或错误信息)。"""
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))
        elapsed = (time.time() - start) * 1000
        sock.close()
        return True, f"{elapsed:.1f}ms"
    except socket.timeout:
        return False, "连接超时"
    except ConnectionRefusedError:
        return False, "连接被拒绝"
    except OSError as exc:
        return False, str(exc)


def tcping_with_retry(
    host: str,
    port: int,
    retries: int = 2,
    timeout: float = 5.0,
    cancel: CancelCheck | None = None,
) -> tuple[bool, str]:
    """带重试的 tcping。仅超时（可能丢包）才重试；连接被拒绝说明端口明确关闭，直接失败。"""
    info = ""
    for attempt in range(max(retries, 1)):
        if cancel is not None and attempt > 0 and cancel():
            return False, "已取消"
        ok, info = tcping(host, port, timeout)
        if ok:
            return True, info
        if info == "连接被拒绝":
            return False, info
        if attempt < retries - 1:
            time.sleep(1)
    return False, info


# ────────────── 本地 TCP 服务三件套 ──────────────


class _LocalTcpService:
    """bind 0.0.0.0 + accept 循环 + 每连接一线程的本地服务基类。"""

    def __init__(self, port: int, name: str):
        self.port = port
        self.name = name
        self.server_socket: socket.socket | None = None
        self.running = False
        self.thread: threading.Thread | None = None

    def start(self) -> tuple[bool, str]:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.settimeout(1)
            sock.bind(("0.0.0.0", self.port))
            sock.listen(5)
        except OSError as exc:
            return False, f"本地端口 {self.port} 无法监听: {exc}"
        self.server_socket = sock
        self.running = True
        self.thread = threading.Thread(target=self._accept_loop, daemon=True)
        self.thread.start()
        return True, ""

    def _accept_loop(self) -> None:
        assert self.server_socket is not None
        while self.running:
            try:
                client, _addr = self.server_socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            handler = threading.Thread(target=self._serve, args=(client,), daemon=True)
            handler.start()

    def _serve(self, client: socket.socket) -> None:  # pragma: no cover - 子类实现
        raise NotImplementedError

    def stop(self) -> None:
        self.running = False
        if self.server_socket is not None:
            try:
                self.server_socket.close()
            except OSError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=3)


class LocalEchoServer(_LocalTcpService):
    """连通性测试目标：收到什么回什么，给穿透隧道提供响应。"""

    def __init__(self, port: int):
        super().__init__(port, "echo")

    def _serve(self, client: socket.socket) -> None:
        try:
            while self.running:
                data = client.recv(1024)
                if not data:
                    break
                client.sendall(data)
        except OSError:
            pass
        finally:
            client.close()


class LocalStreamSource(_LocalTcpService):
    """下载速率测试源：连接建立后持续发送填充块，直到对端断开或硬超时。

    原版从 200MB 文件读取；改为流式生成后客户端按测速时限自行截止。
    """

    def __init__(self, port: int, hard_limit: float = 180.0):
        super().__init__(port, "stream-source")
        self.hard_limit = hard_limit

    def _serve(self, client: socket.socket) -> None:
        deadline = time.monotonic() + self.hard_limit
        try:
            client.settimeout(5)
            while self.running and time.monotonic() < deadline:
                client.sendall(_PAYLOAD_BLOCK)
        except OSError:
            pass
        finally:
            try:
                client.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            client.close()


class LocalDataSink(_LocalTcpService):
    """上传速率测试目标：接收并丢弃，累计字节数。"""

    def __init__(self, port: int):
        super().__init__(port, "data-sink")
        self.total_received = 0
        self.receive_done = threading.Event()

    def start(self) -> tuple[bool, str]:
        self.total_received = 0
        self.receive_done.clear()
        return super().start()

    def _serve(self, client: socket.socket) -> None:
        try:
            while True:
                data = client.recv(65536)
                if not data:
                    break
                self.total_received += len(data)
        except OSError:
            pass
        finally:
            client.close()
            self.receive_done.set()


# ────────────── frpc 配置与进程编排 ──────────────


def render_connectivity_config(server_addr: str, options: ProbeOptions) -> str:
    """连通性测试的 frpc TOML：一条 tcp 代理 local:base → remote:base。"""
    return (
        f'serverAddr = "{server_addr}"\n'
        f"serverPort = {options.frps_port}\n"
        "loginFailExit = false\n"
        "\n[[proxies]]\n"
        f'name = "probe-conn-{options.conn_remote_port}"\n'
        'type = "tcp"\n'
        'localIP = "127.0.0.1"\n'
        f"localPort = {options.conn_local_port}\n"
        f"remotePort = {options.conn_remote_port}\n"
    )


def render_speed_config(server_addr: str, options: ProbeOptions) -> str:
    """速率测试的 frpc TOML：下载/上传两条 tcp 代理。"""
    return (
        f'serverAddr = "{server_addr}"\n'
        f"serverPort = {options.frps_port}\n"
        "loginFailExit = false\n"
        "\n[[proxies]]\n"
        f'name = "probe-dl-{options.dl_remote_port}"\n'
        'type = "tcp"\n'
        'localIP = "127.0.0.1"\n'
        f"localPort = {options.dl_local_port}\n"
        f"remotePort = {options.dl_remote_port}\n"
        "\n[[proxies]]\n"
        f'name = "probe-ul-{options.ul_remote_port}"\n'
        'type = "tcp"\n'
        'localIP = "127.0.0.1"\n'
        f"localPort = {options.ul_local_port}\n"
        f"remotePort = {options.ul_remote_port}\n"
    )


class FrpcProcess:
    """frpc 子进程 + 日志采集。日志行缓存在 deque 供隧道判定与错误摘录。"""

    def __init__(self, config_path: Path, options: ProbeOptions):
        self.config_path = config_path
        self.options = options
        self.proc: subprocess.Popen | None = None
        self.log_lines: deque[str] = deque(maxlen=200)
        self._reader: threading.Thread | None = None

    def start(self) -> tuple[bool, str]:
        try:
            self.proc = subprocess.Popen(
                [self.options.frpc_bin, "-c", str(self.config_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
            )
        except OSError as exc:
            return False, f"frpc 启动失败: {exc}"
        self._reader = threading.Thread(target=self._read_logs, daemon=True)
        self._reader.start()
        return True, ""

    def _read_logs(self) -> None:
        assert self.proc is not None and self.proc.stdout is not None
        for line in self.proc.stdout:
            self.log_lines.append(line.rstrip("\n"))

    def _log_excerpt(self, limit: int = 300) -> str:
        return " | ".join(list(self.log_lines)[-5:])[:limit]

    def wait_login(self, timeout: float, cancel: CancelCheck | None = None) -> tuple[bool, str]:
        """等待 frpc 登录成功或失败关键词。返回 (成功, 错误信息)。

        未在时限内看到任何关键词时返回 (True, "")——与原版「盲等后继续」兼容，
        由后续实际连接做最终判定。
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cancel is not None and cancel():
                return False, "已取消"
            if self.proc is not None and self.proc.poll() is not None:
                return False, f"frpc 进程异常退出: {self._log_excerpt()}"
            lines = list(self.log_lines)
            text = "\n".join(lines)
            if _LOG_LOGIN_FAIL in text:
                return False, f"登录 frps 失败: {self._log_excerpt()}"
            if _LOG_LOGIN_OK in text:
                return True, ""
            time.sleep(0.2)
        return True, ""

    def wait_proxies(self, count: int, timeout: float, cancel: CancelCheck | None = None) -> tuple[bool, str]:
        """等待 count 条代理 start proxy success。同 login 的兜底策略。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cancel is not None and cancel():
                return False, "已取消"
            if self.proc is not None and self.proc.poll() is not None:
                return False, f"frpc 进程异常退出: {self._log_excerpt()}"
            text = "\n".join(self.log_lines)
            if _LOG_LOGIN_FAIL in text:
                return False, f"登录 frps 失败: {self._log_excerpt()}"
            if _LOG_PROXY_FAIL in text:
                return False, f"代理启动失败: {self._log_excerpt()}"
            if text.count(_LOG_PROXY_OK) >= count:
                return True, ""
            time.sleep(0.2)
        return True, ""

    def stop(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self._reader is not None:
            self._reader.join(timeout=3)


class _TempConfig:
    """临时 frpc 配置文件：with 块结束自动删除。"""

    def __init__(self, content: str, work_dir: Path | None):
        handle = tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", suffix=".toml", prefix="probe-", delete=False,
            dir=str(work_dir) if work_dir else None,
        )
        handle.write(content)
        handle.close()
        self.path = Path(handle.name)

    def __enter__(self) -> Path:
        return self.path

    def __exit__(self, *exc_info) -> None:
        try:
            self.path.unlink()
        except OSError:
            pass


# ────────────── 限时测速 ──────────────


def _speed_result() -> dict:
    return {
        "success": False, "total_bytes": 0, "elapsed_sec": 0.0,
        "speed_bps": 0.0, "speed_str": "N/A", "error": "", "cutoff": False,
    }


def _settle(result: dict, total: int, start: float, cutoff: bool) -> dict:
    elapsed = time.time() - start
    if total > 0 and elapsed > 0:
        speed_bps = total / elapsed
        result.update(
            success=True, total_bytes=total, elapsed_sec=elapsed,
            speed_bps=speed_bps, speed_str=format_speed(speed_bps), cutoff=cutoff,
        )
    else:
        result["error"] = "未收到数据" if total == 0 else "无有效耗时"
    return result


def download_speed_test(
    host: str,
    port: int,
    options: ProbeOptions,
    on_progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
) -> dict:
    """连接 host:port 拉取数据，按测速时限截止结算。

    数据流：本地流式源 → frpc 隧道 → frps → 本客户端收，绕服务器一圈。
    """
    result = _speed_result()
    sock = None
    total = 0
    start = 0.0
    last_report = 0.0
    max_duration = options.speed_duration
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(options.speed_socket_timeout)
        sock.connect((host, port))
        start = time.time()
        last_report = start
        cancelled = False
        while True:
            now = time.time()
            elapsed = now - start
            if elapsed >= max_duration:
                result["cutoff"] = True
                break
            if cancel is not None and cancel():
                cancelled = True
                break
            remaining = max_duration - elapsed
            sock.settimeout(min(remaining + 1, options.speed_socket_timeout))
            data = sock.recv(65536)
            if not data:
                break
            total += len(data)
            if on_progress is not None and now - last_report >= 0.5:
                on_progress(
                    f"⬇️ 下载 {format_size(total)}  速率: {format_speed(total / elapsed)}"
                    f"  剩余: {max_duration - int(elapsed)}s"
                )
                last_report = now
        result = _settle(result, total, start, result["cutoff"])
        if cancelled:
            # 取消的测试结果不具参考性，交由调用方按取消语义丢弃
            result["success"] = False
            result["error"] = "已取消"
    except socket.timeout:
        # 时限触发的超时也按已传数据结算（与原版兜底一致）
        result = _settle(result, total, start if start else time.time(), True)
        if not result["success"]:
            result["error"] = "传输超时"
    except OSError as exc:
        result["error"] = str(exc)
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return result


def upload_speed_test(
    host: str,
    port: int,
    options: ProbeOptions,
    on_progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
) -> dict:
    """向 host:port 持续发送填充块，按测速时限截止结算。"""
    result = _speed_result()
    sock = None
    total = 0
    start = 0.0
    last_report = 0.0
    max_duration = options.speed_duration
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(options.speed_socket_timeout)
        sock.connect((host, port))
        start = time.time()
        last_report = start
        cancelled = False
        while True:
            now = time.time()
            elapsed = now - start
            if elapsed >= max_duration:
                result["cutoff"] = True
                break
            if cancel is not None and cancel():
                cancelled = True
                break
            remaining = max_duration - elapsed
            sock.settimeout(min(remaining + 1, options.speed_socket_timeout))
            try:
                sock.sendall(_PAYLOAD_BLOCK)
            except socket.timeout:
                result["cutoff"] = True
                break
            total += len(_PAYLOAD_BLOCK)
            if on_progress is not None and now - last_report >= 0.5:
                on_progress(
                    f"⬆️ 上传 {format_size(total)}  速率: {format_speed(total / elapsed)}"
                    f"  剩余: {max_duration - int(elapsed)}s"
                )
                last_report = now
        try:
            sock.shutdown(socket.SHUT_WR)
            sock.settimeout(5)
            sock.recv(1024)
        except OSError:
            pass
        result = _settle(result, total, start, result["cutoff"])
        if cancelled:
            result["success"] = False
            result["error"] = "已取消"
    except socket.timeout:
        result = _settle(result, total, start if start else time.time(), True)
        if not result["success"]:
            result["error"] = "传输超时"
    except OSError as exc:
        result["error"] = str(exc)
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return result


# ────────────── 单 IP 验收流程 ──────────────


def run_connectivity_probe(
    server_ip: str,
    options: ProbeOptions,
    on_step: StepCallback | None = None,
    on_progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
) -> dict:
    """对单个 frps 服务器执行 tcping → 建隧道 → 验证映射端口放行。"""

    def step(msg: str) -> None:
        if on_step is not None:
            on_step(msg)

    result = {
        "server_ip": server_ip,
        "frps_reachable": False,
        "tunnel_established": False,
        "firewall_open": False,
        "detail": "",
    }

    step(f"tcping {server_ip}:{options.frps_port}（检测 frps 服务）")
    ok, info = tcping_with_retry(
        server_ip, options.frps_port, options.tcping_retries, options.tcping_timeout, cancel
    )
    if not ok:
        result["detail"] = f"frps 不可达: {info}"
        return result
    result["frps_reachable"] = True
    if on_progress is not None:
        on_progress(f"frps 可达，延迟 {info}")

    echo = LocalEchoServer(options.conn_local_port)
    started, err = echo.start()
    if not started:
        result["detail"] = err
        return result

    frpc: FrpcProcess | None = None
    try:
        with _TempConfig(render_connectivity_config(server_ip, options), options.work_dir) as cfg:
            step(f"启动 frpc 建立隧道（本地:{options.conn_local_port} → 远程:{options.conn_remote_port}）")
            frpc = FrpcProcess(cfg, options)
            started, err = frpc.start()
            if not started:
                result["detail"] = err
                return result
            ok, err = frpc.wait_proxies(1, options.tunnel_wait, cancel)
            if not ok:
                result["detail"] = err
                return result
            result["tunnel_established"] = True

            step(f"tcping {server_ip}:{options.conn_remote_port}（验证防火墙是否放行映射端口）")
            ok, info = tcping_with_retry(
                server_ip, options.conn_remote_port, options.tcping_retries,
                options.tcping_timeout, cancel,
            )
            if ok:
                result["firewall_open"] = True
                if on_progress is not None:
                    on_progress(f"端口 {options.conn_remote_port} 已放行，延迟 {info}")
            else:
                result["detail"] = f"防火墙未放行端口 {options.conn_remote_port}: {info}"
    except Exception as exc:  # noqa: BLE001 - 单 IP 失败不应中断批量任务
        result["detail"] = f"测试异常: {exc}"
    finally:
        if frpc is not None:
            frpc.stop()
        echo.stop()
    return result


def run_speed_probe(
    server_ip: str,
    options: ProbeOptions,
    on_step: StepCallback | None = None,
    on_progress: ProgressCallback | None = None,
    cancel: CancelCheck | None = None,
) -> dict:
    """对单个 frps 服务器执行双隧道上下行速率测试。"""

    def step(msg: str) -> None:
        if on_step is not None:
            on_step(msg)

    result = {
        "server_ip": server_ip,
        "frps_reachable": False,
        "tunnel_ok": False,
        "dl_ok": False, "dl_speed_bps": 0.0, "dl_speed_str": "N/A",
        "dl_bytes": 0, "dl_sec": 0.0,
        "ul_ok": False, "ul_speed_bps": 0.0, "ul_speed_str": "N/A",
        "ul_bytes": 0, "ul_sec": 0.0,
        "detail": "",
    }

    step(f"tcping {server_ip}:{options.frps_port}（检测 frps 服务）")
    ok, info = tcping_with_retry(
        server_ip, options.frps_port, options.tcping_retries, options.tcping_timeout, cancel
    )
    if not ok:
        result["detail"] = f"frps 不可达: {info}"
        return result
    result["frps_reachable"] = True

    source = LocalStreamSource(options.dl_local_port, options.serve_hard_limit)
    sink = LocalDataSink(options.ul_local_port)
    started, err = source.start()
    if not started:
        result["detail"] = err
        return result
    started, err = sink.start()
    if not started:
        source.stop()
        result["detail"] = err
        return result

    frpc: FrpcProcess | None = None
    try:
        with _TempConfig(render_speed_config(server_ip, options), options.work_dir) as cfg:
            step("启动 frpc 建立双隧道（下载 + 上传）")
            frpc = FrpcProcess(cfg, options)
            started, err = frpc.start()
            if not started:
                result["detail"] = err
                return result
            ok, err = frpc.wait_proxies(2, options.tunnel_wait, cancel)
            if not ok:
                result["detail"] = err
                return result
            result["tunnel_ok"] = True

            step(f"下载速率测试（{server_ip}:{options.dl_remote_port}）")
            dl = download_speed_test(server_ip, options.dl_remote_port, options, on_progress, cancel)
            if dl["success"]:
                result["dl_ok"] = True
                result["dl_speed_bps"] = dl["speed_bps"]
                result["dl_speed_str"] = dl["speed_str"]
                result["dl_bytes"] = dl["total_bytes"]
                result["dl_sec"] = dl["elapsed_sec"]
            else:
                result["detail"] = f"下载失败: {dl.get('error', '')}"

            step(f"上传速率测试（{server_ip}:{options.ul_remote_port}）")
            ul = upload_speed_test(server_ip, options.ul_remote_port, options, on_progress, cancel)
            if ul["success"]:
                result["ul_ok"] = True
                result["ul_speed_bps"] = ul["speed_bps"]
                result["ul_speed_str"] = ul["speed_str"]
                result["ul_bytes"] = ul["total_bytes"]
                result["ul_sec"] = ul["elapsed_sec"]
        if not result["dl_ok"] and not result["ul_ok"]:
            result["detail"] = "上传和下载均失败"
        elif not result["dl_ok"]:
            result["detail"] = f"下载失败: {dl.get('error', '')}"
        elif not result["ul_ok"]:
            result["detail"] = f"上传失败: {ul.get('error', '')}"
    except Exception as exc:  # noqa: BLE001
        result["detail"] = f"测试异常: {exc}"
    finally:
        if frpc is not None:
            frpc.stop()
        source.stop()
        sink.stop()
    return result
