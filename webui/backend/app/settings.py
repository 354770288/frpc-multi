from __future__ import annotations

import os
import secrets
import sys
from pathlib import Path


def _resolve_jwt_secret() -> str:
    explicit = os.getenv("WEBUI_JWT_SECRET", "").strip()
    if explicit:
        return explicit
    state_dir = Path(os.getenv("PROJECT_DIR", "/opt/frpc-multi")) / ".webui"
    state_dir.mkdir(parents=True, exist_ok=True)
    secret_path = state_dir / "jwt_secret"
    if secret_path.exists():
        value = secret_path.read_text(encoding="utf-8").strip()
        if value:
            return value
    value = secrets.token_urlsafe(48)
    secret_path.write_text(value, encoding="utf-8")
    try:
        secret_path.chmod(0o600)
    except OSError:
        pass
    return value


def _resolve_frpc_multi_role() -> str:
    role = os.getenv("FRPC_MULTI_ROLE", "console").strip().lower()
    # all 模式已取消：现在只有 console（主控）和 agent（执行端）。
    # 旧部署若仍写 all，按 console 运行并提示——主控自身要跑 frpc 时改为单独安装一个 agent。
    if role == "all":
        print(
            "[frpc-multi] 警告：FRPC_MULTI_ROLE=all 已废弃，已按 console 运行。"
            "若本机也要运行 frpc 实例，请在本机安装一个 agent（见 docs/AGENT_INSTALL.md）。",
            file=sys.stderr,
        )
        return "console"
    if role not in {"console", "agent"}:
        raise ValueError("FRPC_MULTI_ROLE must be one of: console, agent")
    return role


def _as_bool(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    project_dir: Path = Path(os.getenv("PROJECT_DIR", "/opt/frpc-multi"))
    webui_host: str = os.getenv("WEBUI_HOST", "127.0.0.1")
    webui_port: int = int(os.getenv("WEBUI_PORT", "8081"))
    username: str = os.getenv("WEBUI_USERNAME", "admin")
    password: str = os.getenv("WEBUI_PASSWORD", "admin")
    jwt_secret: str = _resolve_jwt_secret()
    token_ttl_seconds: int = int(os.getenv("WEBUI_TOKEN_TTL_SECONDS", str(60 * 60 * 12)))
    database_path: Path = Path(os.getenv("DATABASE_PATH", "/data/console.db"))
    frpc_multi_role: str = _resolve_frpc_multi_role()

    # ---- Console：生成一键安装命令所需 ----
    # 主控对 Agent 暴露的可达地址（Agent 出站拨号目标）。例如 frpc.example.com:8081 或 1.2.3.4:8081。
    # 留空时安装命令里用占位符，提示用户手填。
    console_public_host: str = os.getenv("CONSOLE_PUBLIC_HOST", "").strip()
    # Agent 出站是否走 TLS（wss / https）。主控在反代后启用 TLS 时设为 true。
    console_tls: bool = _as_bool(os.getenv("CONSOLE_TLS"))
    # 一键安装使用的 Agent 镜像（GHCR）。
    agent_image: str = os.getenv("AGENT_IMAGE", "ghcr.io/354770288/frpc-multi:latest").strip()
    # frpc 实例镜像，写进一键安装命令注入 Agent（Agent 无 .env 时靠它起 frpc 容器并显示版本）。
    frp_image: str = os.getenv("FRP_IMAGE", "ghcr.io/fatedier/frpc:v0.68.1").strip()
    # install.sh 的下载地址（一键命令 curl 它）。留空则在文档里给出仓库内脚本路径。
    agent_install_url: str = os.getenv("AGENT_INSTALL_URL", "").strip()

    # ---- Agent：出站拨号回主控所需（role=agent 时使用）----
    agent_server: str = os.getenv("AGENT_SERVER", "").strip()  # host:port
    agent_uuid: str = os.getenv("AGENT_UUID", "").strip()
    agent_secret: str = os.getenv("AGENT_SECRET", "").strip()
    agent_tls: bool = _as_bool(os.getenv("AGENT_TLS"))
    agent_heartbeat_seconds: int = int(os.getenv("AGENT_HEARTBEAT_SECONDS", "30"))
    agent_reconnect_min_seconds: float = float(os.getenv("AGENT_RECONNECT_MIN_SECONDS", "1"))
    agent_reconnect_max_seconds: float = float(os.getenv("AGENT_RECONNECT_MAX_SECONDS", "30"))

    @property
    def credentials_path(self) -> Path:
        return self.project_dir / ".webui" / "credentials.json"

    @property
    def is_console(self) -> bool:
        return self.frpc_multi_role == "console"

    @property
    def is_agent(self) -> bool:
        return self.frpc_multi_role == "agent"

    @property
    def include_console_api(self) -> bool:
        return self.frpc_multi_role == "console"

    @property
    def serve_frontend(self) -> bool:
        return self.frpc_multi_role == "console"

    @property
    def agent_ws_url(self) -> str:
        """Agent 出站连接的完整 WebSocket 地址。"""
        scheme = "wss" if self.agent_tls else "ws"
        server = self.agent_server.rstrip("/")
        return f"{scheme}://{server}/ws/agent"

    @property
    def cors_origins(self) -> list[str]:
        """允许的前端来源。默认同源本机；通过域名/反代访问时用 WEBUI_CORS_ORIGINS 覆盖（逗号分隔）。"""
        raw = os.getenv("WEBUI_CORS_ORIGINS", "").strip()
        if not raw:
            return ["http://127.0.0.1:8081", "http://localhost:8081"]
        return [origin.strip() for origin in raw.split(",") if origin.strip()]


settings = Settings()
