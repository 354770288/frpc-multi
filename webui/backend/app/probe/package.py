"""Build a stdlib-only worker bundle from the canonical backend sources."""
import io
import os
import gzip
import tarfile
from pathlib import Path


def worker_bundle():
    root=Path(__file__).parents[1]
    version=os.environ.get('AGENT_VERSION','dev')
    output=io.BytesIO()
    with tarfile.open(fileobj=output,mode='w') as archive:
        files={'app/__init__.py':b'', 'app/probe/__init__.py':b'', 'VERSION':version.encode()}
        for name in ('engine.py','discover.py','executor.py','worker.py'):
            files['app/probe/'+name]=(root/'probe'/name).read_bytes()
        files['app/models.py']=(root/'models.py').read_bytes()
        for name,data in files.items():
            info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
            archive.addfile(info,io.BytesIO(data))
    return gzip.compress(output.getvalue(),mtime=0)
