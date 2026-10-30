"""Literal IPv4 identity shared with the existing fixed-port asset projection."""
import ipaddress

from ..control.database import _probe_asset_host_sql as host_sql


def ipv4_host(value: str) -> str | None:
    if value.count(':') == 1:
        host, port = value.rsplit(':', 1)
        if not port.isdigit() or port.lstrip('0') != '7000':
            return None
        value = host
    try:
        return str(ipaddress.IPv4Address(value))
    except (ValueError, TypeError):
        return None
