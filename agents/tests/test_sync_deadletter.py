"""Sync failure isolation (SCHEMA §10 "Sync", red team H7): dead letters, deletes as VOID, rulebook
issues, per-source isolation, and the db_epoch check on state files."""

import json

import httpx
import pytest

from agents import epoch
from agents import reducers as R
from agents.sync import Sync, summary, void_gl_line
from agents.tests.fakes import FakeWorld

EPOCH = "c" * 16


def _gl(k=1, **kw):
    r = {"id": f"gl-00000{k}", "posted_date": "2026-01-05", "period_key": "2026-01", "account_id": "acct-6010",
         "department_id": "dept-MFG", "vendor_id": "ven-001", "bill_id": None, "amount_minor": 1000 * k,
         "currency": "GBP", "fx_rate_to_usd": 1.27, "amount_usd_minor": 1270 * k, "memo": "m",
         "erp_category_code": "MARKETING", "entity": "RACING", "correction_of": None}
    r.update(kw)
    return r


def _bad_fair_value():
    return {"id": "fv-001", "counterparty_vendor_id": "ven-009", "item": "recharge", "contract_value_minor": 1,
            "fair_value_minor": 2, "effective_from": "2026-01-01"}  # no 'currency'


def _sync(world, stdb, actors, tmp_path, **kw):
    stdb.tables["setting"].append({"key": "db_epoch", "value": EPOCH})
    kw.setdefault("rule_versions", {"ISS22", "SECD-ISS07"})
    return Sync(world.client(), stdb, actors["sync"], cursors_path=tmp_path / "sync_cursors.json",
                cache_path=tmp_path / "sync_cache.json", dead_letter_path=tmp_path / "dead_letter.jsonl",
                issues_path=tmp_path / "rulebook_issues.json", page_size=2, **kw)


def _upserts(stdb, name):
    return [c[2] for c in stdb.reducer_calls(name)]


def test_dead_letter_continues_past_bad_fair_value_and_syncs_gl_lines(world, stdb, actors, tmp_path):
    world.emit("account", {"id": "acct-6010", "code": "6010", "name": "Materials"})
    fv_cursor = world.emit("fair_value", _bad_fair_value())
    for k in (1, 2, 3):
        world.emit("gl_line", _gl(k))
    s = _sync(world, stdb, actors, tmp_path)
    stats = s.run_once()
    assert stats["fair_value"] == {"records": 1, "calls": 0, "cursor": fv_cursor, "dead": 1}
    assert stats["gl_line"]["records"] == 3 and stats["gl_line"]["calls"] == 3 and "dead" not in stats["gl_line"]
    assert len(stdb.tables["gl_line"]) == 3 and len(stdb.tables["work_item"]) == 3
    assert stdb.reducer_calls(R.UPSERT_FAIR_VALUE) == []
    # the dead letter names the record and the error, under the module epoch
    (dl,) = s.dead_letters()
    assert dl["source"] == "fair_value" and dl["cursor"] == fv_cursor and dl["id"] == "fv-001" and dl["op"] == "upsert"
    assert dl["error"].startswith("KeyError") and "currency" in dl["error"]
    assert dl["record"]["id"] == "fv-001"
    assert epoch.read_state_epoch(tmp_path / "dead_letter.jsonl") == EPOCH
    assert any("1 record(s) dead-lettered" in w for w in s.warnings)
    assert "fair_value:1rec/0calls@2/1dead" in summary(stats) and "dead-lettered: 1" in summary(stats)
    # the cursor advanced past it: a second run (fresh process) sends nothing and adds no dead letter
    n = len(stdb.calls)
    s2 = _sync(world, stdb, actors, tmp_path)
    stats2 = s2.run_once()
    assert len(stdb.calls) == n and all(v["records"] == 0 for v in stats2.values())
    assert len(s2.dead_letters()) == 1


def test_module_error_is_dead_lettered_and_the_rest_continues(world, stdb, actors, tmp_path):
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    world.emit("vendor", {"id": "ven-001", "name": "A", "country": "GB", "related_party": False,
                          "related_party_entity": None, "bank_iban": "GB1", "category_hint": None})
    world.emit("vendor", {"id": "ven-002", "name": "B", "country": "GB", "related_party": False,
                          "related_party_entity": None, "bank_iban": "GB2", "category_hint": None})
    world.emit("gl_line", _gl(1))
    stdb.raise_on.add(R.UPSERT_VENDOR)  # module says 500 for every vendor upsert
    s = _sync(world, stdb, actors, tmp_path)
    stats = s.run_once()
    assert stats["vendor"]["dead"] == 2 and stats["vendor"]["records"] == 2
    assert len(stdb.tables["gl_line"]) == 1
    errs = [d["error"] for d in s.dead_letters()]
    assert len(errs) == 2 and all(e.startswith("StdbError") for e in errs)
    assert stats["vendor"]["cursor"] == 3  # advanced past both


