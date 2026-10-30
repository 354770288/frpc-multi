"""Single Console maintenance worker, durable requests, atomic file activation."""
from __future__ import annotations

import os
import logging
import tempfile
import threading
import time
from pathlib import Path

import httpx

from ..models import now_iso
from .database import open_snapshot
from .identity import ipv4_host
from .store import GeoStore

UPDATE_INTERVAL = 24 * 60 * 60
MAX_DATABASE_BYTES = 128 * 1024 * 1024
# Daily million-IP refreshes yield to interactive SQLite readers between batches.
BATCH_PAUSE_SECONDS = 0.1
LOGGER = logging.getLogger(__name__)


class GeoService:
    def __init__(self, database_path: Path, mmdb_path: Path, *, enabled=True, token=''):
        self.store = GeoStore(database_path)
        self.path = Path(mmdb_path)
        self.enabled = enabled
        self.token = token
        self._snapshot = None
        self._fingerprint = None
        self._stop = threading.Event()
        self._updating = False
        self._last_download = 0.0
        self._last_open_attempt = 0.0
        self._maintenance_at = 0.0

    def _error(self, message):
        with self.store.db() as c:
            c.execute('UPDATE geoip_state SET last_error=? WHERE id=1', (message,))

    def _load(self):
        try:
            stat = self.path.stat()
            fingerprint = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if fingerprint != self._fingerprint:
                snapshot = open_snapshot(self.path)
                self.store.activate(snapshot.version, snapshot.build_epoch)
                old, self._snapshot = self._snapshot, snapshot
                self._fingerprint = fingerprint
                if old:
                    old.close()
                self._error('')
        except (OSError, ValueError, RuntimeError) as exc:
            self._error('尚未挂载归属地数据库' if isinstance(exc, FileNotFoundError) else '本地归属地数据库校验失败，请检查文件格式')

    def download(self):
        """Keep credentials out of URLs in logs, errors, responses, and filenames."""
        self._updating = True
        temporary = None
        try:
            if not self.token:
                raise ValueError('请配置 IPINFO_TOKEN 或挂载本地 MMDB 文件')
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(prefix='.ipinfo-', suffix='.mmdb', dir=self.path.parent, delete=False) as output:
                temporary = Path(output.name)
                with httpx.stream('GET', 'https://ipinfo.io/data/ipinfo_lite.mmdb',
                                  params={'token': self.token}, follow_redirects=True,
                                  timeout=httpx.Timeout(30, connect=10)) as response:
                    if response.status_code != 200:
                        raise ValueError(f'数据库下载失败（HTTP {response.status_code}）')
                    size = 0
                    for chunk in response.iter_bytes():
                        if self._stop.is_set():
                            raise ValueError('数据库更新已停止')
                        size += len(chunk)
                        if size > MAX_DATABASE_BYTES:
                            raise ValueError('数据库文件超过 128 MiB 上限')
                        output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            candidate = open_snapshot(temporary)
            candidate.close()
            os.replace(temporary, self.path)
            temporary = None
            self._load()
            with self.store.db() as c:
                c.execute("UPDATE geoip_state SET last_error='' WHERE id=1")
        except ValueError as exc:
            # Only our own ValueErrors are exposed; transport exceptions may include token URLs.
            self._error(str(exc) if self.token not in str(exc) or not self.token else '归属地数据库更新失败')
        except (httpx.HTTPError, OSError, RuntimeError):
            self._error('归属地数据库下载或校验失败，请检查网络、Token 与磁盘')
        finally:
            # Database error reporting can itself fail; never leave the UI or
            # later maintenance attempts permanently marked as updating.
            self._updating = False
            self._last_download = time.time()
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    LOGGER.warning('归属地更新临时文件清理失败，请检查磁盘')
            with self.store.db() as c:
                c.execute('UPDATE geoip_state SET last_check_at=? WHERE id=1', (now_iso(),))

    def step(self):
        if not self.enabled:
            return False
        clock = time.time()
        state = self.store.state()
        if not self._last_download and state['last_check_at']:
            from datetime import datetime
            self._last_download = datetime.fromisoformat(state['last_check_at']).timestamp()
        if self._last_open_attempt + 5 <= clock:
            self._load()
            self._last_open_attempt = clock
        if state['update_requested'] or (self.token and clock - self._last_download >= UPDATE_INTERVAL):
            with self.store.db() as c:
                c.execute('UPDATE geoip_state SET update_requested=0 WHERE id=1')
            self.download()
        maintenance = False
        if clock >= self._maintenance_at or state['refresh_requested'] or state['backfill_phase'] != 'done':
            maintenance = self.store.backfill() | self.store.refresh_batch()
            self._maintenance_at = clock + (0 if maintenance else 30)
        if not self._snapshot:
            return maintenance
        ips = self.store.pending(clock)
        if not ips:
            return maintenance
        try:
            records = []
            for ip in ips:
                if ipv4_host(ip) != ip:
                    self.store.exclude_invalid(ip)
                    continue
                try:
                    records.append(self._snapshot.lookup(ip))
                except (ValueError, RuntimeError):
                    # A retained legacy hostname/IPv6 asset or malformed record
                    # must not keep the other 249 valid addresses waiting.
                    self.store.fail_batch([ip], clock + 300)
                    self._error('部分 IP 本地归属地查询失败，将在 5 分钟后重试')
            self.store.save_batch(records, self._snapshot.version)
        except (ValueError, RuntimeError):
            self.store.fail_batch(ips, clock + 300)
            self._error('本地归属地查询失败，将在 5 分钟后重试')
        return True

    def status(self):
        state = self.store.state()
        return dict(
            enabled=self.enabled, path=str(self.path),
            version=self._snapshot.version if self._snapshot is not None else None,
            buildEpoch=state['build_epoch'], updatedAt=state['updated_at'],
            lastCheckAt=state['last_check_at'], lastError=state['last_error'],
            tokenConfigured=bool(self.token), updating=self._updating or bool(state['update_requested']),
            counts=self.store.counts(),
            backfill=dict(phase=state['backfill_phase'], cursor=state['backfill_cursor'],
                          done=state['backfill_phase'] == 'done'),
        )

    def start(self):
        def run():
            try:
                while not self._stop.is_set():
                    try:
                        busy = self.step()
                    except Exception:
                        # A locked/full database can also reject error reporting.
                        # Preserve the worker so persisted work resumes afterward.
                        try:
                            self._error('归属地后台处理异常，将自动重试')
                        except Exception:
                            LOGGER.warning('归属地后台等待数据库恢复，将自动重试')
                        busy = False
                    self._stop.wait(BATCH_PAUSE_SECONDS if busy else 1)
            finally:
                if self._snapshot:
                    self._snapshot.close()
                    self._snapshot = None
        thread = threading.Thread(target=run, name='geoip-maintenance', daemon=True)
        thread.start()

        def stop():
            self._stop.set()
            thread.join()
        return stop
