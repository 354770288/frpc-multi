"""Console executor uses exactly the worker protocol and durable scheduler."""
from .jobs import ProbeJobStore
from .worker import Worker, runtime_capabilities, PROTOCOL_FEATURES


def start_console_worker(database_path, *, frpc_bin, version='dev'):
    import threading
    store=ProbeJobStore(database_path)
    store.heartbeat('console',version,runtime_capabilities(frpc_bin),[],PROTOCOL_FEATURES)
    def transport(path,payload):
        if path=='heartbeat':return store.heartbeat('console',payload['version'],payload['capabilities'],payload['attempts'],payload.get('protocolFeatures'))
        if path=='claim':return {'task':store.claim('console')}
        if path=='progress':return store.progress('console',payload['taskId'],payload['attemptId'],payload['seq'],generation=payload.get('generation'),hits=payload.get('hits',[]),progress=payload.get('progress'))
        if path=='report':return store.report('console',payload['taskId'],payload['attemptId'],generation=payload.get('generation'),result=payload.get('result'),infra_error=payload.get('infraError'))
        raise ValueError(path)
    worker=Worker(transport,version=version,frpc_bin=frpc_bin)
    thread=threading.Thread(target=worker.run,daemon=True,name='console-probe');thread.start()
    def stop():worker.stop();thread.join()
    return stop
