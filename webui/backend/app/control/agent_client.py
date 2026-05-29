from __future__ import annotations

from typing import Any

import httpx


class AgentClientError(Exception):
    pass


class AgentAuthError(AgentClientError):
    pass


class AgentNotFoundError(AgentClientError):
    pass


class AgentServerError(AgentClientError):
    pass


class AgentTimeoutError(AgentClientError):
    pass


class AgentConnectionError(AgentClientError):
    pass


class AgentClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        timeout: float = 5.0,
        transport: httpx.BaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self.transport = transport

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: dict[str, Any] | None = None,
        content: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict:
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if content is not None:
            headers["Content-Type"] = "text/plain"
        try:
            with httpx.Client(timeout=self.timeout, transport=self.transport) as client:
                response = client.request(
                    method,
                    f"{self.base_url}{path}",
                    headers=headers,
                    json=json,
                    content=content,
                    params=params,
                )
        except httpx.TimeoutException as exc:
            raise AgentTimeoutError(str(exc)) from exc
        except httpx.RequestError as exc:
            raise AgentConnectionError(str(exc)) from exc

        if response.status_code == 401:
            raise AgentAuthError(response.text)
        if response.status_code == 404:
            raise AgentNotFoundError(response.text)
        if response.status_code >= 500:
            raise AgentServerError(response.text)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise AgentClientError(response.text) from exc
        return response.json()

    def ping(self) -> dict:
        return self._request("GET", "/agent/health")

    def get_system(self) -> dict:
        return self._request("GET", "/agent/system")

    def list_instances(self) -> dict:
        return self._request("GET", "/agent/instances")

    def create_instance(self, payload: dict[str, Any]) -> dict:
        return self._request("POST", "/agent/instances", json=payload)

    def get_instance(self, name: str) -> dict:
        return self._request("GET", f"/agent/instances/{name}")

    def patch_instance(self, name: str, payload: dict[str, Any]) -> dict:
        return self._request("PATCH", f"/agent/instances/{name}", json=payload)

    def delete_instance(self, name: str) -> dict:
        return self._request("DELETE", f"/agent/instances/{name}")

    def get_config(self, name: str) -> dict:
        return self._request("GET", f"/agent/instances/{name}/config")

    def update_config(self, name: str, payload: dict[str, Any]) -> dict:
        return self._request("PUT", f"/agent/instances/{name}/config", json=payload)

    def validate_config(self, name: str, config_text: str) -> dict:
        return self._request("POST", f"/agent/instances/{name}/config/validate", content=config_text)

    def start(self, name: str) -> dict:
        return self._request("POST", f"/agent/instances/{name}/start")

    def stop(self, name: str) -> dict:
        return self._request("POST", f"/agent/instances/{name}/stop")

    def restart(self, name: str) -> dict:
        return self._request("POST", f"/agent/instances/{name}/restart")

    def recreate(self, name: str) -> dict:
        return self._request("POST", f"/agent/instances/{name}/recreate")

    def logs(self, name: str, tail: int = 300, keyword: str = "") -> dict:
        return self._request("GET", f"/agent/instances/{name}/logs", params={"tail": tail, "keyword": keyword})

    def summary(self) -> dict:
        return self._request("GET", "/agent/summary")

    def stats(self) -> dict:
        return self._request("GET", "/agent/stats")
