"""Console 侧的 Agent 连接中枢。

每个在线 Agent 维持一条出站 WebSocket。Hub 负责：
- 注册 / 注销连接（按节点 uuid 索引）
- 在这条连接上发起 RPC（请求 → 等待匹配响应的 Future）
- 接收流式帧（日志），路由到对应的异步队列供 StreamingResponse 消费
- 分发 Agent 主动上报（心跳）给回调

设计为单进程内存态：Console 单实例部署，连接状态不跨进程共享。
"""

from __future__ import annotations

import asyncio
import secrets
from typing import Any, Awaitable, Callable

from . import wsproto


class AgentRpcError(Exception):
    """Agent 执行 RPC 返回的业务错误（携带 HTTP 状态码与明细）。"""

    def __init__(self, message: str, *, status_code: int = 502, detail: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail if detail is not None else message


class AgentOfflineError(Exception):
    """目标节点当前没有在线连接。"""


class AgentTimeoutError(Exception):
    """等待 Agent 响应超时。"""


class AgentConnection:
    """封装一条 Agent WebSocket，提供 RPC 与流。"""

    def __init__(self, uuid: str, send: Callable[[str], Awaitable[None]]):
        self.uuid = uuid
        self._send = send
        self._send_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future] = {}
        self._streams: dict[str, asyncio.Queue] = {}
        self.last_heartbeat: dict[str, Any] | None = None
        self.info: dict[str, Any] = {}

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        async with self._send_lock:
            await self._send(wsproto.encode(frame))

    async def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 15.0,
    ) -> Any:
        """发起一次请求 / 响应式 RPC。"""
        request_id = secrets.token_hex(8)
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        self._pending[request_id] = future
        try:
            await self._send_frame(
                {
                    "type": wsproto.T_REQUEST,
                    "id": request_id,
                    "method": method,
                    "params": params or {},
                }
            )
            try:
                return await asyncio.wait_for(future, timeout=timeout)
            except asyncio.TimeoutError as exc:
                raise AgentTimeoutError(f"等待 Agent 响应超时: {method}") from exc
        finally:
            self._pending.pop(request_id, None)

    async def open_stream(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        maxsize: int = 1000,
    ) -> tuple[str, asyncio.Queue]:
        """开启一条流式 RPC，返回 (stream_id, 队列)。队列收到 None 表示结束。"""
        stream_id = secrets.token_hex(8)
        queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._streams[stream_id] = queue
        await self._send_frame(
            {
                "type": wsproto.T_REQUEST,
                "id": stream_id,
                "method": method,
                "params": params or {},
                "stream": True,
            }
        )
        return stream_id, queue

    async def cancel_stream(self, stream_id: str) -> None:
        self._streams.pop(stream_id, None)
        try:
            await self._send_frame({"type": wsproto.T_STREAM_CANCEL, "id": stream_id})
        except Exception:
            # 连接可能已断，忽略取消失败。
            pass

    def handle_response(self, frame: dict[str, Any]) -> None:
        request_id = frame.get("id", "")
        future = self._pending.get(request_id)
        if future is None or future.done():
            return
        if frame.get("ok", False):
            future.set_result(frame.get("result"))
        else:
            future.set_exception(
                AgentRpcError(
                    frame.get("error", "Agent 错误"),
                    status_code=int(frame.get("status", 502) or 502),
                    detail=frame.get("detail", frame.get("error", "Agent 错误")),
                )
            )

    def handle_stream(self, frame: dict[str, Any]) -> None:
        stream_id = frame.get("id", "")
        queue = self._streams.get(stream_id)
        if queue is None:
            return
        if frame.get("end", False):
            self._streams.pop(stream_id, None)
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
            return
        try:
            queue.put_nowait(frame.get("data", ""))
        except asyncio.QueueFull:
            # 背压：消费端跟不上时丢弃，避免拖垮 Console。
            pass

    def fail_all(self, exc: Exception) -> None:
        """连接断开时，唤醒所有未决请求与流。"""
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(exc)
        self._pending.clear()
        for queue in list(self._streams.values()):
            try:
                queue.put_nowait(None)
            except asyncio.QueueFull:
                pass
        self._streams.clear()


HeartbeatHandler = Callable[[str, dict[str, Any]], Awaitable[None]]


class AgentHub:
    def __init__(self) -> None:
        self._connections: dict[str, AgentConnection] = {}
        self._lock = asyncio.Lock()
        self._on_heartbeat: HeartbeatHandler | None = None
        self._on_connect: HeartbeatHandler | None = None
        self._on_disconnect: Callable[[str], Awaitable[None]] | None = None

    def set_handlers(
        self,
        *,
        on_heartbeat: HeartbeatHandler | None = None,
        on_connect: HeartbeatHandler | None = None,
        on_disconnect: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self._on_heartbeat = on_heartbeat
        self._on_connect = on_connect
        self._on_disconnect = on_disconnect

    async def register(self, connection: AgentConnection) -> None:
        async with self._lock:
            existing = self._connections.get(connection.uuid)
            if existing is not None:
                existing.fail_all(AgentOfflineError("连接被新会话取代"))
            self._connections[connection.uuid] = connection
        if self._on_connect is not None:
            await self._on_connect(connection.uuid, connection.info)

    async def unregister(self, uuid: str, connection: AgentConnection) -> None:
        async with self._lock:
            # 仅当注册表里仍是这条连接时才移除，避免误删新会话。
            if self._connections.get(uuid) is connection:
                self._connections.pop(uuid, None)
        connection.fail_all(AgentOfflineError("Agent 连接已断开"))
        if self._on_disconnect is not None:
            await self._on_disconnect(uuid)

    def get(self, uuid: str) -> AgentConnection:
        connection = self._connections.get(uuid)
        if connection is None:
            raise AgentOfflineError(f"节点未在线: {uuid}")
        return connection

    def is_online(self, uuid: str) -> bool:
        return uuid in self._connections

    def online_uuids(self) -> list[str]:
        return list(self._connections.keys())

    async def dispatch_heartbeat(self, uuid: str, payload: dict[str, Any]) -> None:
        connection = self._connections.get(uuid)
        if connection is not None:
            connection.last_heartbeat = payload
        if self._on_heartbeat is not None:
            await self._on_heartbeat(uuid, payload)


# Console 进程内唯一实例。
hub = AgentHub()