def test_delete_becomes_zero_amount_void_upsert(world, stdb, actors, tmp_path):
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    world.emit("gl_line", _gl(1, memo="Canteen January"))
    s = _sync(world, stdb, actors, tmp_path)
    s.run_once()
    world.streams["gl_line"].append({"cursor": 99, "op": "delete", "record": {"id": "gl-000001"}})
    stats = s.run_once()
    assert stats["gl_line"] == {"records": 1, "calls": 1, "cursor": 99}
    calls = _upserts(stdb, R.UPSERT_GL_LINE)
    assert len(calls) == 2
    void = calls[-1]
    assert void[0] == "gl-000001" and void[1] == "gl_line:gl-000001:99"
    row = stdb.tables["gl_line"][0]
    assert row["amount_minor"] == 0 and row["amount_usd_minor"] == 0 and row["memo"] == "VOID: Canteen January"
    assert row["account_code"] == "6010" and row["period_key"] == "2026-01" and row["currency"] == "GBP"
    assert len(stdb.tables["work_item"]) == 1  # an upsert of the same id, not a new line
    assert s.dead_letters() == []


class _RecordsWorld(FakeWorld):
    """/records/{source}/{id} serves the last *upserted* version, as the real world API does."""

    def latest(self, source, rid):
        found = None
        for ch in self.streams[source]:
            if ch.get("op", "upsert") == "upsert" and ch["record"].get("id") == rid:
                found = ch["record"]
        return found


def test_delete_without_cache_fetches_the_record_and_unknown_is_dead_lettered(stdb, actors, tmp_path):
    world = _RecordsWorld()
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    world.emit("gl_line", _gl(1))
    world.streams["gl_line"].append({"cursor": 50, "op": "delete", "record": {"id": "gl-000001"}})
    world.streams["gl_line"].append({"cursor": 51, "op": "delete", "record": {"id": "gl-nope"}})
    world.streams["gl_line"].append({"cursor": 52, "op": "delete", "record": {"id": ""}})
    s = _sync(world, stdb, actors, tmp_path)
    s.cursors["gl_line"] = 2  # pretend the upsert was applied by an earlier epoch-less process: no cache
    stats = s.run_once()
    assert stats["gl_line"]["records"] == 3 and stats["gl_line"]["calls"] == 1 and stats["gl_line"]["dead"] == 2
    (void,) = _upserts(stdb, R.UPSERT_GL_LINE)
    assert void[1] == "gl_line:gl-000001:50" and void[9] == 0 and void[13] == "VOID: m"
    dls = s.dead_letters()
    assert [d["cursor"] for d in dls] == [51, 52] and all(d["op"] == "delete" for d in dls)
    assert "no previous version" in dls[0]["error"] and "without an id" in dls[1]["error"]
    assert stats["gl_line"]["cursor"] == 52


def test_void_gl_line_does_not_double_prefix():
    v = void_gl_line({"memo": "VOID: x", "amount_minor": 5, "amount_usd_minor": 6})
    assert v == {"memo": "VOID: x", "amount_minor": 0, "amount_usd_minor": 0}
    assert void_gl_line({"amount_minor": 1})["memo"] == "VOID: "


def test_delete_on_other_sources_is_dead_lettered(world, stdb, actors, tmp_path):
    world.streams["vendor"].append({"cursor": 5, "op": "delete", "record": {"id": "ven-001"}})
    s = _sync(world, stdb, actors, tmp_path)
    stats = s.run_once()
    assert stats["vendor"]["dead"] == 1 and stats["vendor"]["cursor"] == 5
    assert "not supported" in s.dead_letters()[0]["error"]


