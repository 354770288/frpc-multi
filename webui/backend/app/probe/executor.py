"""Canonical standard-library probe execution used by console and worker bundles."""
from __future__ import annotations

import ipaddress
import json
import shutil
import subprocess
import time
from dataclasses import fields
from pathlib import Path

from .discover import DiscoverParams, DiscoverRunner
from .engine import ProbeOptions, run_connectivity_probe, run_speed_probe


class InfrastructureError(RuntimeError):
    pass


def route_probe(ip, cancel=lambda: False, timeout=60):
    if not shutil.which('mtr'):
        raise InfrastructureError('mtr is missing')
    process = subprocess.Popen(['mtr','--json','--no-dns','-c','5',ip],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    deadline=time.monotonic()+timeout
    try:
        while True:
            if cancel():
                return {'ok':False,'isCn2':False,'hops':[],'error':'cancelled'}
            try:
                stdout,stderr=process.communicate(timeout=.2)
                break
            except subprocess.TimeoutExpired:
                if time.monotonic()>=deadline:
                    return {'ok':False,'isCn2':False,'hops':[],'error':'mtr timeout'}
        if process.returncode:
            return {'ok':False,'isCn2':False,'hops':[],'error':stderr[:500]}
        try:
            report=json.loads(stdout).get('report',{})
            hops=[{'hop':h.get('count'),'host':str(h.get('host','')),'loss':h.get('Loss%'),'avg':h.get('Avg')} for h in report.get('hubs',report.get('hops',[]))]
        except (ValueError,TypeError,AttributeError) as exc:
            return {'ok':False,'isCn2':False,'hops':[],'error':'invalid mtr output: '+str(exc)}
        return {'ok':bool(hops),'isCn2':any(h['host'].startswith('59.43.') for h in hops),'hops':hops,'error':'' if hops else 'empty mtr output'}
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=2)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for stream in (process.stdout,process.stderr):
            if stream:stream.close()


def execute_task(task, cancel, progress, *, frpc_bin=None):
    stage=task['stage'];opts=task['options']
    if stage=='route':return route_probe(task['ip'],cancel)
    if stage=='discover':
        targets=[str(ipaddress.IPv4Address(a))+'-'+str(ipaddress.IPv4Address(b)) for a,b in task['payload']['chunk']]
        runner=DiscoverRunner();batch=[]; seq=0
        def flush():
            nonlocal seq,batch
            if batch:
                seq+=1
                response=progress(seq,batch,runner.status())
                if not response.get('accepted',False):raise InfrastructureError('progress rejected')
                batch=[]
        def hit(ip,port,latency):
            batch.append({'ip':ip,'port':port,'latencyMs':latency})
            if len(batch)>=100:flush()
        runner.start(DiscoverParams(targets,[],task['port'],int(opts.get('concurrency',500)),float(opts.get('timeout',1.5))),hit)
        while runner.status()['running']:
            if cancel():runner.stop()
            time.sleep(.1)
        status=runner.status()
        if cancel():return {'cancelled':True}
        if status['error']:raise InfrastructureError(status['error'])
        flush()
        # Final ACK is persisted before the chunk report schedules a successor.
        seq+=1;response=progress(seq,[],status)
        if not response.get('accepted'):raise InfrastructureError('final progress rejected')
        return {'scanned':status['scanned'],'foundCount':status['foundCount']}
    allowed={f.name for f in fields(ProbeOptions)}
    values={k:v for k,v in opts.items() if k in allowed and k not in {'work_dir','extra'}}
    values['frps_port']=task['port']
    if frpc_bin:values['frpc_bin']=frpc_bin
    options=ProbeOptions(**values)
    if not Path(options.frpc_bin).is_file():raise InfrastructureError('frpc binary is missing')
    function=run_connectivity_probe if stage=='connectivity' else run_speed_probe
    result=function(task['ip'],options,cancel=cancel)
    if result.get('infraError'):raise InfrastructureError(result['infraError'])
    return result
