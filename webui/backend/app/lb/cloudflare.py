"""Cloudflare API v4 客户端（httpx）。

只做负载均衡需要的最小集合：验证令牌列 zones、列/增/删 A 记录。
创建的 A 记录一律灰云（proxied=False，CF 橙云代理不支持 frp 的任意
TCP 端口直连）并带托管 comment，同步引擎只碰带标记的记录。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import httpx

from .store import managed_comment


class CloudflareError(Exception):
    """Cloudflare API 调用失败（已归一化为中文信息）。"""


@dataclass
class DnsRecord:
    id: str
    name: str
    content: str  # IP
    ttl: int
    managed: bool  # 是否为本系统托管（带托管 comment 的灰云 A 记录）


def _default_base_url() -> str:
    # 本地/测试可用环境变量指向 mock 服务
    return os.getenv("LB_CLOUDFLARE_BASE_URL", "https://api.cloudflare.com/client/v4").rstrip("/")


class CloudflareClient:
    def __init__(self, token: str, *, base_url: str | None = None, timeout: float = 15.0):
        if not token or not token.strip():
            raise CloudflareError("Cloudflare API Token 未配置")
        self._token = token.strip()
        self._client = httpx.Client(
            base_url=base_url or _default_base_url(),
            headers={"Authorization": f"Bearer {self._token}"},
            timeout=timeout,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "CloudflareClient":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def _request(self, method: str, path: str, *, json_body: dict | None = None,
                 params: dict | None = None) -> dict:
        try:
            response = self._client.request(method, path, json=json_body, params=params)
        except httpx.HTTPError as exc:
            raise CloudflareError(f"网络请求失败: {exc}") from exc
        if response.status_code == 401:
            raise CloudflareError("Cloudflare 令牌无效或已过期（401）")
        if response.status_code == 403:
            raise CloudflareError("Cloudflare 令牌权限不足（需要 Zone.DNS Edit 与 Zone 读权限）")
        if response.status_code == 429:
            raise CloudflareError("Cloudflare API 限流（429），请稍后重试")
        try:
            data = response.json()
        except ValueError as exc:
            raise CloudflareError(f"Cloudflare 响应解析失败（HTTP {response.status_code}）") from exc
        if not data.get("success"):
            errors = "; ".join(str(item.get("message", item)) for item in data.get("errors", []))
            raise CloudflareError(f"Cloudflare API 错误（HTTP {response.status_code}）: {errors or '未知错误'}")
        return data

    # ---- zones ----

    def verify(self) -> list[dict]:
        """验证令牌并列出租户下的 zones：[{id, name}]。"""
        data = self._request("GET", "/zones", params={"per_page": 50})
        return [{"id": item["id"], "name": item["name"]} for item in data.get("result", [])]

    # ---- A 记录 ----

    def list_a_records(self, zone_id: str, name: str) -> list[DnsRecord]:
        data = self._request(
            "GET", f"/zones/{zone_id}/dns_records",
            params={"type": "A", "name": name, "per_page": 100},
        )
        records = []
        for item in data.get("result", []):
            records.append(DnsRecord(
                id=item["id"],
                name=item["name"],
                content=item["content"],
                ttl=int(item.get("ttl", 1)),
                managed=(item.get("proxied") is False and item.get("comment") == managed_comment()),
            ))
        return records

    def create_a_record(self, zone_id: str, name: str, ip: str, ttl: int = 60) -> DnsRecord:
        data = self._request("POST", f"/zones/{zone_id}/dns_records", json_body={
            "type": "A",
            "name": name,
            "content": ip,
            "ttl": ttl,
            "proxied": False,
            "comment": managed_comment(),
        })
        item = data["result"]
        return DnsRecord(id=item["id"], name=item["name"], content=item["content"],
                         ttl=int(item.get("ttl", ttl)), managed=True)

    def delete_a_record(self, zone_id: str, record_id: str) -> None:
        self._request("DELETE", f"/zones/{zone_id}/dns_records/{record_id}")
