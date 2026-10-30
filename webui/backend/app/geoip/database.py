"""Validated immutable MMDB snapshots; no per-IP network access."""
from __future__ import annotations

import hashlib
import io
import ipaddress
import re
from dataclasses import dataclass
from pathlib import Path

import maxminddb
from maxminddb.const import Mode

from ..models import now_iso


def normalize(data):
    if not isinstance(data, dict):
        raise ValueError('数据库记录格式异常')
    fields = ('country_code', 'country', 'asn', 'as_name', 'as_domain')
    result = {key: data.get(key) or None for key in fields}
    if any(value is not None and not isinstance(value, str) for value in result.values()):
        raise ValueError('数据库字段类型异常')
    if result['country_code'] and not re.fullmatch('[A-Z]{2}', result['country_code']):
        raise ValueError('国家代码格式异常')
    if result['asn'] and not re.fullmatch(r'AS[0-9]+', result['asn']):
        raise ValueError('ASN 格式异常')
    return result


@dataclass
class Snapshot:
    reader: object
    version: str
    build_epoch: int

    def lookup(self, ip):
        address = ipaddress.IPv4Address(ip)
        data = self.reader.get(ip) if address.is_global and not address.is_multicast else None
        status = 'non_public' if not address.is_global or address.is_multicast else 'not_found'
        normalized = normalize(data) if data is not None else normalize({})
        if data is not None and (normalized['country_code'] or normalized['asn']):
            status = 'ready'
        return dict(ip=ip, status=status, database_version=self.version, looked_up_at=now_iso(), **normalized)

    def close(self):
        self.reader.close()


def open_snapshot(path: Path) -> Snapshot:
    with path.open('rb') as stream:
        data = stream.read(128 * 1024 * 1024 + 1)
    if len(data) > 128 * 1024 * 1024:
        raise ValueError('数据库文件超过 128 MiB 上限')
    # Decode and hash the exact same immutable bytes. Reopening the pathname to
    # hash it could mix old lookup data with a newly mounted file's version.
    reader = maxminddb.open_database(io.BytesIO(data), Mode.FD)
    try:
        metadata = reader.metadata()
        # A City/Country MMDB is syntactically valid but has a different wire schema.
        recognized = False
        for index, (_, record) in enumerate(reader):
            if not isinstance(record, dict):
                raise ValueError('数据库记录格式异常')
            normalize(record)
            recognized |= 'country_code' in record and 'asn' in record
            if index >= 127:
                break
        if not recognized or metadata.ip_version not in (4, 6):
            raise ValueError('请选择 IPinfo Lite 格式的 MMDB 数据库')
        return Snapshot(reader, hashlib.sha256(data).hexdigest(), metadata.build_epoch)
    except BaseException:
        reader.close()
        raise
