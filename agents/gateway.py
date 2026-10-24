"""Gateway: the only writer to the system of record. Identity: gateway (role gateway).

May: read APPROVED work items, POST journal entries to the ERP mock with X-Gateway-Key, and call
`post(workItemId, erpEntryId)`. May not: propose, approve or change anything else. No agent has the
gateway key or this identity.

Journal entry design (cost cap sub-ledger)
------------------------------------------
Entries are booked to the cost cap sub-ledger (a separate book in the ERP, not the statutory
ledger), in USD minor units because the cap is measured in USD and FX was applied once at sync:

  * the sub-ledger mirrors each statutory expense account under its own id (`acct-6410`), so an
    unclassified line sits on its source account;
  * classifying a line moves it to a cap category clearing account `capcat-<CATEGORY_CODE>`:
        Dr capcat-<category>   |amount_usd_minor|
        Cr <source account_id> |amount_usd_minor|
    (sides swap for a negative line, e.g. a credit note), so after a month is fully classified the
    acct-* balances in the sub-ledger are zero and every dollar sits in exactly one category;
  * ADJ_RELATED_PARTY_FAIR_VALUE: the line itself is reclassified to capcat-RELEVANT, plus a
    notional uplift to fair value, pro rata to the line: uplift = amount * (FV - CV) / CV:
        Dr capcat-ADJ_RELATED_PARTY_FAIR_VALUE  uplift
        Cr capadj-NOTIONAL_OFFSET               uplift
    (the uplift is not a cash cost; the offset account keeps the sub-ledger balanced);
  * an allocated item (SCHEMA §11.1, proposed_category_code "ALLOCATED"): one journal line pair
    per allocation, each moving that allocation's amount from the source account to its own
    category (a cap_limit_excess allocation is RELEVANT; an ADJ_RELATED_PARTY_FAIR_VALUE allocation
    adds its uplift pair, uplift = its cap effect - its amount);
  * kind="reversal" (REDUCERS.md: posting backs the original out in full and books the reversal's
    own corrected amount): the original entry with debits and credits swapped (from the gateway's
    own record of what it posted, else rebuilt from the original item, allocation by allocation
    when it was allocated), plus the corrected line booked under the reversal's proposed category
    or allocations.

Category limits (SCHEMA §11.1): before the ERP call the gateway checks limit_ledger; a post that
would take a limited category past its limit is not sent to the ERP (the module would deny it as
cap_limit_exceeded), so the item stays APPROVED for the analyst's split to be redone.

Idempotency: an item is posted to the ERP at most once. Before every ERP call we re-read the item
(must still be APPROVED, period not locked) and check agents/state/gateway_posted.json; the ERP body
carries work_item_id as the idempotency key. If the ERP call succeeded but the `post` reducer did
not, the next run reuses the recorded erp_entry_id and only retries the reducer.

Usage:
  GATEWAY_KEY=... uv run python -m agents.gateway --once
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any

from . import config, epoch, identities
from . import reducers as R
from .identities import Actor
from .stdb import StdbClient, sql_quote
from .tools import parse_refs
from .world_client import WorldClient

log = logging.getLogger("agents.gateway")

ADJ_RP = "ADJ_RELATED_PARTY_FAIR_VALUE"
NOTIONAL_OFFSET = "capadj-NOTIONAL_OFFSET"


class UnbalancedEntry(ValueError):
    pass


def cap_account(category_code: str) -> str:
    return f"capcat-{category_code}"


def _pair(debit_acct: str, credit_acct: str, amount: int) -> list[dict]:
    if amount < 0:
        debit_acct, credit_acct, amount = credit_acct, debit_acct, -amount
    return [{"account_id": debit_acct, "debit_minor": amount, "credit_minor": 0},
            {"account_id": credit_acct, "debit_minor": 0, "credit_minor": amount}]


def fair_value_uplift(gl: dict, fv: dict | None) -> int:
    """USD minor units to add so the line counts at the higher of invoiced cost and Fair Value
    (D6.1.1.a.i). One fair_value row prices one invoice's scope (world/PATTERNS.md: the monthly
    recharge, the dyno programme), so the gap is fair value minus what was actually invoiced, in the
    invoice currency, converted with the line's own rate. Comparing against the schedule's contract
    value instead would miss a recharge keyed at a tenth of its value (plant P15).

    No uplift on a negative line (a credit note is not a purchase below fair value). Fails closed:
    a fair value in another currency than the invoice raises, so the gateway refuses to post and
    the item stays APPROVED for a person to look at."""
    if not fv:
        return 0
    if int(gl["amount_minor"]) <= 0:
        return 0
    if (fv.get("currency") or "") != (gl.get("currency") or ""):
        raise ValueError(f"fair value {fv.get('id')} is in {fv.get('currency')!r} but {gl['id']} is in "
                         f"{gl.get('currency')!r}")
    gap = int(fv["fair_value_minor"]) - int(gl["amount_minor"])
    if gap <= 0:
        return 0
    return round(gap * int(gl["fx_rate_e6"]) / 1_000_000)


def uplift_for(item: dict | None, gl: dict, fv: dict | None, amount: int) -> int:
    """The uplift to book: when the proposal carries a validated cap effect (SCHEMA §10, the
    analyst computed amount + uplift at propose time), the uplift is cap_effect - amount, so the
    ERP and cap_position agree; otherwise recompute from the fair value row."""
    cap = (item or {}).get("cap_effect_usd_minor")
    if cap is not None:
        return max(0, int(cap) - amount)
    return fair_value_uplift(gl, fv)


def classification_lines(category_code: str, gl: dict, fv: dict | None = None, amount: int | None = None,
                         item: dict | None = None) -> list[dict]:
    amount = int(gl["amount_usd_minor"] if amount is None else amount)
    if category_code == ADJ_RP:
        lines = _pair(cap_account("RELEVANT"), gl["account_id"], amount)
        uplift = uplift_for(item, gl, fv, amount)
        if uplift:
            lines += _pair(cap_account(ADJ_RP), NOTIONAL_OFFSET, uplift)
        return [l for l in lines if l["debit_minor"] or l["credit_minor"]]
    return [l for l in _pair(cap_account(category_code), gl["account_id"], amount) if l["debit_minor"] or l["credit_minor"]]


ALLOCATED = R.ALLOCATED


def allocation_lines(allocations: list[dict], gl: dict) -> list[dict]:
    """One journal line pair per allocation (plus the uplift pair of a fair value allocation)."""
    out: list[dict] = []
    for a in sorted(allocations, key=lambda r: (int(r.get("line_no", 0)), int(r.get("id", 0)))):
        out += classification_lines(a["category_code"], gl, None, amount=int(a["amount_usd_minor"]),
                                    item={"cap_effect_usd_minor": a.get("cap_effect_usd_minor")})
    return out


def _booking_lines(item: dict, gl: dict, fair_value: dict | None, allocations: list[dict] | None,
                   amount: int | None = None) -> list[dict]:
    if item.get("proposed_category_code") == ALLOCATED:
        if not allocations:
            raise ValueError(f"item {item['id']} is ALLOCATED but has no allocation rows")
        total = sum(int(a["amount_usd_minor"]) for a in allocations)
        want = int(item.get("amount_usd_minor", gl["amount_usd_minor"]) if amount is None else amount)
        if total != want:
            raise UnbalancedEntry(f"allocations of item {item['id']} sum to {total}, not {want}")
        return allocation_lines(allocations, gl)
    return classification_lines(item["proposed_category_code"], gl, fair_value, amount=amount, item=item)


def _describe(item: dict, allocations: list[dict] | None) -> str:
    if item.get("proposed_category_code") == ALLOCATED and allocations:
        return "ALLOCATED[" + ", ".join(f"{a.get('basis')}:{a.get('basis_ref')}={a['category_code']} "
                                        f"{a['amount_usd_minor']}" for a in allocations) + "]"
    return f"{item['proposed_category_code']} ({item.get('proposed_rulebook_entry_id')})"


def reverse_lines(lines: list[dict]) -> list[dict]:
    return [{"account_id": l["account_id"], "debit_minor": l["credit_minor"], "credit_minor": l["debit_minor"]}
            for l in lines]


def check_balanced(lines: list[dict]) -> None:
    if len(lines) < 2:
        raise UnbalancedEntry("a journal entry needs at least two lines")
    for l in lines:
        if l["debit_minor"] < 0 or l["credit_minor"] < 0 or (l["debit_minor"] and l["credit_minor"]):
            raise UnbalancedEntry(f"bad line {l}")
    d = sum(l["debit_minor"] for l in lines)
    c = sum(l["credit_minor"] for l in lines)
    if d != c:
        raise UnbalancedEntry(f"debits {d} != credits {c}")


def build_journal_entry(item: dict, gl: dict, *, fair_value: dict | None = None,
                        original: dict | None = None, original_gl: dict | None = None,
                        original_lines: list[dict] | None = None,
                        original_fair_value: dict | None = None,
                        allocations: list[dict] | None = None,
                        original_allocations: list[dict] | None = None) -> dict:
    """Balanced JE body for POST /erp/journal_entries (see module docstring for the accounts).

    For a reversal, `gl` is the corrected line and `original_lines` (if the gateway recorded them)
    or `original` + `original_gl` (+ `original_allocations` when it was allocated) describe what was
    posted before. `allocations` are this item's allocation rows when it is ALLOCATED."""
    if item.get("kind") == "reversal":
        if original is None:
            raise ValueError("reversal needs the original work item")
        if original_lines is None:
            og = original_gl or gl
            original_lines = _booking_lines(original, og, original_fair_value, original_allocations,
                                            amount=int(original.get("amount_usd_minor", og["amount_usd_minor"])))
        lines = reverse_lines(original_lines)
        lines += _booking_lines(item, gl, fair_value, allocations,
                                amount=int(item.get("amount_usd_minor", gl["amount_usd_minor"])))
        memo = (f"WI-{item['id']} reversal of WI-{original['id']} (ERP {original.get('erp_entry_id')}), re-booked "
                f"{gl['id']} -> {_describe(item, allocations)}: {item.get('reason') or ''}")
    else:
        lines = _booking_lines(item, gl, fair_value, allocations)
        memo = f"WI-{item['id']} {gl['id']} -> {_describe(item, allocations)}: {item.get('reason') or ''}"
    check_balanced(lines)
    refs = parse_refs(item.get("evidence_refs")) + [f"work_item:{item['id']}", gl.get("raw_ref") or gl["id"]]
    refs += [f"allocation:{a['id']}" for a in allocations or [] if a.get("id") is not None]
    return {
        "work_item_id": str(item["id"]),
        "period_key": item.get("period_key") or gl["period_key"],
        "lines": lines,
        "memo": memo[:500],
        "evidence_refs": list(dict.fromkeys(r for r in refs if r)),
    }


