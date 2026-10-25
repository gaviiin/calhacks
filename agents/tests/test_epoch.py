import json

import pytest

from agents import epoch

from .fakes import FakeStdb

E1, E2 = "a" * 16, "b" * 16


def test_new_epoch_is_16_hex():
    e = epoch.new_epoch()
    assert epoch.is_epoch(e) and e != epoch.new_epoch()


def test_current_epoch_reads_the_setting():
    stdb = FakeStdb()
    tok = stdb.actor("sync", "sync").token
    assert epoch.current_epoch(stdb, tok) is None
    stdb.tables["setting"].append({"key": "db_epoch", "value": E1})
    assert epoch.current_epoch(stdb, tok) == E1


def test_json_envelope_roundtrip_and_check(tmp_path):
    p = tmp_path / "sync_cursors.json"
    assert epoch.load_json(p, E1, {"x": 1}) == {"x": 1}  # missing file: default
    epoch.save_json(p, E1, {"gl_line": 7})
    assert json.loads(p.read_text()) == {"db_epoch": E1, "data": {"gl_line": 7}}
    assert epoch.read_state_epoch(p) == E1
    epoch.check_state_epoch(p, E1)
    assert epoch.load_json(p, E1) == {"gl_line": 7}
    with pytest.raises(epoch.EpochMismatch) as ei:
        epoch.check_state_epoch(p, E2)
    msg = str(ei.value)
    assert str(p) in msg and E1 in msg and E2 in msg and "Delete" in msg
    with pytest.raises(epoch.EpochMismatch):
        epoch.load_json(p, E2)


def test_legacy_flat_file_has_no_epoch_and_is_refused(tmp_path):
    p = tmp_path / "gateway_posted.json"
    p.write_text(json.dumps({"1": {"erp_entry_id": "JE-1", "lines": []}}))
    assert epoch.read_state_epoch(p) is None
    with pytest.raises(epoch.EpochMismatch) as ei:
        epoch.check_state_epoch(p, E1)
    assert "no epoch record" in str(ei.value) and "gateway_posted.json" in str(ei.value)
    epoch.check_state_epoch(p, None)  # a module without an epoch yet matches a file without one


def test_identities_layout_epoch(tmp_path):
    p = tmp_path / "identities.json"
    p.write_text(json.dumps({"admin": {"identity": "x", "token": "t", "role": "admin", "db_epoch": E1},
                             "sync": {"identity": "y", "token": "u", "role": "sync", "db_epoch": E1}}))
    assert epoch.read_state_epoch(p) == E1
    p.write_text(json.dumps({"admin": {"identity": "x", "token": "t", "role": "admin"}}))
    assert epoch.read_state_epoch(p) is None


def test_jsonl_header_record(tmp_path):
    p = tmp_path / "dead_letter.jsonl"
    assert epoch.read_jsonl(p) == []
    epoch.append_jsonl(p, E1, {"kind": "dead_letter", "id": "fv-1"})
    epoch.append_jsonl(p, E1, {"kind": "dead_letter", "id": "fv-2"})
    lines = [json.loads(l) for l in p.read_text().splitlines()]
    assert lines[0]["kind"] == "header" and lines[0]["db_epoch"] == E1 and len(lines) == 3
    assert epoch.read_state_epoch(p) == E1
    assert [r["id"] for r in epoch.read_jsonl(p)] == ["fv-1", "fv-2"]
    with pytest.raises(epoch.EpochMismatch) as ei:
        epoch.check_all(E2, tmp_path / "missing.json", p)
    assert ei.value.path == p
