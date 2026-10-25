"""The books: race entries posted to the ERP through the gateway key, or held for a person's review.

    post(state, entries, sink) -> list[Posting]     # new entries since the last call
    apply_reviews(state, sink) -> list[Posting]     # held entries a person decided, and failed posts retried

Each new entry is either posted now or held. It is held when

    a) a crash line behind it waits for a person (its effect is `needs_person`: Jev was unsure)  -> controller
    b) the amount is material, using the thresholds the two desks already use:
         >= $1,000,000  CFO               finance/config.py CFO_CENTS, finance/kernel.py K10 ("the CFO as well at $1M")
         >=   $250,000  Head of Cost Cap  finance/config.py MATERIALITY_CENTS = agents/config.py MATERIALITY_USD_MINOR;
                                          system_of_work/REDUCERS.md `materiality`: at or above it only the
                                          human_head_of_cost_cap may approve, the controller decides below it
    c) the entry is outside the cap (`recognition == 'excluded'`, an FIA fine)  -> Head of Cost Cap confirms the exclusion

The highest role wins (cfo > head_of_cost_cap > controller) and every reason is kept. Otherwise the desk posts it on
its own authority. A held entry reaches the ERP only after a person approves it in the dashboard
(decideRacePosting); a rejected one never does.

The journal entry (POST /erp/journal_entries on the world API, :8010, header X-Gateway-Key):

    statutory lines, mapped to the ERP's accounts:
        expense codes (6050, 5200, 6300, 6910) -> acct-<code> (world/company.py ACCOUNTS, already in the ERP)
        1400 inventory: race spares            -> capadj-RACE_SPARES_INVENTORY_1400
        2100 accrued liabilities: race costs   -> capadj-RACE_ACCRUED_COSTS_2100
      (Meridian's chart has no balance-sheet accounts and the ERP accepts only acct-<existing code> or the cost cap
      sub-ledger pattern cap(cat|adj)-<NAME>. The ERP is the cost cap sub-ledger book (agents/gateway.py), where the
      counter side of an expense is not a cap question, so it sits on an offset account the way the gateway's
      capadj-NOTIONAL_OFFSET does. If world/ adds acct-1400 and acct-2100, BALANCE_ACCOUNTS below maps to them.)
    the cost cap classification, in the gateway's style (agents/gateway.py classification_lines):
        Dr capcat-<category> / Cr acct-<code>   per expense account, sides swapped for a reversal
      category: RELEVANT when the entry counts against the cap, else the account's own default (6910 -> FINES), so
      after classification every acct-* nets to zero and every dollar sits in exactly one category.

work_item_id is the entry key plus a hash of its lines, so the ERP is idempotent: posting the same entry twice returns the
same ERP id, while a rebuilt weekend whose entry under the same key carries other amounts posts as its own entry
(the ERP mock's journal outlives a pit-wall reset).

Works offline: with no pit-wall sink (or a disabled one) nothing is sent to the ERP, because a posting the desk cannot
record would be an ERP entry without its audit row; the entry comes back `failed` with that reason and is retried
when a sink is back. With the ERP down the entry is `failed` with the error and retried on a later call.
RACE_ERP=off turns posting off; RACE_ERP_URL (else WORLD_URL, else http://localhost:8010) and GATEWAY_KEY
(else 'dev-gateway-key', world/api.py's default) say where and how.

Not done: pushing the entry into the cost-cap-desk module. Its only way in is a gl_line from sync, then a proposal,
an approval and the gateway's own `post`, which would book a second ERP entry for the same money.
"""

from __future__ import annotations

import hashlib
import json

import os
import time

import httpx

from finance.config import CFO_CENTS, MATERIALITY_CENTS
from race.events import Entry, Posting, now_iso
from world.company import ACCOUNT

