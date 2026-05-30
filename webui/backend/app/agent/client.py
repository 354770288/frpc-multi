"""Agent 出站 WebSocket 客户端（反转模型的执行端）。

Agent 不再监听入站 HTTP，而是主动连回 Console：
- 启动后用 AGENT_SERVER/AGENT_UUID/AGENT_SECRET 拨号 ws(s)://console/ws/agent
- 首帧 hello 完成鉴权
- 周期心跳保活并上报概要
- 接收 Console 的 RPC 请求，分发给本机 LocalAgentService 执行后回响应
- 接收日志流请求，持续推送 SSE 帧；收到 stream_cancel 时停止
- 断线后指数退避重连

这样 NAT / 无公网的机器也能被纳管——只要它能出站访问 Console。
"""

from __future__ import annotations

import asyncio
import json
import socket
import sys
from typing import Any

from fastapi import HTTPException

from ..control import wsproto
from ..models import now_iso
from ..settings import settings
from .service import LocalAgentService, sse_pack

AGENT_VERSION = "0.2.0"


def _detail_text(detail: Any) -> str:
    if isinstance(detail, str):
        return detail
    try:
        return json.dumps(detail, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(detail)


class AgentWsClient:
    def __init__(self) -> None:
        self.service = LocalAgentService(settings.project_dir)
        self._stop = asyncio.Event()

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------------
    # 重连主循环
    # ------------------------------------------------------------------
    async def run_forever(self) -> None:
        if not settings.agent_server or not settings.agent_uuid or not settings.agent_secret:
            print(
                "[frpc-agent] 缺少 AGENT_SERVER / AGENT_UUID / AGENT_SECRET，无法连接主控。"
                "请用 Console 生成的一键安装命令部署 Agent。",
                file=sys.stderr,
            )
            return
        backoff = settings.agent_reconnect_min_seconds
        while not self._stop.is_set():
            try:
                await self._session()
                backoff = settings.agent_reconnect_min_seconds
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 任何失败都退避重连
                print(f"[frpc-agent] 与主控的连接中断：{exc}", file=sys.stderr)
            if self._stop.is_set():
                break
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, settings.agent_reconnect_max_seconds)

    # ------------------------------------------------------------------
    # 单次会话
    # ------------------------------------------------------------------
    async def _session(self) -> None:
        import websockets

        url = settings.agent_ws_url
        async with websockets.connect(
            url,
            max_size=2**22,
            ping_interval=20,
            ping_timeout=20,
            open_timeout=15,
        ) as ws:
            send_lock = asyncio.Lock()

            async def send(frame: dict[str, Any]) -> None:
                async with send_lock:
                    await ws.send(wsproto.encode(frame))

            await send(
                {
                    "type": wsproto.T_HELLO,
                    "uuid": settings.agent_uuid,
                    "secret": settings.agent_secret,
                    "hostname": socket.gethostname(),
                    "agentVersion": AGENT_VERSION,
                    "protocol": wsproto.PROTOCOL_VERSION,
                }
            )
            ack_raw = await asyncio.wait_for(ws.recv(), timeout=15)
            ack = wsproto.decode(ack_raw)
            if not ack.get("ok"):
                raise RuntimeError(f"鉴权失败：{ack.get('error', '未知原因')}")
            print(
                f"[frpc-agent] 已连接主控 {url}（节点：{ack.get('nodeName', '?')}）",
                file=sys.stderr,
            )

            stream_tasks: dict[str, asyncio.Task] = {}
            heartbeat = asyncio.create_task(self._heartbeat(send))
            try:
                while True:
                    raw = await ws.recv()
                    try:
                        frame = wsproto.decode(raw)
                    except ValueError:
                        continue
                    ftype = frame.get("type")
                    if ftype == wsproto.T_REQUEST:
                        if frame.get("stream"):
                            sid = str(frame.get("id", ""))
                            task = asyncio.create_task(
                                self._run_stream(send, sid, frame.get("params", {}))
                            )
                            stream_tasks[sid] = task
                            task.add_done_callback(lambda t, s=sid: stream_tasks.pop(s, None))
                        else:
                            asyncio.create_task(self._handle_request(send, frame))
                    elif ftype == wsproto.T_STREAM_CANCEL:
                        task = stream_tasks.pop(str(frame.get("id", "")), None)
                        if task is not None:
                            task.cancel()
            finally:
                heartbeat.cancel()
                for task in list(stream_tasks.values()):
                    task.cancel()

    # ------------------------------------------------------------------
    # 心跳
    # ------------------------------------------------------------------
    async def _heartbeat(self, send) -> None:
        interval = max(settings.agent_heartbeat_seconds, 5)
        while True:
            await asyncio.sleep(interval)
            try:
                count = await asyncio.to_thread(lambda: len(self.service.list_instances()))
            except Exception:  # noqa: BLE001
                count = None
            await send(
                {
                    "type": wsproto.T_HEARTBEAT,
                    "payload": {"instanceCount": count, "ts": now_iso()},
                }
            )

    # ------------------------------------------------------------------
    # 请求 / 响应
    # ------------------------------------------------------------------
    async def _handle_request(self, send, frame: dict[str, Any]) -> None:
        request_id = frame.get("id")
        method = frame.get("method", "")
        params = frame.get("params", {}) or {}
        try:
            result = await self._dispatch(method, params)
            await send(
                {"type": wsproto.T_RESPONSE, "id": request_id, "ok": True, "result": result}
            )
        except HTTPException as exc:
            await send(
                {
                    "type": wsproto.T_RESPONSE,
                    "id": request_id,
                    "ok": False,
                    "status": exc.status_code,
                    "error": _detail_text(exc.detail),
                    "detail": exc.detail,
                }
            )
        except Exception as exc:  # noqa: BLE001
            await send(
                {
                    "type": wsproto.T_RESPONSE,
                    "id": request_id,
                    "ok": False,
                    "status": 500,
                    "error": str(exc) or exc.__class__.__name__,
                }
            )

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        svc = self.service
        if method == wsproto.M_LIST_INSTANCES:
            return await asyncio.to_thread(svc.list_instances)
        if method == wsproto.M_GET_SYSTEM:
            return await asyncio.to_thread(svc.get_system)
        if method == wsproto.M_SUMMARY:
            return await asyncio.to_thread(svc.get_summary)
        if method == wsproto.M_STATS:
            return await asyncio.to_thread(svc.get_stats)
        if method == wsproto.M_CREATE_INSTANCE:
            return await asyncio.to_thread(
                lambda: svc.create_instance(
                    name=params["name"],
                    display_name=params.get("displayName", ""),
                    config_text=params.get("configText", ""),
                    enabled=params.get("enabled", True),
                    description=params.get("description", ""),
                    start_after_create=params.get("startAfterCreate", False),
                )
            )
        if method == wsproto.M_GET_INSTANCE:
            return await asyncio.to_thread(svc.get_instance, params["name"])
        if method == wsproto.M_PATCH_INSTANCE:
            patch = params.get("patch", {}) or {}
            return await asyncio.to_thread(
                lambda: svc.patch_instance(
                    params["name"],
                    display_name=patch.get("displayName"),
                    description=patch.get("description"),
                    enabled=patch.get("enabled"),
                    apply_immediately=patch.get("applyImmediately", True),
                )
            )
        if method == wsproto.M_DELETE_INSTANCE:
            return await asyncio.to_thread(svc.delete_instance, params["name"])
        if method == wsproto.M_GET_CONFIG:
            return await asyncio.to_thread(svc.get_config, params["name"])
        if method == wsproto.M_UPDATE_CONFIG:
            return await asyncio.to_thread(
                lambda: svc.update_config(
                    params["name"],
                    params.get("configText", ""),
                    params.get("restartAfterSave", False),
                )
            )
        if method == wsproto.M_VALIDATE_CONFIG:
            return await asyncio.to_thread(
                svc.validate_config, params["name"], params.get("configText", "")
            )
        if method == wsproto.M_START:
            return await asyncio.to_thread(svc.start_instance, params["name"])
        if method == wsproto.M_STOP:
            return await asyncio.to_thread(svc.stop_instance, params["name"])
        if method == wsproto.M_RESTART:
            return await asyncio.to_thread(svc.restart_instance, params["name"])
        if method == wsproto.M_RECREATE:
            return await asyncio.to_thread(svc.recreate_instance, params["name"])
        if method == wsproto.M_LOGS:
            return await asyncio.to_thread(
                svc.get_logs,
                params["name"],
                params.get("tail", 300),
                params.get("keyword", ""),
            )
        raise HTTPException(status_code=400, detail=f"未知方法: {method}")

    # ------------------------------------------------------------------
    # 日志流
    # ------------------------------------------------------------------
    async def _send_stream(self, send, stream_id: str, chunk: bytes) -> None:
        await send(
            {
                "type": wsproto.T_STREAM,
                "id": stream_id,
                "data": chunk.decode("utf-8", errors="replace"),
            }
        )

    async def _run_stream(self, send, stream_id: str, params: dict[str, Any]) -> None:
        name = params.get("name", "")
        tail = params.get("tail", 100)
        keyword = (params.get("keyword") or "").lower()
        try:
            argv = await asyncio.to_thread(self.service.logs_follow_args, name, tail)
        except Exception as exc:  # noqa: BLE001
            await self._send_stream(send, stream_id, sse_pack("error", str(exc)))
            await send({"type": wsproto.T_STREAM, "id": stream_id, "end": True})
            return

        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(self.service.project_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except FileNotFoundError:
            await self._send_stream(send, stream_id, sse_pack("error", "docker 命令不可用"))
            await send({"type": wsproto.T_STREAM, "id": stream_id, "end": True})
            return

        await self._send_stream(send, stream_id, sse_pack("ready", ""))
        assert process.stdout is not None
        try:
            while True:
                try:
                    raw = await asyncio.wait_for(process.stdout.readline(), timeout=15.0)
                except asyncio.TimeoutError:
                    await self._send_stream(send, stream_id, b": keepalive\n\n")
                    continue
                if not raw:
                    if process.returncode is not None:
                        break
                    continue
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if keyword and keyword not in line.lower():
                    continue
                await self._send_stream(send, stream_id, sse_pack("log", line))
        except asyncio.CancelledError:
            raise
        finally:
            if process.returncode is None:
                try:
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=2.0)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                except ProcessLookupError:
                    pass
            try:
                await send({"type": wsproto.T_STREAM, "id": stream_id, "end": True})
            except Exception:  # noqa: BLE001
                pass
