from __future__ import annotations

import os
from pathlib import Path


class Settings:
    project_dir: Path = Path(os.getenv("PROJECT_DIR", "/opt/frpc-multi"))
    webui_host: str = os.getenv("WEBUI_HOST", "127.0.0.1")
    webui_port: int = int(os.getenv("WEBUI_PORT", "8081"))
    username: str = os.getenv("WEBUI_USERNAME", "admin")
    password: str = os.getenv("WEBUI_PASSWORD", "admin")


settings = Settings()

