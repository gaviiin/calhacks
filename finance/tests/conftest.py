import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from finance.agents.store import AgentStore  # noqa: E402
from finance.tests import fixture  # noqa: E402


@pytest.fixture
def world(tmp_path):
    return fixture.build(tmp_path)


@pytest.fixture
def store(tmp_path):
    return AgentStore(tmp_path / "agents.db")
