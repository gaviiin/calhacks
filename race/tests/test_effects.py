from race.effects import EffectsContext, effects_for
from race.events import CarState, RaceEvent
from race.jev import JevAnswers, offline_decide
from race.policies import Policy, PolicyBook

TEAM_OF = {23: "Williams", 55: "Williams", 81: "McLaren", 4: "McLaren", 1: "Red Bull Racing"}
# Williams P8 (4 pts) sits P3 on 64; retiring (60) drops behind Haas (62); a win (85) passes Red Bull (65 + 15 for P3 = 80)
START = {"McLaren": 300.0, "Red Bull Racing": 65.0, "Williams": 60.0, "Haas F1 Team": 62.0, "Alpine": 20.0}


def ctx(**over) -> EffectsContext:
    c = EffectsContext(team="Williams", team_of=TEAM_OF, standings_start=dict(START), positions={23: 8, 55: 12, 81: 1, 4: 2, 1: 3}, **over)
    c.prize_position = 3  # Williams P3 on points_start among the five teams listed
    return c


def ev(kind, car=23, lap=12, payload=None, pos=8) -> RaceEvent:
    return RaceEvent(kind=kind, at="2026-05-24T16:25:37Z", session_key=11291, meeting_key=1285, lap=lap, driver_number=car,
                     team_name=TEAM_OF.get(car, ""), payload=payload or {},
                     state=CarState(car, TEAM_OF.get(car, ""), position=pos, lap=lap, updated_at="2026-05-24T16:25:37Z"))


def test_heavy_williams_incident_lands_in_the_calibrated_band():
    c = ctx()
    e = ev("retirement_suspected", payload={"last_lap": 12, "summary": "no lap since L12"})
    jev = offline_decide(e, {"team_cars": [23, 55], "retired_within_laps": 0})
    assert jev.severity == "heavy"
    effects = effects_for(e, jev, None, c)
    cost = [x for x in effects if x.kind == "cost" and x.bucket == "6050"]
    assert len(cost) == 1
    lo, mid, hi = cost[0].low_cents, cost[0].mid_cents, cost[0].high_cents
    assert lo <= mid <= hi
    # Vowles: five crashes cost $3-10m, so one heavy crash sits roughly in $0.4m-$2.5m
    assert 40_000_000 <= mid <= 250_000_000, mid
    assert cost[0].decided_by == "jev" and cost[0].status == "proposed" and cost[0].jev["severity"] == "heavy"
    assert any(x.kind == "cap_headroom" for x in effects)
    assert any(x.bucket == "5200" for x in effects), "labour is booked for a heavy repair"
    # retiring from P8 drops Williams below Haas in the projection: one place on the ladder
    prize = [x for x in effects if x.kind == "revenue_projection"]
    assert len(prize) == 1 and prize[0].mid_cents == c.world.prize(4) - c.world.prize(3) < 0


