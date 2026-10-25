"""The books: race entries posted to the ERP through the gateway key, or held for a person's review.

    post(state, entries, sink) -> list[Posting]     # new entries since the last call
    apply_reviews(state, sink) -> list[Posting]     # held entries a person decided, and failed posts retried

Each new entry is either posted now or held. There is no amount threshold: an entry posts on precedent, after the
chief of staff has approved the incident's response plan (race/plan.py). It is held when

    a) a crash line behind it waits for a person (its effect is `needs_person`: Jev was unsure)  -> controller
    b) the incident's response plan is not approved yet (or there is none)                       -> chief of staff
    c) the entry has no precedent in the team's history (no case close enough, or a familiar
       part at an unfamiliar price), or is not on the plan                                        -> Head of Cost Cap
    d) the entry is outside the cap (`recognition == 'excluded'`, an FIA fine)                   -> Head of Cost Cap confirms the exclusion
    e) it adjusts an entry that is not in the ERP yet (held, failed)                             -> whoever reviews that entry

The highest role wins (cfo > head_of_cost_cap = chief_of_staff > controller) and every reason is kept.

pit-wall decides, not this file. With SpacetimeDB up, the desk asks the module to authorize each entry
(request_race_posting) and sends to the ERP only what it authorized; the module applies the rules above plus one more
(an estimate that is only Jev's or the forecast agent's waits for a person's sign-off), and the ERP gateway refuses a
race entry pit-wall has not authorized. `review_for` below is the same rule set, used only for a dry run without the
database. A held entry reaches the ERP only after a person approves it (decideRacePosting) or signs off the estimate
behind it; a rejected one never does.

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

from race.events import Entry, Posting, now_iso
from world.company import ACCOUNT

DEFAULT_ERP_URL = "http://localhost:8010"
DEFAULT_GATEWAY_KEY = "dev-gateway-key"
BALANCE_ACCOUNTS = {"1400": "capadj-RACE_SPARES_INVENTORY_1400", "2100": "capadj-RACE_ACCRUED_COSTS_2100"}
ROLE_RANK = {"": 0, "controller": 1, "head_of_cost_cap": 2, "chief_of_staff": 2, "cfo": 3}
PRECEDENT_MIN = 0.8  # race/history.py MIN_SIMILARITY, the module's PRECEDENT_MIN
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


def _plan_line(entry: Entry, state) -> tuple[object | None, dict | None]:
    plan = (getattr(state, "plans", {}) or {}).get(entry.incident_key) if entry.incident_key else None
    return plan, (plan.line(entry.entry_key) if plan is not None else None)


def _precedented(line: dict | None) -> bool:
    return bool(line) and line.get("status") == "precedent" and float((line.get("precedent") or {}).get("similarity") or 0) >= PRECEDENT_MIN


def review_for(entry: Entry, state) -> tuple[str, list[str]]:
    """(review role, reasons). An empty role means the desk may post it on its own authority."""
    role, why = "", []

    def need(r: str, reason: str) -> None:
        nonlocal role
        why.append(reason)
        if ROLE_RANK[r] > ROLE_RANK[role]:
            role = r

    eff = _effect_of(entry, state)
    if (eff is not None and eff.status == "needs_person") or (eff is None and "waits for a person" in entry.memo.lower()):
        need("controller", "the crash line behind it waits for a person (Jev was unsure of the estimate)")
    if entry.incident_key:
        plan, line = _plan_line(entry, state)
        if plan is None:
            need("chief_of_staff", "no response plan for this incident yet")
        elif plan.status == "draft":
            need("chief_of_staff", "the response plan for this incident waits for the chief of staff")
        elif plan.status == "rejected":
            need("chief_of_staff", "the response plan for this incident was rejected")
        if plan is not None and line is None:
            need("head_of_cost_cap", "the entry is not on the response plan")
        elif line is not None and not _precedented(line):
            need("head_of_cost_cap", f"no entry like it in the team's history{': ' + line['why'] if line.get('why') else ''}")
    if entry.recognition == "excluded":
        need("head_of_cost_cap", "it is booked outside the cap (an FIA fine); the Head of Cost Cap confirms the exclusion")
    if entry.entry_key.endswith(":adj"):
        orig = (getattr(state, "postings", {}) or {}).get(entry.entry_key[: -len(":adj")])
        if orig is not None and orig.status != "posted":
            who = orig.review_role or "controller"
            need(who, f"it adjusts an entry not in the ERP yet ({orig.status}, for the {who.replace('_', ' ')}): the two are reviewed together")
    return role, why


def _auto_reason(entry: Entry, state) -> str:
    eff = _effect_of(entry, state)
    who = f", decided by {eff.decided_by} ({eff.status})" if eff is not None else ""
    plan, line = _plan_line(entry, state)
    prec = (line or {}).get("precedent") or {}
    on = (f"on precedent {prec.get('case_id', '?')} (similarity {float(prec.get('similarity') or 0):.2f}) under the plan {plan.approved_by} approved"
          if plan is not None and prec else "no incident behind it")
    return f"posted on the desk's authority: {_usd(entry.amount_cents)} {on}, {entry.recognition.replace('_', ' ')}{who}"


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
def _authorize(e: Entry, sink) -> tuple[str, str, str] | None:
    """pit-wall's decision on an entry: (status, review role, reason), or None without the database."""
    if not _usable(sink) or not hasattr(sink, "request_posting"):
        return None
    row = sink.request_posting(e.entry_key, now_iso())
    if not isinstance(row, dict) or not row:
        return None
    return _sql_str(row.get("status")), _sql_str(row.get("review_role")), _sql_str(row.get("reason"))


