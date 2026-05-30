"""Console 侧 WebSocket 服务端：接受 Agent 的出站长连接。

鉴权流程（反转模型）：
1. Agent 连到 ws(s)://console/ws/agent
2. Agent 发送 hello 帧（uuid + secret + 主机信息）
3. Console 用 NodeStore 按 uuid 查节点，常量时间比对 secret
4. 通过则 hello_ack(ok=true)，把连接注册进 hub，节点标记 online
5. 之后持续接收：response（RPC 响应）/ stream（日志）/ heartbeat
6. 断开时从 hub 注销，节点标记 offline
"""

from __future__ import annotations

import hmac

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..models import now_iso
from ..settings import settings
from . import wsproto
from .hub import AgentConnection, hub
from .node_store import NodeStore

ws_router = APIRouter()


def _secret_ok(provided: str, expected: str) -> bool:
    if not expected:
        return False
    return hmac.compare_digest((provided or "").encode("utf-8"), expected.encode("utf-8"))


@ws_router.websocket("/ws/agent")
async def agent_socket(websocket: WebSocket) -> None:
    await websocket.accept()
    store = NodeStore(settings.database_path)

    # ---- 1. 鉴权握手 ----
    try:
        raw = await websocket.receive_text()
        hello = wsproto.decode(raw)
    except (WebSocketDisconnect, ValueError):
        await websocket.close(code=1008)
        return

    if hello.get("type") != wsproto.T_HELLO:
        await websocket.send_text(
            wsproto.encode({"type": wsproto.T_HELLO_ACK, "ok": False, "error": "首帧必须是 hello"})
        )
        await websocket.close(code=1008)
        return

    node_uuid = str(hello.get("uuid", "")).strip()
    secret = str(hello.get("secret", ""))
    try:
        node = store.get_node_by_uuid(node_uuid)
    except KeyError:
        node = None

    if node is None or not _secret_ok(secret, node.secret):
        await websocket.send_text(
            wsproto.encode(
                {"type": wsproto.T_HELLO_ACK, "ok": False, "error": "uuid 或 secret 无效"}
            )
        )
        await websocket.close(code=1008)
        return

    # ---- 2. 注册连接 ----
    connection = AgentConnection(node_uuid, websocket.send_text)
    connection.info = {
        "hostname": hello.get("hostname", ""),
        "agentVersion": hello.get("agentVersion", ""),
        "protocol": hello.get("protocol", wsproto.PROTOCOL_VERSION),
    }
    await websocket.send_text(
        wsproto.encode(
            {
                "type": wsproto.T_HELLO_ACK,
                "ok": True,
                "nodeId": node.id,
                "nodeName": node.name,
                "heartbeatSeconds": settings.agent_heartbeat_seconds,
            }
        )
    )
    store.update_node(node.id, status="online", last_seen_at=now_iso())
    await hub.register(connection)

    # ---- 3. 消息循环 ----
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                frame = wsproto.decode(raw)
            except ValueError:
                continue
            ftype = frame.get("type")
            if ftype == wsproto.T_RESPONSE:
                connection.handle_response(frame)
            elif ftype == wsproto.T_STREAM:
                connection.handle_stream(frame)
            elif ftype == wsproto.T_HEARTBEAT:
                store.mark_status_by_uuid(node_uuid, status="online", last_seen_at=now_iso())
                await hub.dispatch_heartbeat(node_uuid, frame.get("payload", {}))
    except WebSocketDisconnect:
        pass
    except Exception:
        # 任意异常都视为连接结束，转去清理。
        pass
    finally:
        await hub.unregister(node_uuid, connection)
        store.mark_status_by_uuid(node_uuid, status="offline")
