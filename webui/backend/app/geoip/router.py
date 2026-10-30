"""Authenticated asynchronous local database maintenance endpoints."""
from fastapi import APIRouter, Depends, HTTPException, Request

from ..auth import require_auth
from ..control.audit_store import AuditStore

router = APIRouter(prefix='/api/geoip', dependencies=[Depends(require_auth)])


def service(request: Request):
    value = getattr(request.app.state, 'geoip', None)
    if value is None:
        raise HTTPException(503, '归属地服务尚未启动')
    return value


@router.get('/status')
def status(request: Request):
    return service(request).status()


@router.post('/update', status_code=202)
def update(request: Request, user: str = Depends(require_auth)):
    geo = service(request)
    if not geo.enabled:
        raise HTTPException(409, '归属地识别已关闭')
    if not geo.token:
        raise HTTPException(409, '请配置 IPINFO_TOKEN；也可直接挂载本地 MMDB 文件')
    geo.store.request_update()
    AuditStore(geo.store.path).create_log(username=user, action='geoip_update', success=True,
                                         message='已请求更新本地 IPinfo Lite 数据库')
    return {'queued': True}


@router.post('/refresh', status_code=202)
def refresh(request: Request, user: str = Depends(require_auth)):
    geo = service(request)
    if not geo.enabled:
        raise HTTPException(409, '归属地识别已关闭')
    geo.store.request_refresh()
    AuditStore(geo.store.path).create_log(username=user, action='geoip_refresh', success=True,
                                         message='已请求重新识别发现候选与已测试资产')
    return {'queued': True}
