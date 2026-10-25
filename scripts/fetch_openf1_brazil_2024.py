"""Fetch and cache the OpenF1 records for the 2024 São Paulo Grand Prix race (milestone P0-A).

    uv run python scripts/fetch_openf1_brazil_2024.py            # uses the cache, fetches what is missing
    uv run python scripts/fetch_openf1_brazil_2024.py --refresh  # re-download everything
    uv run python scripts/fetch_openf1_brazil_2024.py --race 2024_belgian_gp --intervals

Discovers the session (never a hardcoded key), caches each endpoint's raw JSON with provenance
(data/openf1/<race>/raw + manifest.json), verifies the incident anchor in race_control before
downloading car_data/location for the focus car in a tight window, and writes the normalized,
ordered, lookahead-masked slice to data/openf1/<race>/derived/events.jsonl + meta.json.
It prints real record counts and the gaps it found. Nothing here invents a record.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from live_racing.config import Config  # noqa: E402
from live_racing.normalize import attach_stint_times, normalize_rows, order_events, write_jsonl  # noqa: E402
from live_racing.openf1_client import OpenF1Client, OpenF1Error, find_race_session, iso_utc, parse_openf1_time  # noqa: E402
from live_racing.races import race as get_race  # noqa: E402

SESSION_ENDPOINTS = ("race_control", "weather", "position", "laps", "stints", "pit")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--race", default="2024_sao_paulo_gp")
    ap.add_argument("--refresh", action="store_true", help="ignore the cache and download again")
    ap.add_argument("--intervals", action="store_true", help="also download intervals for the incident window (large)")
    ap.add_argument("--offline", action="store_true", help="never touch the network; fail on a cache miss")
    args = ap.parse_args()

    cfg = Config.from_env()
    race = get_race(args.race)
    cache_dir = cfg.data_dir / race.cache_dir
    client = OpenF1Client(cache_dir, cfg.openf1_base_url, offline=args.offline)
    counts: dict[str, int] = {}
    gaps: list[str] = []

    def fetch(endpoint: str, **params):
        try:
            r = client.get(endpoint, refresh=args.refresh, **params)
        except OpenF1Error as exc:
            gaps.append(f"{endpoint}: {exc}")
            print(f"  FAILED {endpoint} {params}: {exc}")
            return None
        counts[endpoint] = counts.get(endpoint, 0) + len(r.rows)
        print(f"  {'cache ' if r.from_cache else 'fetch '} {endpoint:14s} {len(r.rows):6d} rows  {r.source_url}")
        return r

    print(f"{race.name}: resolving the session from OpenF1 (year={race.year}, country={race.country_name})")
    sessions = fetch("sessions", year=race.year, country_name=race.country_name)
    if sessions is None:
        return 2
    session = find_race_session(sessions.rows, race.session_name)
    sk = int(session["session_key"])
    print(f"  session_key={sk} meeting_key={session['meeting_key']} {session['date_start']} -> {session['date_end']}")

    drivers = fetch("drivers", session_key=sk)
    results: dict[str, object] = {}
    for ep in SESSION_ENDPOINTS:
        results[ep] = fetch(ep, session_key=sk)

    # Verify the incident anchor from race control before touching car_data (plan P0-A).
    windows = []
    rc = results.get("race_control")
    for focus in race.incident_focus:
        anchor = None
        if rc is not None:
            anchor = next((r for r in rc.rows if r.get("flag") == focus.anchor_flag and r.get("lap_number") == focus.anchor_lap
                           and r.get("category") == "Flag"), None)
        if anchor is None:
            gaps.append(f"{focus.label}: no race_control row with flag={focus.anchor_flag} on lap {focus.anchor_lap}; car_data not fetched")
            print(f"  GAP {gaps[-1]}")
            continue
        t0 = parse_openf1_time(anchor["date"])
        start, end = t0 - timedelta(seconds=focus.window_before_s), t0 + timedelta(seconds=focus.window_after_s)
        named = [r["message"] for r in rc.rows if str(focus.driver_number) in (r.get("message") or "")
                 and focus.anchor_lap - 4 <= (r.get("lap_number") or 0) <= focus.anchor_lap + 2]
        if not named:
            gaps.append(f"{focus.label}: race_control never names car {focus.driver_number} between laps "
                        f"{focus.anchor_lap - 4} and {focus.anchor_lap + 2}; attribution must come from car data plus corroboration")
            print(f"  GAP {gaps[-1]}")
        w = {"label": focus.label, "driver_number": focus.driver_number, "anchor": {"flag": anchor.get("flag"), "lap_number": anchor.get("lap_number"),
             "message": anchor.get("message"), "event_time_utc": iso_utc(t0)}, "start_utc": iso_utc(start), "end_utc": iso_utc(end), "note": focus.note}
        for ep in ("car_data", "location") + (("intervals",) if args.intervals else ()):
            params = {"session_key": sk, "date>=": start.strftime("%Y-%m-%dT%H:%M:%S"), "date<=": end.strftime("%Y-%m-%dT%H:%M:%S")}
            if ep != "intervals":
                params["driver_number"] = focus.driver_number
            r = fetch(ep, **params)
            if r is not None:
                results[f"{ep}:{focus.label}"] = r
                w[f"{ep}_rows"] = len(r.rows)
                if ep == "car_data" and r.rows:
                    moving = [x for x in r.rows if (x.get("speed") or 0) > 0]
                    w["last_sample_moving_utc"] = iso_utc(parse_openf1_time(moving[-1]["date"])) if moving else None
        windows.append(w)

    # Post-session validation only: cached, listed in the manifest, never normalized into the replay.
    fetch("session_result", session_key=sk)

    # Normalize everything that may be replayed.
    events = []
    for key, r in results.items():
        if r is None:
            continue
        ep = key.split(":")[0]
        events.extend(normalize_rows(ep, r.rows, sk, r.source_url))
    events = attach_stint_times(events, iso_utc(parse_openf1_time(session["date_start"])))
    events = order_events(events)

    derived = cache_dir / "derived"
    derived.mkdir(parents=True, exist_ok=True)
    n = write_jsonl(derived / "events.jsonl", events)
    by_endpoint: dict[str, int] = {}
    for e in events:
        by_endpoint[e.endpoint] = by_endpoint.get(e.endpoint, 0) + 1
    meta = {
        "race_id": race.race_id, "name": race.name, "season": race.season, "round": race.round, "slug": race.slug,
        "source_system": "openf1", "base_url": cfg.openf1_base_url,
        "session": {k: session.get(k) for k in ("session_key", "meeting_key", "session_name", "session_type", "date_start", "date_end",
                                                 "circuit_short_name", "country_name", "location", "year", "gmt_offset")},
        "drivers": [{k: d.get(k) for k in ("driver_number", "name_acronym", "full_name", "team_name", "team_colour")} for d in (drivers.rows if drivers else [])],
        "incident_windows": windows,
        "raw_counts": counts,
        "event_counts": by_endpoint,
        "events_total": n,
        "first_event_utc": events[0].event_time_utc if events else None,
        "last_event_utc": events[-1].event_time_utc if events else None,
        "gaps": gaps,
        "never_replayed": ["session_result (validation only)", "drivers", "sessions"],
        "masking": {"stint_start": ["lap_end"], "lap_start": ["lap_duration", "sectors", "speeds"]},
        "corroboration": [c.__dict__ for c in race.corroboration],
        "team_cars_note": race.team_cars_note,
        "openf1_requests": client.requests, "cache_hits": client.cache_hits,
    }
    (derived / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n")
    print(f"\n{n} normalized events -> {derived / 'events.jsonl'}  ({by_endpoint})")
    print(f"{client.requests} HTTP requests, {client.cache_hits} cache hits; raw cache in {cache_dir / 'raw'}")
    for g in gaps:
        print(f"GAP: {g}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
