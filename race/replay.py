"""Replay one OpenF1 session into the race desk at a chosen pace.

    uv run python -m race.replay --session 11291 --pace 60            # 2026 Canada: Albon out on lap 12
    uv run python -m race.replay --session 11291 --from-lap 10         # events before lap 10 land instantly
    uv run python -m race.replay --session 9693 --pace 120 --offline   # no Jev, no Claude, no network

Every event goes to SpacetimeDB (race_events + car_state), then through the three tiers: an approved policy,
else Jev's typed answers, into effects.py; a Williams incident or retirement starts the forecast agent in a
background thread. The tape is printed as it goes. Pace 60 = one race minute per second.
"""

from __future__ import annotations

import argparse
import os
import statistics
import threading
import time
from datetime import timedelta
from pathlib import Path

from race import openf1
from race.effects import EffectsContext, effects_for
from race.events import MONEY_KINDS, RaceEvent, parse_iso
from race.jev import JevAnswers, available as jev_available, decide
from race.normalize import normalize
from race.policies import PolicyBook, flat_view
from race.precedents import PrecedentStore
from race.sink import RaceSink

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EUROPE = {"Spain", "Monaco", "Austria", "United Kingdom", "Great Britain", "Hungary", "Belgium", "Netherlands", "Italy", "Azerbaijan",
          "Germany", "France", "Portugal", "San Marino"}


def load_rows(session_key: int, fixtures_only: bool = False) -> dict[str, list[dict]]:
    try:
        return openf1.load_fixture(session_key, FIXTURES)
    except openf1.OpenF1Error:
        if fixtures_only:
            raise
    rows = openf1.load_session(session_key)
    rows["session"] = [openf1.session(session_key)]
    return rows


def next_race(session: dict) -> tuple[int | None, bool]:
    """Days to the next meeting after this session, and whether it is a flyaway (outside Europe)."""
    try:
        ms = openf1.meetings(int(session.get("year") or session["date_start"][:4]))
    except Exception:
        return None, False
    after = [m for m in ms if m["date_start"] > session["date_start"] and m.get("meeting_key") != session.get("meeting_key")]
    if not after:
        return None, False
    nxt = after[0]
    days = (parse_iso(nxt["date_start"]) - parse_iso(session["date_end"] or session["date_start"])).days
    return days, nxt.get("country_name") not in EUROPE


