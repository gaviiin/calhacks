"""Create agents/fetchai/.env with fresh random seeds and the sponsor agent's address filled in.

    python agents/fetchai/setup_env.py          # refuses to overwrite an existing .env
    python agents/fetchai/setup_env.py --force

Seeds are generated on this machine and never printed. They fix each agent's address,
so keep the .env file (it is gitignored) to keep the same agents on Agentverse.
"""

from __future__ import annotations

import secrets
import sys
from pathlib import Path

from uagents.crypto import Identity

HERE = Path(__file__).resolve().parent
ENV = HERE / ".env"

if ENV.exists() and "--force" not in sys.argv:
    sys.exit(f"{ENV} already exists; use --force to replace it (the agents will get new addresses)")

seeds = {k: f"meridian-{k}-{secrets.token_hex(24)}" for k in ("pitwall", "sponsor", "dispute")}
addr = {k: Identity.from_seed(v, 0).address for k, v in seeds.items()}
ENV.write_text(f"""# Created by setup_env.py. Secret: never commit (gitignored).
PITWALL_API_URL=http://localhost:8000
PITWALL_RUN_ID=

PITWALL_AGENT_SEED={seeds['pitwall']}
PITWALL_AGENT_PORT=8011
PITWALL_COLLECT=1
PITWALL_COLLECT_EVERY=30
PITWALL_COLLECT_BATCH=3
SPONSOR_AGENT={addr['sponsor']}

SPONSOR_AGENT_SEED={seeds['sponsor']}
SPONSOR_AGENT_PORT=8012
SPONSOR_IDS=halcyon,volta,arcadia,northwind,ridgeline
VERIFY_OFFLINE=0

DISPUTE_AGENT_SEED={seeds['dispute']}
DISPUTE_AGENT_PORT=8013

ASI1_API_KEY=
AGENT_MAILBOX=1
""")
ENV.chmod(0o600)
print(f"wrote {ENV}\n")
print(f"  meridian-pit-wall   {addr['pitwall']}")
print(f"  sponsor-ap-desk     {addr['sponsor']}")
print(f"  dispute demo        {addr['dispute']}")
print("\nPut the first two addresses in agents/fetchai/README.md under 'Agents'.")
