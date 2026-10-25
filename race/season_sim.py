"""Stage 6, re-plan: the rest of the season re-run after each change in the evidence.

    run(state, trigger) -> SimRun | None

A vectorised Monte Carlo of the constructors' championship from the start of this weekend to the last round:

    standings at the weekend start (every round before this one, plus this weekend's sprint, which ran Saturday)
  + this weekend's race: sampled before it starts, conditioned on the running order while it runs, the result after
  + every remaining race and sprint, sampled

Strength is empirical: each team's finishing positions in this season's races before this round, resampled with
recency weights, DNFs included at the rate they happened. Two cars per team draw from the team's pool; the 20
draws are ranked (ties broken at random) and scored 25-18-15-12-10-8-6-4-2-1, or 8..1 in a sprint. Team pools,
not driver pools, because mid-season seat changes (Colapinto, Lawson, Bearman) make driver histories short.
Completed rounds use the points actually awarded (fastest-lap points included); simulated rounds ignore the
fastest-lap point. Ties in the final table are broken at random, not by countback.

The first run of a weekend is the baseline; every later run reports its change against it and splits the change
into "our weekend" (our cars as they actually ran, against our baseline-expected weekend, rivals as they ran)
and "rivals' weekend" (the rest). Every run of a weekend uses the same seeded draws (common random numbers), so a
change between two runs, and its split, is the evidence and not Monte Carlo noise.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

import numpy as np

from race import cap_forecast, prize as prize_mod
from race.events import SimRun, parse_iso
from race.points import RACE_POINTS, SPRINT_POINTS

RESULTS = Path(__file__).resolve().parents[1] / "world" / "results"
N = 10_000
HALF_LIFE_ROUNDS = 6.0  # a race six rounds ago counts half as much as the last one
DNF = 99
RIVALS = 4

CONSTRUCTOR_NAMES = {  # jolpica constructor_id -> OpenF1 team_name (what standings and positions use)
    "red_bull": "Red Bull Racing", "mclaren": "McLaren", "ferrari": "Ferrari", "mercedes": "Mercedes",
    "aston_martin": "Aston Martin", "alpine": "Alpine", "williams": "Williams", "rb": "RB", "sauber": "Kick Sauber",
    "haas": "Haas F1 Team", "alphatauri": "AlphaTauri", "alfa": "Alfa Romeo",
}

ATR_SOURCE = ("research/01-f1-team-finance.md (Sporting Regulations sliding scale); "
              "https://racingnews365.com/f1-2026-teams-wind-tunnel-time")
ATR_BASE_RUNS = 320  # wind-tunnel runs per eight-week period at 100%
SPONSOR_PER_POINT_CENTS = 100_000 * 100
SPONSOR_PER_PLACE_CENTS = 500_000 * 100
SPONSOR_SOURCE = "https://www.racecar.com/news/31600/motorsport/judge-orders-etihad-to-pay-for-terminated-force-india-deal"


def atr_pct(position: int) -> int:
    """Aerodynamic testing allowance for the next half-year: 7th = 100%, five points per place either side (1st 70%, 10th 115%)."""
    return 70 + 5 * (position - 1)


# ---------------------------------------------------------------------- the season so far

@lru_cache(maxsize=4)
def _season(year: int) -> dict | None:
    f = RESULTS / f"{year}.json"
    return json.loads(f.read_text()) if f.exists() else None


def _team(cid: str) -> str:
    return CONSTRUCTOR_NAMES.get(cid, cid.replace("_", " ").title())


def standings_at_start(season: dict, rnd: int) -> dict[str, float]:
    """Points before this weekend's race: every round before it, plus its sprint."""
    pts: dict[str, float] = {}
    for r in season["rounds"]:
        rows = (r["race"] if r["round"] < rnd else []) + ((r.get("sprint") or []) if r["round"] <= rnd else [])
        for x in rows:
            t = _team(x["constructor_id"])
            pts[t] = pts.get(t, 0.0) + float(x.get("points") or 0)
        for x in r["race"] + (r.get("sprint") or []):
            pts.setdefault(_team(x["constructor_id"]), 0.0)
    return pts


