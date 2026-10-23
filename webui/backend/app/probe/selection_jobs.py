"""Selection-backed probe-job producer operations.

These helpers deliberately accept the ProbeJobStore-owned connection. They do
not open transactions or connections; job creation, claim, and failover remain
serialized by the existing scheduler boundary.
"""
from __future__ import annotations

import hashlib
import json
import uuid

from ..models import now_iso
from .constants import PROBE_TEST_PORT
from .store import split_probe_endpoint as split_endpoint, validate_probe_addr

SELECTION_PRODUCER_CHUNK_SIZE = 250
SELECTION_PRODUCER_BACKLOG_LIMIT = 500
SELECTION_PRODUCER_RETRY_DAYS = 7


def create_primary_selection_job(store, connection, owner, selection_id, mode, idempotency_key, *,
                                 requested_node_ids=None, options=None, auto_route=False,
                                 auto_full=False, concurrency=6, timeout=1.5, port=PROBE_TEST_PORT):
    """Validate and create a primary-managed selection job within caller's transaction."""
    if mode not in {'route', 'connectivity', 'speed', 'full'}:
        raise ValueError('选择快照任务模式必须是 route/connectivity/speed/full')
    if type(port) is not int or port != PROBE_TEST_PORT:
        raise ValueError(f'探测任务端口固定为 {PROBE_TEST_PORT}')
    if not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 200:
        raise ValueError('idempotencyKey 无效')
    requested_node_ids = store._normalize_requested_node_ids(requested_node_ids)
    if not 1 <= int(concurrency) <= 16:
        raise ValueError('并发须为1-16')
    opts = dict(options or {})
    opts.update(autoRoute=auto_route, autoFull=auto_full, concurrency=int(concurrency), timeout=float(timeout))
    request = {
        'selectionId': str(selection_id), 'mode': mode,
        'nodeIds': requested_node_ids, 'port': PROBE_TEST_PORT,
        'autoRoute': bool(auto_route), 'autoFull': bool(auto_full),
        'concurrency': int(concurrency), 'timeout': float(timeout),
    }
    fingerprint = hashlib.sha256(json.dumps(
        request, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    existing = connection.execute(
        'SELECT p.job_id,p.request_fingerprint FROM probe_job_producers p '
        'WHERE p.created_by=? AND p.idempotency_key=?', (owner, idempotency_key),
    ).fetchone()
    if existing:
        if existing['request_fingerprint'] != fingerprint:
            raise ValueError('idempotencyKey 已用于不同的请求')
        return existing['job_id']

    selection = connection.execute(
        'SELECT state,expires_at,count,max_server_id FROM probe_server_selections '
        'WHERE id=? AND owner=?', (selection_id, owner),
    ).fetchone()
    if selection is None:
        raise KeyError(selection_id)
    if selection['state'] != 'ready' or selection['expires_at'] <= now_iso():
        raise ValueError('选择快照尚未就绪或已过期')
    if int(selection['count']) <= 0:
        raise ValueError('选择快照没有可测试的服务器')
    primary_node_id = store._primary_assignment(connection, requested_node_ids)
    execution_policy = store._stored_execution_policy(connection)
    node = connection.execute('SELECT * FROM probe_nodes WHERE id=?', (primary_node_id,)).fetchone()
    if node is None:
        raise ValueError('主用测试节点不存在')
    capabilities = json.loads(node['capabilities'])
    required = {'route', 'connectivity', 'speed'} if mode == 'full' else {mode}
    if not required.issubset(set(capabilities)):
        raise ValueError('主用测试节点能力不匹配: ' + node['name'])

    job_id = str(uuid.uuid4())
    stage = 'route' if mode == 'full' else mode
    stamp = now_iso()
    connection.execute(
        'INSERT INTO probe_jobs(id,mode,options,created_at,primary_managed,execution_policy) '
        'VALUES(?,?,?,?,1,?)',
        (job_id, mode, store._serialize(opts), stamp, store._serialize(execution_policy)),
    )
    connection.execute(
        'INSERT INTO probe_job_producers(job_id,selection_id,created_by,idempotency_key,request_fingerprint,'
        'stage,target_total,materialized_count,cursor_server_id,max_server_id,current_node_id,owner_index,'
        'generation,state,failover_waiting,error,created_at,updated_at) '
        "VALUES(?,?,?,?,?,?,?,0,0,?,?,0,0,'queued',0,'',?,?)",
        (job_id, selection_id, owner, idempotency_key, fingerprint, stage,
         int(selection['count']), int(selection['max_server_id']), primary_node_id, stamp, stamp),
    )
    store._refresh(connection, [job_id])
    return job_id


def materialize_selection_chunk(store, connection, node_id, capabilities):
    """Append one bounded target chunk for the node that currently owns it."""
    producers = connection.execute(
        "SELECT * FROM probe_job_producers p JOIN probe_jobs j ON j.id=p.job_id "
        "WHERE p.current_node_id=? AND p.state IN ('queued','running') AND j.state='running' "
        "ORDER BY p.created_at,p.job_id LIMIT 20", (node_id,),
    ).fetchall()
    for producer in producers:
        if producer['stage'] not in capabilities:
            continue
        backlog = int(connection.execute(
            "SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND state IN ('pending','running','cancelling')",
            (producer['job_id'],),
        ).fetchone()[0])
        room = min(SELECTION_PRODUCER_CHUNK_SIZE, SELECTION_PRODUCER_BACKLOG_LIMIT - backlog)
        if room <= 0:
            continue
        targets = connection.execute(
            "SELECT server_id,ip FROM probe_server_selection_members "
            "WHERE selection_id=? AND server_id>? AND server_id<=? "
            "ORDER BY server_id LIMIT ?",
            (producer['selection_id'], producer['cursor_server_id'], producer['max_server_id'], room),
        ).fetchall()
        if not targets:
            connection.execute("UPDATE probe_job_producers SET state='done',failover_waiting=0,error='',updated_at=? WHERE job_id=?",
                               (now_iso(), producer['job_id']))
            store._refresh(connection, [producer['job_id']])
            continue
        full = producer['mode'] == 'full'
        for target in targets:
            host, port = split_endpoint(validate_probe_addr(target['ip']), PROBE_TEST_PORT)
            if port != PROBE_TEST_PORT:
                raise ValueError(f'选择快照目标端口必须固定为 {PROBE_TEST_PORT}')
            store._task(connection, producer['job_id'], node_id, producer['stage'], host, PROBE_TEST_PORT,
                        {'full': True} if full else {}, generation=producer['generation'])
        cursor = int(targets[-1]['server_id'])
        more = connection.execute(
            "SELECT 1 FROM probe_server_selection_members WHERE selection_id=? AND server_id>? AND server_id<=? LIMIT 1",
            (producer['selection_id'], cursor, producer['max_server_id']),
        ).fetchone() is not None
        connection.execute(
            "UPDATE probe_job_producers SET cursor_server_id=?,materialized_count=materialized_count+?,"
            "state=?,failover_waiting=0,error='',updated_at=? WHERE job_id=?",
            (cursor, len(targets), 'running' if more else 'done', now_iso(), producer['job_id']),
        )
        store._refresh(connection, [producer['job_id']])
        return len(targets)
    return 0


def sweep_selection_producer(store, connection, job_id, owner_id, *, owner_online,
                             owner_has_generation, owner_is_backup, now, policy_json):
    """Transfer or park one producer while the existing bounded owner sweep runs."""
    producer = connection.execute(
        "SELECT * FROM probe_job_producers WHERE job_id=? AND current_node_id=? "
        "AND state IN ('queued','running','waiting')", (job_id, owner_id),
    ).fetchone()
    if producer is None:
        return
    requires_generation = producer['generation'] > 0 or owner_is_backup
    usable = owner_online and (owner_has_generation or not requires_generation)
    if usable:
        if producer['failover_waiting']:
            next_state = 'queued' if producer['materialized_count'] == 0 else 'running'
            connection.execute("UPDATE probe_job_producers SET state=?,failover_waiting=0,error='',updated_at=? WHERE job_id=?",
                               (next_state, now_iso(), job_id))
        return
    backup = store._next_backup(connection, owner_id, now, policy_json)
    if backup is None:
        if not producer['failover_waiting']:
            connection.execute("UPDATE probe_job_producers SET state='waiting',failover_waiting=1,"
                               "error='waiting for an online backup',updated_at=? WHERE job_id=?",
                               (now_iso(), job_id))
        return
    policy = json.loads(policy_json)
    owner_chain = [policy['primaryNodeId'], *policy['backupNodeIds']]
    generation = int(producer['generation']) + 1
    reason = 'pending_owner_offline' if not owner_online else 'owner_protocol_feature_lost'
    stamp = now_iso()
    connection.execute(
        "UPDATE probe_job_producers SET current_node_id=?,owner_index=?,generation=?,state='running',"
        "failover_waiting=0,error='',updated_at=? WHERE job_id=?",
        (backup, owner_chain.index(backup), generation, stamp, job_id),
    )
    connection.execute(
        "INSERT INTO probe_job_producer_transfers(job_id,from_node_id,to_node_id,generation,cursor_server_id,reason,transferred_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (job_id, owner_id, backup, generation, producer['cursor_server_id'], reason, stamp),
    )
