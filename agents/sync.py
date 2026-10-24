"""Sync job: systems of record -> golden rows. Identity: sync (role sync).

May: upsertGlLine / upsertBillLine / upsertVendor / upsertFairValue (the module creates work items
from gl lines). May not: anything on work items or policies (and no setSetting: a rulebook issue is
recorded locally and announced, never written to the module).

Change-only, cursor per source (agents/state/sync_cursors.json). Every emitted record is an upsert
keyed by its stable id; `raw_ref = "<source>:<id>:<cursor>"` ties the golden row to the exact raw
row. Re-running with the same cursor file sends nothing.

Failure isolation (SCHEMA.md §10 "Sync", defect 9 / red team H7):
  - every record is applied in its own reducer call. A record that cannot be converted (KeyError,
    ValueError, TypeError) or that the module rejects (StdbError 400/500/530) is appended to
    agents/state/dead_letter.jsonl with source, cursor, id and error, and the cursor advances past
    it. Transport/auth failures (world API down, HTTP 401/403/5xx gateway errors) are not dead-
    lettered: that source stops for this run (cursor stays) and the other sources still run, so a
    broken fair value never blocks the GL lines.
  - `op: "delete"` re-emits the gl line with `amount_minor = 0`, `amount_usd_minor = 0` and the
    memo prefixed `VOID: ` (the module's reversal rule turns that into a reversal if the line was
    posted). The previous version comes from the sync cache, else /records/gl_line/{id}.
  - `rulebook_issue` is pulled too: issues are recorded in agents/state/rulebook_issues.json and an
    issue the local rulebook does not know prints `rule change: <id> published ...; rebuild rulebook`.

Epoch (SCHEMA.md §10 "Epoch", defect 10): every state file carries the module's `db_epoch`; a file
from another epoch makes the job refuse to start and name the file (agents/epoch.py).

Joins and conversions:
  - gl_line: account_code from the account master (cached from /changes/account, else
    /records/account/{id}, else the id suffix); fx_rate_to_usd -> integer fx_rate_e6
    (round half up); amount_usd_minor taken from the world record (computed only if missing).
  - bill_line: joined with its bill for bill_text, vendor_id, bank_iban_on_bill. Bills are cached;
    when a bill is re-emitted with different text/vendor/bank details, every cached line of that bill
    is upserted again (raw_ref keeps the bill line's own cursor) so a changed IBAN reaches the work.

Usage:
  uv run python -m agents.sync --once
  uv run python -m agents.sync --loop [--interval 5]
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import httpx

from . import config, epoch, identities
from . import reducers as R
from .identities import Actor
from .policy import line_account_code
from .stdb import StdbClient, StdbError
from .world_client import WorldClient, WorldError

log = logging.getLogger("agents.sync")

# Master data first, gl lines (which create work items) after, rulebook issues last. Each source is
# isolated: a source that stops (transport error) does not prevent the later ones from running.
CACHE_ONLY = ("account", "bill", "rulebook_issue")
UPSERTED = ("vendor", "fair_value", "bill_line", "gl_line")
ORDER = ("account", "vendor", "fair_value", "bill", "bill_line", "gl_line", "rulebook_issue")

# StdbError statuses that mean "try again later", not "this record is bad".
TRANSIENT_STDB_STATUS = {401, 403, 404, 408, 429, 502, 503, 504}
# Conversion errors: the record itself is malformed.
RECORD_ERRORS = (KeyError, ValueError, TypeError)
# Fields a gl line must carry to be voided from the delete record alone.
GL_REQUIRED = ("id", "posted_date", "period_key", "account_id", "amount_minor", "currency")
VOID_PREFIX = "VOID: "


def fx_rate_e6(rate: Any) -> int:
    return int((Decimal(str(rate)) * 1_000_000).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def raw_ref(source: str, rec_id: str, cursor: int) -> str:
    return f"{source}:{rec_id}:{cursor}"


def golden_gl_line(rec: dict, cursor: int, account_code: str) -> dict:
    rate = rec.get("fx_rate_to_usd")
    e6 = fx_rate_e6(rate if rate is not None else 1)
    usd = rec.get("amount_usd_minor")
    if usd is None:
        usd = int((Decimal(int(rec["amount_minor"])) * e6 / 1_000_000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    return {
        "id": rec["id"], "raw_ref": raw_ref("gl_line", rec["id"], cursor),
        "posted_date": rec["posted_date"], "period_key": rec["period_key"],
        "account_id": rec["account_id"], "account_code": str(account_code),
        "department_id": rec.get("department_id") or "", "vendor_id": rec.get("vendor_id"),
        "bill_id": rec.get("bill_id"), "amount_minor": int(rec["amount_minor"]), "currency": rec["currency"],
        "fx_rate_e6": e6, "amount_usd_minor": int(usd), "memo": rec.get("memo") or "",
        "erp_category_code": rec.get("erp_category_code") or "", "entity": rec.get("entity") or "RACING",
        "correction_of": rec.get("correction_of"),
    }


def void_gl_line(rec: dict) -> dict:
    """The world record of a deleted gl line as a zero-amount VOID re-emission (SCHEMA §10 Sync)."""
    memo = rec.get("memo") or ""
    out = dict(rec)
    out["amount_minor"] = 0
    out["amount_usd_minor"] = 0
    out["memo"] = memo if memo.startswith(VOID_PREFIX) else VOID_PREFIX + memo
    return out


def golden_bill_line(bl: dict, cursor: int, bill: dict | None) -> dict:
    bill = bill or {}
    return {
        "id": bl["id"], "raw_ref": raw_ref("bill_line", bl["id"], cursor), "bill_id": bl["bill_id"],
        "gl_line_id": bl.get("gl_line_id"), "line_no": int(bl.get("line_no") or 0),
        "description": bl.get("description") or "", "amount_minor": int(bl["amount_minor"]),
        "bill_text": bill.get("text") or "", "vendor_id": bill.get("vendor_id") or "",
        "bank_iban_on_bill": bill.get("bank_iban_on_bill") or "",
    }


def golden_vendor(v: dict, cursor: int) -> dict:
    return {
        "id": v["id"], "raw_ref": raw_ref("vendor", v["id"], cursor), "name": v["name"],
        "country": v.get("country") or "", "related_party": bool(v.get("related_party")),
        "related_party_entity": v.get("related_party_entity"), "bank_iban": v.get("bank_iban") or "",
        "category_hint": v.get("category_hint"),
    }


def golden_fair_value(f: dict, cursor: int) -> dict:
    return {
        "id": f["id"], "raw_ref": raw_ref("fair_value", f["id"], cursor),
        "counterparty_vendor_id": f["counterparty_vendor_id"], "item": f.get("item") or "",
        "contract_value_minor": int(f["contract_value_minor"]), "fair_value_minor": int(f["fair_value_minor"]),
        "currency": f["currency"], "effective_from": f["effective_from"], "basis": f.get("basis") or "",
    }


def _bill_snapshot(bill: dict | None) -> dict:
    bill = bill or {}
    return {"text": bill.get("text"), "vendor_id": bill.get("vendor_id"), "bank_iban_on_bill": bill.get("bank_iban_on_bill")}


def _gl_snapshot(rec: dict) -> dict:
    """The world gl_line fields the golden row is built from (what a later delete needs)."""
    return {k: v for k, v in rec.items() if k not in ("source", "visible_at", "updated_at")}


def known_rule_versions(path: Path | None = None) -> set[str]:
    """Issue ids the local rulebook was built from (`rule_version` of every entry); empty if unreadable."""
    p = Path(path or config.RULEBOOK_PATH)
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return set()
    entries = data.get("entries", []) if isinstance(data, dict) else data
    return {str(e["rule_version"]) for e in entries if isinstance(e, dict) and e.get("rule_version")}


def _is_transient(e: StdbError) -> bool:
    return e.status in TRANSIENT_STDB_STATUS


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Sync:
    def __init__(self, world: WorldClient, stdb: StdbClient, actor: Actor,
                 cursors_path: Path | None = None, cache_path: Path | None = None, page_size: int = 500,
                 dead_letter_path: Path | None = None, issues_path: Path | None = None,
                 db_epoch: str | None = None, rule_versions: set[str] | None = None):
        self.world, self.stdb, self.actor = world, stdb, actor
        self.cursors_path = Path(cursors_path or config.SYNC_CURSORS_PATH)
        self.cache_path = Path(cache_path or config.SYNC_CACHE_PATH)
        self.dead_letter_path = Path(dead_letter_path or config.DEAD_LETTER_PATH)
        self.issues_path = Path(issues_path or config.RULEBOOK_ISSUES_PATH)
        self.page_size = page_size
        self.rule_versions = known_rule_versions() if rule_versions is None else set(rule_versions)
        self.warnings: list[str] = []

        # Epoch: refuse to start on any state file from another database (names the file).
        self.epoch = db_epoch if db_epoch is not None else epoch.current_epoch(stdb, actor.token)
        if self.epoch is None:
            log.warning("module has no db_epoch setting (bootstrap not run?); state files are written without one")
        epoch.check_all(self.epoch, self.cursors_path, self.cache_path, self.dead_letter_path, self.issues_path)

        self.cursors: dict[str, int] = {k: int(v) for k, v in epoch.load_json(self.cursors_path, self.epoch, {}).items()}
        self.cache: dict[str, dict] = epoch.load_json(self.cache_path, self.epoch, {})
        for k in ("accounts", "bills", "bill_lines", "gl_lines"):
            self.cache.setdefault(k, {})
        self.issues: dict[str, Any] = epoch.load_json(self.issues_path, self.epoch, {})
        self.issues.setdefault("issues", {})
        self.issues.setdefault("latest", None)

    def save(self) -> None:
        epoch.save_json(self.cursors_path, self.epoch, self.cursors)
        epoch.save_json(self.cache_path, self.epoch, self.cache)
        epoch.save_json(self.issues_path, self.epoch, self.issues)

    def _call(self, reducer: str, args: list) -> None:
        self.stdb.call(self.actor.token, reducer, args)

    # -- dead letters
    def dead_letter(self, source: str, cursor: int, rec: dict | None, op: str, err: BaseException) -> None:
        entry = {"kind": "dead_letter", "at": _now(), "source": source, "cursor": cursor,
                 "id": (rec or {}).get("id"), "op": op, "error": f"{type(err).__name__}: {err}", "record": rec}
        epoch.append_jsonl(self.dead_letter_path, self.epoch, entry)
        log.error("dead letter %s cursor %s id %s: %s", source, cursor, entry["id"], entry["error"])

    def dead_letters(self) -> list[dict]:
        return epoch.read_jsonl(self.dead_letter_path)

    # -- lookups
    def account_code(self, account_id: str) -> str:
        code = self.cache["accounts"].get(account_id)
        if code is None:
            rec = self.world.record("account", account_id)
            code = str(rec["code"]) if rec and rec.get("code") is not None else line_account_code({"account_id": account_id})
            if code is None:
                raise ValueError(f"cannot resolve account code for {account_id}")
            self.cache["accounts"][account_id] = code
        return code

    def bill(self, bill_id: str) -> dict | None:
        b = self.cache["bills"].get(bill_id)
        if b is None:
            rec = self.world.record("bill", bill_id)
            if rec is not None:
                b = _bill_snapshot(rec)
                self.cache["bills"][bill_id] = b
        return b

    # -- per source
    def _apply(self, source: str, cursor: int, rec: dict) -> int:
        """Apply one upsert. Returns the number of reducer calls made."""
        if source == "account":
            self.cache["accounts"][rec["id"]] = str(rec.get("code") or line_account_code({"account_id": rec["id"]}))
            return 0
        if source == "bill":
            snap = _bill_snapshot(rec)
            old = self.cache["bills"].get(rec["id"])
            self.cache["bills"][rec["id"]] = snap
            calls = 0
            if old != snap:
                for bl_id, entry in sorted(self.cache["bill_lines"].get(rec["id"], {}).items()):
                    if entry.get("bill") != snap:
                        self._call(R.UPSERT_BILL_LINE,
                                   R.upsert_bill_line(golden_bill_line(entry["record"], entry["cursor"], snap)))
                        entry["bill"] = snap
                        calls += 1
            return calls
        if source == "vendor":
            self._call(R.UPSERT_VENDOR, R.upsert_vendor(golden_vendor(rec, cursor)))
            return 1
        if source == "fair_value":
            self._call(R.UPSERT_FAIR_VALUE, R.upsert_fair_value(golden_fair_value(rec, cursor)))
            return 1
        if source == "bill_line":
            snap = self.bill(rec["bill_id"])
            self._call(R.UPSERT_BILL_LINE, R.upsert_bill_line(golden_bill_line(rec, cursor, snap)))
            self.cache["bill_lines"].setdefault(rec["bill_id"], {})[rec["id"]] = {
                "record": rec, "cursor": cursor, "bill": snap}
            return 1
        if source == "gl_line":
            golden = golden_gl_line(rec, cursor, self.account_code(rec["account_id"]))
            self._call(R.UPSERT_GL_LINE, R.upsert_gl_line(golden))
            self.cache["gl_lines"][rec["id"]] = _gl_snapshot(rec)
            return 1
        if source == "rulebook_issue":
            return self._apply_rulebook_issue(cursor, rec)
        raise ValueError(f"unknown source {source!r}")

    def _apply_rulebook_issue(self, cursor: int, rec: dict) -> int:
        issue = {"id": rec["id"], "published_on": rec.get("published_on"), "effective_from": rec.get("effective_from"),
                 "path": rec.get("path"), "cursor": cursor}
        is_new = rec["id"] not in self.issues["issues"]
        self.issues["issues"][rec["id"]] = issue
        latest = max(self.issues["issues"].values(),
                     key=lambda r: ((r.get("published_on") or ""), (r.get("effective_from") or ""), r["cursor"]))
        self.issues["latest"] = latest
        if is_new and rec["id"] not in self.rule_versions:
            msg = (f"rule change: {rec['id']} published {issue['published_on']}, effective from "
                   f"{issue['effective_from']}; rebuild rulebook (make rulebook, then "
                   f"uv run python -m agents.bootstrap --reload-rulebook)")
            self.warnings.append(msg)
            log.warning(msg)
        return 0

    def _apply_delete(self, source: str, cursor: int, rec: dict) -> int:
        """A deleted gl line becomes a zero-amount VOID upsert. Other sources have no void form."""
        if source != "gl_line":
            raise ValueError(f"delete op is not supported for source {source!r}")
        rid = rec.get("id")
        if not rid:
            raise ValueError("delete op without an id")
        base = self.cache["gl_lines"].get(rid)
        if base is None and all(rec.get(k) is not None for k in GL_REQUIRED):
            base = _gl_snapshot(rec)
        if base is None:
            fetched = self.world.record("gl_line", rid)
            if fetched and all(fetched.get(k) is not None for k in GL_REQUIRED):
                base = _gl_snapshot(fetched)
        if base is None:
            raise ValueError(f"delete of gl_line {rid}: no previous version in the sync cache or the world")
        merged = dict(base)
        merged.update({k: v for k, v in rec.items() if v is not None and k not in ("amount_minor", "amount_usd_minor", "memo")})
        voided = void_gl_line(merged)
        self._call(R.UPSERT_GL_LINE, R.upsert_gl_line(golden_gl_line(voided, cursor, self.account_code(voided["account_id"]))))
        self.cache["gl_lines"][rid] = voided
        return 1

    def _apply_change(self, source: str, ch: dict) -> tuple[int, bool]:
        """Apply one change in isolation. Returns (reducer calls, dead_lettered). Transport errors propagate."""
        cur = int(ch["cursor"])
        op = ch.get("op", "upsert")
        rec = ch.get("record")
        try:
            if not isinstance(rec, dict):
                raise ValueError(f"change has no record (op {op!r})")
            if op == "upsert":
                return self._apply(source, cur, rec), False
            if op == "delete":
                return self._apply_delete(source, cur, rec), False
            raise ValueError(f"unknown op {op!r}")
        except RECORD_ERRORS as e:
            self.dead_letter(source, cur, rec if isinstance(rec, dict) else None, op, e)
        except StdbError as e:
            if _is_transient(e):
                raise
            self.dead_letter(source, cur, rec if isinstance(rec, dict) else None, op, e)
        return 0, True

    def run_once(self) -> dict[str, dict[str, Any]]:
        """One pass over every source. Per source: {"records", "calls", "cursor"} plus "dead" (count,
        only when > 0) and "error" (message, only when the source stopped early)."""
        stats: dict[str, dict[str, Any]] = {}
        self.warnings = []
        total_dead = 0
        try:
            for source in ORDER:
                seen = calls = dead = 0
                error: str | None = None
                after = self.cursors.get(source, 0)
                try:
                    for ch in self.world.iter_changes(source, after, self.page_size):
                        cur = int(ch["cursor"])
                        if cur <= self.cursors.get(source, 0):
                            continue  # defensive: never re-apply at or below the cursor
                        n, dl = self._apply_change(source, ch)
                        calls += n
                        dead += dl
                        self.cursors[source] = cur  # advances past dead-lettered records too
                        seen += 1
                except (WorldError, StdbError, httpx.HTTPError, OSError) as e:  # transport: stop this source, keep the others
                    error = f"{type(e).__name__}: {e}"
                    log.error("source %s stopped at cursor %s: %s", source, self.cursors.get(source, 0), error)
                st: dict[str, Any] = {"records": seen, "calls": calls, "cursor": self.cursors.get(source, 0)}
                if dead:
                    st["dead"] = dead
                if error:
                    st["error"] = error
                stats[source] = st
                total_dead += dead
        finally:
            self.save()
        if total_dead:
            self.warnings.append(f"{total_dead} record(s) dead-lettered this run -> {self.dead_letter_path}")
        return stats


def summary(stats: dict[str, dict[str, Any]]) -> str:
    parts = []
    for k, v in stats.items():
        s = f"{k}:{v['records']}rec/{v['calls']}calls@{v['cursor']}"
        if v.get("dead"):
            s += f"/{v['dead']}dead"
        if v.get("error"):
            s += "/STOPPED"
        parts.append(s)
    dead = sum(v.get("dead", 0) for v in stats.values())
    stopped = [k for k, v in stats.items() if v.get("error")]
    tail = f" | dead-lettered: {dead}"
    if stopped:
        tail += f" | stopped: {', '.join(stopped)}"
    return " ".join(parts) + tail


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.sync",
                                 description="Sync world records into golden rows (identity: sync).")
    ap.add_argument("--once", action="store_true", help="one pass over every source (default)")
    ap.add_argument("--loop", action="store_true", help="repeat every --interval seconds")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)
    stdb, actor = StdbClient(), identities.get("sync")
    try:
        db_epoch = epoch.current_epoch(stdb, actor.token)
        if db_epoch is None:
            print("sync: the module has no db_epoch setting; run `uv run python -m agents.bootstrap` first",
                  file=sys.stderr)
            return 2
        s = Sync(WorldClient(), stdb, actor, db_epoch=db_epoch)
    except epoch.EpochMismatch as e:
        print(f"sync refused: {e}", file=sys.stderr)
        return 2
    while True:
        stats = s.run_once()
        print(summary(stats))
        for w in s.warnings:
            print(f"warning: {w}", file=sys.stderr)
        for k, v in stats.items():
            if v.get("error"):
                print(f"warning: source {k} stopped early (will retry): {v['error']}", file=sys.stderr)
        if not args.loop:
            return 0
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
