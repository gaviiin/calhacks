"""Stage 3, respond: São Paulo 2024's two qualifying crashes, priced, and the playbook's guards."""

import json

from race import logistics
from race.events import Incident
from race.weekend import WeekendState, weekend_info

JEV_HEAVY = {"front_wing": 0.798, "floor": 0.69, "rear_wing": 0.51, "front_suspension": 0.66, "rear_suspension": 0.495, "gearbox": 0.48,
             "chassis": 0.36, "bodywork": 0.76, "power_unit": 0.21, "brakes": 0.008, "electronics": 0.36}
SEV_HEAVY = {"heavy": 0.6, "moderate": 0.3, "light": 0.08, "none": 0.02}


def state() -> WeekendState:
    st = WeekendState(meeting_key=1249, info=weekend_info(1249), team="Williams")
    st.spares = logistics.load_manifest(st)
    return st


def incident(car=23, at="2024-11-03T11:57:19Z", kph=315, session=9627, stype="Qualifying", n=1, parts=None, sev=None, version=1) -> Incident:
    return Incident(incident_key=f"1249-{session}-{car}-{n}", meeting_key=1249, session_key=session, driver_number=car, team_name="Williams",
                    first_seen_at=at, status="corroborated", version=version, updated_at=at, cause="car stopped",
                    belief={"severity": dict(sev or SEV_HEAVY), "parts": dict(JEV_HEAVY if parts is None else parts), "impact_kph": kph,
                            "session_type": stype, "lap": 28},
                    evidence=[{"event_key": "e1", "kind": "car_stopped", "at": at, "source": "telemetry", "note": f"{kph} to 0 km/h"}])


def run(inc, st):
    st.incidents[inc.incident_key] = inc
    acts = logistics.plan(inc, st)
    for a in acts:
        st.actions[a.action_key] = a
    return {a.action_key: a for a in acts}


def test_manifest_comes_from_the_weekend_file_with_its_basis():
    st = state()
    assert st.spares["front_wing"] == {"at_track": 3, "factory": 1}
    assert st.spares["chassis"]["at_track"] == 1
    data = logistics.assumptions(st)
    assert data["sources"]["vowles_spares"]["url"].startswith("https://api.fia.com/")
    assert data["chassis"]["built_2024"] == 3 and data["damage_tally_after_brazil"]["chassis"] == 2


def test_albon_q3_crash_recommends_withdrawing():
    st = state()
    acts = run(incident(), st)
    w = acts["1249-9627-23-1:withdraw_car"]
    assert w.status == "awaiting_approval" and w.owner_role == "team_principal" and w.outward and not w.reversible
    d = w.detail
    assert abs(d["hours_available"] - 3.54) < 0.01 and d["race_start"].startswith("2024-11-03T15:30")
    assert [o["id"] for o in d["options"]] == ["repair", "spare_tub", "withdraw"]
    repair, tub, _ = d["options"]
    assert not repair["feasible"] and not tub["feasible"] and tub["hours_needed"][1] > d["hours_available"]
    assert d["recommendation"] == "withdraw" and "3.5 h" in d["recommendation_why"]
    assert acts["1249-9627-23-1:fia_notice"].detail["follows"] == "withdraw"
    assert acts["1249-9627-23-1:fia_notice"].status == "awaiting_approval" and acts["1249-9627-23-1:fia_notice"].owner_role == "sporting_director"
    assert "1249-9627-23-1:spares_reserve:chassis" in acts, "a likely damaged tub takes the spare tub"
    assert w.due_at.startswith("2024-11-03T14:30")


def test_colapinto_q1_crash_recommends_repairing():
    st = state()
    acts = run(incident(car=43, at="2024-11-03T10:39:00Z", kph=166), st)
    d = acts["1249-9627-43-1:withdraw_car"].detail
    assert abs(d["hours_available"] - 4.85) < 0.01
    repair = d["options"][0]
    assert repair["feasible"] and repair["hours_needed"][1] <= d["hours_available"]
    assert d["recommendation"] == "repair"
    assert acts["1249-9627-43-1:parc_ferme_list"].status == "auto"
    assert "1249-9627-43-1:spares_reserve:chassis" not in acts


