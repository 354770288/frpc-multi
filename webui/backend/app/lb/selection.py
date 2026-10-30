"""Global observation source for ranking; live health always belongs to Console."""

from __future__ import annotations

import ipaddress
import json
from datetime import datetime, timezone

from ..probe.constants import PROBE_TEST_PORT
from ..probe.store import ProbeStore
from .store import LbDomain, LbStore

_SETTING = "selection_config"


def selection_config(store: LbStore) -> dict:
    raw = store.get_setting(_SETTING)
    values = json.loads(raw) if raw else {}
    return {"nodeId": values.get("nodeId", "console"),
            "maxAgeHours": values.get("maxAgeHours", 24), "healthSource": "console"}


def save_selection_config(store: LbStore, node_id: str, max_age_hours: int) -> dict:
    if not 1 <= max_age_hours <= 168:
        raise ValueError("观测有效期需在 1–168 小时之间")
    from ..probe.jobs import ProbeJobStore

    node = ProbeJobStore(store.database_path).get_node(node_id)
    if node is None:
        raise ValueError("观测节点不存在")
    if node_id != "console" and not {"connectivity", "speed"}.issubset(node["capabilities"]):
        raise ValueError("观测节点需支持穿透和测速，请先升级节点")
    store.set_setting(_SETTING, json.dumps({"nodeId": node_id, "maxAgeHours": max_age_hours}))
    return selection_config(store)


def _endpoint(addr: str, default_port: int) -> tuple[str, int]:
    from .health import split_addr

    return split_addr(addr, default_port)


def _order(addr: str) -> tuple:
    host, port = _endpoint(addr, 7000)
    try:
        return (0, int(ipaddress.IPv4Address(host)), port)
    except ValueError:
        return (1, host, port)


def _fresh(row: dict, seconds: float) -> bool:
    try:
        stamp = datetime.fromisoformat(row["test_time"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        age = (datetime.now(timezone.utc) - stamp).total_seconds()
        return 0 <= age <= seconds
    except (KeyError, TypeError, ValueError):
        return False


def selection_for_domain(domain: LbDomain, probe: ProbeStore, monitor, *,
                         lb_store: LbStore | None = None) -> dict:
    """One decision shared by preview, scheduled failover and DNS synchronization."""
    lb_store = lb_store or LbStore(probe.database_path)
    config = selection_config(lb_store)
    legacy_source = config["nodeId"]
    rows = list(lb_store.iter_domain_candidate_rows(domain.id))
    healthy = [r for r in rows if monitor.is_healthy(_endpoint(r["ip"], 7000)[0])]
    view = {"nodeId": legacy_source, "healthSource": "console", "maxAgeHours": config["maxAgeHours"],
            "observedAt": None, "validCandidates": 0, "bestIp": None, "bestServerId": None,
            "reason": "no_healthy_candidates"}
    if not healthy:
        return view

    from ..probe.jobs import ProbeJobStore
    observations = ProbeJobStore(probe.database_path)
    max_age = config["maxAgeHours"] * 3600
    candidate_ips = list(dict.fromkeys(_endpoint(row["ip"], PROBE_TEST_PORT)[0] for row in healthy))
    # Choose latest first, THEN filter age: failed recent results must hide older successes.
    latest = {kind: {_endpoint(r["server_ip"], r.get("port", PROBE_TEST_PORT)): r
                     for r in observations.current_results(kind, candidate_ips)
                     if _fresh(r, max_age)}
              for kind in ("connectivity", "speed")}
    ranked = []
    observed = set()
    timestamps = []
    for row in healthy:
        endpoint = (_endpoint(row["ip"], PROBE_TEST_PORT)[0], PROBE_TEST_PORT)
        conn = latest["connectivity"].get(endpoint)
        speed = latest["speed"].get(endpoint)
        if conn is not None or speed is not None:
            observed.add(row["ip"])
            timestamps.extend(r["test_time"] for r in (conn, speed) if r is not None)
        ranked.append({"server_id": row["id"], "ip": row["ip"],
                       "c_frps_reachable": bool(conn and conn.get("frps_reachable")),
                       "s_dl_speed_mbps": (float(speed.get("dl_speed_bps", 0)) * 8 / 1024**2
                                           if speed and speed.get("dl_ok") else 0)})
    observed_hosts = {_endpoint(addr, PROBE_TEST_PORT)[0] for addr in observed}
    view.update(validCandidates=len(observed_hosts), observedAt=max(timestamps) if timestamps else None)
    preferred = next((row for row in healthy if row["id"] == domain.preferred_server_id), None)
    if preferred is not None:
        view.update(bestIp=_endpoint(preferred["ip"], PROBE_TEST_PORT)[0],
                    bestServerId=preferred["id"], reason="preferred_server")
        return view

    current_healthy = any(_endpoint(r["ip"], PROBE_TEST_PORT)[0] == domain.current_ip for r in healthy)
    if current_healthy and domain.current_ip not in observed_hosts:
        current = next(r for r in healthy if _endpoint(r["ip"], PROBE_TEST_PORT)[0] == domain.current_ip)
        view.update(bestIp=domain.current_ip, bestServerId=current["id"], reason="keep_healthy_current")
    elif observed:
        ranked.sort(key=lambda r: _order(r["ip"]))
        ranked.sort(key=lambda r: (r["c_frps_reachable"], r["s_dl_speed_mbps"]), reverse=True)
        view.update(bestIp=_endpoint(ranked[0]["ip"], PROBE_TEST_PORT)[0],
                    bestServerId=ranked[0]["server_id"], reason="primary_observation")
    else:
        selected = min(healthy, key=lambda r: _order(r["ip"]))
        view.update(bestIp=_endpoint(selected["ip"], PROBE_TEST_PORT)[0],
                    bestServerId=selected["id"], reason="healthy_ip_order")
    return view
