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


class Settings:
    project_dir: Path = Path(os.getenv("PROJECT_DIR", "/opt/frpc-multi"))
    webui_host: str = os.getenv("WEBUI_HOST", "127.0.0.1")
    webui_port: int = int(os.getenv("WEBUI_PORT", "8081"))
    username: str = os.getenv("WEBUI_USERNAME", "admin")
    password: str = os.getenv("WEBUI_PASSWORD", "admin")
    jwt_secret: str = _resolve_jwt_secret()
    token_ttl_seconds: int = int(os.getenv("WEBUI_TOKEN_TTL_SECONDS", str(60 * 60 * 12)))

    @property
    def credentials_path(self) -> Path:
        return self.project_dir / ".webui" / "credentials.json"


settings = Settings()
