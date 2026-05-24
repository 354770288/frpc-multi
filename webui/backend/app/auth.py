from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .settings import settings

PBKDF2_ITERATIONS = 200_000
SALT_BYTES = 16


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


def require_auth_query(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    token: str | None = None,
) -> str:
    """Auth for endpoints reached by EventSource, which can't set headers.

    Prefers the Authorization header, falls back to a ``token`` query parameter.
    """
    raw_token: str | None = None
    if credentials is not None and credentials.scheme.lower() == "bearer":
        raw_token = credentials.credentials
    elif token:
        raw_token = token
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="未登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        payload = decode_token(raw_token)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    return payload.get("sub", "")


def _hash_password(password: str, salt: bytes | None = None) -> dict:
    if salt is None:
        salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return {
        "algo": "pbkdf2_sha256",
        "iterations": PBKDF2_ITERATIONS,
        "salt": _b64url_encode(salt),
        "hash": _b64url_encode(digest),
    }


def _verify_hash(password: str, record: dict) -> bool:
    try:
        salt = _b64url_decode(record["salt"])
        expected = _b64url_decode(record["hash"])
        iterations = int(record.get("iterations", PBKDF2_ITERATIONS))
    except (KeyError, ValueError):
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(digest, expected)


def _read_credentials() -> dict | None:
    path = settings.credentials_path
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_credentials(username: str, password: str) -> None:
    path = settings.credentials_path
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {"username": username.strip(), "password": _hash_password(password)}
    path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def verify_credentials(username: str, password: str) -> bool:
    stored = _read_credentials()
    if stored:
        stored_user = (stored.get("username") or "").strip()
        user_ok = hmac.compare_digest(username.encode("utf-8"), stored_user.encode("utf-8"))
        pass_record = stored.get("password") or {}
        pass_ok = _verify_hash(password, pass_record) if isinstance(pass_record, dict) else False
        return user_ok and pass_ok
    expected_user = settings.username
    expected_pass = settings.password
    user_ok = hmac.compare_digest(username.encode("utf-8"), expected_user.encode("utf-8"))
    pass_ok = hmac.compare_digest(password.encode("utf-8"), expected_pass.encode("utf-8"))
    return user_ok and pass_ok


def current_username() -> str:
    stored = _read_credentials()
    if stored and isinstance(stored.get("username"), str) and stored["username"].strip():
        return stored["username"].strip()
    return settings.username


def change_credentials(
    current_username_input: str,
    current_password: str,
    new_username: str,
    new_password: str,
) -> str:
    if not verify_credentials(current_username_input, current_password):
        raise ValueError("当前用户名或密码不正确")
    new_username = (new_username or "").strip()
    if not new_username:
        raise ValueError("新用户名不能为空")
    if len(new_username) > 64:
        raise ValueError("新用户名过长")
    if len(new_password) < 8:
        raise ValueError("新密码至少 8 位")
    if len(new_password) > 256:
        raise ValueError("新密码过长")
    _write_credentials(new_username, new_password)
    return new_username
