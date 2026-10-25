"""Database epoch (SCHEMA.md §10 "Epoch", defect 10 / red team H1).

`bootstrap` writes `setting db_epoch = <16 random hex>` once per published module. Every local
state file (`agents/state/*.json`, `dead_letter.jsonl`, `agents/identities.json`) records the
epoch it was written under. An agent whose state file carries another epoch than the module
refuses to run and names the file to delete, so state from a wiped database can never be replayed
against a new one (stale cursors, a stale "already posted" ledger, ...).

Envelope for JSON state files:     {"db_epoch": "<hex>", "data": <payload>}
Header record for JSONL files:     {"kind": "header", "db_epoch": "<hex>", "written_at": "..."}  (first line)
identities.json:                   each actor entry carries "db_epoch" (top-level keys stay actor names)

Legacy files without an epoch record read as epoch None and therefore mismatch a bootstrapped module.

One-line check for any agent that keeps a state file:

    epoch.check_state_epoch(path, epoch.current_epoch(stdb, actor.token))

or, to load/save the file with the envelope handled:

    data = epoch.load_json(path, module_epoch, default={})
    epoch.save_json(path, module_epoch, data)
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SETTING_KEY = "db_epoch"
FIELD = "db_epoch"
UNKNOWN = "unknown (no epoch record)"


class EpochMismatch(RuntimeError):
    """A local state file was written under a different database epoch than the module has."""

    def __init__(self, path: Path, file_epoch: str | None, module_epoch: str | None):
        self.path, self.file_epoch, self.module_epoch = Path(path), file_epoch, module_epoch
        super().__init__(
            f"{self.path} was written under db_epoch {file_epoch or UNKNOWN} but the module has "
            f"db_epoch {module_epoch or UNKNOWN}: the database was republished or bootstrapped since. "
            f"Delete {self.path} (or run `make stdb-publish`, which removes agents/state/) and run again."
        )


def new_epoch() -> str:
    """16 random hex characters."""
    return secrets.token_hex(8)


def is_epoch(x: Any) -> bool:
    return isinstance(x, str) and len(x) == 16 and all(c in "0123456789abcdef" for c in x)


def current_epoch(stdb, token: str) -> str | None:
    """The module's `db_epoch` setting, read via SQL (the setting table is public). None before bootstrap."""
    # Whole table (a handful of rows): avoids quoting `key`, a reserved word in some SQL dialects.
    rows = stdb.sql(token, "SELECT * FROM setting")
    for r in rows:
        if r.get("key") == SETTING_KEY and r.get("value") is not None:
            return str(r["value"])
    return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---- reading the epoch recorded in a file -------------------------------------------------------


def _is_envelope(raw: Any) -> bool:
    return isinstance(raw, dict) and set(raw) == {FIELD, "data"}


def read_state_epoch(path: Path | str) -> str | None:
    """The epoch a state file was written under; None when the file has no epoch record (legacy file).
    Raises FileNotFoundError when the file does not exist."""
    p = Path(path)
    text = p.read_text()
    if p.suffix == ".jsonl":
        first = text.splitlines()[0].strip() if text.strip() else ""
        if not first:
            return None
        try:
            head = json.loads(first)
        except json.JSONDecodeError:
            return None
        return head.get(FIELD) if isinstance(head, dict) and head.get("kind") == "header" else None
    try:
        raw = json.loads(text) if text.strip() else None
    except json.JSONDecodeError:
        return None
    if _is_envelope(raw):
        return raw[FIELD]
    if isinstance(raw, dict) and raw and all(isinstance(v, dict) for v in raw.values()):
        # identities.json layout: actor name -> {identity, token, role, db_epoch}
        epochs = {v.get(FIELD) for v in raw.values()}
        if len(epochs) == 1:
            return epochs.pop()
    return None


def check_state_epoch(path: Path | str, module_epoch: str | None) -> None:
    """Refuse (EpochMismatch) when `path` exists and records a different epoch than `module_epoch`.
    A missing file is fine: it will be written under the current epoch."""
    p = Path(path)
    if not p.exists():
        return
    file_epoch = read_state_epoch(p)
    if file_epoch != module_epoch:
        raise EpochMismatch(p, file_epoch, module_epoch)


def check_all(module_epoch: str | None, *paths: Path | str) -> None:
    for p in paths:
        check_state_epoch(p, module_epoch)


# ---- JSON state files with the envelope ---------------------------------------------------------


def load_json(path: Path | str, module_epoch: str | None, default: Any = None) -> Any:
    """Payload of an enveloped JSON state file after the epoch check. `default` when the file is missing."""
    p = Path(path)
    check_state_epoch(p, module_epoch)
    if not p.exists():
        return default
    raw = json.loads(p.read_text())
    return raw["data"] if _is_envelope(raw) else raw


def save_json(path: Path | str, module_epoch: str | None, data: Any) -> None:
    """Atomically write `{"db_epoch": epoch, "data": data}`."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps({FIELD: module_epoch, "data": data}, indent=1, sort_keys=True))
    tmp.replace(p)


# ---- JSONL files with a header record -----------------------------------------------------------


def append_jsonl(path: Path | str, module_epoch: str | None, record: dict) -> None:
    """Append one record; a new file gets the epoch header record first. The caller has already
    run `check_state_epoch` (or `load_json`) for this path in this process."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    if not p.exists() or p.stat().st_size == 0:
        lines.append(json.dumps({"kind": "header", FIELD: module_epoch, "written_at": _now()}, sort_keys=True))
    lines.append(json.dumps(record, sort_keys=True, default=str))
    with p.open("a") as f:
        f.write("\n".join(lines) + "\n")


def read_jsonl(path: Path | str) -> list[dict]:
    """Every non-header record of a JSONL state file (empty list when missing)."""
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if isinstance(rec, dict) and rec.get("kind") == "header":
            continue
        out.append(rec)
    return out
