"""Outward-only stdlib worker; no console/instance administration credentials."""
from __future__ import annotations

import json
import os
import signal
import shutil
import threading
import time
import urllib.request
from pathlib import Path

from .executor import execute_task

CAPABILITIES=['discover','route','connectivity','speed']


def runtime_capabilities(frpc_bin):
    caps=['discover']
    if shutil.which('mtr'):caps.append('route')
    binary=frpc_bin or '/usr/local/bin/frpc'
    if Path(binary).is_file() and os.access(binary,os.X_OK):caps.extend(['connectivity','speed'])
    return caps


class Worker:
    def __init__(self, transport, *, version='dev', frpc_bin=None):
        self.transport=transport;self.version=version;self.frpc_bin=frpc_bin
        self.stop_event=threading.Event();self.lock=threading.Lock();self.active={}
        self.heartbeat_thread=None

    def _heartbeat(self):
        while not self.stop_event.is_set():
            with self.lock:
                attempts=[{'taskId':v['task']['taskId'],'attemptId':v['task']['attemptId']} for v in self.active.values()]
            try:
                response=self.transport('heartbeat',{'version':self.version,'capabilities':runtime_capabilities(self.frpc_bin),'attempts':attempts})
                cancelled={(a['taskId'],a['attemptId']) for a in response.get('cancelled',[])}
                with self.lock:
                    for task_id,entry in self.active.items():
                        if (entry['task']['taskId'],entry['task']['attemptId']) in cancelled:entry['cancel'].set()
                        else:entry['renewed']=time.monotonic()
            except Exception:
                pass
            self.stop_event.wait(10)

    def _run(self,entry):
        task=entry['task']
        def cancelled():
            return self.stop_event.is_set() or entry['cancel'].is_set() or time.monotonic()-entry['renewed']>=90
        def post(name,body):
            payload={'taskId':task['taskId'],'attemptId':task['attemptId'],**body}
            while not cancelled():
                try:return self.transport(name,payload)
                except Exception:
                    entry['cancel'].wait(1)
            return {'accepted':False,'cancel':True}
        try:
            try:
                result=execute_task(task,cancelled,lambda seq,hits,state:post('progress',{'seq':seq,'hits':hits,'progress':state}),frpc_bin=self.frpc_bin)
                body={'result':result}
            except Exception as exc:
                body={'infraError':type(exc).__name__+': '+str(exc)[:500]}
            if not cancelled():post('report',body)
            else:
                # Acknowledge only after the engine has cleaned processes/listeners.
                try:self.transport('report',{'taskId':task['taskId'],'attemptId':task['attemptId'],'infraError':'worker stopped or lease lost'})
                except Exception:pass
        finally:
            with self.lock:self.active.pop(entry['key'],None)

    def run(self):
        self.heartbeat_thread=threading.Thread(target=self._heartbeat,daemon=True,name='probe-heartbeat');self.heartbeat_thread.start()
        try:
            while not self.stop_event.is_set():
                with self.lock:room=len(self.active)<16
                if room:
                    try:task=self.transport('claim',{}).get('task')
                    except Exception:task=None
                    if task:
                        entry={'task':task,'cancel':threading.Event(),'renewed':time.monotonic()}
                        key=task['taskId']+':'+task['attemptId']
                        entry['key']=key
                        thread=threading.Thread(target=self._run,args=(entry,),daemon=True,name='probe-'+task['taskId']);entry['thread']=thread
                        with self.lock:self.active[key]=entry
                        thread.start();continue
                self.stop_event.wait(.2)
        finally:
            self.stop_event.set()
            with self.lock:entries=list(self.active.values())
            for entry in entries:entry['cancel'].set()
            # Engines own cleanup; await it before systemd can restart this process.
            for entry in entries:entry['thread'].join()
            self.heartbeat_thread.join(timeout=6)

    def stop(self):self.stop_event.set()


def main():
    url=os.environ['CONSOLE_URL'].rstrip('/')
    token=os.environ.get('PROBE_TOKEN') or os.environ.get('ROUTE_TOKEN','')
    if not token:raise SystemExit('PROBE_TOKEN is required')
    def transport(path,payload):
        request=urllib.request.Request(url+'/api/probe/worker/'+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-Probe-Token':token})
        with urllib.request.urlopen(request,timeout=5) as response:return json.load(response)
    version_file=Path(__file__).parents[2]/'VERSION'
    version=version_file.read_text().strip() if version_file.exists() else os.environ.get('PROBE_VERSION','dev')
    worker=Worker(transport,version=version,frpc_bin=os.environ.get('PROBE_FRPC_BIN','/usr/local/bin/frpc'))
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:worker.stop())
    worker.run()


if __name__=='__main__':main()
