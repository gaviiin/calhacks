"""Signed, expiring action links for email and Teams (approve, reject, answer, send a draft).

A link carries who may act and what they may do; the server re-checks it and
the ledger still enforces segregation of duties (K11) when the action runs.
Links open a confirmation page (GET) and only act on POST, so mail scanners
that prefetch links can't approve anything.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time


def _secret() -> bytes:
    secret = os.environ.get("PITWALL_SECRET", "")
    if not secret:
        if os.environ.get("PITWALL_NOTIFY", "dry") == "live":
            raise RuntimeError("PITWALL_SECRET must be set before sending live action links")
        secret = "dev-only-not-secret"
    return secret.encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(claims: dict, ttl_seconds: int = 72 * 3600) -> str:
    body = _b64(json.dumps({**claims, "exp": int(time.time()) + ttl_seconds}, separators=(",", ":"), sort_keys=True).encode())
    mac = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{mac}"


def verify(token: str) -> dict:
    try:
        body, mac = token.split(".", 1)
    except ValueError:
        raise ValueError("malformed token")
    expected = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(mac, expected):
        raise ValueError("bad signature")
    claims = json.loads(_unb64(body))
    if claims.get("exp", 0) < time.time():
        raise ValueError("link expired")
    return claims


def link(path: str, claims: dict) -> str:
    base = os.environ.get("PITWALL_PUBLIC_URL", "http://localhost:8000").rstrip("/")
    return f"{base}{path}?token={sign(claims)}"
