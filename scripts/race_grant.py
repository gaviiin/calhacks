"""Give an identity the race desk's writer role in pit-wall.

    uv run python scripts/race_grant.py            # this machine's CLI identity -> role 'race' (the agents)
    uv run python scripts/race_grant.py --role race_head --identity <hex> --name "Morgan Hale"
    uv run python scripts/race_grant.py --role cfo --identity <hex> --name "Dana Okafor"   # a seat on a second device

A person's role (race_head, controller, head_of_cost_cap, cfo) is granted as a seat (grant_seat): the name every
decision of theirs is recorded under. pit-wall refuses to seat the publisher's own identity, which runs the agents.

The module owner (whoever published pit-wall) calls set_writer; by default that is also the CLI identity,
so the replay, the forecast agent and the dashboard's head seat can all run from one laptop.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from finance.spacetime_mirror import cli_token  # noqa: E402


PERSON_ROLES = ["race_head", "controller", "head_of_cost_cap", "cfo"]


def cli_identity() -> str:
    cli = shutil.which("spacetime") or str(Path.home() / ".local" / "bin" / "spacetime")
    out = subprocess.run([cli, "login", "show"], capture_output=True, text=True, timeout=20).stdout
    m = re.search(r"logged in as ([0-9a-fA-F]{64})", out) or re.search(r"([0-9a-fA-F]{64})", out)
    if not m:
        raise SystemExit(f"could not read the CLI identity from `spacetime login show`:\n{out}")
    return m.group(1).lower()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--identity", help="hex identity to grant (default: this CLI's)")
    ap.add_argument("--role", action="append", choices=["race", "kernel", "router", *PERSON_ROLES], help="default: race")
    ap.add_argument("--name", help="the person's name for a seat role (default: the role)")
    ap.add_argument("--db", default=os.environ.get("SPACETIME_DB", "pit-wall"))
    ap.add_argument("--url", default=os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000"))
    args = ap.parse_args()
    who = (args.identity or cli_identity()).lower()
    token = os.environ.get("SPACETIME_TOKEN") or cli_token()
    if not token:
        raise SystemExit("no token: run `spacetime login` or set SPACETIME_TOKEN")
    http = httpx.Client(timeout=10, headers={"Authorization": f"Bearer {token}"})
    # One identity may hold one role in `writers` (who is the primary key), so the last role wins. The
    # replay needs 'race'; grant 'race_head' to a second identity (the dashboard seat) for corrections.
    roles = args.role or ["race"]
    for role in roles:
        base = f"{args.url.rstrip('/')}/v1/database/{args.db}/call"
        if role in PERSON_ROLES:
            name = args.name or role.replace("_", " ").title()
            r = http.post(f"{base}/grant_seat", json=[{"__identity__": f"0x{who}"}, role, name])
            print(f"grant_seat({who[:12]}…, {role}, {name}) -> {r.status_code} {r.text.strip()[:120]}")
        else:
            r = http.post(f"{base}/set_writer", json=[{"__identity__": f"0x{who}"}, role])
            print(f"set_writer({who[:12]}…, {role}) -> {r.status_code} {r.text.strip()[:120]}")
        if r.status_code != 200:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
