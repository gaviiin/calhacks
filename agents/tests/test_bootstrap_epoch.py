"""Bootstrap and the database epoch (SCHEMA §10 "Epoch", red team H1)."""

import json

import pytest

from agents import config, epoch, identities
from agents import reducers as R
from agents.bootstrap import BootstrapError, bootstrap
from agents.sync import Sync

from .fakes import FakeStdb, FakeWorld


def _fresh(rulebook, tmp_path):
    stdb = FakeStdb()
    stdb.tables["setting"] = []
    rb = tmp_path / "rulebook.json"
    rb.write_text(json.dumps(rulebook[:3]))
    return stdb, tmp_path / "identities.json", rb


def _setting(stdb, key):
    return next((r["value"] for r in stdb.tables["setting"] if r["key"] == key), None)


def test_bootstrap_writes_a_random_epoch_and_is_idempotent(tmp_path, rulebook):
    stdb, ids_path, rb = _fresh(rulebook, tmp_path)
    logs = []
    res = bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=logs.append)
    e = _setting(stdb, "db_epoch")
    assert epoch.is_epoch(e)
    assert [c for c in stdb.reducer_calls(R.SET_SETTING) if c[2][0] == "db_epoch"] == [(json.loads(ids_path.read_text())["admin"]["token"], R.SET_SETTING, ["db_epoch", e])]
    ids = json.loads(ids_path.read_text())
    assert set(ids) == set(config.ACTOR_ROLES)  # top-level keys stay actor names
    assert {d["db_epoch"] for d in ids.values()} == {e}
    assert identities.epoch(ids) == e and epoch.read_state_epoch(ids_path) == e
    assert any(l.startswith(f"db_epoch: {e} written") for l in logs)
    assert res["claimed"] and res["created"]

    n = len(stdb.calls)
    logs.clear()
    res2 = bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=logs.append)
    assert res2 == {"created": [], "claimed": [], "rulebook_loaded": 0, "settings_written": []}
    assert len(stdb.calls) == n and _setting(stdb, "db_epoch") == e  # no second epoch, no role traffic
    assert any("roles: unchanged" in l for l in logs)
    assert identities.epoch(json.loads(ids_path.read_text())) == e

    # two bootstraps of two databases never share an epoch
    (tmp_path / "other").mkdir(exist_ok=True)
    stdb2, ids2, rb2 = _fresh(rulebook, tmp_path / "other")
    bootstrap(stdb2, identities_path=ids2, rulebook_path=rb2, log=lambda *_: None)
    assert _setting(stdb2, "db_epoch") != e


def test_identities_from_another_epoch_are_refused(tmp_path, rulebook):
    stdb, ids_path, rb = _fresh(rulebook, tmp_path)
    bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=lambda *_: None)
    ids = json.loads(ids_path.read_text())
    identities.stamp(ids, "f" * 16)
    identities.save(ids, ids_path)
    with pytest.raises(BootstrapError) as ei:
        bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=lambda *_: None)
    assert str(ids_path) in str(ei.value) and "f" * 16 in str(ei.value) and _setting(stdb, "db_epoch") in str(ei.value)


def test_republished_database_gets_a_new_epoch_and_old_state_is_refused(tmp_path, rulebook, monkeypatch):
    stdb, ids_path, rb = _fresh(rulebook, tmp_path)
    bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=lambda *_: None)
    old = _setting(stdb, "db_epoch")
    # sync ran under the old epoch
    cursors = tmp_path / "state" / "sync_cursors.json"
    epoch.save_json(cursors, old, {"gl_line": 285})
    monkeypatch.setattr(config, "SYNC_CURSORS_PATH", cursors)

    # `make stdb-publish`: the module is wiped, identities.json survives (its tokens are still valid)
    wiped = FakeStdb()
    wiped.tables["setting"] = []
    wiped.tokens = dict(stdb.tokens)
    logs = []
    res = bootstrap(wiped, identities_path=ids_path, rulebook_path=rb, log=logs.append)
    new = _setting(wiped, "db_epoch")
    assert epoch.is_epoch(new) and new != old
    assert res["created"] == [] and len(res["claimed"]) == len(config.ACTOR_ROLES) - 1  # roles re-claimed
    assert identities.epoch(json.loads(ids_path.read_text())) == new
    assert any("state files from another db_epoch" in l and str(cursors) in l for l in logs)

    # the old cursor file is refused by name; nothing is replayed against the new database
    world = FakeWorld()
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    sync_actor = identities.get("sync", ids_path)
    n = len(wiped.calls)
    with pytest.raises(epoch.EpochMismatch) as ei:
        Sync(world.client(), wiped, sync_actor, cursors_path=cursors, cache_path=tmp_path / "state" / "sync_cache.json",
             dead_letter_path=tmp_path / "state" / "dead_letter.jsonl",
             issues_path=tmp_path / "state" / "rulebook_issues.json", rule_versions=set())
    assert str(cursors) in str(ei.value) and old in str(ei.value) and new in str(ei.value)
    assert len(wiped.calls) == n


def test_bootstrap_without_identities_file_on_an_epoched_module_still_bootstraps(tmp_path, rulebook):
    # legacy identities.json (no db_epoch) against a module that already has one: just stamp it
    stdb, ids_path, rb = _fresh(rulebook, tmp_path)
    bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=lambda *_: None)
    ids = json.loads(ids_path.read_text())
    for d in ids.values():
        d.pop("db_epoch")
    identities.save(ids, ids_path)
    n = len(stdb.calls)
    bootstrap(stdb, identities_path=ids_path, rulebook_path=rb, log=lambda *_: None)
    assert len(stdb.calls) == n
    assert identities.epoch(json.loads(ids_path.read_text())) == _setting(stdb, "db_epoch")
