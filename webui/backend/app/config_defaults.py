from __future__ import annotations

from .instance_store import validate_instance_name

DEFAULT_FRPC_TEMPLATE = """# 默认 frpc 配置模板，请根据实际 frps 信息修改 CHANGE_ME 字段。
serverAddr = "CHANGE_ME_FRPS_HOST"
serverPort = 7000

[auth]
method = "token"
token = "CHANGE_ME_STRONG_TOKEN"

[log]
to = "console"
level = "info"
maxDays = 3

[[proxies]]
name = "__INSTANCE_NAME__-ssh"
type = "tcp"
localIP = "host.docker.internal"
localPort = 22
remotePort = 6001
"""


def render_default_config(instance_name: str | None = None) -> str:
    placeholder = "client-xxx"
    if instance_name:
        placeholder = validate_instance_name(instance_name)
    return DEFAULT_FRPC_TEMPLATE.replace("__INSTANCE_NAME__", placeholder)
