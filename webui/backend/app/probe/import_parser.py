"""Shared parser for synchronous and asynchronous server imports."""
from __future__ import annotations

import json


def reject_nonstandard_json_constant(value: str):
    raise ValueError(f"JSON 不支持常量 {value}")


def _json_entry_to_item(entry: object, default_group: str = "") -> dict | None:
    if isinstance(entry, str):
        return {"ip": entry, "label": "", "group": default_group}
    if isinstance(entry, dict):
        return {"ip": str(entry.get("ip", "")),
                "label": str(entry.get("label", "") or ""),
                "group": str(entry.get("group", "") or "") or default_group}
    return None


def parse_batch_text(text: str, default_group: str = "") -> list[dict]:
    """Parse one IP per line or the legacy JSON array/object import shape."""
    stripped = (text or "").lstrip()
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            data = json.loads(text, parse_constant=reject_nonstandard_json_constant)
        except json.JSONDecodeError:
            data = None
        if data is not None:
            if isinstance(data, dict):
                data = data.get("servers", [])
            if isinstance(data, list):
                items = [item for item in (_json_entry_to_item(entry, default_group) for entry in data) if item]
                if items:
                    return items
    items: list[dict] = []
    for line in text.splitlines():
        parts = line.replace(",", " ").replace(";", " ").split()
        if not parts:
            continue
        if parts[0].startswith("{"):
            try:
                entry = json.loads(line, parse_constant=reject_nonstandard_json_constant)
            except json.JSONDecodeError:
                entry = None
            if entry is not None:
                item = _json_entry_to_item(entry, default_group)
                if item is not None:
                    items.append(item)
                    continue
        items.append({"ip": parts[0], "label": parts[1] if len(parts) > 1 else "", "group": default_group})
    return items
