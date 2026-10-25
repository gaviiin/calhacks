import os
from pathlib import Path

import pytest

from race.openf1 import load_fixture

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
os.environ["RACE_OFFLINE"] = "1"


@pytest.fixture(scope="session")
def canada():
    """2026 Canada race, session 11291: Albon (23) out on lap 12 after contact with Piastri (81)."""
    return load_fixture(11291, FIXTURES)


@pytest.fixture(scope="session")
def australia():
    """2025 Australia race, session 9693: Sainz (55) crashes on lap 1 under the safety car; race control names no car."""
    return load_fixture(9693, FIXTURES)
