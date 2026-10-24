"""Environment and paths for the agent runtime (SCHEMA.md §8).

Everything is read from the environment at call time through `Config.from_env()`, so tests
can monkeypatch env vars. Module-level constants are the defaults.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parent
REPO_ROOT = AGENTS_DIR.parent

IDENTITIES_PATH = AGENTS_DIR / "identities.json"
STATE_DIR = AGENTS_DIR / "state"
SYNC_CURSORS_PATH = STATE_DIR / "sync_cursors.json"
SYNC_CACHE_PATH = STATE_DIR / "sync_cache.json"
GATEWAY_LEDGER_PATH = STATE_DIR / "gateway_posted.json"
DEAD_LETTER_PATH = STATE_DIR / "dead_letter.jsonl"
RULEBOOK_ISSUES_PATH = STATE_DIR / "rulebook_issues.json"
OUT_DIR = AGENTS_DIR / "out"
ONBOARDING_REPORT_PATH = OUT_DIR / "onboarding_report.md"
RULEBOOK_PATH = REPO_ROOT / "rulebook" / "rulebook.json"
RULEBOOK_CHANGES_PATH = REPO_ROOT / "rulebook" / "CHANGES.md"
WORLD_OUT_DIR = REPO_ROOT / "world" / "out"

DEFAULT_STDB_URL = "http://localhost:3000"
DEFAULT_STDB_DB = "cost-cap-desk"  # SpacetimeDB 2.13 rejects underscores (REDUCERS.md)
DEFAULT_WORLD_URL = "http://localhost:8010"

# Claude model. Override with CCD_MODEL.
DEFAULT_MODEL = "claude-opus-5-5"
# Refusal fallback (server side). Verified accepted by anthropic 2.3.0 on client.beta.messages.*.
LLM_BETAS = ["server-side-fallback-2026-07-01"]
LLM_FALLBACKS = "default"
LLM_EFFORT = "medium"
LLM_MAX_TOKENS = 16000

# Settings written by bootstrap (SCHEMA §6 `setting`).
MATERIALITY_USD_MINOR = 25_000_000  # $250k
CAP_USD_MINOR = 21_500_000_000  # $215m
CAP_YEAR = 2026

# Roles (SCHEMA §2). Actor name -> role.
ACTOR_ROLES: dict[str, str] = {
    "admin": "admin",
    "sync": "sync",
    "cap_analyst": "ai_cap_analyst",
    "policy_learner": "ai_policy_learner",
    "controller": "human_controller",
    "head_of_cost_cap": "human_head_of_cost_cap",
    "gateway": "gateway",
    "auto_approver": "auto_approver",
    "red_team": "red_team",
}

ACTOR_LABELS: dict[str, str] = {
    "admin": "Bootstrap script",
    "sync": "Sync job",
    "cap_analyst": "AI Cap Analyst",
    "policy_learner": "AI Policy Learner",
    "controller": "Financial Controller",
    "head_of_cost_cap": "Head of Cost Cap",
    "gateway": "ERP gateway",
    "auto_approver": "Standing-approval job",
    "red_team": "Red team harness",
}


@dataclass(frozen=True)
class Config:
    stdb_url: str
    stdb_db: str
    world_url: str
    gateway_key: str | None
    model: str

    @classmethod
    def from_env(cls) -> "Config":
        return cls(
            stdb_url=os.environ.get("STDB_URL", DEFAULT_STDB_URL).rstrip("/"),
            stdb_db=os.environ.get("STDB_DB", DEFAULT_STDB_DB),
            world_url=os.environ.get("WORLD_URL", DEFAULT_WORLD_URL).rstrip("/"),
            gateway_key=os.environ.get("GATEWAY_KEY") or None,
            model=os.environ.get("CCD_MODEL", DEFAULT_MODEL),
        )


def model() -> str:
    """The Claude model id, overridable by CCD_MODEL."""
    return os.environ.get("CCD_MODEL", DEFAULT_MODEL)


def has_llm_credentials() -> bool:
    """True when the anthropic SDK can plausibly authenticate (key or token in env)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
