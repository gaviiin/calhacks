"""The response plan: the team's reaction to an incident as one object the chief of staff approves.

    plan = build(incident, state)      # idempotent for the incident's current actions and entries
    learn(state, posting)              # a posted entry becomes a case in the team's history
    learn_approval(state, plan)        # an approved plan's operations become cases

A plan lists the hardware operations the playbook set off (race/logistics.py) and the financial entries that follow
(race/ledger.py), one line each. Every line is broken into components, one per part (a first-use entry covering five
spares is five components, a freight booking of three parts is one line with its own amount), and each component is
matched against the team's own history (race/history.py). A line is `precedent` when every component has a case close
enough; otherwise `novel`, and the line says which component the team has never done. A large or compound request
never passes on its total: it passes component by component, or not at all.

The chief of staff approves the plan as a whole, before anything irreversible runs. Reservations, work orders, inventory
moves and drafts are reversible and run ahead of the approval; execution (the ERP posting, freight, notices) waits for
it. After approval, lines with a precedent execute on their own, whatever their amount, and novel lines wait for the
Head of Cost Cap. A person's decision on a novel line becomes the precedent for next time.
"""

from __future__ import annotations

from race import logistics, prices as P
from race.events import Action, Entry, Incident, Plan, Posting
from race.history import MIN_SIMILARITY, OperationStore

DESK_ONLY = ("garage_check", "withdraw_car")  # a person's own call, not an operation the desk executes


def _usd(cents: int) -> str:
    return f"${cents / 100:,.0f}"


def _store(state) -> OperationStore:
    s = getattr(state, "history", None)
    if s is None:
        s = OperationStore.load()
        try:
            state.history = s
        except AttributeError:
            pass
    return s


def _part_label(part: str) -> str:
    return "monocoque" if part == "chassis" else P.PART_LABELS.get(part, part.replace("_", " "))


def _mid(part: str) -> int:
    return P.PARTS[part].usd_cents()[1] if part in P.PARTS else 0


# ---------------------------------------------------------------------- components

_LABEL_TO_PART = {v: k for k, v in P.PART_LABELS.items()} | {"monocoque": "chassis"}


def _memo_parts(memo: str) -> list[str]:
    """The parts a ledger memo names: "Spares fitted to car 43: floor and diffuser, front wing - counts when fitted"."""
    head = memo.split(" - counts")[0].split(". ")[0]
    if ":" not in head:
        return []
    tail = head.split(":", 1)[1]
    out = []
    for bit in tail.split(","):
        part = _LABEL_TO_PART.get(bit.strip().lower())
        if part and part not in out:
            out.append(part)
    return out


def _entry_components(e: Entry, inc: Incident, state) -> list[dict]:
    """One component per part the entry covers (the allocation's parts, else the memo's), its amount split by price-book
    mid; labour and freight are one each."""
    expense = next((ln.account for ln in e.lines if ln.account in ("6050", "5200", "6300", "6910")), "")
    amount = e.amount_cents
    if expense == "6050":
        try:
            alloc = logistics.allocate(inc, state)
        except (KeyError, ValueError, TypeError):
            alloc = {}
        # the parts the entry pays for: the current belief's allocation (the amount is the whole crash's estimate, however
        # few parts the memo named when it was first raised), else the parts the memo names
        if e.recognition == "first_use":
            parts = [p for p, a in alloc.items() if a["source"] != "make"]
        else:
            parts = [p for p, a in alloc.items() if a["source"] == "make"]
        if not parts:
            parts = _memo_parts(e.memo)
        if e.recognition == "incurred" and "chassis" in parts:
            # the tub: a new monocoque or a repair at Grove, whichever the belief says
            b = logistics.belief_of(inc, state)["parts"]
            if b.get("chassis_repair", 0.0) > b.get("chassis", 0.0):
                parts = ["chassis_repair" if p == "chassis" else p for p in parts]
        if not parts:
            return [{"part": "", "label": "crash damage parts", "account": expense, "recognition": e.recognition, "amount_cents": amount}]
        # the entry's amount split by each part's price-book mid: every component then sits at the same ratio to what
        # its part has cost before, so a booking above the team's history is caught part by part, and a
        # probability-weighted booking below it passes (race/history.py's one-sided guard)
        w = {p: _mid(p) or 1 for p in parts}
        total = sum(w.values()) or 1
        out = []
        left = amount
        for i, p in enumerate(parts):
            share = amount - sum(x["amount_cents"] for x in out) if i == len(parts) - 1 else int(round(amount * w[p] / total))
            left -= share
            out.append({"part": p, "label": _part_label(p), "account": expense, "recognition": e.recognition, "amount_cents": share})
        return out
    label = {"5200": "repair labour", "6300": "air freight of replacement parts", "6910": "FIA fine"}.get(expense, e.memo[:40])
    return [{"part": "", "label": label, "account": expense, "recognition": e.recognition, "amount_cents": amount}]


