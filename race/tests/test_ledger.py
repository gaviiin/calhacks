"""Stage 4, account: balanced provisional entries, recognised when the cap counts them."""

from race import ledger
from race.events import Effect, RaceEvent
from race.tests.test_logistics import incident, run, state


def ev(kind="car_stopped", car=23, at="2024-11-03T11:57:19Z", payload=None) -> RaceEvent:
    return RaceEvent(kind=kind, at=at, session_key=9627, meeting_key=1249, lap=28, driver_number=car, team_name="Williams", payload=payload or {})


def cost(bucket, mid, memo="Crash damage - car 23", status="proposed"):
    lo, hi = sorted((int(mid * 0.5), int(mid * 1.5)))
    return Effect("cost", bucket, min(lo, mid), mid, max(hi, mid), memo, "assumption", "jev", "why", {}, status)


def post(effects, st=None, inc=None, e=None):
    st = st or state()
    inc = inc or incident()
    run(inc, st)
    e = e or ev()
    st.effects.append((e, effects))
    return ledger.entries_for(inc, effects, st), e


def test_crash_lines_balance_and_say_when_the_cap_counts_them():
    effects = [cost("6050", 150_000_000), cost("5200", 13_000_000), cost("6300", 3_000_000),
               Effect("cap_headroom", "cap_headroom", 1, 1, 1, "Cap headroom", "policy", "code", "", {}, "autonomous")]
    entries, e = post(effects)
    by = {x.entry_key: x for x in entries}
    assert set(by) == {f"{e.key}:0:first_use", f"{e.key}:1:incurred", f"{e.key}:2:incurred"}
    parts = by[f"{e.key}:0:first_use"]
    assert parts.cap_relevant and parts.recognition == "first_use" and parts.amount_cents == 150_000_000
    assert [(l.account, l.debit_cents, l.credit_cents) for l in parts.lines] == [("6050", 150_000_000, 0), ("1400", 0, 150_000_000)]
    assert "expensed when first used" in parts.memo and "not booked again" in parts.memo
    labour = by[f"{e.key}:1:incurred"]
    assert [(l.account, l.credit_cents > 0) for l in labour.lines] == [("5200", False), ("2100", True)]
    assert all(x.status == "proposed" and x.effect_key.startswith(e.key) for x in entries)
    assert sum(x.amount_cents for x in entries) == 166_000_000


def test_entries_are_idempotent_by_key():
    st = state()
    effects = [cost("6050", 50_000_000)]
    a, _ = post(effects, st)
    b = ledger.entries_for(st.incidents["1249-9627-23-1"], effects, st)
    assert [x.entry_key for x in a] == [x.entry_key for x in b] and [x.wire() | {"at": ""} for x in a] == [x.wire() | {"at": ""} for x in b]


def test_a_downward_revision_is_a_balanced_reversal():
    entries, _ = post([cost("6050", -20_000_000, memo="Crash damage revision - car 23")])
    (x,) = entries
    assert x.amount_cents == 20_000_000
    assert [(l.account, l.debit_cents, l.credit_cents) for l in x.lines] == [("1400", 20_000_000, 0), ("6050", 0, 20_000_000)]
    assert "reversal" in x.memo
    assert all(l.debit_cents >= 0 and l.credit_cents >= 0 for l in x.lines)


def test_a_fine_is_outside_the_cap():
    e = ev("penalty", payload={"what": "FINE", "reason": "UNSAFE RELEASE"})
    entries, _ = post([cost("6910", 1_100_000, memo="FIA fine - car 23")], e=e)
    (x,) = entries
    assert not x.cap_relevant and x.recognition == "excluded" and "Art. 3.1(m)" in x.memo
    assert x.lines[0].account == "6910" and x.lines[1].account == "2100"


def test_a_part_with_no_stock_is_incurred_not_first_use():
    st = state()
    for part in st.spares:
        st.spares[part] = {"at_track": 0, "factory": 0}
    entries, _ = post([cost("6050", 100_000_000)], st)
    assert {x.recognition for x in entries} == {"incurred"}
    assert all(x.lines[1].account == "2100" for x in entries)
