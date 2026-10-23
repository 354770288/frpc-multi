"""Durable scheduler shared by the console, full workers and route adapters.

Every mutation takes a short BEGIN IMMEDIATE transaction. A task's attempt UUID is
its fencing token; target failures are results, only infrastructure failures retry.
"""
from __future__ import annotations

import hmac
import ipaddress
import itertools
import json
import secrets
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..control.database import connect_database, initialize_database
from ..models import now_iso
from .constants import PROBE_TEST_PORT
from .discover import DiscoverParams, DiscoverRunner, parse_targets
from .store import validate_probe_addr, split_probe_endpoint as split_endpoint

LEASE_SECONDS = 120
CAPABILITIES = ['discover', 'route', 'connectivity', 'speed']
GENERATION_PROTOCOL_FEATURE = 'task-generation-v1'
TERMINAL = {'done', 'failed', 'skipped', 'stopped'}
_LOW_LEVEL_ASSIGNMENT = object()


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _id():
    return str(uuid.uuid4())



class ProbeJobStore:
    def __init__(self, database_path: Path):
        self.database_path = Path(database_path)
        initialize_database(self.database_path)
        with self._db() as c:
            c.execute("INSERT OR IGNORE INTO probe_nodes(id,name,token,kind,capabilities,created_at) VALUES('console','Console','','console',?,?)", (_json(CAPABILITIES), now_iso()))
            raw = c.execute("SELECT value FROM probe_settings WHERE key='route_nodes'").fetchone()
            try:
                nodes = json.loads(raw['value']) if raw else []
            except (ValueError, TypeError):
                nodes = []
            nodes_migrated = c.execute("SELECT 1 FROM probe_settings WHERE key='probe_nodes_migrated'").fetchone()
            for node in (nodes if isinstance(nodes, list) and not nodes_migrated else []):
                if node.get('name') and node.get('token'):
                    c.execute("INSERT OR IGNORE INTO probe_nodes(id,name,token,kind,capabilities,created_at) VALUES(?,?,?,'legacy',?,?)", (str(uuid.uuid5(uuid.NAMESPACE_URL, 'frpc-route:'+node['token'])), node['name'], node['token'], '["route"]', now_iso()))
            if not nodes_migrated:
                c.execute("INSERT INTO probe_settings VALUES('probe_nodes_migrated','1')")
            # A one-time snapshot gives historical console data explicit provenance.
            migrated = c.execute("SELECT 1 FROM probe_settings WHERE key='probe_results_migrated'").fetchone()
            if not migrated:
                port_row=c.execute("SELECT value FROM probe_settings WHERE key='frps_port'").fetchone()
                legacy_port=int(port_row['value']) if port_row else 7000
                for kind, table in [('connectivity','probe_connectivity_results'), ('speed','probe_speed_results')]:
                    for row in c.execute('SELECT * FROM '+table).fetchall():
                        data = dict(row)
                        if kind == 'speed':
                            for prefix in ('dl','ul'):
                                data[prefix+'_speed_bps'] = data[prefix+'_speed_mbps'] * 1024 * 1024 / 8
                        host,target_port=split_endpoint(row['server_ip'],legacy_port)
                        self._result(c, 'legacy-'+kind+'-'+str(row['id']), '', 'console', kind, host, target_port, data, row['test_time'])
                c.execute("INSERT INTO probe_discover_observations SELECT 'console',ip,port,latency_ms,discovered_at FROM probe_discover_results WHERE 1 ON CONFLICT DO NOTHING")
                c.execute("INSERT INTO probe_settings VALUES('probe_results_migrated','1')")

    @contextmanager
    def _db(self):
        c = connect_database(self.database_path)
        try:
            c.execute('BEGIN IMMEDIATE')
            yield c
            c.commit()
        except BaseException:
            c.rollback()
            raise
        finally:
            c.close()

    def _node_view(self, row, secret=False):
        d = dict(row)
        d['capabilities'] = json.loads(d['capabilities'])
        try:
            d['protocolFeatures'] = json.loads(d.pop('protocol_features', '[]'))
        except (TypeError, ValueError):
            d.pop('protocol_features', None)
            d['protocolFeatures'] = []
        d['online'] = d['id'] == 'console' or time.time()-d['last_seen'] < 30
        d['lastSeen'] = datetime.fromtimestamp(d.pop('last_seen'), timezone.utc).isoformat() if row['last_seen'] else None
        d['createdAt'] = d.pop('created_at')
        d['tokenMasked'] = d['token'][:4]+'…'+d['token'][-4:] if d['token'] else ''
        d['installCommand'] = 'curl -fsSL "$CONSOLE_URL/api/probe/worker/install.sh" | sudo bash' if d['kind'] != 'console' else ''
        if not secret:
            d.pop('token')
        return d

    def list_nodes(self):
        with self._db() as c:
            return [self._node_view(r) for r in c.execute('SELECT * FROM probe_nodes ORDER BY created_at,id')]

    def list_failovers(self, page=1, page_size=50, *, node_id=None, from_time=None, to_time=None):
        page = max(1, int(page))
        page_size = min(200, max(1, int(page_size)))
        filters = []
        args = []
        if node_id:
            filters.append('(from_node_id=? OR to_node_id=?)')
            args = [node_id, node_id]
        if from_time:
            filters.append('transferred_at>=?')
            args.append(from_time)
        if to_time:
            filters.append('transferred_at<=?')
            args.append(to_time)
        where = (' WHERE ' + ' AND '.join(filters)) if filters else ''
        with self._db() as c:
            total = c.execute('SELECT COUNT(*) FROM probe_task_transfers' + where, args).fetchone()[0]
            rows = c.execute('SELECT * FROM probe_task_transfers' + where +
                              ' ORDER BY transferred_at DESC,id DESC LIMIT ? OFFSET ?',
                              (*args, page_size, (page - 1) * page_size)).fetchall()
            items = []
            for row in rows:
                item = dict(row)
                for source, target in (('task_id', 'taskId'), ('job_id', 'jobId'),
                                       ('from_node_id', 'fromNodeId'), ('to_node_id', 'toNodeId'),
                                       ('transferred_at', 'transferredAt')):
                    item[target] = item.pop(source)
                items.append(item)
            return {'page': page, 'pageSize': page_size, 'total': total, 'items': items}

    @staticmethod
    def _eligible_policy_node(row):
        if not row or row['kind'] != 'worker':
            return False
        try:
            capabilities = json.loads(row['capabilities'])
        except (TypeError, ValueError):
            return False
        return (isinstance(capabilities, list)
                and all(isinstance(capability, str) for capability in capabilities)
                and set(CAPABILITIES).issubset(capabilities))

    @staticmethod
    def _stored_execution_policy(c):
        row = c.execute("SELECT value FROM probe_settings WHERE key='probe_execution_policy'").fetchone()
        if row is None:
            return None
        try:
            value = json.loads(row['value'])
        except (ValueError, TypeError) as exc:
            raise ValueError('已保存的主备测试策略 JSON 损坏') from exc
        if (not isinstance(value, dict) or not isinstance(value.get('primaryNodeId'), str)
                or not value['primaryNodeId'] or not isinstance(value.get('backupNodeIds'), list)
                or not all(isinstance(node_id, str) and node_id for node_id in value['backupNodeIds'])):
            raise ValueError('已保存的主备测试策略结构无效')
        backup_node_ids = value['backupNodeIds']
        if len(set(backup_node_ids)) != len(backup_node_ids):
            raise ValueError('已保存的主备测试策略包含重复备用节点')
        if value['primaryNodeId'] in backup_node_ids:
            raise ValueError('已保存的主备测试策略将主用节点重复列为备用节点')
        policy = {'primaryNodeId': value['primaryNodeId'], 'backupNodeIds': backup_node_ids}
        for node_id in [policy['primaryNodeId'], *backup_node_ids]:
            node = c.execute('SELECT * FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
            if node is None:
                raise ValueError('已保存的主备测试策略引用了不存在的节点: ' + node_id)
            if not ProbeJobStore._eligible_policy_node(node):
                raise ValueError('已保存的主备测试策略引用了不符合要求的节点: ' + node_id)
        return policy

    def get_execution_policy(self):
        with self._db() as c:
            policy = self._stored_execution_policy(c)
            suggested = None
            selection = c.execute("SELECT value FROM lb_settings WHERE key='selection_config'").fetchone()
            try:
                selection_config = json.loads(selection['value']) if selection else {}
                candidate = selection_config.get('nodeId') if isinstance(selection_config, dict) else None
            except (ValueError, TypeError):
                candidate = None
            if isinstance(candidate, str):
                node = c.execute('SELECT * FROM probe_nodes WHERE id=?', (candidate,)).fetchone()
                if self._eligible_policy_node(node):
                    suggested = candidate
            return {
                'configured': policy is not None,
                'primaryNodeId': policy['primaryNodeId'] if policy else None,
                'backupNodeIds': policy['backupNodeIds'] if policy else [],
                'suggestedPrimaryNodeId': suggested,
            }

    def set_execution_policy(self, primary_node_id, backup_node_ids):
        if not isinstance(primary_node_id, str) or not primary_node_id:
            raise ValueError('必须设置一个主用测试节点')
        if not isinstance(backup_node_ids, list) or not all(isinstance(node_id, str) and node_id for node_id in backup_node_ids):
            raise ValueError('备用节点须为节点 ID 列表')
        if len(set(backup_node_ids)) != len(backup_node_ids):
            raise ValueError('备用节点不能重复')
        if primary_node_id in backup_node_ids:
            raise ValueError('主用节点不能同时列为备用节点')
        node_ids = [primary_node_id, *backup_node_ids]
        with self._db() as c:
            for node_id in node_ids:
                node = c.execute('SELECT * FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
                if node is None:
                    raise ValueError('测试节点不存在: ' + node_id)
                if not self._eligible_policy_node(node):
                    raise ValueError('节点须为具备完整测试能力的 worker: ' + node['name'])
            value = {'primaryNodeId': primary_node_id, 'backupNodeIds': backup_node_ids}
            c.execute("INSERT INTO probe_settings(key,value) VALUES('probe_execution_policy',?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (_json(value),))
        return self.get_execution_policy()

    @staticmethod
    def _normalize_requested_node_ids(requested_node_ids):
        if requested_node_ids is None:
            return None
        if not isinstance(requested_node_ids, (list, tuple)):
            raise ValueError('nodeIds 须为节点 ID 列表')
        requested_node_ids = list(requested_node_ids)
        try:
            duplicate_ids = len(set(requested_node_ids)) != len(requested_node_ids)
        except TypeError as exc:
            raise ValueError('nodeIds 须为节点 ID 列表') from exc
        if duplicate_ids:
            raise ValueError('nodeIds 不能重复')
        return requested_node_ids

    def _primary_assignment(self, c, requested_node_ids):
        try:
            policy = self._stored_execution_policy(c)
        except ValueError as exc:
            raise ValueError(f'测试节点主备策略无效，请重新配置测试节点: {exc}') from exc
        if policy is None or not policy['primaryNodeId']:
            raise ValueError('请先配置测试节点主备策略，再创建任务')
        primary_node_id = policy['primaryNodeId']
        if requested_node_ids and requested_node_ids != [primary_node_id]:
            raise ValueError('所选节点与已配置的主用测试节点不一致，请使用主用节点')
        return primary_node_id

    def validate_primary_assignment(self, requested_node_ids=None):
        """Preflight a legacy selection before checking adapter busy state.

        Task creation repeats this validation under its own write transaction.
        """
        requested_node_ids = self._normalize_requested_node_ids(requested_node_ids)
        with self._db() as c:
            return self._primary_assignment(c, requested_node_ids)

    def create_primary_job(self, mode, requested_node_ids=None, **kwargs):
        """Create one public job on the saved primary execution node.

        ``create_job`` remains the low-level primitive for internal callers that
        explicitly assign nodes. HTTP-facing callers use this wrapper so legacy
        node selections cannot fan a job out across multiple workers.
        """
        requested_node_ids = self._normalize_requested_node_ids(requested_node_ids)
        return self.create_job(mode, None, _primary_requested_node_ids=requested_node_ids, **kwargs)

    def get_node(self, node_id):
        with self._db() as c:
            row = c.execute('SELECT * FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
            if row is None:
                raise KeyError(node_id)
            return self._node_view(row)

    def create_node(self, name, *, kind='worker'):
        name = str(name).strip()
        if not name or len(name)>64:
            raise ValueError('节点名称须为1-64字符')
        node_id, token = _id(), secrets.token_hex(16 if kind=='legacy' else 32)
        with self._db() as c:
            c.execute('INSERT INTO probe_nodes(id,name,token,kind,capabilities,created_at) VALUES(?,?,?,?,?,?)', (node_id,name,token,kind,_json(['route'] if kind=='legacy' else CAPABILITIES),now_iso()))
        return {**self.get_node(node_id), 'token':token}

    def delete_node(self, node_id):
        if node_id == 'console':
            raise ValueError('Console 为内置节点')
        with self._db() as c:
            policy = self._stored_execution_policy(c)
            if policy and node_id in [policy['primaryNodeId'], *policy['backupNodeIds']]:
                raise ValueError('节点仍被主备测试策略引用，请先从策略中移除')
            if not c.execute('DELETE FROM probe_nodes WHERE id=?',(node_id,)).rowcount:
                raise KeyError(node_id)
            c.execute("UPDATE probe_tasks SET state=CASE WHEN state='running' THEN 'cancelling' ELSE 'stopped' END,error='stopped' WHERE node_id=? AND state IN ('pending','running')",(node_id,))
            self._refresh(c)

    def authenticate(self, token):
        if not token:
            raise ValueError('节点 Token 无效')
        with self._db() as c:
            for row in c.execute("SELECT * FROM probe_nodes WHERE kind!='console'"):
                if hmac.compare_digest(row['token'], token):
                    return self._node_view(row)
        raise ValueError('节点 Token 无效')

    def _task(self, c, job_id, node_id, stage, ip, port, payload=None, state='pending', generation=0):
        task_id = _id()
        c.execute('INSERT OR IGNORE INTO probe_tasks(id,job_id,node_id,stage,ip,port,payload,state,error,created_at,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?)', (task_id,job_id,node_id,stage,ip,port,_json(payload or {}),state,'dependency' if state=='skipped' else '',now_iso(),generation))
        if state=='pending' and stage!='discover':
            c.execute("UPDATE probe_tasks SET state='pending',error='',generation=?,failover_waiting=0 WHERE job_id=? AND node_id=? AND stage=? AND ip=? AND port=? AND state='skipped' AND error='dependency'",(generation,job_id,node_id,stage,ip,port))
        if state == 'pending' and generation > 0:
            c.execute("UPDATE probe_tasks SET generation=?,error=CASE WHEN failover_waiting=1 THEN '' ELSE error END,failover_waiting=0 WHERE job_id=? AND node_id=? AND stage=? AND ip=? AND port=? AND state='pending' AND generation<?",
                      (generation,job_id,node_id,stage,ip,port,generation))
        return task_id

    @staticmethod
    def _owner_online(c, node_id, now):
        row = c.execute('SELECT last_seen FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
        return bool(row and now - row['last_seen'] < 30)

    @staticmethod
    def _owner_supports_generation(c, node_id):
        row = c.execute('SELECT protocol_features FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
        try:
            features = json.loads(row['protocol_features']) if row else []
            return isinstance(features, list) and GENERATION_PROTOCOL_FEATURE in features
        except (TypeError, ValueError):
            return False

    def _next_backup(self, c, owner_id, now, execution_policy_json):
        try:
            policy = json.loads(execution_policy_json)
        except (TypeError, ValueError):
            return None
        if (not isinstance(policy, dict) or not isinstance(policy.get('primaryNodeId'), str)
                or not isinstance(policy.get('backupNodeIds'), list)):
            return None
        if owner_id == policy['primaryNodeId']:
            later = policy['backupNodeIds']
        elif owner_id in policy['backupNodeIds']:
            later = policy['backupNodeIds'][policy['backupNodeIds'].index(owner_id) + 1:]
        else:
            return None
        for node_id in later:
            node = c.execute('SELECT * FROM probe_nodes WHERE id=?', (node_id,)).fetchone()
            if not node or not self._eligible_policy_node(node) or not self._owner_online(c, node_id, now):
                continue
            try:
                features = json.loads(node['protocol_features'])
            except (TypeError, ValueError):
                features = []
            if isinstance(features, list) and GENERATION_PROTOCOL_FEATURE in features:
                return node_id
        return None

    def _transfer_task(self, c, task, to_node_id, reason):
        generation = task['generation'] + 1
        stamp = now_iso()
        c.execute("UPDATE probe_tasks SET node_id=?,generation=?,failover_waiting=0,state='pending',attempt_id=NULL,lease_until=0,error='',seq=0,progress='{}' WHERE id=?",
                  (to_node_id, generation, task['id']))
        c.execute('INSERT INTO probe_task_transfers(task_id,job_id,from_node_id,to_node_id,generation,reason,transferred_at) VALUES(?,?,?,?,?,?,?)',
                  (task['id'], task['job_id'], task['node_id'], to_node_id, generation, reason, stamp))
        return generation

    @staticmethod
    def _pending_failover_batch(c, job_id, owner_id, limit, *, generation_only=False, generation_zero=False):
        generation_filter = ' AND generation>0' if generation_only else (' AND generation=0' if generation_zero else '')
        return c.execute(
            "SELECT * FROM probe_tasks WHERE job_id=? AND node_id=? AND state='pending'" + generation_filter +
            ' ORDER BY created_at,rowid LIMIT ?', (job_id, owner_id, limit),
        ).fetchall()

    @staticmethod
    def _update_pending_error_batch(c, job_id, owner_id, old_error, new_error, limit, *, generation_only=False, generation_zero=False):
        generation_filter = ' AND generation>0' if generation_only else (' AND generation=0' if generation_zero else '')
        waiting = old_error is None
        return c.execute(
            "UPDATE probe_tasks SET error=?,failover_waiting=? WHERE id IN ("
            "SELECT id FROM probe_tasks WHERE job_id=? AND node_id=? AND state='pending' AND failover_waiting=?" +
            generation_filter + ' ORDER BY created_at,rowid LIMIT ?)',
            (new_error, int(waiting), job_id, owner_id, int(not waiting), limit),
        ).rowcount

    def create_job(self, mode, node_ids, *, ips=None, targets=None, exclude=None, port=PROBE_TEST_PORT, options=None, auto_route=False, auto_full=False, concurrency=6, timeout=1.5, _primary_requested_node_ids=_LOW_LEVEL_ASSIGNMENT):
        if mode not in {*CAPABILITIES,'full'}:
            raise ValueError('mode 必须是 discover/route/connectivity/speed/full')
        if type(port) is not int or port != PROBE_TEST_PORT:
            raise ValueError(f'探测任务端口固定为 {PROBE_TEST_PORT}')
        if _primary_requested_node_ids is _LOW_LEVEL_ASSIGNMENT and not node_ids:
            raise ValueError('需要节点')
        opts = dict(options or {})
        opts.update(autoRoute=auto_route, autoFull=auto_full, concurrency=concurrency, timeout=timeout)
        plan = None
        if mode == 'discover':
            target_text = targets if isinstance(targets,str) else ','.join(targets or ips or [])
            exclude_text = exclude if isinstance(exclude,str) else ','.join(exclude or [])
            plan = parse_targets(target_text,exclude_text)
            DiscoverRunner._validate_params(DiscoverParams([target_text],[exclude_text],int(port),int(concurrency),float(timeout)))
            opts['total'] = plan.total
        else:
            supplied=ips or targets or []
            if isinstance(supplied,str):supplied=[x.strip() for x in supplied.replace('\n',',').split(',') if x.strip()]
            ips = list(dict.fromkeys(validate_probe_addr(ip) for ip in supplied))
            if not ips:
                raise ValueError('没有可测试的服务器')
            if any(split_endpoint(ip, PROBE_TEST_PORT)[1] != PROBE_TEST_PORT for ip in ips):
                raise ValueError(f'探测任务端口固定为 {PROBE_TEST_PORT}')
            if not 1<=int(concurrency)<=16:
                raise ValueError('并发须为1-16')
        job_id = _id()
        with self._db() as c:
            execution_policy = {}
            if _primary_requested_node_ids is not _LOW_LEVEL_ASSIGNMENT:
                node_ids = [self._primary_assignment(c, _primary_requested_node_ids)]
                execution_policy = self._stored_execution_policy(c)
            selected=[]
            for node_id in dict.fromkeys(node_ids):
                node = c.execute('SELECT * FROM probe_nodes WHERE id=?',(node_id,)).fetchone()
                if node is None:
                    raise ValueError('未知节点: '+node_id)
                caps=json.loads(node['capabilities'])
                required = ['route','connectivity','speed'] if mode=='full' else [mode]
                if mode=='discover' and auto_full:required=CAPABILITIES
                elif mode=='discover' and auto_route:required=['discover','route']
                if any(k not in caps for k in required):
                    raise ValueError('节点能力不匹配: '+node['name'])
                selected.append(node_id)
            primary_managed = int(_primary_requested_node_ids is not _LOW_LEVEL_ASSIGNMENT)
            c.execute('INSERT INTO probe_jobs(id,mode,options,created_at,primary_managed,execution_policy) VALUES(?,?,?,?,?,?)',
                      (job_id,mode,_json(opts),now_iso(),primary_managed,_json(execution_policy)))
            for node_id in selected:
                if plan is not None:
                    # One bounded chunk is runnable; commit/report schedules its successor.
                    payload={'intervals':[[i.start,i.end] for i in plan.intervals], 'cursor':0}
                    if plan.total:
                        self._scan_chunk(c,job_id,node_id,int(port),payload)
                else:
                    for ip in ips:
                        host,target_port=split_endpoint(ip,int(port))
                        self._task(c,job_id,node_id,'route' if mode=='full' else mode,host,target_port)
            self._refresh(c)
        return self.get_job(job_id)

    def _scan_chunk(self,c,job,node,port,payload,generation=0):
        intervals=payload['intervals']; cursor=payload['cursor']; skip=cursor; parts=[]; remaining=4096
        for start,end in intervals:
            size=end-start+1
            if skip>=size:
                skip-=size; continue
            start+=skip; skip=0; take=min(remaining,end-start+1)
            parts.append([start,start+take-1]); remaining-=take
            if not remaining: break
        if parts:
            self._task(c,job,node,'discover','',port,{'intervals':intervals,'cursor':cursor,'chunk':parts,'size':4096-remaining},generation=generation)

    def _expire(self,c):
        now = time.time()
        refresh_job_ids = set()
        expired = c.execute("SELECT t.*,j.primary_managed,j.execution_policy FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.state IN ('running','cancelling') AND t.lease_until<=? ORDER BY t.lease_until LIMIT 500",(now,)).fetchall()
        for t in expired:
            owner_online = self._owner_online(c, t['node_id'], now)
            owner_supports_generation = self._owner_supports_generation(c, t['node_id'])
            try:
                policy_snapshot = json.loads(t['execution_policy'])
                owner_is_backup = t['node_id'] in policy_snapshot.get('backupNodeIds', [])
            except (TypeError, ValueError, AttributeError):
                owner_is_backup = False
            requires_generation_protocol = t['generation'] > 0 or (t['primary_managed'] and owner_is_backup)
            owner_unavailable = not owner_online or (requires_generation_protocol and not owner_supports_generation)
            if t['state'] == 'running' and t['primary_managed'] and owner_unavailable:
                backup = self._next_backup(c, t['node_id'], now, t['execution_policy'])
                if backup:
                    reason = 'lease_expired_owner_offline' if not owner_online else 'owner_protocol_feature_lost'
                    self._transfer_task(c, t, backup, reason)
                else:
                    c.execute("UPDATE probe_tasks SET state='pending',lease_until=0,error='waiting for an online backup',failover_waiting=1 WHERE id=?", (t['id'],))
                continue
            state = (t['error'] if t['error'] in {'stopped','skipped'} else 'stopped') if t['state']=='cancelling' else ('pending' if t['attempts']<3 else 'failed')
            c.execute("UPDATE probe_tasks SET state=?,lease_until=0,error='lease expired' WHERE id=?",(state,t['id']))
            if state in TERMINAL:
                refresh_job_ids.add(t['job_id'])

        # Sweep at most 500 job/owner pairs and 500 task IDs per call. The
        # persistent cursor prevents a large policy set from starving later jobs.
        remaining = 500
        pair_budget = 500
        job_budget = 500
        cursor = c.execute('SELECT job_id,owner_index FROM probe_failover_scan_cursor WHERE id=1').fetchone()
        cursor_job_id, cursor_owner_index = cursor['job_id'], cursor['owner_index']
        jobs = c.execute("SELECT id,execution_policy FROM probe_jobs WHERE primary_managed=1 AND state='running' AND id>=? ORDER BY id", (cursor_job_id,))
        sweep_complete = True
        last_job_id, last_owner_index = '', -1
        for job in jobs:
            if remaining <= 0 or pair_budget <= 0 or job_budget <= 0:
                sweep_complete = False
                break
            job_budget -= 1
            try:
                policy = json.loads(job['execution_policy'])
            except (TypeError, ValueError):
                last_job_id, last_owner_index = job['id'], 1_000_000_000
                continue
            if not isinstance(policy, dict) or not isinstance(policy.get('primaryNodeId'), str) or not isinstance(policy.get('backupNodeIds'), list):
                last_job_id, last_owner_index = job['id'], 1_000_000_000
                continue
            owners = itertools.chain([policy['primaryNodeId']], policy['backupNodeIds'])
            start_index = cursor_owner_index if job['id'] == cursor_job_id else 0
            for owner_index, owner_id in itertools.islice(enumerate(owners), start_index, None):
                if remaining <= 0:
                    last_job_id, last_owner_index = job['id'], owner_index - 1
                    sweep_complete = False
                    break
                if pair_budget <= 0:
                    last_job_id, last_owner_index = job['id'], owner_index
                    sweep_complete = False
                    break
                pair_budget -= 1
                last_job_id, last_owner_index = job['id'], owner_index + 1
                owner = c.execute('SELECT * FROM probe_nodes WHERE id=?', (owner_id,)).fetchone()
                owner_online = bool(owner and now - owner['last_seen'] < 30)
                try:
                    raw_features = json.loads(owner['protocol_features']) if owner else []
                    owner_features = set(raw_features) if isinstance(raw_features, list) and all(isinstance(feature, str) for feature in raw_features) else set()
                except (TypeError, ValueError):
                    owner_features = set()
                owner_is_backup = owner_id in policy.get('backupNodeIds', [])
                missing_generation_protocol = owner_online and GENERATION_PROTOCOL_FEATURE not in owner_features
                generation_only = missing_generation_protocol and not owner_is_backup
                backup_protocol_lost = missing_generation_protocol and owner_is_backup

                if owner_online and not generation_only and not backup_protocol_lost:
                    # Clear stale wait messages in a bounded statement when a
                    # heartbeat restores the current owner.
                    cleared = self._update_pending_error_batch(
                        c, job['id'], owner_id, 'waiting for an online backup', '', remaining,
                    )
                    remaining -= cleared
                    if remaining <= 0:
                        last_job_id, last_owner_index = job['id'], owner_index
                        sweep_complete = False
                        break
                    continue

                if generation_only:
                    cleared = self._update_pending_error_batch(
                        c, job['id'], owner_id, 'waiting for an online backup', '', remaining,
                        generation_zero=True,
                    )
                    remaining -= cleared
                    if remaining <= 0:
                        last_job_id, last_owner_index = job['id'], owner_index
                        sweep_complete = False
                        break

                backup = self._next_backup(c, owner_id, now, job['execution_policy'])
                if backup is None:
                    marked = self._update_pending_error_batch(
                        c, job['id'], owner_id, None, 'waiting for an online backup', remaining,
                        generation_only=generation_only,
                    )
                    remaining -= marked
                    if remaining <= 0:
                        last_job_id, last_owner_index = job['id'], owner_index
                        sweep_complete = False
                        break
                    continue

                batch = self._pending_failover_batch(
                    c, job['id'], owner_id, remaining, generation_only=generation_only,
                )
                remaining -= len(batch)
                reason = 'pending_owner_offline' if not owner_online else 'owner_protocol_feature_lost'
                for task in batch:
                    self._transfer_task(c, task, backup, reason)
                if remaining <= 0:
                    last_job_id, last_owner_index = job['id'], owner_index
                    sweep_complete = False
                    break
            if not sweep_complete:
                break

        if sweep_complete:
            c.execute("UPDATE probe_failover_scan_cursor SET job_id='',owner_index=-1 WHERE id=1")
        elif last_job_id:
            c.execute('UPDATE probe_failover_scan_cursor SET job_id=?,owner_index=? WHERE id=1', (last_job_id, last_owner_index))
        if refresh_job_ids:
            self._refresh(c, refresh_job_ids)

    def _refresh(self,c,job_ids=None):
        sql = "UPDATE probe_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM probe_tasks t WHERE t.job_id=probe_jobs.id AND t.state IN ('pending','running','cancelling')) THEN 'running' WHEN EXISTS(SELECT 1 FROM probe_tasks t WHERE t.job_id=probe_jobs.id AND t.state='failed') THEN 'failed' ELSE 'done' END WHERE state!='stopped'"
        if job_ids is None:
            c.execute(sql)
        elif job_ids:
            ids = list(dict.fromkeys(job_ids))
            c.execute(sql + ' AND id IN (' + ','.join('?' for _ in ids) + ')', ids)

    def claim(self,node_id,capabilities=None):
        with self._db() as c:
            node=c.execute('SELECT * FROM probe_nodes WHERE id=?',(node_id,)).fetchone()
            if node is None: raise KeyError(node_id)
            self._expire(c)
            try:
                raw_features = json.loads(node['protocol_features'])
                protocol_features = set(raw_features) if isinstance(raw_features, list) and all(isinstance(feature, str) for feature in raw_features) else set()
            except (TypeError, ValueError):
                protocol_features = set()
            caps=set(capabilities or json.loads(node['capabilities'])) & set(json.loads(node['capabilities']))
            active=c.execute("SELECT * FROM probe_tasks WHERE state IN ('running','cancelling')").fetchall()
            local=[t for t in active if t['node_id']==node_id]
            for t in c.execute("SELECT t.*,j.options,j.mode,j.primary_managed,j.execution_policy FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.node_id=? AND t.state='pending' AND j.state='running' ORDER BY t.created_at,t.rowid",(node_id,)):
                try:
                    task_policy = json.loads(t['execution_policy'])
                    is_backup_owner = node_id in task_policy.get('backupNodeIds', [])
                except (TypeError, ValueError, AttributeError):
                    is_backup_owner = False
                if ((t['generation'] > 0 or (t['primary_managed'] and is_backup_owner))
                        and GENERATION_PROTOCOL_FEATURE not in protocol_features):
                    continue
                if t['failover_waiting'] or t['error'] == 'waiting for an online backup':
                    continue
                if t['stage'] not in caps: continue
                opts=json.loads(t['options'])
                if len(local)>=min(16,int(opts.get('concurrency',6))): continue
                if any(x['stage']=='speed' for x in local): continue
                if t['stage']=='speed' and local: continue
                # Local listener ports are exclusive; tunnel conflicts span all nodes,
                # including different frps control ports on the same host.
                if t['stage'] in {'connectivity','speed'}:
                    if any(x['ip']==t['ip'] and x['stage'] in {'connectivity','speed'} for x in active): continue
                if t['stage'] in {'connectivity','speed'}:
                    used_ports=set()
                    for x in local:
                        state=json.loads(x['progress'])
                        if '_localBasePort' in state:
                            used_ports.update(range(state['_localBasePort'],state['_localBasePort']+3))
                    base=int(opts.get('local_base_port',11561))
                    available=[i for i in range(16) if base+i*3+2<=65535 and not set(range(base+i*3,base+i*3+3)) & used_ports]
                    if not available:continue
                    slot=available[0]
                    opts['local_base_port']=base+slot*3
                    internal_progress=_json({'_slot':slot,'_localBasePort':opts['local_base_port']})
                else:
                    internal_progress='{}'
                attempt=_id()
                c.execute("UPDATE probe_tasks SET state='running',attempt_id=?,attempts=attempts+1,lease_until=?,seq=0,progress=? WHERE id=?",(attempt,time.time()+LEASE_SECONDS,internal_progress,t['id']))
                return {'taskId':t['id'],'attemptId':attempt,'generation':t['generation'],'jobId':t['job_id'],'nodeId':node_id,'stage':t['stage'],'ip':t['ip'],'port':t['port'],'options':opts,'payload':json.loads(t['payload']),'leaseSeconds':LEASE_SECONDS}
        return None

    def heartbeat(self,node_id,version,capabilities,attempts,protocol_features=None):
        with self._db() as c:
            row=c.execute('SELECT kind FROM probe_nodes WHERE id=?',(node_id,)).fetchone()
            if row is None: raise KeyError(node_id)
            caps=[k for k in capabilities if k in CAPABILITIES]
            if row['kind']=='legacy' and set(CAPABILITIES).issubset(caps):
                c.execute("UPDATE probe_nodes SET kind='worker' WHERE id=?",(node_id,))
            elif row['kind']=='legacy': caps=['route']
            features = [feature for feature in (protocol_features or []) if isinstance(feature, str)]
            features = list(dict.fromkeys(features))
            c.execute('UPDATE probe_nodes SET version=?,capabilities=?,protocol_features=?,last_seen=? WHERE id=?',(str(version)[:100],_json(caps),_json(features),time.time(),node_id))
            self._expire(c)
            cancelled=[]
            for a in attempts:
                task=c.execute('SELECT * FROM probe_tasks WHERE id=? AND node_id=?',(a['taskId'],node_id)).fetchone()
                generation = a.get('generation')
                generation_ok = task and (generation == task['generation'] or (task['generation'] == 0 and generation is None))
                if generation_ok and task['state']=='running' and task['attempt_id']==a['attemptId']:
                    c.execute('UPDATE probe_tasks SET lease_until=? WHERE id=?',(time.time()+LEASE_SECONDS,task['id']))
                else: cancelled.append(a)
            return {'ok':True,'leaseSeconds':LEASE_SECONDS,'cancelled':cancelled}

    def _valid(self,c,node,task,attempt,generation=None):
        self._expire(c)
        t=c.execute('SELECT t.*,j.mode,j.options FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.id=? AND t.node_id=?',(task,node)).fetchone()
        generation_ok = t and (generation == t['generation'] or (t['generation'] == 0 and generation is None))
        return t if generation_ok and t['state']=='running' and t['attempt_id']==attempt else None

    def progress(self,node_id,task_id,attempt_id,seq,*,generation=None,hits=(),progress=None):
        if len(hits)>4096: raise ValueError('hits batch exceeds 4096')
        with self._db() as c:
            t=self._valid(c,node_id,task_id,attempt_id,generation)
            if not t: return {'ok':True,'accepted':False,'cancel':True}
            if seq<=t['seq']: return {'ok':True,'accepted':True,'seq':t['seq']}
            if seq!=t['seq']+1: return {'ok':False,'accepted':False,'seq':t['seq']}
            if t['stage']!='discover' and hits: raise ValueError('hits only valid for discovery')
            payload=json.loads(t['payload']); opts=json.loads(t['options'])
            for hit in hits:
                ip=str(ipaddress.IPv4Address(hit['ip'])); n=int(ipaddress.IPv4Address(ip))
                if int(hit.get('port',t['port']))!=t['port'] or not any(a<=n<=b for a,b in payload['chunk']):
                    raise ValueError('hit outside claimed chunk')
                stamp=now_iso();latency=float(hit.get('latencyMs',hit.get('latency_ms',0)))
                c.execute("INSERT INTO probe_discover_results(ip,ip_sort,port,latency_ms,label,discovered_at) VALUES(?,?,?,?,',未路由测试,',?) ON CONFLICT(ip,port) DO UPDATE SET latency_ms=excluded.latency_ms,discovered_at=excluded.discovered_at",(ip,n,t['port'],latency,stamp))
                c.execute('INSERT INTO probe_discover_observations VALUES(?,?,?,?,?) ON CONFLICT(node_id,ip,port) DO UPDATE SET latency_ms=excluded.latency_ms,discovered_at=excluded.discovered_at',(node_id,ip,t['port'],latency,stamp))
                if opts.get('autoFull') or opts.get('autoRoute'):
                    exists=c.execute("SELECT 1 FROM probe_tasks WHERE job_id=? AND node_id=? AND ip=? AND port=? AND stage='route'",(t['job_id'],node_id,ip,t['port'])).fetchone()
                    if not exists:self._task(c,t['job_id'],node_id,'route',ip,t['port'],{'full':bool(opts.get('autoFull'))},generation=t['generation'])
            state=dict(progress or {});previous=json.loads(t['progress'])
            for key in ('_slot','_localBasePort'):
                if key in previous:state[key]=previous[key]
            c.execute('UPDATE probe_tasks SET seq=?,progress=? WHERE id=?',(seq,_json(state),task_id))
            return {'ok':True,'accepted':True,'seq':seq}

    def _result(self,c,task,job,node,kind,ip,port,result,stamp=None,attempt_id="",generation=0):
        stamp=stamp or now_iso()
        c.execute('INSERT OR IGNORE INTO probe_results(task_id,attempt_id,job_id,node_id,kind,server_ip,port,test_time,data,generation) VALUES(?,?,?,?,?,?,?,?,?,?)',(task,attempt_id,job,node,kind,ip,port,stamp,_json(result),generation))

    def report(self,node_id,task_id,attempt_id,*,generation=None,result=None,infra_error=None):
        with self._db() as c:
            self._expire(c)
            cancelling=c.execute("SELECT * FROM probe_tasks WHERE id=? AND node_id=? AND attempt_id=? AND state='cancelling'",(task_id,node_id,attempt_id)).fetchone()
            if cancelling and not (generation == cancelling['generation'] or (cancelling['generation'] == 0 and generation is None)):
                cancelling = None
            if cancelling:
                c.execute('UPDATE probe_tasks SET state=?,lease_until=0 WHERE id=?',(cancelling['error'] if cancelling['error'] in {'stopped','skipped'} else 'stopped',task_id))
                self._refresh(c)
                return {'ok':True,'applied':True,'accepted':True}
            t=self._valid(c,node_id,task_id,attempt_id,generation)
            if not t:
                existing=c.execute('SELECT state,attempt_id,generation FROM probe_tasks WHERE id=? AND node_id=?',(task_id,node_id)).fetchone()
                generation_ok = existing and (generation == existing['generation'] or (existing['generation'] == 0 and generation is None))
                return {'ok':True,'applied':False,'accepted':bool(generation_ok and existing['state'] in TERMINAL and existing['attempt_id']==attempt_id)}
            if infra_error:
                c.execute('UPDATE probe_tasks SET state=?,lease_until=0,error=? WHERE id=?',('pending' if t['attempts']<3 else 'failed',str(infra_error)[:1000],task_id))
            else:
                result=dict(result or {});stage=t['stage'];payload=json.loads(t['payload'])
                if stage!='discover':
                    result.update(server_ip=t['ip'],port=t['port'])
                    self._result(c,task_id,t['job_id'],node_id,stage,t['ip'],t['port'],result,attempt_id=attempt_id,generation=t['generation'])
                passed=(bool(result.get('ok')) if stage=='route' else all(result.get(k) for k in ('frps_reachable','tunnel_established','firewall_open')) if stage=='connectivity' else bool(result.get('dl_ok') and result.get('ul_ok')) if stage=='speed' else True)
                c.execute("UPDATE probe_tasks SET state=?,lease_until=0,error='' WHERE id=?",('done' if passed else 'failed',task_id))
                full=t['mode']=='full' or payload.get('full')
                if stage=='discover':
                    self._scan_chunk(c,t['job_id'],node_id,t['port'],{'intervals':payload['intervals'],'cursor':payload['cursor']+payload['size']},generation=t['generation'])
                elif full and stage=='route':
                    self._task(c,t['job_id'],node_id,'connectivity',t['ip'],t['port'],{'full':True},generation=t['generation'])
                elif full and stage=='connectivity':
                    passed=all(result.get(k) for k in ('frps_reachable','tunnel_established','firewall_open'))
                    self._task(c,t['job_id'],node_id,'speed',t['ip'],t['port'],{},'pending' if passed else 'skipped',generation=t['generation'])
            self._refresh(c)
            return {'ok':True,'applied':True,'accepted':True}

    def action(self,job_id,action,task_ids=None):
        if action not in {'stop','skip','retry'}:raise ValueError('unknown action')
        with self._db() as c:
            if not c.execute('SELECT 1 FROM probe_jobs WHERE id=?',(job_id,)).fetchone():raise KeyError(job_id)
            rows=c.execute('SELECT * FROM probe_tasks WHERE job_id=?',(job_id,)); changed=0
            for t in rows:
                if task_ids is not None and t['id'] not in task_ids:continue
                if action in {'stop','skip'} and t['state'] in {'pending','running'}:
                    c.execute('UPDATE probe_tasks SET state=?,error=? WHERE id=?',('cancelling' if t['state']=='running' else ('stopped' if action=='stop' else 'skipped'),'stopped' if action=='stop' else 'skipped',t['id']));changed+=1
                elif action=='retry' and t['state'] in {'failed','stopped','skipped'}:
                    job=c.execute('SELECT mode FROM probe_jobs WHERE id=?',(job_id,)).fetchone()
                    if t['stage']=='speed' and (job['mode']=='full' or t['error']=='dependency'):
                        gate=c.execute("SELECT state FROM probe_tasks WHERE job_id=? AND node_id=? AND ip=? AND port=? AND stage='connectivity'",(job_id,t['node_id'],t['ip'],t['port'])).fetchone()
                        if not gate or gate['state']!='done':continue
                    c.execute("UPDATE probe_tasks SET state='pending',attempt_id=NULL,attempts=0,lease_until=0,error='',failover_waiting=0,seq=0 WHERE id=?",(t['id'],));changed+=1
            if action=='stop' and task_ids is None:c.execute("UPDATE probe_jobs SET state='stopped' WHERE id=?",(job_id,))
            if action=='retry':c.execute("UPDATE probe_jobs SET state='running' WHERE id=?",(job_id,))
            self._refresh(c)
            return {'ok':True,'changed':changed}

    def _job(self,c,row,detail=False,page=1,page_size=200,*,node_id=None,stage=None,state=None,target=None):
        d=dict(row);d.pop('execution_policy',None);d['options']=json.loads(d['options']);d['createdAt']=d.pop('created_at')
        d['counts']={r['state']:r['n'] for r in c.execute('SELECT state,COUNT(*) n FROM probe_tasks WHERE job_id=? GROUP BY state',(d['id'],))}
        d['nodeIds']=[r[0] for r in c.execute('SELECT DISTINCT node_id FROM probe_tasks WHERE job_id=?',(d['id'],))]
        d['stageCounts']=[{'nodeId':r['node_id'],'stage':r['stage'],'state':r['state'],'count':r['n']}
                          for r in c.execute('SELECT node_id,stage,state,COUNT(*) n FROM probe_tasks WHERE job_id=? GROUP BY node_id,stage,state ORDER BY node_id,stage,state',(d['id'],))]
        d['taskTotal']=sum(d['counts'].values())
        aggregate=c.execute("SELECT COALESCE(SUM(json_extract(progress,'$.scanned')),0),COALESCE(SUM(json_extract(progress,'$.foundCount')),0) FROM probe_tasks WHERE job_id=? AND stage='discover'",(d['id'],)).fetchone()
        d['progress']={'scanned':aggregate[0],'foundCount':aggregate[1]}
        if detail:
            d['failoverWaitingCount']=c.execute(
                "SELECT COUNT(*) FROM probe_tasks WHERE job_id=? AND state='pending' AND (failover_waiting=1 OR error='waiting for an online backup')",
                (d['id'],),
            ).fetchone()[0]
            d['page']=page;d['pageSize']=page_size
            filters=['job_id=?']; args=[d['id']]
            for column,value in (('node_id',node_id),('stage',stage),('state',state)):
                if value:
                    filters.append(column+'=?'); args.append(value)
            if target:
                filters.append('ip LIKE ?'); args.append('%'+target.strip()+'%')
            where=' AND '.join(filters)
            d['filteredTaskTotal']=c.execute('SELECT COUNT(*) FROM probe_tasks WHERE '+where,args).fetchone()[0]
            tasks=[]
            for r in c.execute('SELECT * FROM probe_tasks WHERE '+where+' ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',(*args,page_size,(page-1)*page_size)):
                task=dict(r)
                for a,b in [('id','taskId'),('job_id','jobId'),('node_id','nodeId'),('attempt_id','attemptId'),('lease_until','leaseUntil'),('created_at','createdAt')]:task[b]=task.pop(a)
                task['payload']=json.loads(task['payload']);task['progress']=json.loads(task['progress'])
                result=c.execute('SELECT data,test_time FROM probe_results WHERE task_id=? ORDER BY id DESC LIMIT 1',(task['taskId'],)).fetchone()
                task['result']={**json.loads(result['data']),'test_time':result['test_time'],'node_id':task['nodeId']} if result else None
                tasks.append(task)
            d['tasks']=tasks
        return d

    def list_jobs(self,limit=100):
        with self._db() as c:
            self._expire(c)
            return [self._job(c,r) for r in c.execute('SELECT * FROM probe_jobs ORDER BY created_at DESC LIMIT ?',(min(1000,max(1,limit)),))]

    def query_jobs(self,page=1,page_size=20,*,mode=None,state=None,node_id=None,target=None,from_time=None,to_time=None):
        with self._db() as c:
            self._expire(c)
            filters=['1=1']; args=[]
            for column,value in (('mode',mode),('state',state)):
                if value:filters.append('j.'+column+'=?');args.append(value)
            if from_time:filters.append('j.created_at>=?');args.append(from_time)
            if to_time:filters.append('j.created_at<=?');args.append(to_time)
            if node_id or target:
                sub=['t.job_id=j.id'];subargs=[]
                if node_id:sub.append('t.node_id=?');subargs.append(node_id)
                if target:sub.append('t.ip LIKE ?');subargs.append('%'+target.strip()+'%')
                filters.append('EXISTS(SELECT 1 FROM probe_tasks t WHERE '+' AND '.join(sub)+')');args.extend(subargs)
            where=' AND '.join(filters)
            total=c.execute('SELECT COUNT(*) FROM probe_jobs j WHERE '+where,args).fetchone()[0]
            rows=c.execute('SELECT j.* FROM probe_jobs j WHERE '+where+' ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?',(*args,page_size,(page-1)*page_size)).fetchall()
            return {'items':[self._job(c,r) for r in rows],'page':page,'pageSize':page_size,'total':total}

    def get_job(self,job_id,page=1,page_size=200,*,node_id=None,stage=None,state=None,target=None):
        with self._db() as c:
            self._expire(c)
            row=c.execute('SELECT * FROM probe_jobs WHERE id=?',(job_id,)).fetchone()
            if row is None:raise KeyError(job_id)
            return self._job(c,row,True,max(1,page),min(500,max(1,page_size)),node_id=node_id,stage=stage,state=state,target=target)

    def history(self,node_id,kind,ip=None,limit=200):
        with self._db() as c:
            rows=c.execute('SELECT * FROM probe_results WHERE node_id=? AND kind=?'+(' AND server_ip=?' if ip else '')+' ORDER BY id DESC LIMIT ?', (node_id,kind,*([ip] if ip else []),min(1000,max(1,limit))))
            return [self._flatten(r) for r in rows]

    def history_page(self,node_id,kind,page=1,page_size=50,*,ip=None,port=None,job_id=None,from_time=None,to_time=None):
        with self._db() as c:
            filters=['node_id=?','kind=?'];args=[node_id,kind]
            for column,value in (('server_ip',ip),('port',port),('job_id',job_id)):
                if value is not None:filters.append(column+'=?');args.append(value)
            if from_time:filters.append('test_time>=?');args.append(from_time)
            if to_time:filters.append('test_time<=?');args.append(to_time)
            where=' AND '.join(filters)
            total=c.execute('SELECT COUNT(*) FROM probe_results WHERE '+where,args).fetchone()[0]
            rows=c.execute('SELECT * FROM probe_results WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?',(*args,page_size,(page-1)*page_size)).fetchall()
            return {'items':[self._flatten(r) for r in rows],'page':page,'pageSize':page_size,'total':total}

    @staticmethod
    def _flatten(row):
        d={**json.loads(row['data']),**{k:row[k] for k in ('id','task_id','job_id','node_id','kind','server_ip','port','test_time','generation')}}
        d.setdefault('detail','')
        if row['kind']=='connectivity':
            for field in ('frps_reachable','tunnel_established','firewall_open'):d.setdefault(field,False)
        if row['kind']=='speed':
            for field in ('frps_reachable','tunnel_ok','dl_ok','ul_ok'):d.setdefault(field,False)
            for field in ('dl_bytes','ul_bytes','dl_sec','ul_sec','dl_speed_bps','ul_speed_bps'):d.setdefault(field,0)
            for p in ('dl','ul'):
                d[p+'_speed_mbps']=d.get(p+'_speed_bps',0)*8/(1024*1024)
                d[p+'_speed_mbs']=d.get(p+'_speed_bps',0)/(1024*1024)
        return d

    def latest_results(self,node_id,kind,max_age_seconds=None,ips=None):
        wanted = None if ips is None else tuple(dict.fromkeys(ips))
        if wanted == ():
            return []
        with self._db() as c:
            address_filter = ' AND r.server_ip IN (' + ','.join('?' for _ in wanted) + ')' if wanted is not None else ''
            rows=c.execute('SELECT r.* FROM probe_results r WHERE node_id=? AND kind=?' + address_filter + ' AND id=(SELECT MAX(x.id) FROM probe_results x WHERE x.node_id=r.node_id AND x.kind=r.kind AND x.server_ip=r.server_ip AND x.port=r.port)',(node_id,kind,*(wanted or ()))).fetchall()
            cutoff=time.time()-max_age_seconds if max_age_seconds is not None else None
            return [self._flatten(r) for r in rows if cutoff is None or datetime.fromisoformat(r['test_time'].replace('Z','+00:00')).timestamp()>=cutoff]


    def clear_history(self,node_id,kind):
        with self._db() as c:
            # Canonical rows and legacy console history are one logical history.
            canonical=c.execute("SELECT COUNT(*) FROM probe_results WHERE node_id=? AND kind=? AND task_id NOT LIKE 'legacy-%'",(node_id,kind)).fetchone()[0]
            c.execute('DELETE FROM probe_results WHERE node_id=? AND kind=?',(node_id,kind))
            legacy=0
            if node_id=='console' and kind in {'connectivity','speed'}:
                table='probe_connectivity_results' if kind=='connectivity' else 'probe_speed_results'
                legacy=c.execute('DELETE FROM '+table).rowcount
            return canonical+legacy


    def active_tasks(self,job_id=None,stage=None):
        with self._db() as c:
            self._expire(c)
            where="state IN ('running','cancelling')";params=[]
            if job_id is not None:where+=' AND job_id=?';params.append(job_id)
            if stage is not None:where+=' AND stage=?';params.append(stage)
            return [dict(r) for r in c.execute('SELECT * FROM probe_tasks WHERE '+where,params)]

    def stage_status(self,stage):
        with self._db() as c:
            self._expire(c)
            counts={r['state']:r['n'] for r in c.execute('SELECT state,COUNT(*) n FROM probe_tasks WHERE stage=? GROUP BY state',(stage,))}
            running=[{'taskId':r['id'],'ip':r['ip'],'node':r['node_id']} for r in c.execute("SELECT * FROM probe_tasks WHERE stage=? AND state IN ('running','cancelling')",(stage,))]
            return {**{k:counts.get(k,0) for k in ('pending','running','done','failed')},'active':bool(counts.get('pending',0)+counts.get('running',0)+counts.get('cancelling',0)),'runningTasks':running}

    def stop_stage(self,stage):
        with self._db() as c:
            pending=c.execute("UPDATE probe_tasks SET state='skipped',error='skipped' WHERE stage=? AND state='pending'",(stage,)).rowcount
            running=c.execute("UPDATE probe_tasks SET state='cancelling',error='skipped' WHERE stage=? AND state='running'",(stage,)).rowcount
            self._refresh(c)
            return pending+running