def test_plan_is_idempotent_and_keys_are_stable():
    st = state()
    inc = incident()
    first = run(inc, st)
    second = {a.action_key: a for a in logistics.plan(inc, st)}
    assert first == second
    assert all(k.startswith(inc.incident_key + ":") for k in first)
    assert all(k.split(":")[1] == a.kind for k, a in first.items())


def test_reservations_never_double_count():
    st = state()
    run(incident(car=43, at="2024-11-03T10:39:00Z", kph=166), st)
    alb = run(incident(), st)
    fw = alb["1249-9627-23-1:spares_reserve:front_wing"].detail
    assert (fw["at_track_before"], fw["at_track_after"]) == (2, 1), "Colapinto's crash took one front wing first"
    # a later version of Colapinto's incident re-plans it: the stock it holds is recomputed, not added again
    col2 = incident(car=43, at="2024-11-03T10:39:00Z", kph=166, version=2)
    run(col2, st)
    again = run(incident(version=2), st)
    assert again["1249-9627-23-1:spares_reserve:front_wing"].detail["at_track_after"] == 1


def test_a_part_no_longer_likely_is_cancelled_and_a_decision_is_kept():
    st = state()
    acts = run(incident(), st)
    key = "1249-9627-23-1:withdraw_car"
    st.actions[key].status = "approved"
    light = incident(parts={"front_wing": 0.7, "bodywork": 0.6}, sev={"light": 0.8, "none": 0.2}, kph=None, version=2)
    later = run(light, st)
    assert later["1249-9627-23-1:spares_reserve:gearbox"].status == "cancelled"
    assert later[key].status == "approved", "a person's decision is never overwritten"
    assert "1249-9627-23-1:spares_reserve:front_wing" in later and later["1249-9627-23-1:spares_reserve:front_wing"].status == "auto"
    assert len(acts) <= len(later)


def test_outward_or_irreversible_actions_wait_and_every_detail_says_why():
    st = state()
    acts = {**run(incident(car=43, at="2024-11-03T10:39:00Z", kph=166), st), **run(incident(), st),
            **run(incident(car=43, at="2024-11-03T16:36:55Z", kph=188, session=9636, stype="Race", n=2), st)}
    for a in acts.values():
        if a.outward or not a.reversible:
            assert a.status in ("awaiting_approval", "cancelled"), a.action_key
        assert isinstance(a.detail.get("why"), str) and a.detail["why"], a.action_key
        assert len(json.dumps(a.detail, separators=(",", ":"), default=str)) < 4096, a.action_key
    kinds = {a.kind for a in acts.values()}
    assert {"garage_check", "spares_reserve", "work_order", "freight", "withdraw_car", "parc_ferme_list", "fia_notice", "pu_check",
            "td017_move", "evidence_pack"} <= kinds
    assert not any(a.kind == "withdraw_car" and a.incident_key.startswith("1249-9636") for a in acts.values()), "no withdraw call in the race"


def test_late_work_order_needs_a_hand_carry():
    st = state()
    # a front wing takes 3 working days: started on 14 Nov it misses the 16 Nov air freight but makes the hand carry
    acts = run(incident(car=43, at="2024-11-14T09:00:00Z", kph=166, session=9636, stype="Race"), st)
    wo = acts["1249-9636-43-1:work_order:front_wing"]
    assert "hand carry" in wo.detail["route"]
    hc = acts["1249-9636-43-1:hand_carry"]
    assert hc.status == "awaiting_approval" and hc.outward and hc.owner_role == "logistics" and "front_wing" in hc.detail["parts"]


def test_power_unit_check_flags_the_penalty_risk():
    st = state()
    pu = run(incident(), st)["1249-9627-23-1:pu_check"].detail
    assert pu["penalty_risk"] > 0 and any(e["element"] == "ICE" and e["left"] == 0 for e in pu["elements"])
