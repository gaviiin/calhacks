"""Readable tail of the live racing SSE stream: one line per event.

    curl -N localhost:8020/live/stream | uv run python scripts/tail_live_stream.py
    curl -N 'localhost:8020/live/stream?kinds=incident_signal,jev_decision' | uv run python scripts/tail_live_stream.py

Reads server-sent events from stdin and prints the kind, the race clock, the lap and what changed.
"""

from __future__ import annotations

import json
import sys

sys.path.insert(0, __import__("pathlib").Path(__file__).resolve().parent.parent.as_posix())
from live_racing.finance_projections import usd  # noqa: E402


def line(rec: dict) -> str:
    kind, p = rec["kind"], rec["payload"]
    if kind == "race_state":
        t = p["event_time_utc"][11:19]
        fc = p["forecast"]
        team = ", ".join(f"car {d['driver_number']} P{d['position']}" for d in p["driver_states"] if d["driver_number"] in p["team_cars"])
        change = f"  <- {p['forecast_change']['text']}" if p.get("forecast_change") else ""
        return f"{t}Z lap {p['lap']!s:>2} {p['flag_status'] or '':<12} {team:<22} if finished now {usd(fc['amount_cents']):>7}{change}"
    if kind == "jev_decision":
        d = p["decision"]
        said = f" said {d['route']} {d['route_confidence']:.2f}" if d.get("route") else ""
        lat = f" {d['latency_ms']}ms" if d.get("latency_ms") is not None else ""
        return f"{p['at'][11:19]}Z lap {p.get('lap')!s:>2} JEV  {p['kind']:<28} -> {d['chosen_route']:<14} [{d['status']}{lat}{said}; urgency {d.get('urgency') or 'n/a'}]"
    if kind == "incident_signal":
        return (f"{p['event_time_utc'][11:19]}Z lap {p.get('lap')!s:>2} INCIDENT v{p['version']} {p['incident_id'].split(':', 2)[-1]}: {p['sporting_confirmation']}, "
                f"attribution {p['driver_attribution']}, handoff {p['handoff']['target']}/{p['handoff']['status']}, impact {p['financial_impact']['status']}")
    if kind == "result_change":
        return f"{p['event_time_utc'][11:16]}Z RESULT {p['type']:<16} {usd(p['before']['amount_cents'])} -> {usd(p['after']['amount_cents'])}  {p['message'][:110]}"
    if kind == "finance_impact":
        return f"FINANCE IMPACT {p['incident_id'].split(':', 2)[-1]}: {p['financial_status']} exposure {usd(p.get('initial_exposure_cents'))} recovery {usd(p.get('selected_recovery_cost_cents'))}"
    if kind == "strategy_advice":
        places = "; ".join(f"car {x['car']} P{x['position']}: up {usd(x['up_one_cents'])} / down {usd(x['down_one_cents'])}" for x in p["places"])
        pits = "; ".join(f"car {x['car']} pit now {usd(x['delta_cents'])} (-{x['positions_lost']} places, {x['pit_loss_s']}s)" for x in p["pit"])
        return (f"{p['as_of_utc'][11:19]}Z lap {p['lap']!s:>2} STRATEGY exposure {usd(p['exposure_now_cents'])} (peak {usd(p['exposure_peak_cents'])}, "
                f"given up {usd(p['lost_from_peak_cents'])}) | {places} | {pits}")
    if kind == "incident_plan":
        a = p["advisor"]
        worst = min(p["scenarios"], key=lambda s: s["delta_cents"])
        adv = (f"advisor {a['status']}" + (f" -> {a['recommended_scenario']} ({a['confidence']}, {a['latency_ms']}ms): {a['headline']}" if a.get("used") else ""))
        return (f"{p['as_of_utc'][11:19]}Z lap {p['lap']!s:>2} PLAN v{p['version']} car {p['car']} P{p['position_now']}: {len(p['scenarios'])} outcomes, "
                f"worst {worst['label'].lower()} {usd(worst['delta_cents'])}; damage {'unknown' if p['damage_estimate_cents'] is None else usd(p['damage_estimate_cents'])}; {adv}")
    if kind == "feed_health":
        sinks = ", ".join(f"{s['name']} {s['written']} rows" + ("" if s["ok"] else " OFF") for s in p["sinks"])
        return (f"HEALTH {p['state']} lap {p['lap']} race {p['race_clock_utc'][11:19] if p['race_clock_utc'] else '--'}Z | {p['publishes_last_60s']}/min, "
                f"{p['publishes_per_second_10s']}/s, last publish {p['seconds_since_last_publish']}s ago | {sinks} | jev {p['jev'].get('requests')} req p95 {p['jev'].get('p95_ms')}ms | "
                f"exposure {usd(p['exposure_now_cents'])} given up {usd(p['lost_from_peak_cents'])}")
    if kind == "replay_status":
        return f"REPLAY {p['state']} {p['events_done']}/{p['events_total']} events, lap {p.get('lap')}, jev {p['jev_requests']} requests, sinks {p['sinks']}"
    return f"{kind} {json.dumps(p)[:120]}"


def main() -> None:
    data: list[str] = []
    for raw in sys.stdin:
        s = raw.rstrip("\n")
        if s.startswith("data:"):
            data.append(s[5:].strip())
        elif s == "" and data:
            try:
                print(line(json.loads("".join(data))), flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"?? {exc}: {''.join(data)[:160]}", flush=True)
            data = []


if __name__ == "__main__":
    main()