def test_rulebook_issue_is_recorded_and_a_new_one_warns(world, stdb, actors, tmp_path, capsys):
    world.emit("rulebook_issue", {"id": "ISS22", "published_on": "2024-12-11", "effective_from": "2021-01-01",
                                  "path": "rulebook/rulebook.json"})
    world.emit("rulebook_issue", {"id": "SECD-ISS07", "published_on": "2026-06-25", "effective_from": "2026-01-01",
                                  "path": "rulebook/rulebook.json"})
    s = _sync(world, stdb, actors, tmp_path)
    stats = s.run_once()
    assert stats["rulebook_issue"]["records"] == 2 and stats["rulebook_issue"]["calls"] == 0
    assert s.warnings == []  # both issues are in the local rulebook
    assert s.issues["latest"]["id"] == "SECD-ISS07"
    saved = json.loads((tmp_path / "rulebook_issues.json").read_text())
    assert saved["db_epoch"] == EPOCH and set(saved["data"]["issues"]) == {"ISS22", "SECD-ISS07"}
    assert not stdb.reducer_calls(R.SET_SETTING)  # sync never writes settings
    c = world.emit("rulebook_issue", {"id": "SECD-ISS08", "published_on": "2026-09-01", "effective_from": "2027-01-01",
                                      "path": "rulebook/rulebook.json"})
    s.run_once()
    assert len(s.warnings) == 1
    assert s.warnings[0].startswith("rule change: SECD-ISS08 published 2026-09-01, effective from 2027-01-01; rebuild rulebook")
    assert s.issues["latest"] == {"id": "SECD-ISS08", "published_on": "2026-09-01", "effective_from": "2027-01-01",
                                  "path": "rulebook/rulebook.json", "cursor": c}
    s.run_once()
    assert s.warnings == []  # already known: no repeat


class _FlakyWorld(FakeWorld):
    def __init__(self, broken_source: str):
        super().__init__()
        self.broken_source = broken_source

    def handler(self, request):
        if request.url.path == f"/changes/{self.broken_source}":
            return httpx.Response(500, json={"detail": "boom"})
        return super().handler(request)


def test_transport_failure_on_one_source_does_not_block_gl_lines(stdb, actors, tmp_path):
    world = _FlakyWorld("vendor")
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    world.emit("vendor", {"id": "ven-001", "name": "A"})
    world.emit("gl_line", _gl(1))
    s = _sync(world, stdb, actors, tmp_path)
    stats = s.run_once()
    assert stats["vendor"]["records"] == 0 and stats["vendor"]["cursor"] == 0 and "HTTP 500" in stats["vendor"]["error"]
    assert stats["gl_line"]["records"] == 1 and len(stdb.tables["gl_line"]) == 1
    assert s.dead_letters() == []  # transient: retried next run, not dead-lettered
    assert "vendor:0rec/0calls@0/STOPPED" in summary(stats) and "stopped: vendor" in summary(stats)
    world.broken_source = "none"
    stats = s.run_once()
    assert stats["vendor"]["records"] == 1 and len(stdb.tables["vendor"]) == 1


def test_state_files_carry_the_epoch_and_a_mismatch_refuses(world, stdb, actors, tmp_path):
    world.emit("account", {"id": "acct-6010", "code": "6010"})
    world.emit("gl_line", _gl(1))
    _sync(world, stdb, actors, tmp_path).run_once()
    for name in ("sync_cursors.json", "sync_cache.json", "rulebook_issues.json"):
        assert json.loads((tmp_path / name).read_text())["db_epoch"] == EPOCH
    # the database is republished and bootstrapped again: a new epoch
    stdb.tables["setting"] = [r for r in stdb.tables["setting"] if r["key"] != "db_epoch"]
    stdb.tables["setting"].append({"key": "db_epoch", "value": "d" * 16})
    with pytest.raises(epoch.EpochMismatch) as ei:
        Sync(world.client(), stdb, actors["sync"], cursors_path=tmp_path / "sync_cursors.json",
             cache_path=tmp_path / "sync_cache.json", dead_letter_path=tmp_path / "dead_letter.jsonl",
             issues_path=tmp_path / "rulebook_issues.json", rule_versions=set())
    assert str(tmp_path / "sync_cursors.json") in str(ei.value) and "d" * 16 in str(ei.value)
    assert len(stdb.calls) == 1  # nothing was replayed


def test_legacy_cursor_file_without_epoch_is_refused(world, stdb, actors, tmp_path):
    (tmp_path / "sync_cursors.json").write_text(json.dumps({"gl_line": 285}))  # pre-epoch layout
    with pytest.raises(epoch.EpochMismatch) as ei:
        _sync(world, stdb, actors, tmp_path)
    assert "sync_cursors.json" in str(ei.value) and "no epoch record" in str(ei.value)


def test_explicit_epoch_wins_over_the_setting(world, stdb, actors, tmp_path):
    s = _sync(world, stdb, actors, tmp_path, db_epoch="e" * 16)
    s.run_once()
    assert json.loads((tmp_path / "sync_cursors.json").read_text())["db_epoch"] == "e" * 16
