"""Environment and paths for the live racing workstream (OpenF1 replay, Jev routing, publishing).

Everything is read at call time so tests can monkeypatch the environment. Nothing here is a
secret: TYPESAFE_API_KEY is read, never logged.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PACKAGE_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = PACKAGE_DIR / "fixtures"
# The OpenF1 cache is committed (data/openf1 is un-ignored in .gitignore) so the replay runs offline.
DEFAULT_DATA_DIR = REPO / "data" / "openf1"
# Append-only JSONL of everything published (gitignored).
DEFAULT_OUT_DIR = REPO / "data" / "live_racing"

DEFAULT_OPENF1_BASE_URL = "https://api.openf1.org/v1"
DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai"
DEFAULT_JEV_MODEL = "jev-latest"
DEFAULT_REPLAY_SPEED = 20.0
DEFAULT_LIVE_API_PORT = 8020

# Routing policy defaults (section 4B of the plan). Tune against the labeled fixtures.
JEV_MIN_CONFIDENCE = 0.75  # a Jev route that differs from code's needs this much (p_max about 0.8 of five options)
JEV_AGREE_FLOOR = 0.40  # when Jev picks the same route code did, two signals agree: a lower floor (p_max about 0.52)
JEV_DOWNGRADE_CONFIDENCE = 0.90  # taking a material event from 'a person verifies' down to 'refresh the forecast' needs this much
JEV_MIN_TOP2_GAP = 0.15
# How much a route commits the desk to. Jev may move a material event up this ladder freely (above the gate),
# down it only under the rules in JevRouter.policy, and never to no_action.
ROUTE_RANK = {"no_action": 0, "race_forecast": 1, "human_review": 2, "revenue_change": 3, "crash_finance": 3}
JEV_TIMEOUT_S = 8.0
JEV_RETRY_AFTER_CAP_S = 5.0
JEV_BUDGET_PER_REPLAY = 60

ROUTES = ("crash_finance", "revenue_change", "race_forecast", "human_review", "no_action")
URGENCY_LEVELS = ("routine", "watch", "urgent", "critical")


@dataclass(frozen=True)
class Config:
    data_dir: Path
    out_dir: Path
    openf1_base_url: str
    typesafe_base_url: str
    typesafe_api_key: str | None
    jev_model: str
    jev_mode: str  # api | deterministic_fallback
    replay_speed: float
    finance_agent_url: str | None
    spacetime_url: str
    spacetime_db: str
    spacetime_token: str | None
    live_api_port: int

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            data_dir=Path(os.environ.get("LIVE_RACING_DATA_DIR", DEFAULT_DATA_DIR)),
            out_dir=Path(os.environ.get("LIVE_RACING_OUT_DIR", DEFAULT_OUT_DIR)),
            openf1_base_url=os.environ.get("OPENF1_BASE_URL", DEFAULT_OPENF1_BASE_URL).rstrip("/"),
            typesafe_base_url=os.environ.get("TYPESAFE_BASE_URL", DEFAULT_TYPESAFE_BASE_URL).rstrip("/"),
            typesafe_api_key=os.environ.get("TYPESAFE_API_KEY") or None,
            jev_model=os.environ.get("JEV_MODEL", DEFAULT_JEV_MODEL),
            jev_mode=os.environ.get("JEV_MODE", "api"),
            replay_speed=float(os.environ.get("RACE_REPLAY_SPEED", DEFAULT_REPLAY_SPEED)),
            finance_agent_url=os.environ.get("FINANCE_AGENT_URL") or None,
            spacetime_url=os.environ.get("SPACETIME_URL", "http://127.0.0.1:3000").rstrip("/"),
            spacetime_db=os.environ.get("SPACETIME_DB", "pit-wall"),
            spacetime_token=os.environ.get("SPACETIME_TOKEN") or None,
            live_api_port=int(os.environ.get("LIVE_API_PORT", DEFAULT_LIVE_API_PORT)),
        )