def test_second_message_about_the_same_crash_only_revises():
    c = ctx()
    e1 = ev("retirement_suspected", payload={"last_lap": 12})
    j1 = offline_decide(e1, {"team_cars": [23, 55], "retired_within_laps": 0})
    first = effects_for(e1, j1, None, c)
    booked = c.booked[23]["mid"]
    e2 = ev("incident", lap=16, payload={"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "NOTED"})
    j2 = offline_decide(e2, {"team_cars": [23, 55], "retired_within_laps": 4})
    second = effects_for(e2, j2, None, c)
    costs2 = [x for x in second if x.kind == "cost"]
    assert len(costs2) <= 1  # nothing, or one revision line
    if costs2:
        assert "revision" in costs2[0].memo.lower() and abs(costs2[0].mid_cents) < booked
    assert sum(1 for x in first if x.kind == "cost" and x.bucket == "6050") == 1
    e3 = ev("incident", lap=22, payload={"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "UNDER INVESTIGATION"})
    third = effects_for(e3, offline_decide(e3, {"team_cars": [23, 55], "retired_within_laps": 10}), None, c)
    assert [x for x in third if x.bucket == "6050" and "revision" not in x.memo.lower()] == [], "a retired car's crash is booked once"
    e4 = ev("retirement_confirmed", lap=11, payload={"dnf": True, "number_of_laps": 11})
    assert [x for x in effects_for(e4, offline_decide(e4, {"team_cars": [23, 55], "retired_within_laps": 0}), None, c) if x.kind == "cost"] == []


def test_infringement_without_damage_costs_nothing():
    c = ctx()
    e = ev("incident", payload={"car_numbers": [23], "team_involved": True, "reason": "SAFETY CAR INFRINGEMENT", "stage": "NOTED"})
    jev = offline_decide(e, {"team_cars": [23, 55]})
    assert jev.severity == "none"
    assert [x for x in effects_for(e, jev, None, c) if x.kind == "cost"] == []


def test_position_change_moves_the_prize_projection_by_one_ladder_step():
    c = ctx()
    c.positions[23] = 1  # Williams car leads: 25 points pushes Williams past Red Bull (200 + 15 for P3)
    e = ev("position", payload={"from": 8, "to": 1, "gained": 7}, pos=1)
    effects = effects_for(e, JevAnswers(), None, c)
    prize = [x for x in effects if x.kind == "revenue_projection"]
    assert len(prize) == 1
    assert prize[0].mid_cents == c.world.prize(2) - c.world.prize(3) > 0
    assert prize[0].basis == "ladder" and prize[0].decided_by == "code"


def test_podium_bonus_expected_then_lost():
    c = ctx()
    bonuses = [x for x in effects_for(ev("position", payload={"from": 8, "to": 3}, pos=3), JevAnswers(), None, c) if x.kind == "bonus"]
    assert bonuses and all(b.mid_cents > 0 and "expected" in b.memo for b in bonuses)
    lost = [x for x in effects_for(ev("retirement_suspected", payload={"last_lap": 20}, pos=3), JevAnswers(), None, c) if x.kind == "bonus"]
    assert lost and all(b.mid_cents < 0 and "lost" in b.memo for b in lost)
    assert sum(b.mid_cents for b in bonuses) + sum(b.mid_cents for b in lost) == 0


def test_granted_policy_decides_without_jev_and_is_autonomous():
    c = ctx()
    book = PolicyBook([Policy("collision-retired-heavy", {"kind": {"in": ["incident", "retirement_suspected"]}, "team_involved": True,
                                                         "retired_within_laps": {"lte": 2}}, {"severity": "heavy"}, autonomy="GRANTED")])
    e = ev("incident", payload={"car_numbers": [81, 23], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "NOTED"})
    policy = book.resolve(e, {"retired_within_laps": 1})
    assert policy is not None and policy.policy_id == "collision-retired-heavy"
    effects = effects_for(e, JevAnswers(), policy, c)
    cost = next(x for x in effects if x.bucket == "6050")
    assert cost.decided_by == "policy:collision-retired-heavy" and cost.status == "autonomous" and cost.mid_cents > 0


def test_shadow_policy_yields_proposed():
    c = ctx()
    book = PolicyBook([Policy("sc-pit-free", {"kind": "pit_stop", "under": "sc"}, {"cost": 0}, autonomy="SHADOW"),
                       Policy("light-contact", {"kind": "incident", "team_involved": True}, {"severity": "light"}, autonomy="SHADOW")])
    e = ev("incident", payload={"car_numbers": [23, 1], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "NOTED"})
    policy = book.resolve(e, {})
    assert policy.policy_id == "light-contact"
    jev = offline_decide(e, {"team_cars": [23, 55]})
    cost = next(x for x in effects_for(e, jev, policy, c) if x.bucket == "6050")
    # a shadow only watches: Jev decides, the row names the draft that would have matched
    # (offline Jev calls a plain collision light at P=0.45, under the 0.5 floor, so the line also asks a person)
    assert cost.status == "needs_person" and cost.decided_by == "jev" and "shadow policy light-contact" in cost.why


# ---------------------------------------------------------------------- the season, FX, the cap and the calibration
from race import cap_forecast, prize as ladder  # noqa: E402

JEV_PARTS = {"front_wing": 0.798, "floor": 0.69, "rear_wing": 0.51, "front_suspension": 0.66, "rear_suspension": 0.495, "gearbox": 0.48,
             "chassis": 0.36, "bodywork": 0.76, "power_unit": 0.21, "brakes": 0.008, "electronics": 0.36}
BRAZIL_TEAM_OF = {23: "Williams", 43: "Williams", 50: "Haas F1 Team", 1: "Red Bull Racing"}


def brazil_ctx() -> EffectsContext:
    return EffectsContext(team="Williams", team_of=BRAZIL_TEAM_OF, fx_date="2024-11-03", next_race_days=7, next_race_flyaway=True,
                          positions={23: 7, 43: 18})


def stop(car, kph, lap, at):
    return RaceEvent(kind="car_stopped", at=at, session_key=9627, meeting_key=1249, lap=lap, driver_number=car, team_name="Williams",
                     payload={"peak_kph": kph, "signature": "stop", "summary": f"{kph} to 0 km/h"},
                     state=CarState(car, "Williams", position=10, lap=lap, updated_at=at))


def jev_heavy() -> JevAnswers:
    return JevAnswers(relevant=0.95, severity="heavy", parts=dict(JEV_PARTS), confidence={"severity": 0.6},
                      probabilities={"severity": {"heavy": 0.6, "moderate": 0.3, "light": 0.08, "none": 0.02}})


def test_sao_paulo_weekend_lands_near_the_press_figure():
    """Albon 315 km/h, Colapinto 166 km/h in qualifying and 188 km/h in the race: about $4m (AMS via RacingNews365)."""
    total = 0
    for car, kph, lap, at in ((43, 166, 5, "2024-11-03T10:39:00Z"), (23, 315, 28, "2024-11-03T11:57:19Z"), (43, 188, 31, "2024-11-03T16:36:55Z")):
        out = effects_for(stop(car, kph, lap, at), jev_heavy(), None, brazil_ctx())
        total += sum(x.mid_cents for x in out if x.kind == "cost")
        crash = next(x for x in out if x.bucket == "6050")
        assert f"{kph} km/h" in crash.why
    contact = ev("incident", car=43, payload=dict(COLLISION_43))
    total += sum(x.mid_cents for x in effects_for(contact, offline_decide(contact, {"team_cars": [23, 43]}), None, brazil_ctx()) if x.kind == "cost")
    assert 300_000_000 <= total <= 450_000_000, total / 1e8


def test_the_hardest_hit_costs_the_most():
    a = sum(x.mid_cents for x in effects_for(stop(23, 315, 28, "2024-11-03T11:57:19Z"), jev_heavy(), None, brazil_ctx()) if x.kind == "cost")
    b = sum(x.mid_cents for x in effects_for(stop(43, 166, 5, "2024-11-03T10:39:00Z"), jev_heavy(), None, brazil_ctx()) if x.kind == "cost")
    assert a > 1.5 * b


def test_a_car_that_did_not_start_books_no_crash_again():
    c = brazil_ctx()
    c.standings_start = {"Williams": 17.0, "Alpine": 16.0, "Haas F1 Team": 46.0}
    c.team_of = {**BRAZIL_TEAM_OF, 10: "Alpine"}
    c.positions = {23: 7, 43: 12, 10: 9}
    c.prize_position = None
    effects_for(RaceEvent(kind="position", at="2024-11-03T15:31:00Z", session_key=9636, meeting_key=1249, lap=1, driver_number=10,
                          team_name="Alpine", payload={"from": 10, "to": 9}), JevAnswers(), None, c)
    dns = RaceEvent(kind="retirement_confirmed", at="2024-11-03T17:30:00Z", session_key=9636, meeting_key=1249, lap=0, driver_number=23,
                    team_name="Williams", payload={"dns": True, "dnf": False, "number_of_laps": 0},
                    state=CarState(23, "Williams", status="retired", updated_at="2024-11-03T17:30:00Z"))
    out = effects_for(dns, offline_decide(dns, {"team_cars": [23, 43], "retired_within_laps": 0}), None, c)
    assert [x for x in out if x.kind in ("cost", "cap_headroom")] == [], "the damage was booked when the car stopped in qualifying"
    assert c.positions[23] is None, "the running order still drops the car"
    assert c.prize_position is not None


def test_prize_uses_the_season_ladder():
    c = brazil_ctx()
    c.standings_start = {"Williams": 17.0, "Alpine": 16.0, "Haas F1 Team": 46.0}
    c.team_of = {**BRAZIL_TEAM_OF, 10: "Alpine"}
    c.positions = {23: 20, 43: 20, 10: 20}
    c.prize_position = 2  # Williams P2 of the three teams listed
    c.positions[10] = 1  # Alpine leads: 25 points pass Williams
    out = [x for x in effects_for(RaceEvent(kind="position", at="2024-11-03T16:00:00Z", session_key=9636, meeting_key=1249, lap=20, driver_number=10,
                                            team_name="Alpine", payload={"from": 2, "to": 1}), JevAnswers(), None, c) if x.kind == "revenue_projection"]
    assert len(out) == 1 and out[0].mid_cents == ladder.prize(2024, 3) - ladder.prize(2024, 2) < 0
    assert "2024 ladder" in out[0].why and "The Race" in out[0].why


def test_euro_bonus_is_converted_to_dollars():
    c = ctx(fx_date="2024-11-03")
    out = [x for x in effects_for(ev("position", payload={"from": 12, "to": 9}, pos=9), JevAnswers(), None, c) if x.bucket == "sponsor_bonus:volta"]
    assert out, "Volta's points-finish clause is in euros"
    rate = float(c.world.fx("EUR", "2024-11-03"))
    assert out[0].mid_cents == round(10_000_000 * rate) != 10_000_000
    assert "EUR 100,000" in out[0].why


def test_cap_headroom_uses_the_season_cap_and_what_was_booked_before():
    c = brazil_ctx()
    c.cap_relevant_cents = 100_000_000_00
    out = effects_for(stop(23, 315, 28, "2024-11-03T11:57:19Z"), jev_heavy(), None, c)
    hr = next(x for x in out if x.kind == "cap_headroom")
    assert hr.mid_cents == cap_forecast.cap_level_cents(2024) - c.cap_relevant_cents - c.race_cost_mid
    assert hr.why.startswith("2024 cap")
    assert ctx().season == 2026 and ctx(year=2024).season == 2024


COLLISION_43 = {"car_numbers": [50, 43], "team_involved": True, "reason": "CAUSING A COLLISION", "stage": "NOTED"}
