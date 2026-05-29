from __future__ import annotations

import hmac
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ..settings import settings

agent_bearer_scheme = HTTPBearer(auto_error=False)


def require_agent_auth(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(agent_bearer_scheme)],
) -> None:
    if not settings.agent_auth_enabled:
        return
    if not settings.agent_token:
        raise HTTPException(status_code=500, detail="Agent token 未配置")
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Agent 未认证",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not hmac.compare_digest(credentials.credentials.encode("utf-8"), settings.agent_token.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Agent token 无效",
            headers={"WWW-Authenticate": "Bearer"},
        )