DEFAULT_ERP_URL = "http://localhost:8010"
DEFAULT_GATEWAY_KEY = "dev-gateway-key"
BALANCE_ACCOUNTS = {"1400": "capadj-RACE_SPARES_INVENTORY_1400", "2100": "capadj-RACE_ACCRUED_COSTS_2100"}
ROLE_RANK = {"": 0, "controller": 1, "head_of_cost_cap": 2, "cfo": 3}
READ_EVERY_S = 1.0  # how often apply_reviews reads race_postings
RETRY_EVERY_S = 5.0  # how often a failed post is tried again
TIMEOUT = httpx.Timeout(5.0, connect=1.5)

_http: httpx.Client | None = None


def _client() -> httpx.Client:
    global _http
    if _http is None:
        _http = httpx.Client(timeout=TIMEOUT)
    return _http


def erp_url() -> str:
    return (os.environ.get("RACE_ERP_URL") or os.environ.get("WORLD_URL") or DEFAULT_ERP_URL).rstrip("/")


def _usd(cents: int) -> str:
    return f"${cents / 100:,.0f}"


def _desk(state) -> dict:
    """Bookkeeping kept on the weekend state: ERP ids already returned, what to retry, when we last looked."""
    d = state.__dict__.get("_erp_desk")
    if d is None:
        d = {"erp_ids": {}, "retry": set(), "approver": {}, "last_read": 0.0, "last_retry": 0.0}
        state.__dict__["_erp_desk"] = d
    return d


def _usable(sink) -> bool:
    return sink is not None and not getattr(sink, "disabled", False)


# ---------------------------------------------------------------------------------------------- review
def _effect_of(entry: Entry, state):
    for ev, effs in getattr(state, "effects", []) or []:
        for n, e in enumerate(effs):
            if f"{ev.key}:{n}" == entry.effect_key:
                return e
    return None


def review_for(entry: Entry, state) -> tuple[str, list[str]]:
    """(review role, reasons). An empty role means the desk may post it on its own authority."""
    role, why = "", []

    def need(r: str, reason: str) -> None:
        nonlocal role
        why.append(reason)
        if ROLE_RANK[r] > ROLE_RANK[role]:
            role = r

    amt = entry.amount_cents
    eff = _effect_of(entry, state)
    if (eff is not None and eff.status == "needs_person") or (eff is None and "waits for a person" in entry.memo.lower()):
        need("controller", "the crash line behind it waits for a person (Jev was unsure of the estimate)")
    if amt >= CFO_CENTS:
        need("cfo", f"{_usd(amt)} is at or above the CFO's $1,000,000 threshold (finance/kernel.py K10)")
    elif amt >= MATERIALITY_CENTS:
        need("head_of_cost_cap", f"{_usd(amt)} is at or above the $250,000 materiality the Head of Cost Cap decides "
                                 "(cost cap desk REDUCERS.md `materiality`)")
    if entry.recognition == "excluded":
        need("head_of_cost_cap", "it is booked outside the cap (an FIA fine); the Head of Cost Cap confirms the exclusion")
    return role, why


def _auto_reason(entry: Entry, state) -> str:
    eff = _effect_of(entry, state)
    who = f", decided by {eff.decided_by} ({eff.status})" if eff is not None else ""
    return (f"posted on the desk's authority: {_usd(entry.amount_cents)} is under the $250,000 review threshold, "
            f"{entry.recognition.replace('_', ' ')}{who}")


# ---------------------------------------------------------------------------------------------- journal entry
def erp_account(code: str) -> str:
    if code in ACCOUNT:
        return f"acct-{code}"
    if code in BALANCE_ACCOUNTS:
        return BALANCE_ACCOUNTS[code]
    raise ValueError(f"no ERP account for {code}: add it to world/company.py ACCOUNTS or race/erp.py BALANCE_ACCOUNTS")


def _pair(debit: str, credit: str, amount: int) -> list[dict]:
    if amount < 0:
        debit, credit, amount = credit, debit, -amount
    return [{"account_id": debit, "debit_minor": amount, "credit_minor": 0},
            {"account_id": credit, "debit_minor": 0, "credit_minor": amount}]


def category_for(entry: Entry, code: str, year: int) -> str | None:
    if entry.cap_relevant:
        return "RELEVANT"
    a = ACCOUNT.get(code)
    if a is None:
        return None
    default = a["default_2025"] if year <= 2025 else a["default"]
    return None if default == "RELEVANT" else default  # not counted, but the account says it would be: left unclassified


