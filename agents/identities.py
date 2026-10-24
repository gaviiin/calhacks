"""agents/identities.json: actor name -> {identity, token, role, db_epoch}. Written by agents.bootstrap.

This file holds bearer tokens. It is gitignored. Each process loads only the actor it runs as
(`get(actor)`); no agent process is handed another actor's token.

`db_epoch` (SCHEMA §10) is the module epoch the roles were claimed under; it sits on every actor
entry so the top-level keys stay actor names. `epoch(data)` returns it (None when absent or mixed).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from . import config


@dataclass(frozen=True)
class Actor:
    name: str
    identity: str
    token: str
    role: str


def load(path: Path | None = None) -> dict[str, dict]:
    p = Path(path or config.IDENTITIES_PATH)
    if not p.exists():
        return {}
    return json.loads(p.read_text())


def save(data: dict[str, dict], path: Path | None = None) -> None:
    p = Path(path or config.IDENTITIES_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True))
    os.chmod(tmp, 0o600)
    tmp.replace(p)


def epoch(data: dict[str, dict]) -> str | None:
    """The db_epoch recorded on the actor entries, or None when missing or inconsistent."""
    epochs = {d.get("db_epoch") for d in data.values() if isinstance(d, dict)}
    return epochs.pop() if len(epochs) == 1 else None


def stamp(data: dict[str, dict], db_epoch: str | None) -> bool:
    """Record `db_epoch` on every actor entry in place. Returns True when anything changed."""
    changed = False
    for d in data.values():
        if isinstance(d, dict) and d.get("db_epoch") != db_epoch:
            d["db_epoch"] = db_epoch
            changed = True
    return changed


def get(name: str, path: Path | None = None) -> Actor:
    data = load(path)
    if name not in data:
        raise KeyError(
            f"actor {name!r} not in {path or config.IDENTITIES_PATH}; run `uv run python -m agents.bootstrap` first"
        )
    d = data[name]
    return Actor(name=name, identity=d["identity"], token=d["token"], role=d["role"])
