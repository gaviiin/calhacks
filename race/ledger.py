"""Stage 4, account: balanced provisional entries for an incident, each saying when the cost cap counts it.

    entries = entries_for(incident, effects, state)   # idempotent by entry_key

One entry per money effect (and recognition), keyed from the effect's own key, so a replay or a second call
posts nothing new. Amounts are the effect's mid; a revision posts its delta, and a downward revision is a
balanced reversal (debit and credit swapped, amounts positive), because the module refuses negative lines.

When the cap counts it (2021-25 Financial Regulations Issue 22 for 2024; 2026 Section D):
- a spare fitted from stock counts on first use: Dr 6050 crash damage repairs & race spares / Cr 1400 inventory;
- a part made new, repair labour and freight count as incurred: Dr 6050, 5200 or 6300 / Cr 2100 accrued liabilities;
- an FIA fine never counts: Dr 6910 / Cr 2100, excluded (Issue 22 Art. 3.1(m); 2026 D5.1.1.m);
- the destroyed part itself was expensed when it was first used (D6.1.1.e, Issue 22 inventory rules), so it is
  not booked again; the parts entry's memo says so.

Expense codes are Meridian's chart (world/company.py); that chart has no balance-sheet accounts, so the two
counter-accounts are defined here (BALANCE_ACCOUNTS).
"""

from __future__ import annotations

from race import logistics, prices as P
from race.events import Effect, Entry, EntryLine, Incident, RaceEvent, event_key

BALANCE_ACCOUNTS = {"1400": "Inventory: race spares", "2100": "Accrued liabilities: race costs"}
INVENTORY, ACCRUED = "1400", "2100"
EXPENSE = {"6050": "Crash damage repairs & race spares", "5200": "Contract & agency staff", "6300": "Freight & logistics",
           "6910": "FIA fines & penalties"}
FINE_BUCKETS = ("6910", "fine")
REG = {2024: ("Issue 22 Art. 3.1(m)", "D6.1.1.e / Issue 22 inventory rules"), 2026: ("D5.1.1.m", "D6.1.1.e")}


def _reg(year: int) -> tuple[str, str]:
    return REG[2024] if year <= 2025 else REG[2026]


def _event_of(effects: list[Effect], state) -> RaceEvent | None:
    for ev, effs in reversed(getattr(state, "effects", []) or []):
        if effs is effects:
            return ev
    return None


def _first_use_share(inc: Incident | None, state) -> tuple[float, list[str], list[str]]:
    """(share of the parts cost that comes out of stock, parts from stock, parts made new), weighted by price."""
    if inc is None:
        return 1.0, [], []
    try:
        alloc = logistics.allocate(inc, state)
    except (KeyError, ValueError, TypeError):
        alloc = {}
    if not alloc:
        return 1.0, [], []
    stock = [p for p, a in alloc.items() if a["source"] != "make"]
    made = [p for p, a in alloc.items() if a["source"] == "make"]
    w = {p: P.PARTS[p].mid if p in P.PARTS else 1.0 for p in alloc}
    total = sum(w.values()) or 1.0
    return sum(w[p] for p in stock) / total, stock, made


def _lines(expense: str, credit: str, amount: int, memo: str, reverse: bool) -> list[EntryLine]:
    dr, cr = (credit, expense) if reverse else (expense, credit)
    return [EntryLine(dr, debit_cents=amount, memo=memo), EntryLine(cr, credit_cents=amount, memo=memo)]


def _labels(parts: list[str]) -> str:
    return ", ".join("monocoque" if p == "chassis" else P.PART_LABELS.get(p, p) for p in parts)


def entries_for(inc: Incident | None, effects: list[Effect], state) -> list[Entry]:
    ev = _event_of(effects, state)
    ik = inc.incident_key if inc is not None else ""
    car = inc.driver_number if inc is not None else (ev.driver_number if ev else 0)
    year = int(getattr(state, "year", 0) or 2026)
    fine_reg, inv_reg = _reg(year)
    out: list[Entry] = []
    for n, e in enumerate(effects):
        if e.kind != "cost" or not e.mid_cents or (e.bucket not in EXPENSE and e.bucket not in FINE_BUCKETS):
            continue
        if ev is not None:
            key, at, evidence = f"{ev.key}:{n}", ev.at, [ev.key]
        else:
            key = event_key("ledger", 0, e.bucket, car, 0, getattr(inc, "updated_at", ""), f"{ik}|{n}|{e.memo}")
            at, evidence = getattr(inc, "updated_at", "") or getattr(state, "now", ""), []
        day = (at or "")[:10]
        amount, reverse = abs(int(e.mid_cents)), e.mid_cents < 0
        revision = "revision" in e.memo.lower()
        tag = " (reversal of an earlier estimate)" if reverse else (" (revision delta)" if revision else "")
        waits = " Waits for a person: Jev was unsure." if e.status == "needs_person" else ""
        common = dict(incident_key=ik, effective_date=day, effect_key=key, evidence=evidence, at=at)

        if e.bucket in FINE_BUCKETS:
            memo = f"FIA fine - car {car}{tag}: outside the cap ({fine_reg})."
            out.append(Entry(entry_key=f"{key}:excluded", memo=memo, recognition="excluded", cap_relevant=False,
                             lines=_lines("6910", ACCRUED, amount, "FIA fine accrued", reverse), **common))
            continue

        if e.bucket == "6050":
            share, stock, made = _first_use_share(inc, state)
            used = int(round(amount * share))
            new = amount - used
            destroyed = (f" The destroyed parts ({_labels(stock + made)}) were expensed when first used ({inv_reg}): not booked again."
                         if stock or made else f" The destroyed parts were expensed when first used ({inv_reg}): not booked again.")
            if used:
                memo = (f"Spares fitted to car {car}{tag}: {_labels(stock) or 'crash damage parts'} - counts when fitted (first use).{destroyed}{waits}")
                out.append(Entry(entry_key=f"{key}:first_use", memo=memo, recognition="first_use", cap_relevant=True,
                                 lines=_lines("6050", INVENTORY, used, "spares out of inventory on first use", reverse), **common))
            if new:
                memo = f"New manufacture for car {car}{tag}: {_labels(made)} - none in stock, counts as incurred.{waits}"
                out.append(Entry(entry_key=f"{key}:incurred", memo=memo, recognition="incurred", cap_relevant=True,
                                 lines=_lines("6050", ACCRUED, new, "new parts accrued", reverse), **common))
            continue

        what = {"5200": f"Repair labour - car {car}", "6300": f"Air freight of replacement parts - car {car}"}[e.bucket]
        memo = f"{what}{tag} - counts as incurred.{waits}"
        out.append(Entry(entry_key=f"{key}:incurred", memo=memo, recognition="incurred", cap_relevant=True,
                         lines=_lines(e.bucket, ACCRUED, amount, f"{EXPENSE[e.bucket].lower()} accrued", reverse), **common))
    return out