def journal_entry(entry: Entry, year: int = 2026) -> dict:
    """The balanced body for POST /erp/journal_entries."""
    lines = []
    for ln in entry.lines:
        acct = erp_account(ln.account)
        if ln.debit_cents:
            lines.append({"account_id": acct, "debit_minor": int(ln.debit_cents), "credit_minor": 0})
        if ln.credit_cents:
            lines.append({"account_id": acct, "debit_minor": 0, "credit_minor": int(ln.credit_cents)})
    net: dict[str, int] = {}
    for ln in entry.lines:
        if ln.account in ACCOUNT:
            net[ln.account] = net.get(ln.account, 0) + int(ln.debit_cents) - int(ln.credit_cents)
    for code, amount in net.items():
        cat = category_for(entry, code, year)
        if cat and amount:
            lines += _pair(f"capcat-{cat}", f"acct-{code}", amount)
    d = sum(x["debit_minor"] for x in lines)
    c = sum(x["credit_minor"] for x in lines)
    if d != c:
        raise ValueError(f"journal entry for {entry.entry_key} does not balance: {d} != {c}")
    day = entry.effective_date or (entry.at or now_iso())[:10]
    refs = list(dict.fromkeys([*entry.evidence, f"race_entry:{entry.entry_key}"] + ([f"incident:{entry.incident_key}"] if entry.incident_key else [])))
    digest = hashlib.sha256(json.dumps(lines, sort_keys=True).encode()).hexdigest()[:12]
    return {"work_item_id": f"{entry.entry_key}#{digest}", "period_key": day[:7], "lines": lines,
            "memo": f"Race desk {entry.recognition}: {entry.memo}"[:500], "evidence_refs": refs}


class ErpError(RuntimeError):
    def __init__(self, message: str, retry: bool):
        super().__init__(message)
        self.retry = retry


def send(body: dict) -> str:
    """POST one journal entry; the ERP's id, or ErpError saying whether a retry could help."""
    if os.environ.get("RACE_ERP", "on").lower() in ("off", "0", "false"):
        raise ErpError("ERP posting is off (RACE_ERP=off)", retry=False)
    url = f"{erp_url()}/erp/journal_entries"
    key = os.environ.get("GATEWAY_KEY") or DEFAULT_GATEWAY_KEY
    try:
        r = _client().post(url, json=body, headers={"X-Gateway-Key": key})
    except httpx.HTTPError as exc:
        raise ErpError(f"ERP unreachable at {erp_url()} ({type(exc).__name__}); will retry", retry=True) from exc
    if r.status_code == 200:
        erp_id = (r.json() or {}).get("erp_entry_id") or ""
        if not erp_id:
            raise ErpError("ERP answered without an erp_entry_id; will retry", retry=True)
        return erp_id
    detail = r.text.strip()[:240]
    if r.status_code in (401, 403):
        raise ErpError(f"ERP refused the gateway key (HTTP {r.status_code}): {detail}", retry=False)
    if r.status_code == 409:
        raise ErpError(f"ERP already holds this entry with different lines (HTTP 409): {detail}", retry=False)
    if r.status_code == 422:
        raise ErpError(f"ERP rejected the entry (HTTP 422): {detail}", retry=False)
    raise ErpError(f"ERP error HTTP {r.status_code}: {detail}; will retry", retry=r.status_code >= 500)


