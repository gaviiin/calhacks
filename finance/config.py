"""Constants shared by the finance core. Money is always integer cents."""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WORLD_DIR = REPO / "world"
POLICY_DIR = REPO / "policy"
KEYS_DIR = REPO / "keys"
DATA_DIR = REPO / "data"
CAPTURES_DIR = REPO / "ingestion" / "captures"

MATERIALITY_CENTS = 25_000_000  # $250,000
CFO_CENTS = 100_000_000  # $1,000,000

GP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1]

ACCOUNTS = {
    "1000": "Cash (USD)",
    "1200": "Accounts receivable: sponsors",
    "1250": "Prize money receivable (contract asset)",
    "1300": "Accrued bonus revenue (contract asset)",
    "4000": "Sponsorship revenue: base",
    "4010": "Sponsorship revenue: performance bonuses",
    "4100": "Championship prize money revenue",
    "7100": "Realized FX gain/loss",
}

# Accounts each entry kind may touch (kernel check K2).
KIND_ACCOUNTS = {
    "base_recognition": {"1200", "4000"},
    "bonus": {"1300", "4010"},
    "bonus_reversal": {"1300", "1200", "4010"},
    "bonus_billing": {"1200", "1300"},
    "prize_accrual": {"1250", "4100"},
    "prize_estimate_change": {"1250", "4100"},
    "cash_receipt": {"1000", "1200", "7100"},
}

# Kinds that park at materiality regardless of preparer (policy: materiality).
JUDGMENT_KINDS = {"bonus_reversal", "prize_estimate_change"}

DSQ_TEXTS = {"D", "DSQ"}
