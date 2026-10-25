"""Milestone P1: replay the 2024 Belgian Grand Prix result change from the real FIA documents.

    uv run python scripts/replay_spa_2024.py --speed 120

Provisional classification -> Doc 43 summons (car 63) -> Doc 44 infringement (disqualification)
-> Doc 46 final classification, each at its real publication time (ingestion/captures). Jev routes
the documents; the arithmetic is the revenue desk's own contract logic; nothing is booked here.
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
from live_racing.finance_projections import usd  # noqa: E402
from live_racing.result_replay import ResultReplayOptions  # noqa: E402
from live_racing.runtime import make_replay  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--speed", default="120", help="seconds of document time per wall second; 'inf' for no waiting")
    ap.add_argument("--no-jev", action="store_true")
    ap.add_argument("--no-spacetime", action="store_true")
    args = ap.parse_args()
    speed = float("inf") if args.speed.lower() == "inf" else float(args.speed)
    rp = make_replay("2024_belgian_gp", ResultReplayOptions(speed=speed, jev=not args.no_jev), cfg=Config.from_env(), spacetime=not args.no_spacetime)
    print(f"{rp.race.name}: {len(rp.docs)} race documents from the saved FIA captures; Jev {rp.jev.describe()}; sinks {rp.publisher.names()}\n")
    rp.run()
    print("\nmeasured:", json.dumps(rp.metrics(), indent=1))
    for s in rp.signals:
        print(f"\n{s.type}: {s.status}\n  {s.message}\n  before {usd(s.before.amount_cents)} / after {usd(s.after.amount_cents)}; jev used={s.jev.used} ({s.jev.status}) -> {s.jev.chosen_route}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
