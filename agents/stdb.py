"""Tiny SpacetimeDB HTTP client (SCHEMA.md §6 "Calling reducers over HTTP").

- `create_identity()` -> (identity, token)        POST {STDB_URL}/v1/identity
- `call(token, reducer, args)`                    POST /v1/database/{db}/call/{reducer}, JSON array body
- `sql(token, query)` -> list[dict]               POST /v1/database/{db}/sql, SQL text body

SQL rows come back positional; we zip them with `schema.elements[i].name.some` and decode
SATS-JSON values (system_of_work/REDUCERS.md "SQL result encoding", verified on 2.13):
options come back tagged, `[0, x]` (some) / `[1, []]` (none), and become `x` / `None`; identities
`["0x..."]` become lowercase hex without `0x` (the form POST /v1/identity returns); timestamps
`[micros]` become integer microseconds. `{"some": x}` / `{"none": []}` (the ARGUMENT encoding) is
also unwrapped. Column `fx_rate_e_6` (the module's snake_case of fxRateE6) is also exposed as
`fx_rate_e6`, the SCHEMA name.

Remember (SCHEMA §2): a *denied* reducer call returns 200 and writes an audit row; only invalid
arguments raise. Callers confirm success by re-reading state.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from .config import Config


class StdbError(RuntimeError):
    """A reducer call or SQL query failed at the HTTP level (invalid args, unknown reducer, ...)."""

    def __init__(self, message: str, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body


# ---- SATS-JSON helpers -------------------------------------------------------------------------


def some(x: Any) -> dict:
    """SATS-JSON `Some(x)`."""
    return {"some": x}


def none() -> dict:
    """SATS-JSON `None`."""
    return {"none": []}


def opt(x: Any) -> dict:
    """`some(x)` unless x is None, then `none()`."""
    return none() if x is None else some(x)


def norm_identity(x: Any) -> str:
    """Normalise an identity to lowercase hex without a 0x prefix (64 chars when numeric)."""
    if isinstance(x, int):
        return f"{x:064x}"
    if isinstance(x, list) and len(x) == 1:
        return norm_identity(x[0])
    if isinstance(x, dict) and len(x) == 1:
        return norm_identity(next(iter(x.values())))
    s = str(x).strip().lower()
    return s[2:] if s.startswith("0x") else s


_SPECIAL_PRODUCTS = {
    "__identity__": "identity",
    "__connection_id__": "identity",
    "__timestamp_micros_since_unix_epoch__": "micros",
    "__time_duration_micros__": "micros",
}


def _name(n: Any) -> str | None:
    if isinstance(n, dict):
        if "some" in n:
            return n["some"]
        if "none" in n:
            return None
    return n


def _special_kind(atype: Any) -> tuple[str, str] | None:
    if isinstance(atype, dict) and "Product" in atype:
        els = (atype["Product"] or {}).get("elements") or []
        if len(els) == 1:
            n = _name(els[0].get("name"))
            if n in _SPECIAL_PRODUCTS:
                return n, _SPECIAL_PRODUCTS[n]
    return None


def _option_inner(atype: Any) -> Any:
    if isinstance(atype, dict) and "Sum" in atype:
        variants = (atype["Sum"] or {}).get("variants") or []
        names = [_name(v.get("name")) for v in variants]
        if names == ["some", "none"]:
            return variants[0].get("algebraic_type")
    return None


def _is_option(atype: Any) -> bool:
    if isinstance(atype, dict) and "Sum" in atype:
        variants = (atype["Sum"] or {}).get("variants") or []
        return [_name(v.get("name")) for v in variants] == ["some", "none"]
    return False


def _heuristic(v: Any) -> Any:
    """Decode without (recognised) type info. Safe for this schema: no table has array columns,
    so every JSON array in a SQL row is an option, an identity or a timestamp."""
    if isinstance(v, list):
        if len(v) == 2 and isinstance(v[0], int) and not isinstance(v[0], bool):
            if v[0] == 1 and v[1] == []:
                return None
            if v[0] == 0:
                return _heuristic(v[1])
        if len(v) == 1:
            x = v[0]
            if isinstance(x, str) and x.lower().startswith("0x"):
                return norm_identity(x)
            if isinstance(x, int) and not isinstance(x, bool):
                return x
    if isinstance(v, dict) and len(v) == 1:
        (k, inner), = v.items()
        if k == "some":
            return _heuristic(inner)
        if k == "none":
            return None
        if k in _SPECIAL_PRODUCTS:
            return norm_identity(inner) if _SPECIAL_PRODUCTS[k] == "identity" else int(inner)
    return v


def decode_value(v: Any, atype: Any = None) -> Any:
    """Decode one SATS-JSON value into plain Python."""
    special = _special_kind(atype)
    if special is not None:
        field, kind = special
        inner = v
        if isinstance(v, list) and len(v) == 1:
            inner = v[0]
        elif isinstance(v, dict) and field in v:
            inner = v[field]
        return norm_identity(inner) if kind == "identity" else int(inner)
    if isinstance(v, dict) and len(v) == 1:
        (k, inner), = v.items()
        if k == "some":
            return decode_value(inner, _option_inner(atype))
        if k == "none":
            return None
        if k in _SPECIAL_PRODUCTS:
            return norm_identity(inner) if _SPECIAL_PRODUCTS[k] == "identity" else int(inner)
    if _is_option(atype) and isinstance(v, list) and len(v) == 2 and isinstance(v[0], int):
        # tagged-array form of a sum (what SQL returns): [0, value] = some, [1, []] = none
        return decode_value(v[1], _option_inner(atype)) if v[0] == 0 else None
    return _heuristic(v)


# SQL column name -> extra key exposed under the SCHEMA.md name.
COLUMN_ALIASES = {"fx_rate_e_6": "fx_rate_e6"}


def decode_sql_response(payload: Any) -> list[list[dict]]:
    """Turn `[{schema, rows}, ...]` into one list of dict rows per statement."""
    if isinstance(payload, dict):
        payload = [payload]
    out: list[list[dict]] = []
    for stmt in payload or []:
        elements = (stmt.get("schema") or {}).get("elements") or []
        names = [_name(e.get("name")) or f"col{i}" for i, e in enumerate(elements)]
        types = [e.get("algebraic_type") for e in elements]
        rows = []
        for row in stmt.get("rows") or []:
            d = {names[i]: decode_value(row[i], types[i]) for i in range(min(len(names), len(row)))}
            for src, alias in COLUMN_ALIASES.items():
                if src in d and alias not in d:
                    d[alias] = d[src]
            rows.append(d)
        out.append(rows)
    return out


def sql_quote(s: str) -> str:
    """Quote a string literal for SpacetimeDB SQL."""
    return "'" + str(s).replace("'", "''") + "'"


# ---- client ------------------------------------------------------------------------------------


class StdbClient:
    def __init__(self, url: str | None = None, db: str | None = None, http: httpx.Client | None = None,
                 timeout: float = 30.0):
        cfg = Config.from_env()
        self.url = (url or cfg.stdb_url).rstrip("/")
        self.db = db or cfg.stdb_db
        self.http = http or httpx.Client(timeout=timeout)

    def _check(self, r: httpx.Response, what: str) -> None:
        if r.status_code >= 400:
            raise StdbError(f"{what} failed: HTTP {r.status_code}: {r.text[:500]}", r.status_code, r.text)

    def create_identity(self) -> tuple[str, str]:
        r = self.http.post(f"{self.url}/v1/identity")
        self._check(r, "create_identity")
        data = r.json()
        return norm_identity(data["identity"]), data["token"]

    def call(self, token: str, reducer: str, args: list | None = None) -> None:
        """Call a reducer. `args` is the positional argument array (see agents/reducers.py)."""
        args = [] if args is None else list(args)
        r = self.http.post(
            f"{self.url}/v1/database/{self.db}/call/{reducer}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=json.dumps(args),
        )
        self._check(r, f"call {reducer}")

    def sql_all(self, token: str, query: str) -> list[list[dict]]:
        r = self.http.post(
            f"{self.url}/v1/database/{self.db}/sql",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
            content=query.encode(),
        )
        self._check(r, "sql")
        return decode_sql_response(r.json())

    def sql(self, token: str, query: str) -> list[dict]:
        """Run one SQL statement and return its rows as dicts."""
        results = self.sql_all(token, query)
        return results[0] if results else []