class Replay:
    def __init__(self, session_key: int, team: str, *, pace: float, from_lap: int, sink: RaceSink | None, offline: bool,
                 forecast: bool, fixtures_only: bool, max_sleep: float = 5.0, quiet: bool = False):
        self.rows = load_rows(session_key, fixtures_only)
        self.session = (self.rows.get("session") or [{"session_key": session_key}])[0]
        self.team = team
        self.pace = pace
        self.from_lap = from_lap
        self.sink = sink
        self.offline = offline
        self.want_forecast = forecast
        self.max_sleep = max_sleep
        self.quiet = quiet
        self.team_of = {int(d["driver_number"]): d.get("team_name", "") for d in self.rows.get("drivers", [])}
        self.acronym = {int(d["driver_number"]): d.get("name_acronym", str(d["driver_number"])) for d in self.rows.get("drivers", [])}
        self.ctx = EffectsContext(team=team, team_of=self.team_of, fx_date=(self.session.get("date_start") or "2026-06-01")[:10])
        self.ctx.set_standings(self.rows.get("championship_teams", []))
        self.ctx.next_race_days, self.ctx.next_race_flyaway = next_race(self.session) if not fixtures_only else (7, True)
        self.ctx.sprint = "Sprint" in (self.session.get("session_name") or "")
        self.book = PolicyBook.from_rows(sink.sql("SELECT * FROM race_policies") if sink else [])
        self.precedents = PrecedentStore.load()
        self.track_status = "green"
        self.recent: dict[int, list[str]] = {}
        self.incident_lap: dict[int, int] = {}
        self.pit_lap: dict[int, int] = {}
        self.retired_lap: dict[int, int] = {}
        self.forecasted: set[int] = set()
        self.reforecasted: set[int] = set()
        self.threads: list[threading.Thread] = []
        self.stats = {"events": 0, "effects": 0, "jev_calls": 0, "jev_ms": [], "policy_hits": 0, "precedent_hits": 0, "forecasts": 0}

    # ------------------------------------------------------------------ per event
    def context_for(self, ev: RaceEvent) -> dict:
        car = ev.driver_number
        ctx = {"team": self.team, "team_cars": self.ctx.team_cars(), "track_status": self.track_status, "field_lap": ev.lap,
               "bonus_positions": self.ctx.best_bonus_position(), "recent_events": self.recent.get(car, [])[-6:]}
        if car in self.incident_lap and car in self.retired_lap:
            ctx["retired_within_laps"] = abs(self.retired_lap[car] - self.incident_lap[car])
        elif ev.kind.startswith("retirement") and car:
            ctx["retired_within_laps"] = 0
        if car in self.incident_lap and car in self.pit_lap and self.pit_lap[car] >= self.incident_lap[car]:
            ctx["pit_within_laps"] = self.pit_lap[car] - self.incident_lap[car]
        return ctx

    def wants_jev(self, ev: RaceEvent) -> bool:
        ours = self.team_of.get(ev.driver_number) == self.team or bool(ev.payload.get("team_involved"))
        if ev.kind in ("incident", "penalty", "retirement_suspected", "retirement_confirmed", "pit_stop"):
            return ours
        if ev.kind == "position" and ours:
            to = ev.payload.get("to") or 99
            frm = ev.payload.get("from") or 99
            return min(to, frm) <= self.ctx.best_bonus_position() + 1
        return False

    def handle(self, ev: RaceEvent) -> list:
        car = ev.driver_number
        if ev.kind in ("safety_car", "vsc", "red_flag", "flag"):
            msg = (ev.payload.get("message") or "").upper()
            if ev.kind == "red_flag":
                self.track_status = "red"
            elif ev.kind == "vsc":
                self.track_status = "vsc" if ev.payload.get("deployed") else "green"
            elif ev.kind == "safety_car":
                self.track_status = "sc" if ev.payload.get("deployed") else "green"
            elif ev.payload.get("flag") == "CHEQUERED":
                self.track_status = "finished"
            elif self.track_status == "red" and ev.payload.get("flag") in ("GREEN", "CLEAR"):
                self.track_status = "green"
        if car:
            if ev.kind == "incident":
                for c in ev.payload.get("car_numbers") or [car]:
                    self.incident_lap.setdefault(c, ev.lap)
            elif ev.kind == "pit_stop":
                self.pit_lap[car] = ev.lap
            elif ev.kind.startswith("retirement"):
                self.retired_lap.setdefault(car, ev.lap)
                self.incident_lap.setdefault(car, ev.lap)
            self.recent.setdefault(car, []).append(ev.one_line().strip())

        if self.sink:
            self.sink.event(ev)
        self.stats["events"] += 1

        jev = JevAnswers()
        policy = None
        precedent = None
        if self.wants_jev(ev):
            context = self.context_for(ev)
            policy = self.book.resolve(ev, context)
            granted = policy is not None and policy.autonomy == "GRANTED"
            if not granted:
                precedent = self.precedents.match(flat_view(ev, context))
            if granted:
                self.stats["policy_hits"] += 1
            elif precedent:
                self.stats["precedent_hits"] += 1
            else:
                # nothing learned covers it: System One decides in a few hundred milliseconds
                jev = decide(ev, context) if not self.offline else __import__("race.jev", fromlist=["offline_decide"]).offline_decide(ev, context)
                if not jev.offline:
                    self.stats["jev_calls"] += 1
                    self.stats["jev_ms"].append(jev.latency_ms)
        effects = effects_for(ev, jev, policy, self.ctx, precedent)
        if effects and self.sink:
            self.sink.effects(ev, effects)
        self.stats["effects"] += len(effects)

        ours = self.team_of.get(car) == self.team
        if self.want_forecast and ours and car not in self.forecasted and (
            ev.kind in ("retirement_suspected", "retirement_confirmed") or (ev.kind == "incident" and jev.needs_forecast >= 0.5)
            or (ev.kind == "incident" and precedent is not None and precedent.outcome in ("heavy", "moderate"))
        ):
            self.forecasted.add(car)
            self.start_forecast(ev, jev, effects)
        elif (self.want_forecast and ours and car in self.forecasted and car not in self.reforecasted and ev.kind == "incident"
              and ev.payload.get("damage_likely") and ev.payload.get("stage") == "NOTED"):
            # The stewards' message arrives minutes after our own call: new evidence (who hit whom), new plan.
            self.reforecasted.add(car)
            self.start_forecast(ev, jev, effects)
        return effects

    def start_forecast(self, ev: RaceEvent, jev: JevAnswers, effects: list) -> None:
        from race.forecast_agent import ForecastAgent

        agent = ForecastAgent(self.ctx, self.sink, offline=self.offline or not os.environ.get("ANTHROPIC_API_KEY"))
        t = threading.Thread(target=agent.run, args=(ev, jev, effects), daemon=True, name=f"forecast-{ev.driver_number}")
        t.start()
        self.threads.append(t)
        self.stats["forecasts"] += 1
        if not self.quiet:
            print(f"      >> forecast agent started for car {ev.driver_number} ({'offline' if agent.offline else 'claude'})")

    # ------------------------------------------------------------------ loop
    def run(self, max_events: int | None = None) -> dict:
        events = normalize(self.rows, self.team)
        if not self.quiet:
            print(f"session {self.session.get('session_key')} {self.session.get('country_name', '')} {self.session.get('session_name', '')}: "
                  f"{len(events)} events, {len(self.book)} policies, jev={'on' if (jev_available() and not self.offline) else 'offline'}, "
                  f"sink={'on' if self.sink and not self.sink.disabled else 'off'}, team cars {self.ctx.team_cars()}")
        prev_at = None
        t_start = time.monotonic()
        for i, ev in enumerate(events):
            if max_events is not None and i >= max_events:
                break
            if ev.lap >= self.from_lap and prev_at is not None and self.pace > 0:
                gap = (parse_iso(ev.at) - parse_iso(prev_at)).total_seconds() / self.pace
                if gap > 0:
                    time.sleep(min(self.max_sleep, gap))
            if ev.lap >= self.from_lap:
                prev_at = ev.at
            effects = self.handle(ev)
            if not self.quiet and (ev.lap >= self.from_lap) and (ev.kind not in ("position", "overtake", "flag", "notice", "session_status", "lap") or effects
                                                                 or self.team_of.get(ev.driver_number) == self.team):
                line = ev.one_line()
                if effects:
                    line += "  => " + "; ".join(f"{e.kind}:{e.bucket} ${e.mid_cents / 100:,.0f} [{e.decided_by}]" for e in effects)
                print(line[:200])
        for t in self.threads:
            t.join(timeout=120)
        s = self.stats
        s["wall_s"] = round(time.monotonic() - t_start, 1)
        s["race_cost_mid"] = self.ctx.race_cost_mid
        s["prize_position"] = self.ctx.prize_position
        s["jev_mean_ms"] = round(statistics.mean(s["jev_ms"]), 0) if s["jev_ms"] else None
        s.pop("jev_ms", None)
        if self.sink:
            s["sink_calls"], s["sink_errors"] = self.sink.calls, self.sink.errors
        if not self.quiet:
            print("done:", s)
        return s


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session", type=int, default=int(os.environ.get("RACE_SESSION", "11291")))
    ap.add_argument("--team", default=os.environ.get("RACE_TEAM", "Williams"))
    ap.add_argument("--pace", type=float, default=60.0, help="race seconds per wall second; 0 = as fast as possible")
    ap.add_argument("--from-lap", type=int, default=0, help="events before this lap are written instantly")
    ap.add_argument("--max-sleep", type=float, default=5.0)
    ap.add_argument("--no-sink", action="store_true", help="print the tape only; write nothing to SpacetimeDB")
    ap.add_argument("--offline", action="store_true", default=os.environ.get("RACE_OFFLINE", "") in ("1", "true"))
    ap.add_argument("--no-forecast", action="store_true")
    ap.add_argument("--fixtures-only", action="store_true", help="never touch the network")
    ap.add_argument("--max-events", type=int)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    sink = None if args.no_sink else RaceSink()
    Replay(args.session, args.team, pace=args.pace, from_lap=args.from_lap, sink=sink, offline=args.offline,
           forecast=not args.no_forecast, fixtures_only=args.fixtures_only, max_sleep=args.max_sleep, quiet=args.quiet).run(args.max_events)


if __name__ == "__main__":
    main()