def _action_components(a: Action) -> list[dict]:
    d = a.detail or {}
    if a.kind == "spares_reserve":
        part = str(d.get("part") or "")
        return [{"part": part, "label": _part_label(part), "amount_cents": _mid(part)}]
    if a.kind == "work_order":
        part = str(d.get("part") or "")
        return [{"part": part, "label": f"rebuild {_part_label(part)}", "amount_cents": _mid(part)}]
    if a.kind in ("hand_carry", "freight"):
        band = d.get("cost_cents") or [0, 0, 0]
        return [{"part": "", "label": a.kind.replace("_", " "), "amount_cents": int(band[1] if len(band) > 1 else 0)}]
    if a.kind == "td017_move":
        parts = sorted({str(m.get("part")) for m in d.get("moves") or [] if m.get("part")})
        return [{"part": p, "label": f"inventory move, {_part_label(p)}", "amount_cents": 0} for p in parts] or [{"part": "", "label": "inventory move", "amount_cents": 0}]
    return [{"part": "", "label": a.kind.replace("_", " "), "amount_cents": 0}]


def _match(store: OperationStore, kind: str, comp: dict) -> dict:
    view = {"kind": kind, "part": comp.get("part") or "", "account": comp.get("account") or "", "recognition": comp.get("recognition") or "",
            "amount_cents": int(comp.get("amount_cents") or 0)}
    case, sim = store.match(view)
    near = store.nearest(view, 1)
    nearest = near[0][1] if near else None
    return {**comp, "status": "precedent" if case else "novel", "similarity": round(sim, 3),
            "precedent": {"case_id": case.case_id, "similarity": round(sim, 3), "summary": case.summary} if case else None,
            "nearest": {"case_id": nearest.case_id, "summary": nearest.summary, "amount_cents": nearest.amount_cents} if nearest and not case else None}


def _why_novel(comps: list[dict]) -> str:
    bits = []
    for c in comps:
        if c["status"] == "precedent":
            continue
        n = c.get("nearest")
        if n and n.get("amount_cents") and c.get("amount_cents"):
            bits.append(f"{c['label']} at {_usd(c['amount_cents'])} (the closest case was {_usd(n['amount_cents'])}, {n['summary'][:60]})")
        elif n:
            bits.append(f"{c['label']} (closest: {n['summary'][:60]})")
        else:
            bits.append(f"{c['label']}: nothing like it on the record")
    return "; ".join(bits)[:400]


def _line(ref: str, kind: str, label: str, comps: list[dict], *, owner: str = "", action_status: str = "") -> dict:
    status = "precedent" if comps and all(c["status"] == "precedent" for c in comps) else "novel"
    best = [c for c in comps if c.get("precedent")]
    top = min(best, key=lambda c: c["similarity"]) if best else None
    return {"ref": ref, "kind": kind, "label": label[:120], "amount_cents": sum(int(c.get("amount_cents") or 0) for c in comps),
            "status": status, "why": "" if status == "precedent" else _why_novel(comps),
            "precedent": top["precedent"] if top and status == "precedent" else None,
            "owner_role": owner, "action_status": action_status,
            "components": [{k: v for k, v in c.items() if k != "nearest"} | ({"nearest": c["nearest"]} if c.get("nearest") else {}) for c in comps]}


