"""Replay a whole race weekend through the race-day flow: qualifying, then the race, then the close.

    uv run python -m race.weekend --meeting 1249 --pace 60          # São Paulo 2024: three Williams crashes
    uv run python -m race.weekend --meeting 1249 --pace 0 --offline  # as fast as possible, no Jev, no Claude

The tape and the money effects come from race/replay.py, one session at a time. This module owns what happens
after each event, across the sessions of the weekend:

    1 detect     race/telemetry.py (car_stopped) and race/normalize.py, inside the replay
    2 log        race/incidents.py   one incident per crash, its belief versioned as evidence arrives
    3 respond    race/logistics.py   spares, work orders, freight, the withdraw decision, FIA paperwork
    4 account    race/ledger.py      balanced provisional entries, recognised when the cap counts them
    5 ask        race/questions.py   a person is asked when a wrong answer would cost more than the question
    6 re-plan    race/season_sim.py + race/cap_forecast.py   the season and the cap re-run after each change
    7 close      race/close.py       the sealed weekend and a brief per role

Every stage writes its rows to pit-wall through RaceSink, so the dashboard's Race day page moves live.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from race import cap_forecast, close as close_mod, erp, incidents, ledger, logistics, people, questions, season_sim, strategy
from race.events import Action, Close, Effect, Entry, Incident, OptionSet, Posting, Question, RaceEvent, SimRun, now_iso
from race.replay import Replay
from race.sink import RaceSink

DATA = Path(__file__).resolve().parent / "data"


def weekend_info(meeting_key: int) -> dict:
    return json.loads((DATA / "weekends.json").read_text())[str(meeting_key)]


@dataclass
class WeekendState:
    """Everything the stages share across the sessions of one weekend. Plain data: each stage reads it and
    returns rows; only this module writes them to the sink."""

    meeting_key: int
    info: dict
    team: str
    offline: bool = True
    session: dict = field(default_factory=dict)  # the session now replaying
    session_type: str = "Race"
    now: str = ""  # time of the latest event (race time, not wall time)
    incidents: dict[str, Incident] = field(default_factory=dict)
    actions: dict[str, Action] = field(default_factory=dict)
    entries: dict[str, Entry] = field(default_factory=dict)
    questions: dict[str, Question] = field(default_factory=dict)
    sims: list[SimRun] = field(default_factory=list)
    effects: list[tuple[RaceEvent, list[Effect]]] = field(default_factory=list)  # every money effect this weekend
    results: dict[int, list[dict]] = field(default_factory=dict)  # session_key -> session_result rows, when known
    spares: dict = field(default_factory=dict)  # part -> {"at_track": n, "factory": n}, from logistics.load_manifest
    applied_answers: set = field(default_factory=set)  # question keys whose answer the desk has applied
    options: dict[str, OptionSet] = field(default_factory=dict)  # the latest priced decisions per car
    postings: dict[str, Posting] = field(default_factory=dict)  # entry key -> where it went in the books
    close: Close | None = None
    replay: Replay | None = None  # the live session's replay (its EffectsContext, policies, precedents)

    @property
    def year(self) -> int:
        return int(self.info["year"])

    @property
    def round(self) -> int:
        return int(self.info["round"])

    def cars(self) -> list[int]:
        return sorted(int(c) for c in self.info.get("cars", {}))


class Weekend:
    def __init__(self, meeting_key: int, *, pace: float, sink: RaceSink | None, offline: bool, forecast: bool,
                 fixtures_only: bool = True, max_sleep: float = 5.0, quiet: bool = False, from_at: dict[int, str] | None = None,
                 sessions: list[int] | None = None, linger: float = 0.0, until: str = "", script: dict | None = None):
        self.info = weekend_info(meeting_key)
        self.state = WeekendState(meeting_key=meeting_key, info=self.info, team=self.info.get("team", "Williams"), offline=offline)
        self.state.spares = logistics.load_manifest(self.state)
        self.sessions = sessions or [int(s) for s in self.info["sessions"]]
        self.pace, self.sink, self.offline, self.forecast = pace, sink, offline, forecast
        self.fixtures_only, self.max_sleep, self.quiet = fixtures_only, max_sleep, quiet
        self.from_at = from_at or {}
        self.linger = linger  # seconds to wait after the last session for people to answer open questions
        self.until = until  # stop here (race time): a snapshot, not sealed
        self.script = script  # people's decisions replayed into a demo (race/people.py)
        self.book = incidents.IncidentBook(self.state)
        self.timings: dict[str, list[float]] = {}

    # ------------------------------------------------------------------ helpers
    def _time(self, stage: str, t0: float) -> None:
        self.timings.setdefault(stage, []).append((time.perf_counter() - t0) * 1000)

    def say(self, line: str) -> None:
        if not self.quiet:
            print(f"      {line}"[:220])

    # ------------------------------------------------------------------ hooks called by Replay
    def after_event(self, replay: Replay, ev: RaceEvent, effects: list[Effect], jev, policy, precedent) -> None:
        st = self.state
        st.now = ev.at
        for line in people.apply_due(st, self.sink, self.script, ev.at):
            self.say(f"[people] {line}")
            self.follow_decisions()
        if effects:
            st.effects.append((ev, effects))
        t0 = time.perf_counter()
        for o in strategy.options_for(st, ev):  # the strategy desk's priced decisions, on every decision point
            st.options[o.option_key] = o
            if self.sink:
                self.sink.options(o)
        self._time("strategy", t0)
        t0 = time.perf_counter()
        inc = self.book.observe(ev, effects, jev)
        self._time("log", t0)
        if inc is None:
            if any(e.bucket == "6910" for e in effects):  # an FIA fine: an entry outside the cap, no incident
                self.book_entries(ledger.entries_for(None, effects, st))
            self.apply_answers()
            return
        st.incidents[inc.incident_key] = inc
        if self.sink:
            self.sink.incident(inc)
        self.say(f"[log] {inc.incident_key} v{inc.version} {inc.status}: {inc.cause}")

        t0 = time.perf_counter()
        acts = logistics.plan(inc, st)
        self._time("respond", t0)
        fresh = [a for a in acts if st.actions.get(a.action_key) != a]
        for a in acts:
            st.actions[a.action_key] = a
        if fresh and self.sink:
            self.sink.actions(fresh)
        for a in fresh:
            self.say(f"[respond] {a.kind}: {a.title} ({a.status})")

        t0 = time.perf_counter()
        self.book_entries(ledger.entries_for(inc, effects, st))
        self._time("account", t0)

        t0 = time.perf_counter()
        qs = questions.questions_for(inc, effects, st)
        self._time("ask", t0)
        for q in qs:
            if q.question_key not in st.questions:
                st.questions[q.question_key] = q
                if self.sink:
                    self.sink.ask(q)
                self.say(f"[ask] {q.route_role}: {q.prompt}")

        self.replan(f"incident:{inc.incident_key}@v{inc.version}")
        self.apply_answers()

    def stop(self, ev: RaceEvent) -> bool:
        """The snapshot's end: events after `until` are not played."""
        return bool(self.until) and ev.at > self.until

    def after_session(self, replay: Replay) -> None:
        st = self.state
        st.results[int(replay.session.get("session_key") or 0)] = replay.rows.get("session_result", [])
        for inc in self.book.end_of_session(replay):
            st.incidents[inc.incident_key] = inc
            if self.sink:
                self.sink.incident(inc)
            self.say(f"[log] {inc.incident_key} v{inc.version} {inc.status}: {inc.cause}")
            for a in logistics.plan(inc, st):
                if st.actions.get(a.action_key) != a:
                    st.actions[a.action_key] = a
                    if self.sink:
                        self.sink.actions([a])
                    self.say(f"[respond] {a.kind}: {a.title} ({a.status})")
            for q in questions.questions_for(inc, [], st):
                if q.question_key not in st.questions:
                    st.questions[q.question_key] = q
                    if self.sink:
                        self.sink.ask(q)
                    self.say(f"[ask] {q.route_role}: {q.prompt}")
        self.replan(f"result:{replay.session.get('session_key')}")

    def book_entries(self, ents: list[Entry]) -> None:
        fresh = []
        for e in ents:
            if e.entry_key not in self.state.entries:
                self.state.entries[e.entry_key] = e
                fresh.append(e)
                if self.sink:
                    self.sink.entry(e)
                self.say(f"[account] {e.memo[:90]} ${e.amount_cents / 100:,.0f} ({e.recognition})")
        if fresh:
            self.record_postings(erp.post(self.state, fresh, self.sink))

    def record_postings(self, postings: list[Posting]) -> None:
        t0 = time.perf_counter()
        for p in postings:
            self.state.postings[p.entry_key] = p
            if self.sink:
                self.sink.posting(p)
            self.say(f"[books] {p.entry_key[:40]} {p.status}{' ' + p.erp_entry_id if p.erp_entry_id else ''}: {p.reason[:90]}")
        self._time("books", t0)

    # ------------------------------------------------------------------ stages that run on their own clock
    def replan(self, trigger: str) -> None:
        t0 = time.perf_counter()
        run = season_sim.run(self.state, trigger)
        self._time("replan", t0)
        if run is None:
            return
        run.runtime_ms = int((time.perf_counter() - t0) * 1000)
        self.state.sims.append(run)
        if self.sink:
            self.sink.sim(run)
        head = run.payload.get("headline") or ""
        if head:
            self.say(f"[re-plan] {head} ({run.runtime_ms} ms)")

    def follow_decisions(self) -> None:
        """A person decided an action that waited for them (in the dashboard, or replayed): read it back and re-plan the
        incident, so the next steps follow the choice (the notice that goes with it, the list no longer needed)."""
        st = self.state
        waiting = [a for a in st.actions.values() if a.status == "awaiting_approval"]
        if waiting and self.sink is not None and not self.sink.disabled:
            now = time.monotonic()
            if now - getattr(self, "_decision_poll", 0.0) >= 1.0:
                self._decision_poll = now
                rows = {r["action_key"]: r for r in self.sink.sql("SELECT * FROM race_actions") if r.get("status") in ("approved", "rejected", "done")}
                for a in waiting:
                    r = rows.get(a.action_key)
                    if r is None:
                        continue
                    a.status, a.decided_by = r["status"], r.get("decided_by") or a.decided_by
                    try:
                        a.detail = json.loads(r.get("detail_json") or "{}") or a.detail
                    except ValueError:
                        pass
        for a in list(st.actions.values()):
            if a.kind != "withdraw_car" or a.status not in ("approved", "done"):
                continue
            chosen = a.detail.get("chosen")
            notice = st.actions.get(f"{a.incident_key}:fia_notice")
            inc = st.incidents.get(a.incident_key)
            if not chosen or inc is None or (notice is not None and notice.detail.get("chosen") == chosen):
                continue
            fresh = [x for x in logistics.plan(inc, st) if st.actions.get(x.action_key) != x]
            for x in fresh:
                st.actions[x.action_key] = x
            if fresh and self.sink:
                self.sink.actions(fresh)
            self.say(f"[respond] {a.detail.get('chosen_by', 'a person')} chose {chosen.replace('_', ' ')} for car {inc.driver_number}: "
                     f"{len(fresh)} next steps re-planned")

    def apply_answers(self) -> None:
        """Answers a person gave in the dashboard since the last event: apply them and re-decide what they cover.
        Held entries a person approved are posted to the ERP here too, and decisions are followed."""
        self.record_postings(erp.apply_reviews(self.state, self.sink))
        self.follow_decisions()
        changed = questions.apply_answers(self.state, self.sink, self.book)
        pend = getattr(self.state, "pending_entries", None)
        if pend:
            self.state.pending_entries = []
            self.book_entries(pend)  # corrections move the books by an adjusting entry
        for inc in changed:
            self.state.incidents[inc.incident_key] = inc
            if self.sink:
                self.sink.incident(inc)
            self.say(f"[ask] {inc.incident_key} re-decided: {inc.cause}")
            acts = logistics.plan(inc, self.state)  # the answer can change what the garage needs and what waits for a person
            fresh = [a for a in acts if self.state.actions.get(a.action_key) != a]
            for a in acts:
                self.state.actions[a.action_key] = a
            if fresh and self.sink:
                self.sink.actions(fresh)
            self.replan(f"answer:{inc.incident_key}@v{inc.version}")

    # ------------------------------------------------------------------ run
    def _session_start(self, key: int) -> str:
        try:
            return json.loads((Path(__file__).resolve().parent / "fixtures" / str(key) / "session.json").read_text())["date_start"].replace("+00:00", "Z")
        except (OSError, ValueError, KeyError):
            return ""

    def report_health(self, final: bool = False) -> None:
        """What each outside service did on this run, written so every view can say what is live and what is not."""
        if not self.sink:
            return
        from race import jev as jev_mod, openf1

        now = now_iso()
        st = self.state
        o = openf1.STATS
        src = "the checked-in fixtures (no network)" if self.fixtures_only else "api.openf1.org REST"
        self.sink.call("record_race_health", ["openf1", "offline" if self.fixtures_only else ("degraded" if o["errors"] else "live"),
                       f"{src}: {o['reads']} endpoint reads, {o['cache']} served from the cache of earlier API responses, {o['fetched']} fetched now"
                       + ("; live MQTT needs the paid tier (race/live.py)" if not self.fixtures_only else ""), o["reads"], o["errors"], 0, now])
        d = self._done
        calls, errs = d["jev_calls"], d["jev_errors"]
        mean = int(d["jev_ms_sum"] / calls) if calls else 0
        jev_status = "offline" if self.offline else "not_configured" if not jev_mod.available() else "degraded" if errs else "live"
        self.sink.call("record_race_health", ["jev", jev_status,
                       f"TypeSafe System One: {calls} typed decisions" + (f", mean {mean} ms" if calls else "")
                       + (f", {errs} fell back to the rule table" if errs else ""), calls, errs, mean, now])
        has_claude = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
        by = (st.close.totals.get("briefs_by") if st.close else None) or {}
        written = sum(1 for v in by.values() if v != "offline")
        self.sink.call("record_race_health", ["claude", "offline" if self.offline else ("live" if has_claude else "not_configured"),
                       f"repair and money plans after incidents: {d['forecasts']}; close briefs written by Claude: {written} of {len(by) or 4}",
                       d["forecasts"] + written, 0, 0, now])
        posted = sum(1 for p in st.postings.values() if p.status == "posted")
        failed = sum(1 for p in st.postings.values() if p.status == "failed")
        held = sum(1 for p in st.postings.values() if p.status == "held")
        self.sink.call("record_race_health", ["erp", "offline" if (failed and not posted) else "degraded" if failed else "live",
                       f"ERP journal via the gateway: {posted} posted, {held} held for review, {failed} failed", posted, failed, 0, now])
        self.sink.call("record_race_health", ["spacetimedb", "degraded" if self.sink.errors else "live",
                       f"pit-wall at {self.sink.url.split('/v1/')[0]}: {self.sink.calls} reducer calls, {self.sink.errors} refused", self.sink.calls,
                       self.sink.errors, 0, now])
        try:
            from finance.notify.channels import ALL

            configured = [name for name, cls in ALL.items() if cls(env=os.environ).configured()]
        except Exception:  # the channel module is optional for the race desk
            configured = []
        mode = os.environ.get("PITWALL_NOTIFY", "dry")
        self.sink.call("record_race_health", ["notify", "not_configured" if not configured else ("live" if mode == "live" else "dry_run"),
                       ("channels: " + ", ".join(configured) if configured else "no Slack, email, Teams or SMS credentials yet (add them in Connect)")
                       + f"; PITWALL_NOTIFY={mode}", len(configured), 0, 0, now])

    def run(self) -> dict:
        stats = {}
        self._done = {"jev_calls": 0, "jev_ms_sum": 0.0, "jev_errors": 0, "forecasts": 0}  # totals of the finished sessions
        booked_before = 0
        for key in self.sessions:
            if self.until and self._session_start(key) > self.until:
                break
            r = Replay(key, self.state.team, pace=self.pace, from_lap=0, sink=self.sink, offline=self.offline, forecast=self.forecast,
                       fixtures_only=self.fixtures_only, max_sleep=self.max_sleep, quiet=self.quiet, hooks=self,
                       from_at=self.from_at.get(key, ""), era=self.info.get("era", "2025-26"))
            # One cap year across the weekend: the season's cap, what was booked before it, and the earlier sessions.
            r.ctx.year = self.state.year
            r.ctx.cap_level_cents = cap_forecast.cap_level_cents(self.state.year)
            r.ctx.cap_relevant_cents = cap_forecast.relevant_before_cents(self.state) + booked_before
            self.state.replay = r
            self.state.session = r.session
            self.state.session_type = r.session_type
            if key == self.sessions[0]:
                self.replan("baseline")
                self.report_health()
            stats[key] = r.run()
            if self.until and self.script:
                # The snapshot's end can fall in a quiet spell (a red flag): decisions due by then still land.
                for line in people.apply_due(self.state, self.sink, self.script, self.until):
                    self.say(f"[people] {line}")
                self.follow_decisions()
                self.state._last_poll = 0.0
                self.apply_answers()
            booked_before += r.ctx.race_cost_mid
            done = stats[key]
            self._done["jev_calls"] += done.get("jev_calls", 0)
            self._done["jev_ms_sum"] += (done.get("jev_mean_ms") or 0) * done.get("jev_calls", 0)
            self._done["jev_errors"] += done.get("jev_errors", 0)
            self._done["forecasts"] += done.get("forecasts", 0)
            self.report_health()
        waited = 0.0
        while self.linger and waited < self.linger and (any(q.status == "open" for q in self.state.questions.values())
                                                         or any(p.status == "held" for p in self.state.postings.values())):
            time.sleep(1.0)
            waited += 1.0
            self.apply_answers()
        t0 = time.perf_counter()
        c = None if self.until else close_mod.close_weekend(self.state, offline=self.offline)  # a snapshot is not sealed
        self._time("close", t0)
        if c is not None:
            self.state.close = c
            if self.sink:
                self.sink.close(c)
            self.say(f"[close] sealed {c.leaves} rows, root {c.root_hash[:12]}…, briefs for {', '.join(c.briefs)}")
        self.report_health(final=True)
        stats["timings_ms"] = {k: round(sum(v) / len(v), 2) for k, v in self.timings.items() if v}
        if not self.quiet:
            print("weekend:", {k: v for k, v in stats.items() if k == "timings_ms"},
                  f"{len(self.state.incidents)} incidents, {len(self.state.actions)} actions, {len(self.state.entries)} entries, "
                  f"{len(self.state.questions)} questions, {len(self.state.sims)} sims")
        return stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--meeting", type=int, default=int(os.environ.get("RACE_MEETING", "1249")))
    ap.add_argument("--pace", type=float, default=60.0)
    ap.add_argument("--max-sleep", type=float, default=5.0)
    ap.add_argument("--from", dest="from_at", action="append", default=[], help="SESSION=ISO: events before it land instantly")
    ap.add_argument("--sessions", help="comma-separated session keys (default: the weekend's)")
    ap.add_argument("--no-sink", action="store_true")
    ap.add_argument("--offline", action="store_true", default=os.environ.get("RACE_OFFLINE", "") in ("1", "true"))
    ap.add_argument("--no-forecast", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--linger", type=float, default=0.0, help="seconds to wait for answers to open questions before the close")
    ap.add_argument("--until", default="", help="stop at this race time (ISO UTC): a snapshot, not sealed")
    ap.add_argument("--snapshot", action="store_true", help="the meeting's demo snapshot: stop time and people's decisions from race/data/snapshot_<meeting>.json")
    ap.add_argument("--fixtures", action="store_true", default=os.environ.get("RACE_SOURCE", "openf1") == "fixtures",
                    help="read the checked-in fixtures instead of the OpenF1 API (no network)")
    args = ap.parse_args()
    from_at = {int(k): v for k, v in (x.split("=", 1) for x in args.from_at)}
    script = people.load_script(args.meeting) if args.snapshot else None
    until = args.until or ((script or {}).get("until") or "")
    sink = None if args.no_sink else RaceSink()
    Weekend(args.meeting, pace=args.pace, sink=sink, offline=args.offline, forecast=not args.no_forecast, max_sleep=args.max_sleep,
            quiet=args.quiet, from_at=from_at, sessions=[int(s) for s in args.sessions.split(",")] if args.sessions else None,
            linger=args.linger, fixtures_only=args.fixtures, until=until, script=script).run()


if __name__ == "__main__":
    main()
