"""Legacy HTTP shapes backed by the single persistent job owner."""
from dataclasses import asdict

from .constants import PROBE_TEST_PORT
from .discover import DiscoverState
from .runner import _idle_state


def serial_options(options):
    return {k:v for k,v in asdict(options).items() if k not in {'work_dir','extra'}}


class LegacyProbeAdapter:
    def __init__(self, store_factory):self.factory=store_factory;self.job_id=None
    def start(self,mode,ips,options,requested_node_ids=None):
        store=self.factory()
        store.validate_primary_assignment(requested_node_ids)
        if self.status()['running']:return False,'已有测试任务在运行'
        job=store.create_primary_job(mode,requested_node_ids,ips=ips,port=PROBE_TEST_PORT,options=serial_options(options),concurrency=options.conn_concurrency)
        self.job_id=job['id'];return True,''
    def status(self):
        if not self.job_id:return _idle_state()
        try:job=self.factory().get_job(self.job_id)
        except KeyError:return _idle_state()
        tasks=job['tasks'];done=[t for t in tasks if t['state'] in {'done','failed','skipped','stopped'}]
        return {**_idle_state(),'jobId':job['id'],'running':job['state']=='running','mode':job['mode'],'phase':next((t['stage'] for t in tasks if t['state']=='running'),''),'workers':[{'ip':t['ip'],'step':t['stage'],'text':t['error']} for t in self.factory().active_tasks(self.job_id)],'done':sum(n for state,n in job['counts'].items() if state in {'done','failed','skipped','stopped'}),'total':job['taskTotal'],'startedAt':job['createdAt'],'stopped':job['state']=='stopped','recent':[{'ip':t['ip'],'mode':t['stage'],'result':t['result'],'ok':bool(t['result'] and (t['result'].get('firewall_open') if t['stage']=='connectivity' else t['result'].get('dl_ok') or t['result'].get('ul_ok')))} for t in done[-30:]]}
    def stop(self):
        if not self.status()['running']:return False
        self.factory().action(self.job_id,'stop');return True
    def skip_current(self):
        if not self.status()['running']:return False
        self.factory().action(self.job_id,'skip',[t['id'] for t in self.factory().active_tasks(self.job_id)]);return True


class LegacyDiscoverAdapter:
    def __init__(self,store_factory,options_factory):self.factory=store_factory;self.options=options_factory;self.job_id=None
    def start(self,params,*,auto_route=False,auto_full=False,requested_node_ids=None):
        store=self.factory()
        store.validate_primary_assignment(requested_node_ids)
        if self.status()['running']:raise RuntimeError('已有扫描在进行中')
        job=store.create_primary_job('discover',requested_node_ids,targets=params.targets,exclude=params.exclude,port=PROBE_TEST_PORT,auto_route=auto_route,auto_full=auto_full,concurrency=params.concurrency,timeout=params.timeout,options=serial_options(self.options()))
        self.job_id=job['id'];return DiscoverState(params)
    def status(self):
        if not self.job_id:return {'running':False,'params':None,'total':0,'scanned':0,'foundCount':0,'recentHits':[],'startedAt':None,'finishedAt':None,'error':''}
        job=self.factory().get_job(self.job_id);scans=[t for t in job['tasks'] if t['stage']=='discover']
        return {'running':job['state']=='running' and job['progress']['scanned']<job['options'].get('total',0),'jobId':job['id'],'params':job['options'],'total':job['options'].get('total',0),'scanned':job['progress']['scanned'],'foundCount':job['progress']['foundCount'],'recentHits':[h for t in scans for h in t['progress'].get('recentHits',[])][-100:],'startedAt':job['createdAt'],'finishedAt':None,'error':'; '.join(t['error'] for t in scans if t['error'])}
    def stop(self):
        if not self.job_id or not self.status()['running']:return False
        self.factory().action(self.job_id,'stop');return True
