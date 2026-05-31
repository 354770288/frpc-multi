"""Console ↔ Agent WebSocket 通信协议。

反转模型：Agent 主动外连 Console（出站 WebSocket），Console 通过这条长连接
向 Agent 下发 RPC 请求并接收响应 / 日志流。两端都以 JSON 文本帧通信。
"""

from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = 1

# ---- 帧类型 ----
T_HELLO = "hello"  # agent -> console：首帧，携带 uuid + secret 鉴权
T_HELLO_ACK = "hello_ack"  # console -> agent：鉴权结果
T_HEARTBEAT = "heartbeat"  # agent -> console：心跳 + 概要
T_REQUEST = "request"  # console -> agent：RPC 请求
T_RESPONSE = "response"  # agent -> console：RPC 响应
T_STREAM = "stream"  # agent -> console：流式帧（日志）
T_STREAM_CANCEL = "stream_cancel"  # console -> agent：取消某个流

# ---- RPC 方法（console -> agent）----
M_LIST_INSTANCES = "list_instances"
M_CREATE_INSTANCE = "create_instance"
M_GET_INSTANCE = "get_instance"
M_PATCH_INSTANCE = "patch_instance"
M_DELETE_INSTANCE = "delete_instance"
M_GET_CONFIG = "get_config"
M_UPDATE_CONFIG = "update_config"
M_VALIDATE_CONFIG = "validate_config"
M_START = "start"
M_STOP = "stop"
M_RESTART = "restart"
M_RECREATE = "recreate"
M_LOGS = "logs"
M_LOGS_STREAM = "logs_stream"
M_GET_SYSTEM = "get_system"
M_SUMMARY = "summary"
M_STATS = "stats"
M_DECOMMISSION = "decommission"  # console -> agent：删节点时停所有实例、删配置、自毁 agent 容器


def encode(frame: dict[str, Any]) -> str:
    return json.dumps(frame, ensure_ascii=False, separators=(",", ":"))


def decode(raw: str | bytes) -> dict[str, Any]:
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("帧必须是 JSON 对象")
    return data