# ---------------------------------------------------------------------- the plan

def build(inc: Incident, state) -> Plan:
    store = _store(state)
    ik = inc.incident_key
    lines: list[dict] = []
    for a in sorted((x for x in (state.actions or {}).values() if x.incident_key == ik), key=lambda x: x.action_key):
        if a.kind in DESK_ONLY or a.status == "cancelled":
            continue
        comps = [_match(store, a.kind, c) for c in _action_components(a)]
        lines.append(_line(a.action_key, a.kind, a.title, comps, owner=a.owner_role, action_status=a.status))
    for e in sorted((x for x in (state.entries or {}).values() if x.incident_key == ik), key=lambda x: x.entry_key):
        if e.entry_key.endswith(":adj"):
            base = next((x for x in lines if x["ref"] == e.entry_key[:-4]), None)
            if base is not None:  # an adjustment follows the entry it adjusts
                lines.append({**base, "ref": e.entry_key, "label": f"{base['label'][:90]} (adjustment)", "amount_cents": e.amount_cents})
                continue
        comps = [_match(store, "entry", c) for c in _entry_components(e, inc, state)]
        lines.append(_line(e.entry_key, "entry", e.memo.split(" - counts")[0].split(". ")[0], comps))
    ops = sum(1 for x in lines if x["kind"] != "entry")
    ents = len(lines) - ops
    novel = [x for x in lines if x["status"] == "novel"]
    summary = (f"Car {inc.driver_number}: {ops} operation{'s' if ops != 1 else ''} and {ents} entr{'ies' if ents != 1 else 'y'}; "
               f"{len(lines) - len(novel)} on precedent, {len(novel)} novel"
               + (f" ({'; '.join(x['label'][:40] for x in novel[:3])}{'…' if len(novel) > 3 else ''})" if novel else "") + ".")
    prior = (getattr(state, "plans", {}) or {}).get(ik)
    plan = Plan(plan_key=ik, incident_key=ik, version=inc.version, lines=lines, summary=summary, updated_at=inc.updated_at or state.now)
    if prior is not None and prior.status != "draft":  # an approval stands across versions
        plan.status, plan.approved_by, plan.approved_at = prior.status, prior.approved_by, prior.approved_at
    return plan


def same(a: Plan | None, b: Plan) -> bool:
    return a is not None and (a.lines, a.summary, a.status) == (b.lines, b.summary, b.status)


# ---------------------------------------------------------------------- learning

def _weekend_name(state) -> str:
    info = getattr(state, "info", {}) or {}
    return str(info.get("name") or info.get("meeting_name") or f"meeting {getattr(state, 'meeting_key', '')}")


def learn(state, posting: Posting) -> int:
    """A posted entry's components join the team's history, so the afternoon's crash matches the morning's."""
    if posting.status != "posted":
        return 0
    plan = (getattr(state, "plans", {}) or {}).get(posting.incident_key)
    line = plan.line(posting.entry_key) if plan else None
    if line is None:
        return 0
    store = _store(state)
    n = 0
    for c in line.get("components") or []:
        store.learn_entry(posting.entry_key, c.get("part") or "", c.get("account") or "", c.get("recognition") or "", int(c.get("amount_cents") or 0),
                          at=posting.at, weekend=_weekend_name(state), by=posting.by, summary=f"{_weekend_name(state)}: {line['label']}")
        n += 1
    return n


def learn_approval(state, plan: Plan) -> int:
    """An approved plan's operations join the history (the entries join when they post)."""
    if plan.status != "approved":
        return 0
    store = _store(state)
    n = 0
    for line in plan.lines:
        if line.get("kind") == "entry":
            continue
        for c in line.get("components") or []:
            store.learn_action(line["ref"], line["kind"], c.get("part") or "", int(c.get("amount_cents") or 0), at=plan.approved_at,
                               weekend=_weekend_name(state), by=plan.approved_by, summary=f"{_weekend_name(state)}: {line['label']}")
            n += 1
    return n


__all__ = ["build", "same", "learn", "learn_approval", "MIN_SIMILARITY"]
