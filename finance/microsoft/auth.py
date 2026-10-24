"""Microsoft Entra ID tokens for Graph, Business Central, Azure OpenAI and Confidential Ledger.

One app registration serves every Microsoft integration:

    MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   client-credentials flow (hackathon, CI)

In Azure (Container Apps, App Service, AKS) leave the secret unset and turn on a
managed identity: if azure-identity is installed, DefaultAzureCredential is
used, so no secret exists anywhere. Tokens are cached until five minutes
before they expire.
"""

from __future__ import annotations

import os
import threading
import time

import httpx

_CACHE: dict[str, tuple[str, float]] = {}
_LOCK = threading.Lock()


class AuthError(RuntimeError):
    pass


def configured(env=os.environ) -> bool:
    return bool(env.get("MS_TENANT_ID") and env.get("MS_CLIENT_ID") and env.get("MS_CLIENT_SECRET")) or _managed_identity(env)


def _managed_identity(env) -> bool:
    return env.get("PITWALL_MS_AUTH", "") == "managed_identity"


def token(scope: str, env=os.environ, http: httpx.Client | None = None) -> str:
    key = f"{env.get('MS_TENANT_ID', '')}|{env.get('MS_CLIENT_ID', '')}|{scope}"
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[1] - 300 > time.time():
            return hit[0]
    if env.get("MS_CLIENT_SECRET"):
        tenant = env["MS_TENANT_ID"]
        r = (http or httpx.Client(timeout=15)).post(
            f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
            data={"grant_type": "client_credentials", "client_id": env["MS_CLIENT_ID"], "client_secret": env["MS_CLIENT_SECRET"],
                  "scope": scope})
        if r.status_code != 200:
            raise AuthError(f"Entra token for {scope}: {r.status_code} {r.text[:300]}")
        data = r.json()
        tok, exp = data["access_token"], time.time() + int(data.get("expires_in", 3600))
    else:
        try:
            from azure.identity import DefaultAzureCredential
        except ImportError as exc:
            raise AuthError("set MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET, or install azure-identity for managed identity") from exc
        t = DefaultAzureCredential().get_token(scope)
        tok, exp = t.token, float(t.expires_on)
    with _LOCK:
        _CACHE[key] = (tok, exp)
    return tok


def clear_cache() -> None:
    with _LOCK:
        _CACHE.clear()
