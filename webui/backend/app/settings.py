from __future__ import annotations

import os
import secrets
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
    role = os.getenv("FRPC_MULTI_ROLE", "all").strip().lower()
    if role not in {"all", "console", "agent"}:
        raise ValueError("FRPC_MULTI_ROLE must be one of: all, console, agent")
    return role


class Settings:
    project_dir: Path = Path(os.getenv("PROJECT_DIR", "/opt/frpc-multi"))
    webui_host: str = os.getenv("WEBUI_HOST", "127.0.0.1")
    webui_port: int = int(os.getenv("WEBUI_PORT", "8081"))
    username: str = os.getenv("WEBUI_USERNAME", "admin")
    password: str = os.getenv("WEBUI_PASSWORD", "admin")
    jwt_secret: str = _resolve_jwt_secret()
    token_ttl_seconds: int = int(os.getenv("WEBUI_TOKEN_TTL_SECONDS", str(60 * 60 * 12)))
    database_path: Path = Path(os.getenv("DATABASE_PATH", "/data/console.db"))
    agent_token: str = os.getenv("AGENT_TOKEN", "").strip()
    agent_auth_enabled: bool = os.getenv("AGENT_AUTH_ENABLED", "false").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    frpc_multi_role: str = _resolve_frpc_multi_role()

    @property
    def credentials_path(self) -> Path:
        return self.project_dir / ".webui" / "credentials.json"

    @property
    def include_console_api(self) -> bool:
        return self.frpc_multi_role in {"all", "console"}

    @property
    def include_agent_api(self) -> bool:
        return self.frpc_multi_role in {"all", "agent"}

    @property
    def serve_frontend(self) -> bool:
        return self.frpc_multi_role in {"all", "console"}


settings = Settings()
