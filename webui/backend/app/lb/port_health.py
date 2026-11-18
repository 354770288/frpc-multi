"""优选域名业务端口健康巡检与大陆 GFW 防火墙屏蔽自动切换。

核心规则：
1. 从在线部署节点（Agent）运行的 frpc 实例配置中，收集指向各优选域名（serverAddr == domain.name）
   且处于启用运行中（enabled & running）的 TCP 业务端口（remotePort），按端口号升序排列。
2. 对已启用且当前有解析 IP（current_ip）的优选域名，依次检查其关联的业务端口：
   - 先由主测试节点（一般为大陆节点）对 (current_ip, port) 执行 tcping；
   - 若主节点连通：该业务端口正常，继续检查下一端口；
   - 若任意业务端口对主节点不通，立即由备用测试节点（外部备用节点或 Console）执行 tcping：
     * 备用节点连通 → 判定当前 IP 被大陆 GFW 防火墙屏蔽端口，将该 IP 标记为 GFW 屏蔽隔离态，
       立即触发切换候选池内其他健康 IP 解析到该域名（并写审计与告警记录）；
     * 主备节点均不通 → 判定为业务端口异常（不盲目切换 IP），记录活跃异常供 Web 主页异常窗口展示。
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from typing import Any, Callable

from ..control import wsproto
from ..control.audit_store import AuditStore
from ..control.hub import hub
from ..control.node_store import NodeStore
from ..models import now_iso
from ..probe.ephemeral_tcping import ephemeral_tcping_broker
from ..probe.jobs import ProbeJobStore
from ..probe.store import ProbeStore
from ..settings import Settings
from .cloudflare import CloudflareClient
from .health import PoolHealthMonitor, best_ip_for_domain, pool_health, split_addr
from .store import LbDomain, LbStore
from .syncer import sync_domain

DEFAULT_PORT_CHECK_INTERVAL_SECONDS = 60.0

TcpProber = Callable[[str, str, int], tuple[bool | None, str]]

_hub_loop_lock = threading.Lock()
_hub_loop: asyncio.AbstractEventLoop | None = None
# 针对未升级旧版 Agent（M_SUMMARY 未内联 summary）的内存缓存：(node_id, instance_name) -> (updatedAt, summary)
_legacy_summary_cache_lock = threading.Lock()
_legacy_summary_cache: dict[tuple[int, str], tuple[str, dict[str, Any]]] = {}


def set_hub_event_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _hub_loop
    with _hub_loop_lock:
        _hub_loop = loop


def get_hub_event_loop() -> asyncio.AbstractEventLoop | None:
    with _hub_loop_lock:
        return _hub_loop


async def collect_and_sync_node_ports_async(
    lb_store: LbStore,
    node_id: int,
    node_name: str,
    node_uuid: str,
    summary_data: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """从单个在线部署节点同步实例业务端口映射到 lb_instance_ports（兼容新旧 Agent），并返回内联了 summary 的实例列表。"""
    if not hub.is_online(node_uuid):
        return (summary_data or {}).get("instances") or []
    connection = hub.get(node_uuid)
    if summary_data is None:
        summary_data = await connection.call(wsproto.M_SUMMARY, timeout=8.0)
    raw_instances = summary_data.get("instances") or []
    enriched: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for item in raw_instances:
        if not isinstance(item, dict):
            continue
        inst_name = str(item.get("name") or "").strip()
        if not inst_name:
            continue
        seen_names.add(inst_name)
        if isinstance(item.get("summary"), dict):
            enriched.append(item)
            continue
        # 兼容旧版 Agent：仅在启用时按 updatedAt 缓存拉取一次实例配置摘要
        updated_at = str(item.get("updatedAt") or "")
        cache_key = (int(node_id), inst_name)
        cached_summary: dict[str, Any] | None = None
        with _legacy_summary_cache_lock:
            cached = _legacy_summary_cache.get(cache_key)
            if cached is not None and cached[0] == updated_at:
                cached_summary = cached[1]
        if cached_summary is None and item.get("enabled", True):
            try:
                detail = await connection.call(wsproto.M_GET_INSTANCE, {"name": inst_name}, timeout=6.0)
                if isinstance(detail, dict) and isinstance(detail.get("summary"), dict):
                    cached_summary = detail["summary"]
                    with _legacy_summary_cache_lock:
                        _legacy_summary_cache[cache_key] = (updated_at, cached_summary)
            except Exception:  # noqa: BLE001
                cached_summary = None
        enriched.append({**item, **({"summary": cached_summary} if cached_summary is not None else {})})

    with _legacy_summary_cache_lock:
        stale_keys = [key for key in _legacy_summary_cache if key[0] == int(node_id) and key[1] not in seen_names]
        for key in stale_keys:
            _legacy_summary_cache.pop(key, None)

    lb_store.replace_node_instance_ports(node_id, node_name, enriched)
    return enriched


async def refresh_all_online_node_ports_async(database_path: Path) -> None:
    node_store = NodeStore(database_path)
    lb_store = LbStore(database_path)
    for node in node_store.list_nodes():
        if not hub.is_online(node.uuid):
            continue
        try:
            await collect_and_sync_node_ports_async(lb_store, node.id, node.name, node.uuid)
        except Exception:  # noqa: BLE001
            continue


def refresh_online_node_ports_from_thread(database_path: Path, *, timeout: float = 12.0) -> None:
    """供后台调度线程或同步路由安全刷新在线 Agent 的实例业务端口映射。"""
    loop = get_hub_event_loop()
    if loop is None or loop.is_closed() or not loop.is_running():
        return
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None
    if running_loop is loop:
        return
    future = asyncio.run_coroutine_threadsafe(refresh_all_online_node_ports_async(database_path), loop)
    try:
        future.result(timeout=timeout)
    except Exception:  # noqa: BLE001
        pass


class DomainPortHealthChecker:
    """按域名周期执行业务端口主备 tcping 检测、GFW 屏蔽切换与异常记录。"""

    def __init__(self, *, check_interval: float = DEFAULT_PORT_CHECK_INTERVAL_SECONDS) -> None:
        self._check_interval = check_interval
        self._lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._last_checked_monotonic: dict[int, float] = {}
        self._last_domain_summary: dict[int, dict[str, Any]] = {}

    def reset(self) -> None:
        with self._lock:
            self._last_checked_monotonic.clear()
            self._last_domain_summary.clear()

    def domain_summaries(self) -> dict[int, dict[str, Any]]:
        with self._lock:
            return {k: dict(v) for k, v in self._last_domain_summary.items()}

    def _select_nodes(self, job_store: ProbeJobStore) -> tuple[dict | None, list[dict], str | None]:
        try:
            policy = job_store.get_execution_policy()
        except ValueError as exc:
            return None, [], f"主备测试策略异常: {exc}"
        if not policy.get("configured") or not policy.get("primaryNodeId"):
            return None, [], "尚未配置主用测试节点"
        primary_id = policy["primaryNodeId"]
        try:
            primary_node = job_store.get_node(primary_id)
        except KeyError:
            return None, [], f"主用测试节点不存在: {primary_id}"
        if not primary_node.get("online"):
            return None, [], f"主用测试节点（{primary_node.get('name') or primary_id}）当前离线"

        backups: list[dict] = []
        for backup_id in policy.get("backupNodeIds") or ["console"]:
            if backup_id == primary_id:
                continue
            try:
                node = job_store.get_node(backup_id)
            except KeyError:
                continue
            if node.get("online") and "discover" in (node.get("capabilities") or []):
                backups.append(node)
        if not backups:
            return primary_node, [], "没有在线的备用测试节点"
        return primary_node, backups, None

    def run_checks(
        self,
        lb_store: LbStore,
        probe_store: ProbeStore,
        settings: Settings,
        *,
        force: bool = False,
        domain_id: int | None = None,
        monitor: PoolHealthMonitor | None = None,
        cf_factory: Callable[[str], CloudflareClient] | None = None,
        tcp_prober: TcpProber | None = None,
        refresh_agents: bool = True,
    ) -> dict[str, Any]:
        """执行到期（或强制）优选域名的业务端口检查，返回检查摘要。"""
        with self._run_lock:
            if refresh_agents:
                refresh_online_node_ports_from_thread(lb_store.database_path)
            monitor = monitor or pool_health
            job_store = ProbeJobStore(lb_store.database_path)
            prober = tcp_prober or (
                lambda node_id, ip, port: ephemeral_tcping_broker.probe_tcp(job_store, node_id, ip, port)
            )
            primary_node, backup_nodes, policy_skip_reason = self._select_nodes(job_store)

            domains = [lb_store.get_domain(domain_id)] if domain_id is not None else lb_store.list_domains()
            now_mono = time.monotonic()
            checked_domains: list[dict[str, Any]] = []
            switched_domains = 0

            for domain in domains:
                if not domain.enabled:
                    lb_store.resolve_domain_port_alerts(domain.id, kind="port_unreachable")
                    continue

                with self._lock:
                    last_mono = self._last_checked_monotonic.get(domain.id)
                if not force and last_mono is not None and (now_mono - last_mono) < self._check_interval:
                    continue

                port_specs = lb_store.domain_business_ports(domain.name)
                if not port_specs or not domain.current_ip:
                    lb_store.resolve_domain_port_alerts(domain.id, kind="port_unreachable")
                    summary = {
                        "domainId": domain.id,
                        "domainName": domain.name,
                        "currentIp": domain.current_ip,
                        "ports": [spec["port"] for spec in port_specs],
                        "checkedPorts": 0,
                        "status": "no_business_ports" if not port_specs else "no_current_ip",
                        "checkedAt": now_iso(),
                    }
                    with self._lock:
                        self._last_checked_monotonic[domain.id] = time.monotonic()
                        self._last_domain_summary[domain.id] = summary
                    checked_domains.append(summary)
                    continue

                if policy_skip_reason or primary_node is None or not backup_nodes:
                    summary = {
                        "domainId": domain.id,
                        "domainName": domain.name,
                        "currentIp": domain.current_ip,
                        "ports": [spec["port"] for spec in port_specs],
                        "checkedPorts": 0,
                        "status": "skipped",
                        "reason": policy_skip_reason or "缺少可用主备测试节点",
                        "checkedAt": now_iso(),
                    }
                    checked_domains.append(summary)
                    continue

                domain_outcome = self._check_single_domain(
                    domain=domain,
                    port_specs=port_specs,
                    primary_node=primary_node,
                    backup_nodes=backup_nodes,
                    lb_store=lb_store,
                    probe_store=probe_store,
                    settings=settings,
                    monitor=monitor,
                    cf_factory=cf_factory,
                    prober=prober,
                )
                if domain_outcome.get("switched"):
                    switched_domains += 1
                with self._lock:
                    self._last_checked_monotonic[domain.id] = time.monotonic()
                    self._last_domain_summary[domain.id] = domain_outcome
                checked_domains.append(domain_outcome)

            return {
                "checkedAt": now_iso(),
                "checkedDomains": checked_domains,
                "switchedCount": switched_domains,
                "policySkipReason": policy_skip_reason,
            }

    def _check_single_domain(
        self,
        *,
        domain: LbDomain,
        port_specs: list[dict[str, Any]],
        primary_node: dict[str, Any],
        backup_nodes: list[dict[str, Any]],
        lb_store: LbStore,
        probe_store: ProbeStore,
        settings: Settings,
        monitor: PoolHealthMonitor,
        cf_factory: Callable[[str], CloudflareClient] | None,
        prober: TcpProber,
    ) -> dict[str, Any]:
        current_ip = split_addr(domain.current_ip or "", 7000)[0]
        primary_id = str(primary_node["id"])
        primary_name = str(primary_node.get("name") or primary_id)
        active_unreachable_keys: set[str] = set()
        port_results: list[dict[str, Any]] = []
        gfw_triggered = False
        switched = False
        switched_to_ip: str | None = None

        for spec in port_specs:
            port = int(spec["port"])
            instances = spec.get("instances") or []
            p_ok, p_detail = prober(primary_id, current_ip, port)
            if p_ok is True:
                port_results.append({
                    "port": port,
                    "status": "ok",
                    "primaryOk": True,
                    "primaryDetail": p_detail,
                })
                continue

            if p_ok is None:
                # 主节点探测中途离线/超时，中止本轮判定以避免误报或误切
                return {
                    "domainId": domain.id,
                    "domainName": domain.name,
                    "currentIp": current_ip,
                    "ports": [s["port"] for s in port_specs],
                    "checkedPorts": len(port_results),
                    "status": "indeterminate",
                    "reason": p_detail,
                    "checkedAt": now_iso(),
                }

            # 主节点确认不通 → 依次选第一个能给出确定性结果的在线备用节点验证
            b_ok: bool | None = None
            b_detail = ""
            used_backup = backup_nodes[0]
            for candidate_backup in backup_nodes:
                used_backup = candidate_backup
                b_ok, b_detail = prober(str(candidate_backup["id"]), current_ip, port)
                if b_ok is not None:
                    break

            backup_id = str(used_backup["id"])
            backup_name = str(used_backup.get("name") or backup_id)

            if b_ok is None:
                return {
                    "domainId": domain.id,
                    "domainName": domain.name,
                    "currentIp": current_ip,
                    "ports": [s["port"] for s in port_specs],
                    "checkedPorts": len(port_results),
                    "status": "indeterminate",
                    "reason": b_detail,
                    "checkedAt": now_iso(),
                }

            if b_ok is True:
                # 主节点不通 + 备用节点通 => 判定当前 IP 被 GFW 防火墙屏蔽端口！
                gfw_triggered = True
                lb_store.mark_gfw_blocked(
                    ip=current_ip,
                    domain_id=domain.id,
                    domain_name=domain.name,
                    blocked_port=port,
                    primary_node_id=primary_id,
                    primary_node_name=primary_name,
                    primary_detail=p_detail,
                    backup_node_id=backup_id,
                    backup_node_name=backup_name,
                    backup_detail=b_detail,
                )
                # 清理该域名在旧 IP 上的普通端口不通告警，转为 GFW 屏蔽切换流程
                lb_store.resolve_domain_port_alerts(domain.id, kind="port_unreachable")

                switch_note = ""
                next_best = best_ip_for_domain(domain, probe_store, monitor, lb_store=lb_store)
                token = lb_store.cloudflare_token()
                if next_best and next_best != current_ip and token:
                    factory = cf_factory or (lambda value: CloudflareClient(value))
                    try:
                        with factory(token) as cf:
                            sync_res = sync_domain(domain, probe_store, lb_store, cf, monitor)
                        if sync_res.ok and sync_res.target_ip and sync_res.target_ip != current_ip:
                            switched = True
                            switched_to_ip = sync_res.target_ip
                            switch_note = f"已自动切换解析至 {switched_to_ip}"
                        else:
                            switch_note = f"尝试切换至 {next_best} 失败：{'；'.join(sync_res.errors) or sync_res.message}"
                    except Exception as exc:  # noqa: BLE001
                        switch_note = f"调用 Cloudflare 切换异常：{exc}"
                elif not next_best:
                    switch_note = "候选池内暂无其他可用健康 IP，保留原解析等待处理"
                elif not token:
                    switch_note = "尚未配置 Cloudflare API Token，无法自动修改 DNS"
                else:
                    switch_note = "未找到可替换的其他候选 IP"

                AuditStore(settings.database_path).create_log(
                    username="scheduler",
                    action="lb_gfw_failover",
                    success=switched,
                    message=(
                        f"{domain.name}: 检测到 {current_ip}:{port} 被防火墙屏蔽"
                        f"（主节点 {primary_name} 不通，备用节点 {backup_name} 通），{switch_note}"
                    ),
                )

                alert_key = f"gfw_blocked:{domain.id}:{current_ip}:{port}"
                lb_store.upsert_port_alert(
                    alert_key=alert_key,
                    kind="gfw_blocked",
                    severity="warning" if switched else "error",
                    domain_id=domain.id,
                    domain_name=domain.name,
                    ip=current_ip,
                    port=port,
                    instances=instances,
                    primary_node_id=primary_id,
                    primary_node_name=primary_name,
                    primary_detail=p_detail,
                    backup_node_id=backup_id,
                    backup_node_name=backup_name,
                    backup_detail=b_detail,
                    switched=switched,
                    switched_to_ip=switched_to_ip,
                    message=(
                        f"域名 {domain.name} 原 IP {current_ip} 的业务端口 {port} 对主节点（{primary_name}）不通、"
                        f"对备用节点（{backup_name}）连通，判定被 GFW 屏蔽；{switch_note}。"
                    ),
                )
                port_results.append({
                    "port": port,
                    "status": "gfw_blocked",
                    "primaryOk": False,
                    "primaryDetail": p_detail,
                    "backupOk": True,
                    "backupDetail": b_detail,
                    "switched": switched,
                    "switchedToIp": switched_to_ip,
                })
                # 任意业务端口判定被 GFW 屏蔽即短路当前 IP 的后续端口检查
                break

            # 主节点不通 + 备用节点也不通 => 判定为业务端口异常（不切 IP，记录提示）
            alert_key = f"port_unreachable:{domain.id}:{current_ip}:{port}"
            active_unreachable_keys.add(alert_key)
            inst_names = "、".join(
                f"{item.get('nodeName')}/{item.get('displayName') or item.get('instanceName')}"
                for item in instances[:3]
            )
            lb_store.upsert_port_alert(
                alert_key=alert_key,
                kind="port_unreachable",
                severity="error",
                domain_id=domain.id,
                domain_name=domain.name,
                ip=current_ip,
                port=port,
                instances=instances,
                primary_node_id=primary_id,
                primary_node_name=primary_name,
                primary_detail=p_detail,
                backup_node_id=backup_id,
                backup_node_name=backup_name,
                backup_detail=b_detail,
                switched=False,
                switched_to_ip=None,
                message=(
                    f"域名 {domain.name}（{current_ip}:{port}）业务端口异常：主节点（{primary_name}）"
                    f"与备用节点（{backup_name}）tcping 均不通"
                    + (f"（关联实例：{inst_names}）" if inst_names else "")
                ),
            )
            port_results.append({
                "port": port,
                "status": "port_unreachable",
                "primaryOk": False,
                "primaryDetail": p_detail,
                "backupOk": False,
                "backupDetail": b_detail,
            })

        if not gfw_triggered:
            lb_store.resolve_domain_port_alerts(
                domain.id, kind="port_unreachable", keep_keys=active_unreachable_keys,
            )
            if not active_unreachable_keys:
                # 当前 IP 所有业务端口均对主节点正常：若存在停留在本 IP 且未切换的旧 gfw_blocked 告警，自动恢复
                for alert in lb_store.list_port_alerts(status="active"):
                    if (alert["domainId"] == domain.id and alert["kind"] == "gfw_blocked"
                            and alert["ip"] == current_ip and not alert["switched"]):
                        lb_store.dismiss_port_alert(alert["id"])

        overall = (
            "gfw_blocked" if gfw_triggered
            else ("port_unreachable" if active_unreachable_keys else "healthy")
        )
        return {
            "domainId": domain.id,
            "domainName": domain.name,
            "currentIp": switched_to_ip or current_ip,
            "previousIp": current_ip if switched else None,
            "ports": [s["port"] for s in port_specs],
            "checkedPorts": len(port_results),
            "portResults": port_results,
            "status": overall,
            "switched": switched,
            "switchedToIp": switched_to_ip,
            "checkedAt": now_iso(),
        }


domain_port_checker = DomainPortHealthChecker()
