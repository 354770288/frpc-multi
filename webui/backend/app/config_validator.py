from __future__ import annotations

import tomllib
from collections import Counter
from typing import Any

from .models import ValidationResult


def _mask_token(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 6:
        return "***"
    return value[:2] + "*" * max(4, len(value) - 4) + value[-2:]


def validate_config_text(config_text: str) -> ValidationResult:
    errors: list[str] = []
    warnings: list[str] = []
    summary: dict[str, Any] = {
        "serverAddr": None,
        "serverPort": None,
        "authMethod": None,
        "tokenMasked": None,
        "proxyCount": 0,
        "proxyTypes": {},
        "remotePorts": [],
    }

    try:
        data = tomllib.loads(config_text)
    except tomllib.TOMLDecodeError as exc:
        return ValidationResult(False, [f"TOML 语法错误: {exc}"], warnings, summary)

    server_addr = data.get("serverAddr")
    server_port = data.get("serverPort")
    if not server_addr:
        errors.append("缺少必填字段: serverAddr")
    if server_port is None:
        errors.append("缺少必填字段: serverPort")
    elif not isinstance(server_port, int):
        errors.append("serverPort 必须是整数")

    auth = data.get("auth") if isinstance(data.get("auth"), dict) else {}
    token = auth.get("token")
    if not token:
        warnings.append("未配置 auth.token，确认 frps 是否不需要 token")

    proxies = data.get("proxies", [])
    if proxies is None:
        proxies = []
    if not isinstance(proxies, list):
        errors.append("proxies 必须是数组")
        proxies = []

    names = [proxy.get("name") for proxy in proxies if isinstance(proxy, dict) and proxy.get("name")]
    duplicate_names = [name for name, count in Counter(names).items() if count > 1]
    if duplicate_names:
        errors.append("代理名称重复: " + ", ".join(sorted(duplicate_names)))

    proxy_types = Counter()
    remote_ports: list[int] = []
    for proxy in proxies:
        if not isinstance(proxy, dict):
            errors.append("proxy 配置项必须是对象")
            continue
        proxy_type = proxy.get("type")
        if proxy_type:
            proxy_types[str(proxy_type)] += 1
        if proxy.get("type") == "tcp" and proxy.get("remotePort") is None:
            warnings.append(f"TCP 代理 {proxy.get('name', '<未命名>')} 未配置 remotePort")
        remote_port = proxy.get("remotePort")
        if isinstance(remote_port, int):
            remote_ports.append(remote_port)

    duplicate_ports = [str(port) for port, count in Counter(remote_ports).items() if count > 1]
    if duplicate_ports:
        warnings.append("当前配置内 remotePort 重复: " + ", ".join(duplicate_ports))

    summary.update(
        {
            "serverAddr": server_addr,
            "serverPort": server_port,
            "authMethod": auth.get("method"),
            "tokenMasked": _mask_token(str(token)) if token else None,
            "proxyCount": len(proxies),
            "proxyTypes": dict(proxy_types),
            "remotePorts": remote_ports,
        }
    )
    return ValidationResult(not errors, errors, warnings, summary)

