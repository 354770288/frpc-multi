from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import settings


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def _sign(message: bytes, secret: str) -> str:
    digest = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).digest()
    return _b64url_encode(digest)


def create_token(username: str, ttl_seconds: int | None = None) -> dict:
    issued_at = int(time.time())
    expires_at = issued_at + (ttl_seconds or settings.token_ttl_seconds)
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {
        "sub": username,
        "iat": issued_at,
        "exp": expires_at,
        "jti": secrets.token_hex(8),
    }
    header_segment = _b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_segment = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    signature = _sign(signing_input, settings.jwt_secret)
    token = f"{header_segment}.{payload_segment}.{signature}"
    return {"token": token, "expiresAt": expires_at, "issuedAt": issued_at, "username": username}


def decode_token(token: str) -> dict:
    try:
        header_segment, payload_segment, signature = token.split(".")
    except ValueError as exc:
        raise ValueError("token 格式无效") from exc
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    expected = _sign(signing_input, settings.jwt_secret)
    if not hmac.compare_digest(expected, signature):
        raise ValueError("token 签名无效")
    payload = json.loads(_b64url_decode(payload_segment).decode("utf-8"))
    if payload.get("exp", 0) < int(time.time()):
        raise ValueError("token 已过期")
    return payload


bearer_scheme = HTTPBearer(auto_error=False)


def require_auth(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(credentials.credentials)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return payload.get("sub", "")


def verify_credentials(username: str, password: str) -> bool:
    expected_user = settings.username
    expected_pass = settings.password
    user_ok = hmac.compare_digest(username.encode("utf-8"), expected_user.encode("utf-8"))
    pass_ok = hmac.compare_digest(password.encode("utf-8"), expected_pass.encode("utf-8"))
    return user_ok and pass_ok