class Gateway:
    def __init__(self, world: WorldClient, stdb: StdbClient, actor: Actor, gateway_key: str,
                 ledger_path: Path | None = None):
        if not gateway_key:
            raise ValueError("GATEWAY_KEY is not set")
        self.world, self.stdb, self.actor, self.key = world, stdb, actor, gateway_key
        self.ledger_path = Path(ledger_path or config.GATEWAY_LEDGER_PATH)
        # SCHEMA §10 "Epoch": a ledger written against a republished database must not be replayed
        # (it would mark new items as posted with old ERP ids). Refuses naming the file.
        self.epoch = epoch.current_epoch(stdb, actor.token)
        raw = epoch.load_json(self.ledger_path, self.epoch, {}) or {}
        # work_item_id -> {"erp_entry_id", "lines"}; a bare string is an older record
        self.ledger: dict[str, dict] = {k: (v if isinstance(v, dict) else {"erp_entry_id": v, "lines": None})
                                        for k, v in raw.items()}

    def _save(self) -> None:
        epoch.save_json(self.ledger_path, self.epoch, self.ledger)  # stamped with the module's epoch

    def _sql(self, q: str) -> list[dict]:
        return self.stdb.sql(self.actor.token, q)

    def _one(self, table: str, col: str, v: Any) -> dict | None:
        rows = self._sql(f"SELECT * FROM {table} WHERE {col} = {v if isinstance(v, int) else sql_quote(v)}")
        return rows[0] if rows else None

    def _locked(self, period_key: str) -> bool:
        p = self._one("period", "key", period_key)
        return bool(p and p.get("locked"))

    def _fv_from_refs(self, item: dict) -> dict | None:
        for ref in parse_refs(item.get("evidence_refs")):
            if ref.startswith("fv-"):
                fv = self._one("fair_value", "id", ref)
                if fv:
                    return fv
        return None

    def _gl_from_refs(self, item: dict) -> dict | None:
        for ref in parse_refs(item.get("evidence_refs")):
            if ":" not in ref and ref.startswith("gl-"):
                g = self._one("gl_line", "id", ref)
                if g:
                    return g
        return None

    def _allocations(self, item: dict) -> list[dict] | None:
        if item.get("proposed_category_code") != ALLOCATED:
            return None
        rows = self._sql(f"SELECT * FROM allocation WHERE work_item_id = {int(item['id'])}")
        return sorted(rows, key=lambda r: (int(r.get("line_no", 0)), int(r.get("id", 0))))

    def _limit_problem(self, item: dict) -> str | None:
        """SCHEMA §11.1: would posting take a limited EXCLUDED category past its limit?"""
        from . import policy as pol

        period = item.get("period_key") or ""
        allocs = self._allocations(item)
        parts = ([(a["category_code"], int(a["amount_usd_minor"])) for a in allocs] if allocs is not None
                 else [(item.get("proposed_category_code"), int(item.get("amount_usd_minor") or 0))])
        totals: dict[str, int] = {}
        for code, amt in parts:
            totals[code] = totals.get(code, 0) + amt
        rulebook = None
        for code, amt in totals.items():
            if amt <= 0 or not code:
                continue
            rulebook = rulebook if rulebook is not None else self._sql("SELECT * FROM rulebook_entry")
            e = pol.rulebook_entry_in_force(rulebook, code, period)
            if not e or e.get("treatment") != "EXCLUDED" or e.get("cap_limit_usd_minor") is None:
                continue
            led = self._one("limit_ledger", "key", f"{period[:4]}|{code}")
            remaining = int(e["cap_limit_usd_minor"]) - int((led or {}).get("excluded_usd_minor") or 0)
            if amt > remaining:
                return f"cap_limit_exceeded: {code} {amt} > remaining {remaining}; needs a cap_limit_excess split"
        return None

    def _entry_for(self, item: dict) -> dict:
        fv = self._fv_from_refs(item) if item.get("proposed_category_code") == ADJ_RP else None
        allocations = self._allocations(item)
        if item.get("kind") == "reversal":
            orig = self._one("work_item", "id", int(item["subject_ref"]))
            if orig is None:
                raise ValueError(f"reversal {item['id']}: original {item['subject_ref']} not found")
            orig_gl = self._one("gl_line", "id", orig["subject_ref"])
            gl = self._gl_from_refs(item) or orig_gl
            if gl is None:
                raise ValueError(f"reversal {item['id']}: no corrected gl line")
            recorded = (self.ledger.get(str(orig["id"])) or {}).get("lines")
            ofv = self._fv_from_refs(orig) if orig.get("proposed_category_code") == ADJ_RP else None
            return build_journal_entry(item, gl, fair_value=fv, original=orig, original_gl=orig_gl,
                                       original_lines=recorded, original_fair_value=ofv, allocations=allocations,
                                       original_allocations=self._allocations(orig))
        gl = self._one("gl_line", "id", item["subject_ref"])
        if gl is None:
            raise ValueError(f"item {item['id']}: gl line {item['subject_ref']} not found")
        return build_journal_entry(item, gl, fair_value=fv, allocations=allocations)

    def post_item(self, item: dict) -> dict:
        wid = str(item["id"])
        fresh = self._one("work_item", "id", int(item["id"]))
        if fresh is None or fresh.get("state") != "APPROVED":
            return {"work_item_id": wid, "status": "skipped", "note": f"state is {fresh and fresh.get('state')}"}
        if self._locked(fresh.get("period_key")):
            return {"work_item_id": wid, "status": "skipped", "note": f"period {fresh.get('period_key')} locked"}
        rec = self.ledger.get(wid)
        reused = rec is not None
        if rec is None:
            limit = self._limit_problem(fresh)
            if limit:
                return {"work_item_id": wid, "status": "skipped", "note": limit}
            body = self._entry_for(fresh)
            rec = {"erp_entry_id": self.world.post_journal_entry(body, self.key), "lines": body["lines"]}
            self.ledger[wid] = rec
            self._save()  # before the reducer call: a crash here must not cause a second ERP post
        erp_id = rec["erp_entry_id"]
        self.stdb.call(self.actor.token, R.POST, R.post(int(item["id"]), erp_id))
        after = self._one("work_item", "id", int(item["id"])) or {}
        ok = after.get("state") == "POSTED"
        return {"work_item_id": wid, "status": "posted" if ok else "erp_only", "erp_entry_id": erp_id,
                "reused_erp_entry": reused, "note": None if ok else f"post reducer left state {after.get('state')}"}

    def run_once(self) -> list[dict]:
        items = sorted(self._sql("SELECT * FROM work_item WHERE state = 'APPROVED'"), key=lambda r: int(r["id"]))
        out = []
        for item in items:
            try:
                out.append(self.post_item(item))
            except Exception as e:
                log.exception("posting item %s failed", item.get("id"))
                out.append({"work_item_id": str(item.get("id")), "status": "error", "note": f"{type(e).__name__}: {e}"})
        return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.gateway",
                                 description="Post APPROVED work items to the ERP mock (identity: gateway).")
    ap.add_argument("--once", action="store_true", help="post every APPROVED item once and exit (default)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING)
    key = config.Config.from_env().gateway_key
    if not key:
        print("GATEWAY_KEY is not set (see SCHEMA.md §8)", file=sys.stderr)
        return 2
    gw = Gateway(WorldClient(), StdbClient(), identities.get("gateway"), key)
    results = gw.run_once()
    for r in results:
        print(f"{r['work_item_id']:>6} {r['status']:<8} {r.get('erp_entry_id') or '':<18} {r.get('note') or ''}")
    print(f"{sum(1 for r in results if r['status'] == 'posted')} posted, {len(results)} considered")
    return 0


if __name__ == "__main__":
    sys.exit(main())
