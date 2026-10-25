import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from finance.world import World  # noqa: E402
from live_racing.normalize import read_jsonl  # noqa: E402
from live_racing.races import race as get_race  # noqa: E402

SLICE = ROOT / "data" / "openf1" / "2024_brazil" / "derived"


@pytest.fixture(scope="session")
def world():
    return World()


@pytest.fixture(scope="session")
def brazil():
    return get_race("2024_sao_paulo_gp")


@pytest.fixture(scope="session")
def spa():
    return get_race("2024_belgian_gp")


@pytest.fixture(scope="session")
def slice_meta():
    return json.loads((SLICE / "meta.json").read_text())


@pytest.fixture(scope="session")
def slice_events():
    return read_jsonl(SLICE / "events.jsonl")


@pytest.fixture
def quiet(monkeypatch, tmp_path):
    """No SpacetimeDB, no webhook, JSONL under tmp, no Jev key: the replay runs on this machine alone."""
    monkeypatch.setenv("LIVE_RACING_OUT_DIR", str(tmp_path / "out"))
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("FINANCE_AGENT_URL", raising=False)
    monkeypatch.setenv("JEV_MODE", "api")
    return tmp_path
