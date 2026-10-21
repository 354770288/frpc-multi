"""Durable scheduler shared by the console, full workers and route adapters.

Every mutation takes a short BEGIN IMMEDIATE transaction. A task's attempt UUID is
its fencing token; target failures are results, only infrastructure failures retry.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import secrets
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..control.database import connect_database, initialize_database
from ..models import now_iso
from .discover import DiscoverParams, DiscoverRunner, parse_targets
from .store import validate_probe_addr, split_probe_endpoint as split_endpoint

LEASE_SECONDS = 120
CAPABILITIES = ['discover', 'route', 'connectivity', 'speed']
TERMINAL = {'done', 'failed', 'skipped', 'stopped'}


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

    def _task(self, c, job_id, node_id, stage, ip, port, payload=None, state='pending'):
        task_id = _id()
        c.execute('INSERT OR IGNORE INTO probe_tasks(id,job_id,node_id,stage,ip,port,payload,state,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', (task_id,job_id,node_id,stage,ip,port,_json(payload or {}),state,'dependency' if state=='skipped' else '',now_iso()))
        if state=='pending' and stage!='discover':
            c.execute("UPDATE probe_tasks SET state='pending',error='' WHERE job_id=? AND node_id=? AND stage=? AND ip=? AND port=? AND state='skipped' AND error='dependency'",(job_id,node_id,stage,ip,port))
        return task_id

    def create_job(self, mode, node_ids, *, ips=None, targets=None, exclude=None, port=7000, options=None, auto_route=False, auto_full=False, concurrency=6, timeout=1.5):
        if mode not in {*CAPABILITIES,'full'}:
            raise ValueError('mode 必须是 discover/route/connectivity/speed/full')
        if not 1<=int(port)<=65535 or not node_ids:
            raise ValueError('需要节点及有效端口')
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
            if not 1<=int(concurrency)<=16:
                raise ValueError('并发须为1-16')
        job_id = _id()
        with self._db() as c:
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
            c.execute('INSERT INTO probe_jobs(id,mode,options,created_at) VALUES(?,?,?,?)',(job_id,mode,_json(opts),now_iso()))
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

    def _scan_chunk(self,c,job,node,port,payload):
        intervals=payload['intervals']; cursor=payload['cursor']; skip=cursor; parts=[]; remaining=4096
        for start,end in intervals:
            size=end-start+1
            if skip>=size:
                skip-=size; continue
            start+=skip; skip=0; take=min(remaining,end-start+1)
            parts.append([start,start+take-1]); remaining-=take
            if not remaining: break
        if parts:
            self._task(c,job,node,'discover','',port,{'intervals':intervals,'cursor':cursor,'chunk':parts,'size':4096-remaining})

    def _expire(self,c):
        for t in c.execute("SELECT * FROM probe_tasks WHERE state IN ('running','cancelling') AND lease_until<=?",(time.time(),)).fetchall():
            c.execute("UPDATE probe_tasks SET state=?,lease_until=0,error='lease expired' WHERE id=?",((t['error'] if t['error'] in {'stopped','skipped'} else 'stopped') if t['state']=='cancelling' else ('pending' if t['attempts']<3 else 'failed'),t['id']))
        self._refresh(c)

    def _refresh(self,c):
        c.execute("UPDATE probe_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM probe_tasks t WHERE t.job_id=probe_jobs.id AND t.state IN ('pending','running','cancelling')) THEN 'running' WHEN EXISTS(SELECT 1 FROM probe_tasks t WHERE t.job_id=probe_jobs.id AND t.state='failed') THEN 'failed' ELSE 'done' END WHERE state!='stopped'")

    def claim(self,node_id,capabilities=None):
        with self._db() as c:
            self._expire(c)
            node=c.execute('SELECT * FROM probe_nodes WHERE id=?',(node_id,)).fetchone()
            if node is None: raise KeyError(node_id)
            caps=set(capabilities or json.loads(node['capabilities'])) & set(json.loads(node['capabilities']))
            active=c.execute("SELECT * FROM probe_tasks WHERE state IN ('running','cancelling')").fetchall()
            local=[t for t in active if t['node_id']==node_id]
            for t in c.execute("SELECT t.*,j.options,j.mode FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.node_id=? AND t.state='pending' AND j.state='running' ORDER BY t.created_at,t.rowid",(node_id,)):
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
                return {'taskId':t['id'],'attemptId':attempt,'jobId':t['job_id'],'nodeId':node_id,'stage':t['stage'],'ip':t['ip'],'port':t['port'],'options':opts,'payload':json.loads(t['payload']),'leaseSeconds':LEASE_SECONDS}
        return None

    def heartbeat(self,node_id,version,capabilities,attempts):
        with self._db() as c:
            self._expire(c)
            row=c.execute('SELECT kind FROM probe_nodes WHERE id=?',(node_id,)).fetchone()
            if row is None: raise KeyError(node_id)
            caps=[k for k in capabilities if k in CAPABILITIES]
            if row['kind']=='legacy' and set(CAPABILITIES).issubset(caps):
                c.execute("UPDATE probe_nodes SET kind='worker' WHERE id=?",(node_id,))
            elif row['kind']=='legacy': caps=['route']
            c.execute('UPDATE probe_nodes SET version=?,capabilities=?,last_seen=? WHERE id=?',(str(version)[:100],_json(caps),time.time(),node_id))
            cancelled=[]
            for a in attempts:
                task=c.execute('SELECT * FROM probe_tasks WHERE id=? AND node_id=?',(a['taskId'],node_id)).fetchone()
                if task and task['state']=='running' and task['attempt_id']==a['attemptId']:
                    c.execute('UPDATE probe_tasks SET lease_until=? WHERE id=?',(time.time()+LEASE_SECONDS,task['id']))
                else: cancelled.append(a)
            return {'ok':True,'leaseSeconds':LEASE_SECONDS,'cancelled':cancelled}

    def _valid(self,c,node,task,attempt):
        self._expire(c)
        t=c.execute('SELECT t.*,j.mode,j.options FROM probe_tasks t JOIN probe_jobs j ON j.id=t.job_id WHERE t.id=? AND t.node_id=?',(task,node)).fetchone()
        return t if t and t['state']=='running' and t['attempt_id']==attempt else None

    def progress(self,node_id,task_id,attempt_id,seq,*,hits=(),progress=None):
        if len(hits)>4096: raise ValueError('hits batch exceeds 4096')
        with self._db() as c:
            t=self._valid(c,node_id,task_id,attempt_id)
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
                    if not exists:self._task(c,t['job_id'],node_id,'route',ip,t['port'],{'full':bool(opts.get('autoFull'))})
            state=dict(progress or {});previous=json.loads(t['progress'])
            for key in ('_slot','_localBasePort'):
                if key in previous:state[key]=previous[key]
            c.execute('UPDATE probe_tasks SET seq=?,progress=? WHERE id=?',(seq,_json(state),task_id))
            return {'ok':True,'accepted':True,'seq':seq}

    def _result(self,c,task,job,node,kind,ip,port,result,stamp=None,attempt_id=""):
        stamp=stamp or now_iso()
        c.execute('INSERT OR IGNORE INTO probe_results(task_id,attempt_id,job_id,node_id,kind,server_ip,port,test_time,data) VALUES(?,?,?,?,?,?,?,?,?)',(task,attempt_id,job,node,kind,ip,port,stamp,_json(result)))

    def report(self,node_id,task_id,attempt_id,*,result=None,infra_error=None):
        with self._db() as c:
            self._expire(c)
            cancelling=c.execute("SELECT * FROM probe_tasks WHERE id=? AND node_id=? AND attempt_id=? AND state='cancelling'",(task_id,node_id,attempt_id)).fetchone()
            if cancelling:
                c.execute('UPDATE probe_tasks SET state=?,lease_until=0 WHERE id=?',(cancelling['error'] if cancelling['error'] in {'stopped','skipped'} else 'stopped',task_id))
                self._refresh(c)
                return {'ok':True,'applied':True,'accepted':True}
            t=self._valid(c,node_id,task_id,attempt_id)
            if not t:
                existing=c.execute('SELECT state,attempt_id FROM probe_tasks WHERE id=? AND node_id=?',(task_id,node_id)).fetchone()
                return {'ok':True,'applied':False,'accepted':bool(existing and existing['state'] in TERMINAL and existing['attempt_id']==attempt_id)}
            if infra_error:
                c.execute('UPDATE probe_tasks SET state=?,lease_until=0,error=? WHERE id=?',('pending' if t['attempts']<3 else 'failed',str(infra_error)[:1000],task_id))
            else:
                result=dict(result or {});stage=t['stage'];payload=json.loads(t['payload'])
                if stage!='discover':
                    result.update(server_ip=t['ip'],port=t['port'])
                    self._result(c,task_id,t['job_id'],node_id,stage,t['ip'],t['port'],result,attempt_id=attempt_id)
                passed=(bool(result.get('ok')) if stage=='route' else all(result.get(k) for k in ('frps_reachable','tunnel_established','firewall_open')) if stage=='connectivity' else bool(result.get('dl_ok') and result.get('ul_ok')) if stage=='speed' else True)
                c.execute("UPDATE probe_tasks SET state=?,lease_until=0,error='' WHERE id=?",('done' if passed else 'failed',task_id))
                full=t['mode']=='full' or payload.get('full')
                if stage=='discover':
                    self._scan_chunk(c,t['job_id'],node_id,t['port'],{'intervals':payload['intervals'],'cursor':payload['cursor']+payload['size']})
                elif full and stage=='route':
                    self._task(c,t['job_id'],node_id,'connectivity',t['ip'],t['port'],{'full':True})
                elif full and stage=='connectivity':
                    passed=all(result.get(k) for k in ('frps_reachable','tunnel_established','firewall_open'))
                    self._task(c,t['job_id'],node_id,'speed',t['ip'],t['port'],{},'pending' if passed else 'skipped')
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
                    c.execute("UPDATE probe_tasks SET state='pending',attempt_id=NULL,attempts=0,lease_until=0,error='',seq=0 WHERE id=?",(t['id'],));changed+=1
            if action=='stop' and task_ids is None:c.execute("UPDATE probe_jobs SET state='stopped' WHERE id=?",(job_id,))
            if action=='retry':c.execute("UPDATE probe_jobs SET state='running' WHERE id=?",(job_id,))
            self._refresh(c)
            return {'ok':True,'changed':changed}

    def _job(self,c,row,detail=False,page=1,page_size=200):
        d=dict(row);d['options']=json.loads(d['options']);d['createdAt']=d.pop('created_at')
        d['counts']={r['state']:r['n'] for r in c.execute('SELECT state,COUNT(*) n FROM probe_tasks WHERE job_id=? GROUP BY state',(d['id'],))}
        d['nodeIds']=[r[0] for r in c.execute('SELECT DISTINCT node_id FROM probe_tasks WHERE job_id=?',(d['id'],))]
        d['stageCounts']=[{'nodeId':r['node_id'],'stage':r['stage'],'state':r['state'],'count':r['n']}
                          for r in c.execute('SELECT node_id,stage,state,COUNT(*) n FROM probe_tasks WHERE job_id=? GROUP BY node_id,stage,state ORDER BY node_id,stage,state',(d['id'],))]
        d['taskTotal']=sum(d['counts'].values())
        aggregate=c.execute("SELECT COALESCE(SUM(json_extract(progress,'$.scanned')),0),COALESCE(SUM(json_extract(progress,'$.foundCount')),0) FROM probe_tasks WHERE job_id=? AND stage='discover'",(d['id'],)).fetchone()
        d['progress']={'scanned':aggregate[0],'foundCount':aggregate[1]}
        if detail:
            d['page']=page;d['pageSize']=page_size
            tasks=[]
            for r in c.execute('SELECT * FROM probe_tasks WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',(d['id'],page_size,(page-1)*page_size)):
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

    def get_job(self,job_id,page=1,page_size=200):
        with self._db() as c:
            self._expire(c)
            row=c.execute('SELECT * FROM probe_jobs WHERE id=?',(job_id,)).fetchone()
            if row is None:raise KeyError(job_id)
            return self._job(c,row,True,max(1,page),min(500,max(1,page_size)))

    def history(self,node_id,kind,ip=None,limit=200):
        with self._db() as c:
            rows=c.execute('SELECT * FROM probe_results WHERE node_id=? AND kind=?'+(' AND server_ip=?' if ip else '')+' ORDER BY id DESC LIMIT ?', (node_id,kind,*([ip] if ip else []),min(1000,max(1,limit))))
            return [self._flatten(r) for r in rows]

    @staticmethod
    def _flatten(row):
        d={**json.loads(row['data']),**{k:row[k] for k in ('id','task_id','job_id','node_id','kind','server_ip','port','test_time')}}
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
        with self._db() as c:
            rows=c.execute('SELECT r.* FROM probe_results r WHERE node_id=? AND kind=? AND id=(SELECT MAX(x.id) FROM probe_results x WHERE x.node_id=r.node_id AND x.kind=r.kind AND x.server_ip=r.server_ip AND x.port=r.port)',(node_id,kind)).fetchall()
            if ips is not None:
                wanted=set(ips);rows=[r for r in rows if r['server_ip'] in wanted]
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