def pools(season: dict, rnd: int) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """Team -> (finishing positions with DNF=99, cumulative recency weights) from the races before round `rnd`."""
    out: dict[str, tuple[list[int], list[float]]] = {}
    last = max((r["round"] for r in season["rounds"] if r["round"] < rnd), default=rnd - 1)
    for r in season["rounds"]:
        if r["round"] >= rnd:
            continue
        w = 0.5 ** ((last - r["round"]) / HALF_LIFE_ROUNDS)
        for x in r["race"]:
            pos = int(x["position_text"]) if str(x.get("position_text", "")).isdigit() else DNF
            p, ws = out.setdefault(_team(x["constructor_id"]), ([], []))
            p.append(pos)
            ws.append(w)
    res = {}
    for t, (p, ws) in out.items():
        cw = np.cumsum(ws)
        res[t] = (np.array(p, dtype=np.int16), cw / cw[-1])
    return res


# ---------------------------------------------------------------------- this weekend

def _race_key(state) -> int | None:
    for k, name in (state.info.get("session_names") or {}).items():
        if name == "Race":
            return int(k)
    return None


def _out_of_race(state, race_key: int | None) -> set[int]:
    """Our cars that will not take (or have not taken) the start: the race result says DNS, an incident's belief says
    the car is out of the race once the incident is confirmed, or a withdraw-the-car action was approved."""
    out: set[int] = set()
    for r in state.results.get(race_key, []) if race_key else []:
        if r.get("dns"):
            out.add(int(r["driver_number"]))
    for inc in state.incidents.values():
        b = inc.belief or {}
        if inc.status not in ("confirmed", "assessed", "closed"):
            continue
        if b.get("dns") or b.get("out_of_race") or b.get("starts_race") is False or (b.get("out_of_session") and inc.session_key == race_key):
            out.add(int(inc.driver_number))
    for a in state.actions.values():
        if a.kind == "withdraw_car" and a.status in ("approved", "done"):
            inc = state.incidents.get(a.incident_key)
            car = (a.detail or {}).get("car") or (inc.driver_number if inc else None)
            if car:
                out.add(int(car))
    return out


def _progress(replay, now: str) -> tuple[int, int]:
    """(leader's lap now, race distance) from the laps rows; the distance is the scheduled lap count."""
    laps = replay.rows.get("laps", []) if replay else []
    total = max((int(x.get("lap_number") or 0) for x in laps), default=0)
    if not now or not total:
        return 0, total
    t = parse_iso(now)
    done = [int(x["lap_number"]) for x in laps if x.get("date_start") and parse_iso(x["date_start"]) <= t]
    return (max(done) if done else 0), total


def _remaining(state, season: dict) -> list[bool]:
    """The sessions still to run after this weekend, as is_sprint flags, in order."""
    after = [r for r in season["rounds"] if r["round"] > state.round]
    out: list[bool] = []
    for r in after:
        if r.get("has_sprint"):
            out.append(True)
        out.append(False)
    return out


# ---------------------------------------------------------------------- the simulation

def _seed(state) -> int:
    """One seed per weekend, so every trigger re-runs the same draws: two runs differ by the evidence, never by noise."""
    return int.from_bytes(hashlib.sha256(f"season|{state.meeting_key}|{state.year}".encode()).digest()[:4], "big")


def _draw(rng, teams: list[str], pool: dict, shape: tuple[int, ...]) -> np.ndarray:
    """Base finishing positions for (…, 2 cars per team) slots: car 2t and 2t+1 belong to teams[t]."""
    out = np.empty(shape + (2 * len(teams),), dtype=np.int16)
    for t, team in enumerate(teams):
        p, cw = pool.get(team, (np.array([15, DNF], dtype=np.int16), np.array([0.85, 1.0])))
        idx = np.searchsorted(cw, rng.random(shape + (2,)), side="right")
        out[..., 2 * t:2 * t + 2] = p[np.minimum(idx, len(p) - 1)]
    return out


