"""Shared fixtures: generate the world once per session into a temp dir (seed 7)."""

from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from world import generate


def load_dir(d: Path) -> dict[str, list[dict]]:
    out = {}
    for src in generate.SOURCES:
        with (d / f"{src}.jsonl").open(encoding="utf-8") as f:
            out[src] = [json.loads(x) for x in f if x.strip()]
    return out


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


@pytest.fixture(scope="session")
def out_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("world_out_seed7")
    assert generate.main(["--seed", "7", "--out", str(d), "--quiet"]) == 0
    return d


@pytest.fixture(scope="session")
def recs(out_dir) -> dict[str, list[dict]]:
    return load_dir(out_dir)


@pytest.fixture(scope="session")
def latest(recs) -> dict[str, dict[str, dict]]:
    """Upsert semantics: last emission per id wins."""
    out: dict[str, dict[str, dict]] = {}
    for src, rows in recs.items():
        m: dict[str, dict] = {}
        for r in rows:
            m[r["id"]] = r
        out[src] = m
    return out


@pytest.fixture(scope="session")
def answer_key(out_dir) -> list[dict]:
    return read_csv(out_dir / "answer_key.csv")


@pytest.fixture(scope="session")
def truth(out_dir) -> list[dict]:
    return read_csv(out_dir / "truth_2026.csv")
