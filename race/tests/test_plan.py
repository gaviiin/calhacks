"""The response plan: the team's reaction to an incident, line by line against its own history."""

from __future__ import annotations

from race import history, logistics, plan as plan_mod, prices as P
from race.events import Incident
from race.history import OpCase, OperationStore
from race.tests.test_logistics import incident, state


def test_the_amount_guard_is_one_sided():
    case = OpCase("c", "entry", "front_wing", "6050", "first_use", 12_700_000)
    view = {"kind": "entry", "part": "front_wing", "account": "6050", "recognition": "first_use"}
    assert history.similarity({**view, "amount_cents": 12_700_000}, case) == 1.0
    assert history.similarity({**view, "amount_cents": 8_000_000}, case) == 1.0  # a probability-weighted booking below the price
    assert history.similarity({**view, "amount_cents": 15_000_000}, case) > history.MIN_SIMILARITY  # 18% over: inside the band
    assert history.similarity({**view, "amount_cents": 30_000_000}, case) < history.MIN_SIMILARITY  # a wing at twice its price is new
    assert history.similarity({**view, "amount_cents": 12_700_000}, OpCase("d", "entry", "floor", "6050", "first_use", 12_700_000)) < history.MIN_SIMILARITY


def test_the_2024_history_has_no_new_monocoque_built_mid_season():
    store = OperationStore.load()
    assert len(store) > 100
    case, sim = store.match({"kind": "entry", "part": "chassis", "account": "6050", "recognition": "incurred", "amount_cents": P.PARTS["chassis"].usd_cents()[1]})
    assert case is None, "a monocoque made new has no case: the team repaired or used the spare in 2024"
    case, sim = store.match({"kind": "entry", "part": "chassis_repair", "account": "6050", "recognition": "incurred", "amount_cents": P.PARTS["chassis_repair"].usd_cents()[1]})
    assert case is not None and "Melbourne" in case.summary


def _weekend_state():
    st = state()
    st.history = OperationStore.load()
    return st


def test_a_plan_breaks_an_entry_into_parts_and_matches_each(fake_entries=None):
    from race import ledger
    from race.events import Effect, RaceEvent

    st = _weekend_state()
    inc = incident(car=23, at="2024-11-03T11:57:19Z", kph=315)
    st.incidents[inc.incident_key] = inc
    for a in logistics.plan(inc, st):
        st.actions[a.action_key] = a
    ev = RaceEvent(kind="car_stopped", at=inc.first_seen_at, session_key=9627, meeting_key=1249, lap=0, driver_number=23, team_name="Williams")
    effs = [Effect("cost", "6050", 100_000_000, 150_000_000, 220_000_000, "Crash damage - car 23 - heavy", "assumption", "jev", "why", {}, "autonomous")]
    st.effects.append((ev, effs))
    for e in ledger.entries_for(inc, effs, st):
        st.entries[e.entry_key] = e
    p = plan_mod.build(inc, st)
    assert p.status == "draft" and p.plan_key == inc.incident_key
    kinds = {x["kind"] for x in p.lines}
    assert {"spares_reserve", "work_order", "td017_move", "evidence_pack", "entry"} <= kinds
    assert "garage_check" not in kinds and "withdraw_car" not in kinds, "a person's own calls are not lines the desk executes"
    entries = [x for x in p.lines if x["kind"] == "entry"]
    assert entries and all(len(x["components"]) >= 1 for x in entries)
    fitted = next(x for x in entries if "fitted" in x["label"].lower())
    parts = {c["part"] for c in fitted["components"]}
    assert len(parts) > 1, "a first-use entry covering several spares is matched part by part"
    assert sum(c["amount_cents"] for c in fitted["components"]) == fitted["amount_cents"]
    for c in fitted["components"]:
        assert c["status"] in ("precedent", "novel") and (c["precedent"] is None) == (c["status"] == "novel")
    assert p.precedented + p.novel == len(p.lines)
    assert "on precedent" in p.summary


def test_a_familiar_part_at_an_unfamiliar_price_is_novel_and_says_why():
    st = _weekend_state()
    st.history = OperationStore([OpCase("c", "entry", "front_wing", "6050", "first_use", 12_700_000, summary="Melbourne 2024: front wing fitted")])
    inc = incident(car=43, at="2024-11-03T10:39:00Z", kph=166)
    st.incidents[inc.incident_key] = inc
    from race.events import Entry, EntryLine

    e = Entry(entry_key="x:first_use", incident_key=inc.incident_key, memo="Spares fitted to car 43: front wing - counts when fitted", effective_date="2024-11-03",
              recognition="first_use", cap_relevant=True, lines=[EntryLine("6050", debit_cents=40_000_000), EntryLine("1400", credit_cents=40_000_000)], at=inc.first_seen_at)
    st.entries[e.entry_key] = e
    p = plan_mod.build(inc, st)
    line = p.line(e.entry_key)
    assert line is not None and line["status"] == "novel"
    assert "$400,000" in line["why"] and "the closest case was $127,000" in line["why"]


def test_a_posted_entry_becomes_the_precedent_for_the_next_one():
    from race.events import Entry, EntryLine, Posting

    st = _weekend_state()
    st.history = OperationStore()
    inc = incident(car=43, at="2024-11-03T10:39:00Z", kph=166)
    st.incidents[inc.incident_key] = inc
    e = Entry(entry_key="y:first_use", incident_key=inc.incident_key, memo="Spares fitted to car 43: front wing", effective_date="2024-11-03",
              recognition="first_use", cap_relevant=True, lines=[EntryLine("6050", debit_cents=12_000_000), EntryLine("1400", credit_cents=12_000_000)], at=inc.first_seen_at)
    st.entries[e.entry_key] = e
    first = plan_mod.build(inc, st)
    assert first.line(e.entry_key)["status"] == "novel"
    st.plans[inc.incident_key] = first
    n = plan_mod.learn(st, Posting(entry_key=e.entry_key, incident_key=inc.incident_key, status="posted", amount_cents=12_000_000, reason="r", erp_entry_id="JE-1", by="Priya Raman"))
    assert n >= 1 and len(st.history) >= 1
    again = plan_mod.build(inc, st)
    assert again.line(e.entry_key)["status"] == "precedent"
    assert again.line(e.entry_key)["precedent"]["case_id"].endswith(":front_wing") or again.line(e.entry_key)["precedent"]["case_id"]


def test_an_approval_stands_across_versions():
    st = _weekend_state()
    inc = incident(car=43, at="2024-11-03T10:39:00Z", kph=166)
    st.incidents[inc.incident_key] = inc
    for a in logistics.plan(inc, st):
        st.actions[a.action_key] = a
    p1 = plan_mod.build(inc, st)
    p1.status, p1.approved_by = "approved", "Sam Reyes"
    st.plans[inc.incident_key] = p1
    inc2 = Incident(**{**inc.__dict__, "version": inc.version + 1, "cause": "garage confirmed"})
    p2 = plan_mod.build(inc2, st)
    assert p2.version == inc.version + 1 and p2.status == "approved" and p2.approved_by == "Sam Reyes"
    n = plan_mod.learn_approval(st, p2)
    assert n == sum(len(x["components"]) for x in p2.lines if x["kind"] != "entry")