def _score(score: np.ndarray, dnf: np.ndarray, sprint: np.ndarray | bool, rng) -> np.ndarray:
    """Per-slot points from scores (lower is better), DNFs scoring nothing."""
    s = np.where(dnf, 1000.0, score) + rng.random(score.shape) * 0.999
    rank = np.argsort(np.argsort(s, axis=-1), axis=-1)  # 0-based finishing order
    race_t = np.array([RACE_POINTS.get(i + 1, 0) for i in range(score.shape[-1])], dtype=np.float32)
    sprint_t = np.array([SPRINT_POINTS.get(i + 1, 0) for i in range(score.shape[-1])], dtype=np.float32)
    pts = np.where(np.asarray(sprint)[..., None], sprint_t[rank], race_t[rank])
    return np.where(dnf, 0.0, pts)


def _team_points(slot_pts: np.ndarray) -> np.ndarray:
    return slot_pts.reshape(slot_pts.shape[:-1] + (slot_pts.shape[-1] // 2, 2)).sum(-1)


def simulate(state, trigger: str, n: int = N) -> dict | None:
    season = _season(state.year)
    if season is None:
        return None
    rng = np.random.default_rng(_seed(state))
    start = standings_at_start(season, state.round)
    teams = sorted(start, key=lambda t: (-start[t], t))
    pool = pools(season, state.round)
    us = teams.index(state.team) if state.team in teams else None
    if us is None:
        return None
    race_key = _race_key(state)
    replay = state.replay
    team_of = dict(replay.team_of) if replay else {}
    cars_of = {t: sorted(c for c, tt in team_of.items() if tt == t)[:2] for t in teams}
    slot = {c: 2 * t + i for t, team in enumerate(teams) for i, c in enumerate(cars_of.get(team, []))}
    out_cars = _out_of_race(state, race_key)
    final = race_key in state.results and bool(state.results.get(race_key))
    live = (not final and replay is not None and int(replay.session.get("session_key") or 0) == race_key
            and len([p for p in replay.ctx.positions.values()]) >= 10)

    # this weekend's race: the unconditioned draw (the baseline view) and what we know now
    base = _draw(rng, teams, pool, (n,)).astype(np.float32)
    dnf0 = base >= DNF
    pos0 = np.where(dnf0, 0, base)
    uncond = _score(pos0, dnf0, False, rng)
    phase = "sampled"
    if final:
        actual = np.zeros(2 * len(teams), dtype=np.float32)
        for r in state.results[race_key]:
            c = int(r["driver_number"])
            if c in slot:
                actual[slot[c]] = float(r.get("points") if r.get("points") is not None else RACE_POINTS.get(r.get("position") or 0, 0))
        now_pts = np.broadcast_to(actual, uncond.shape)
        phase = "result"
    else:
        score = pos0.copy()
        dnf = dnf0.copy()
        if live:
            lap, total = _progress(replay, state.now)
            f = lap / total if total else 0.0
            w = min(1.0, 0.25 + 0.75 * f)  # the grid already says something; the order says more as laps run out
            phase = f"live lap {lap}/{total}" if total else "live"
            survive = rng.random(base.shape) < f  # a DNF in the pool happens in the laps still to run
            for c, p in replay.ctx.positions.items():
                if c not in slot:
                    continue
                k = slot[c]
                if p is None:
                    dnf[:, k] = True
                    continue
                late = dnf0[:, k] & ~survive[:, k]
                sample = np.where(dnf0[:, k], float(p), pos0[:, k])
                score[:, k] = w * float(p) + (1 - w) * sample
                dnf[:, k] = late
        for c in out_cars:
            if c in slot:
                dnf[:, slot[c]] = True
        now_pts = _score(score, dnf, False, rng) if (live or out_cars) else uncond
        if out_cars and not live:
            phase = "sampled, " + ", ".join(f"car {c} out" for c in sorted(out_cars))
    ours = slice(2 * us, 2 * us + 2)
    cf_pts = np.array(now_pts, copy=True)
    cf_pts[:, ours] = uncond[:, ours]

    # the rest of the season
    sprints = np.array(_remaining(state, season), dtype=bool)
    if len(sprints):
        fut = _draw(rng, teams, pool, (n, len(sprints))).astype(np.float32)
        fd = fut >= DNF
        rest = _team_points(_score(np.where(fd, 0, fut), fd, sprints[None, :], rng)).sum(1)
    else:
        rest = np.zeros((n, len(teams)), dtype=np.float32)
    start_v = np.array([start[t] for t in teams], dtype=np.float32)
    tie = rng.random((n, len(teams))) * 1e-3

    def table(weekend_slots: np.ndarray):
        tot = start_v + _team_points(weekend_slots) + rest
        order = np.argsort(np.argsort(-(tot + tie), axis=1), axis=1) + 1
        return tot, order

    tot, pos = table(now_pts)
    _, pos_cf = table(cf_pts)
    return {"teams": teams, "start": start, "us": us, "tot": tot, "pos": pos, "pos_cf": pos_cf, "phase": phase,
            "weekend_points": _team_points(now_pts)[:, us], "out_cars": sorted(out_cars), "n": n, "seed": _seed(state),
            "remaining_sessions": int(len(sprints))}


# ---------------------------------------------------------------------- the payload

def _dist(pos: np.ndarray, places: int) -> list[float]:
    c = np.bincount(pos, minlength=places + 1)[1:places + 1]
    return [round(float(x) / len(pos), 4) for x in c]


def _m(c: float) -> str:
    sign = "−" if c < 0 else "+"
    return f"{sign}${abs(c) / 1e8:.1f}m"


def _baseline(state) -> dict | None:
    for s in state.sims:
        if s.trigger == "baseline" and s.meeting_key == state.meeting_key:
            return s.payload
    return state.sims[0].payload if state.sims else None


def run(state, trigger: str) -> SimRun | None:
    sim = simulate(state, trigger)
    if sim is None:
        return None
    teams, us, pos, pos_cf = sim["teams"], sim["us"], sim["pos"], sim["pos_cf"]
    places = len(teams)
    me = pos[:, us]
    target = sorted(teams, key=lambda t: -sim["start"][t]).index(state.team) + 1
    p_target = float(np.mean(me <= target))
    lad = prize_mod.ladder(state.year)
    lad_v = np.array([0] + [lad.get(i, lad[max(lad)]) for i in range(1, places + 1)], dtype=np.int64)
    prize_now = lad_v[me]
    prize_cf = lad_v[pos_cf[:, us]]
    e_prize = float(prize_now.mean())
    pts_us = sim["tot"][:, us]
    sponsor = SPONSOR_PER_POINT_CENTS * pts_us + SPONSOR_PER_PLACE_CENTS * np.maximum(0, 10 - me)
    atr = np.array([atr_pct(p) for p in me])

    base = _baseline(state)
    if base is None or trigger == "baseline":
        pb, eb, sb, ab = p_target, e_prize, float(sponsor.mean()), float(atr.mean())
    else:
        pb = float(base.get("p_target", p_target))
        eb = float((base.get("prize") or {}).get("expected_cents", e_prize))
        sb = float((base.get("sponsor") or {}).get("expected_cents", sponsor.mean()))
        ab = float((base.get("atr") or {}).get("expected_pct", atr.mean()))
    d_prize = e_prize - eb
    ours = e_prize - float(prize_cf.mean()) if trigger != "baseline" else 0.0
    rivals = d_prize - ours

    # rivals: the teams nearest to us on points at the weekend start
    near = sorted((t for t in teams if t != state.team), key=lambda t: (abs(sim["start"][t] - sim["start"][state.team]), t))[:RIVALS]
    rival_rows = [{"team": t, "points_start": sim["start"][t], "expected_points": round(float(sim["tot"][:, teams.index(t)].mean()), 1),
                   "dist": _dist(pos[:, teams.index(t)], places)} for t in sorted(near, key=lambda t: -sim["start"][t])]

    cap = cap_forecast.forecast(state)
    drop = pb - p_target
    tone = "alert" if (drop >= 0.2 or d_prize <= -2e8) else "hold" if (drop >= 0.05 or d_prize <= -5e7 or cap.get("p_overspend", 0) > 0.1) else "ok"
    if trigger == "baseline":
        headline = f"before the weekend · ${e_prize / 1e8:.1f}m expected prize (P10–P90 ${np.percentile(prize_now, 10) / 1e8:.1f}m–${np.percentile(prize_now, 90) / 1e8:.1f}m)"
    else:
        word = "down" if p_target < pb - 0.005 else "up" if p_target > pb + 0.005 else "unchanged"
        money = f"{_m(d_prize)} expected prize" if abs(d_prize) >= 5e6 else "expected prize unchanged"
        headline = f"{word} from {pb:.0%} before the weekend · {money}"
    mode = int(np.bincount(me).argmax())
    return SimRun(
        sim_key=f"sim|{state.meeting_key}|{len(state.sims)}|{trigger}"[:256], meeting_key=state.meeting_key, trigger=trigger,
        at=state.now or str(state.session.get("date_start") or ""),
        payload={
            "headline_value": f"P(P{target}) {p_target:.0%}", "headline": headline, "tone": tone, "trigger": trigger,
            "phase": sim["phase"], "session": str(state.session.get("session_name") or state.session_type or ""), "n": sim["n"], "seed": sim["seed"], "team": state.team,
            "target_position": target, "target_note": f"P{target} or better, our place at the weekend start",
            "p_target": round(p_target, 4), "p_p8": round(float(np.mean(me <= 8)), 4), "p_target_baseline": round(pb, 4), "p_target_delta": round(p_target - pb, 4),
            "dist": _dist(me, places), "expected_points": round(float(pts_us.mean()), 1), "points_start": sim["start"][state.team],
            "weekend_expected_points": round(float(sim["weekend_points"].mean()), 2), "out_cars": sim["out_cars"],
            "remaining_sessions": sim["remaining_sessions"], "rivals": rival_rows,
            "prize": {"expected_cents": int(e_prize), "p10_cents": int(np.percentile(prize_now, 10)), "p50_cents": int(np.percentile(prize_now, 50)),
                      "p90_cents": int(np.percentile(prize_now, 90)), "baseline_cents": int(eb), "delta_cents": int(d_prize),
                      "ladder_cents": {str(k): v for k, v in lad.items()}, "basis": prize_mod.basis(state.year)},
            "attribution": {"ours_cents": int(ours), "rivals_cents": int(rivals),
                            "note": "ours: our cars as they ran vs our baseline-expected race, rivals as they ran; rivals: the rest of the change"},
            "atr": {"expected_pct": round(float(atr.mean()), 1), "baseline_pct": round(ab, 1), "delta_pct": round(float(atr.mean()) - ab, 1),
                    "most_likely_position": mode, "most_likely_pct": atr_pct(mode), "wind_tunnel_runs": int(round(ATR_BASE_RUNS * atr.mean() / 100)),
                    "period": f"H1 {state.year + 1}", "basis": "7th = 100%, +5 points per place lower, 1st = 70%; set by the final standings",
                    "source": ATR_SOURCE},
            "sponsor": {"expected_cents": int(sponsor.mean()), "baseline_cents": int(sb), "delta_cents": int(sponsor.mean() - sb),
                        "per_point_cents": SPONSOR_PER_POINT_CENTS, "per_place_cents": SPONSOR_PER_PLACE_CENTS, "assumption": True,
                        "basis": "ASSUMPTION: $100k per championship point and $500k per place above 10th, the structure (not the amounts) "
                                 "of the only public case, Etihad/Aldar with Force India 2007-09", "source": SPONSOR_SOURCE},
            "cap": cap,
            "assumptions": ["team-level finishing pools from this season's races before this round, recency half-life 6 rounds, DNFs at their rate",
                            "fastest-lap point ignored in simulated rounds; completed rounds use the points awarded",
                            "ties in the final table broken at random, not by countback"],
        },
    )
