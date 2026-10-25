"""Race Desk from the terminal: replay a real Grand Prix and hear the money.

    python -m racedesk races 2026
    python -m racedesk replay 2024 14            # Spa 2024: Russell wins on the road, disqualified 3 hours later
    python -m racedesk replay 2026 10            # Spa 2026: Russell out on lap 1, damage hits the cost cap
    python -m racedesk replay 2023 15 --pace 0.2 # Singapore 2023, played back with a pause between calls
"""

from __future__ import annotations

import argparse
import time

from .replay import money, races, replay, usd


def main() -> None:
    ap = argparse.ArgumentParser(prog="racedesk")
    ap.add_argument("cmd", choices=["races", "replay"])
    ap.add_argument("season", type=int)
    ap.add_argument("round", type=int, nargs="?")
    ap.add_argument("--team", default="mercedes")
    ap.add_argument("--pace", type=float, default=0.0, help="seconds to pause between radio calls")
    args = ap.parse_args()
    if args.cmd == "races":
        for r in races(args.season):
            print(f"R{r['round']:>2}  {r['date']}  {r['name']} ({r['laps']} laps)")
        return
    out = replay(args.season, args.round, args.team)
    print(f"{out['season']} {out['race']}  |  {', '.join(out['team_cars'].values())}  |  start {out['start_utc']}\n")
    for c in out["radio"]:
        clock = (c.get("clock") or "")[11:19]
        print(f"[{clock or '  final '}] L{c['lap']:>2}  {c['text']}")
        time.sleep(args.pace)
    print("\nSPEED SCOREBOARD")
    for s in out["speed"]:
        when = (s["happened_at"] or "")[11:19] or "--:--:--"
        stake = money(s["usd_at_stake"]) if s["usd_at_stake"] else "-"
        saved = f"  saved {money(s['usd_protected'])}" if s["usd_protected"] else ""
        secs = f"{s['seconds_to_act']}s" if s["seconds_to_act"] is not None else "-"
        print(f"  {when}  {s['event']}: acted in {secs}  ({s['action']}; at stake {stake}{saved})")
        print(f"            normal finance team: {s['manual_baseline']}")
    t = out["totals"]
    print(f"\nRoad {money(t['road'])} -> booked {money(t['final'])} ({usd(t['final'] - t['road'])}); money protected {money(t['money_protected'])}")


if __name__ == "__main__":
    main()