def _post_one(state, entry: Entry, sink, *, reason: str, by: str = "race_desk", review_role: str = "") -> Posting:
    desk = _desk(state)
    base = dict(entry_key=entry.entry_key, incident_key=entry.incident_key, amount_cents=entry.amount_cents,
                review_role=review_role, by=by)
    if not _usable(sink):
        desk["retry"].add(entry.entry_key)
        return Posting(status="failed", reason=f"not sent to the ERP: no pit-wall sink to record the posting (dry run). {reason}", **base)
    erp_id = desk["erp_ids"].get(entry.entry_key)
    if not erp_id:
        try:
            erp_id = send(journal_entry(entry, int(getattr(state, "year", 0) or 2026)))
        except (ErpError, ValueError) as exc:
            if getattr(exc, "retry", False):
                desk["retry"].add(entry.entry_key)
            else:
                desk["retry"].discard(entry.entry_key)
            return Posting(status="failed", reason=f"{exc}. {reason}", **base)
        desk["erp_ids"][entry.entry_key] = erp_id
    desk["retry"].discard(entry.entry_key)
    return Posting(status="posted", erp_entry_id=erp_id, reason=f"{reason}; ERP {erp_id}", **base)


# ---------------------------------------------------------------------------------------------- the two calls
def post(state, entries: list[Entry], sink) -> list[Posting]:
    out = []
    for e in entries:
        try:
            role, why = review_for(e, state)
            if role:
                out.append(Posting(entry_key=e.entry_key, incident_key=e.incident_key, status="held", amount_cents=e.amount_cents,
                                   review_role=role, reason="held for review: " + "; ".join(why)))
            else:
                out.append(_post_one(state, e, sink, reason=_auto_reason(e, state)))
        except Exception as exc:  # the replay must go on; the entry says what went wrong
            _desk(state)["retry"].add(e.entry_key)
            out.append(Posting(entry_key=e.entry_key, incident_key=e.incident_key, status="failed", amount_cents=e.amount_cents,
                               reason=f"not posted: {type(exc).__name__}: {exc}"))
    return out


def _sql_str(v) -> str:
    if isinstance(v, (list, tuple)) and v:
        v = v[0]
    return str(v or "")


def apply_reviews(state, sink) -> list[Posting]:
    """Held entries a person approved go to the ERP (by 'race_desk after <approver>'); rejected ones stay out.
    Failed posts are retried. Returns only postings whose status changed."""
    desk = _desk(state)
    postings: dict[str, Posting] = getattr(state, "postings", {}) or {}
    entries: dict[str, Entry] = getattr(state, "entries", {}) or {}
    out: list[Posting] = []
    now = time.monotonic()
    try:
        waiting = [k for k, p in postings.items() if p.status in ("held", "approved")]
        if waiting and _usable(sink) and now - desk["last_read"] >= READ_EVERY_S:
            desk["last_read"] = now
            rows = {_sql_str(r.get("entry_key")): r for r in sink.sql("SELECT * FROM race_postings")}
            for key in waiting:
                r, e = rows.get(key), entries.get(key)
                if r is None or e is None:
                    continue
                status, who = _sql_str(r.get("status")), _sql_str(r.get("by")) or "a person"
                cur = postings[key]
                if status == "approved":
                    desk["approver"][key] = who
                    out.append(_post_one(state, e, sink, by=f"race_desk after {who}", review_role=cur.review_role,
                                         reason=f"approved by {who} ({cur.review_role.replace('_', ' ')})"))
                elif status == "rejected" and cur.status != "rejected":
                    out.append(Posting(entry_key=key, incident_key=e.incident_key, status="rejected", amount_cents=e.amount_cents,
                                       review_role=cur.review_role, by=who, reason=f"rejected by {who}: kept out of the ERP"))
        if desk["retry"] and now - desk["last_retry"] >= RETRY_EVERY_S:
            desk["last_retry"] = now
            for key in sorted(desk["retry"]):
                cur, e = postings.get(key), entries.get(key)
                if e is None or cur is None or cur.status != "failed" or any(p.entry_key == key for p in out):
                    continue
                who = desk["approver"].get(key)
                p = _post_one(state, e, sink, by=f"race_desk after {who}" if who else "race_desk", review_role=cur.review_role,
                              reason=(f"approved by {who}, posted on retry" if who else _auto_reason(e, state) + ", posted on retry"))
                if p.status != cur.status:
                    out.append(p)
    except Exception as exc:  # never stop the replay over the books; say so once per call
        print(f"  race books: apply_reviews failed ({type(exc).__name__}: {exc})")
    return out
