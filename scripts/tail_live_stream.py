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