def post(state, entries: list[Entry], sink) -> list[Posting]:
    out = []
    for e in entries:
        try:
            decision = _authorize(e, sink)
            if decision is not None:
                status, role, reason = decision
                if status in ("authorized", "approved"):
                    out.append(_post_one(state, e, sink, reason=reason, review_role=role))
                elif status != "posted":  # held (or a person already decided): pit-wall's row is the record
                    out.append(Posting(entry_key=e.entry_key, incident_key=e.incident_key, status=status if status in ("held", "rejected", "posted") else "held",
                                       amount_cents=e.amount_cents, review_role=role, reason=reason or "held by pit-wall"))
                continue
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


def reconsider(state, incident_key: str, sink) -> list[Posting]:
    """Without the database deciding (dry run), re-run the rule for the incident's held entries after its plan changed:
    the ones now clear are posted. With pit-wall up the module does this itself in the approval's transaction."""
    out: list[Posting] = []
    postings: dict[str, Posting] = getattr(state, "postings", {}) or {}
    entries: dict[str, Entry] = getattr(state, "entries", {}) or {}
    for key, cur in list(postings.items()):
        e = entries.get(key)
        if e is None or cur.status != "held" or e.incident_key != incident_key:
            continue
        if _authorize(e, sink) is not None:
            continue  # pit-wall decides: its row changes in the approval's transaction and apply_reviews posts it
        role, why = review_for(e, state)
        if role:
            if (role, why) != (cur.review_role, None) and cur.reason != "held for review: " + "; ".join(why):
                out.append(Posting(entry_key=key, incident_key=e.incident_key, status="held", amount_cents=e.amount_cents, review_role=role,
                                   reason="held for review: " + "; ".join(why)))
            continue
        out.append(_post_one(state, e, sink, reason=_auto_reason(e, state)))
    return out


def apply_reviews(state, sink) -> list[Posting]:
    """Held entries a person approved go to the ERP (by 'race_desk after <approver>'); rejected ones stay out.
    Failed posts are retried. Returns only postings whose status changed."""
    desk = _desk(state)
    postings: dict[str, Posting] = getattr(state, "postings", {}) or {}
    entries: dict[str, Entry] = getattr(state, "entries", {}) or {}
    out: list[Posting] = []
    now = time.monotonic()
    try:
        waiting = [k for k, p in postings.items() if p.status in ("held", "approved", "authorized")]
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
                elif status == "authorized" and cur.status != "authorized":  # a person signed off the estimate behind it
                    out.append(_post_one(state, e, sink, review_role=cur.review_role, reason=_sql_str(r.get("reason")) or "authorized by pit-wall"))
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
