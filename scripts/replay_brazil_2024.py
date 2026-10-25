"""Replay the 2024 São Paulo Grand Prix from the cached OpenF1 slice and print the finance trace.

    uv run python scripts/replay_brazil_2024.py --from-lap 28 --to-lap 34 --speed 20
    uv run python scripts/replay_brazil_2024.py --from-lap 30 --to-lap 33 --pause-at 32
    uv run python scripts/replay_brazil_2024.py --speed inf --no-spacetime        # the whole race, instantly

Publishes race state, Jev decisions and incident signals to data/live_racing/<replay>.jsonl and,
when a local SpacetimeDB is up with the pit-wall database, to its pit_wall_items table. Jev is
called only when TYPESAFE_API_KEY is set; otherwise every decision says so (deterministic fallback).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from live_racing.config import Config  # noqa: E402
from live_racing.replay import ReplayOptions  # noqa: E402
from live_racing.runtime import make_replay  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--race", default="2024_sao_paulo_gp")
    ap.add_argument("--speed", default=None, help="race seconds per wall second (default RACE_REPLAY_SPEED or 20); 'inf' for no waiting")
    ap.add_argument("--from-lap", type=int, default=1)
    ap.add_argument("--to-lap", type=int, default=None)
    ap.add_argument("--pause-at", type=int, default=None, help="pause when the leader reaches this lap; Enter continues")
    ap.add_argument("--step", action="store_true", help="step through events one by one (Enter advances)")
    ap.add_argument("--no-jev", action="store_true")
    ap.add_argument("--no-spacetime", action="store_true")
    ap.add_argument("--corroborate-after", type=float, default=60.0, help="replay seconds after an attributed incident before corroboration")
    ap.add_argument("--state-every", type=float, default=2.0)
    ap.add_argument("--metrics-out", default=None, help="write the measured metrics JSON here")
    args = ap.parse_args()

    cfg = Config.from_env()
    speed = float("inf") if str(args.speed).lower() == "inf" else float(args.speed) if args.speed else cfg.replay_speed
    options = ReplayOptions(speed=speed, from_lap=args.from_lap, to_lap=args.to_lap, pause_at_lap=args.pause_at, step=args.step, jev=not args.no_jev,
                            corroborate_after_s=args.corroborate_after, state_every_s=args.state_every)

    def pause(rp):
        input(f"   paused at lap {rp.state.lap}; Enter to continue > ")

    def step(rp, ev):
        input(f"   {ev.event_time_utc[11:23]} {ev.endpoint:<12} car {ev.driver_number or '-':<3} lap {ev.lap_number or '-'} > ")

    rp = make_replay(args.race, options, cfg=cfg, spacetime=not args.no_spacetime, pause_handler=pause, step_handler=step)
    print(f"{rp.race.name}: {len(rp.events)} events, team cars {rp.team_cars}, Jev {rp.jev.describe()}, sinks {rp.publisher.names()}")
    print(f"replay {rp.replay_id}: laps {args.from_lap}-{args.to_lap or 'end'} at {speed}x; "
          f"state every {args.state_every}s of race time and on every material event\n")
    rp.run()
    m = rp.metrics()
    print("\nmeasured:", json.dumps(m, indent=1))
    if args.metrics_out:
        Path(args.metrics_out).write_text(json.dumps(m, indent=1) + "\n")
    for iid, sig in rp.incidents.items():
        print(f"\nincident {iid} v{sig.version}: {sig.sporting_confirmation}, attribution {sig.driver_attribution}, "
              f"jev used={sig.jev.used} ({sig.jev.status}) route {sig.jev.chosen_route}, handoff {sig.handoff.target}/{sig.handoff.status}, "
              f"financial impact {sig.financial_impact.status}")
    return 0 if rp.status.state in ("finished", "stopped") else 1


if __name__ == "__main__":
    raise SystemExit(main())
