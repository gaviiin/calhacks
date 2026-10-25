"""Record genuinely everything (SCHEMA §6b): ordering, attribution, caps, and never dropping a step."""

import json

from agents import reducers as R
from agents.cap_analyst import CapAnalyst
from agents.recorder import MAX_EXCERPT_BYTES, MAX_INPUT_BYTES, TRUNCATED, Recorder, cap_bytes, digest
from agents.tools import AgentTools

from .conftest import gl, policy, seed_line, vendor
from .fakes import FakeAnthropic


def _rec(stdb, actor, tmp_path, **kw):
    return Recorder(actor, stdb, "2026-01-15", fallback_path=tmp_path / "steps.jsonl", **kw)


def _step_calls(stdb):
    return [args for _, name, args in stdb.calls if name == R.RECORD_STEP]


def test_record_step_args_follow_reducers_md(stdb, actors, tmp_path):
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    rec.record("tool_call", "read_item", {"work_item_id": 7}, {"ok": True}, work_item_id=7, model=None)
    (args,) = _step_calls(stdb)
    # runId, step, kind, name, input, outputDigest, outputExcerpt, workItemId?, model?
    assert args[0] == rec.run_id and rec.run_id.startswith("cap_analyst-2026-01-15-")
    assert args[1:4] == [1, "tool_call", "read_item"]
    assert json.loads(args[4]) == {"work_item_id": 7}
    assert args[5] == digest(json.dumps({"ok": True}, sort_keys=True))
    assert args[7] == {"some": 7} and args[8] == {"none": []}


def test_caps_are_bytes_and_marked_and_digest_covers_the_full_output():
    s = "é" * 10_000
    capped = cap_bytes(s, MAX_INPUT_BYTES)
    assert capped.endswith(TRUNCATED) and len(capped.encode()) <= MAX_INPUT_BYTES
    assert cap_bytes("short", MAX_EXCERPT_BYTES) == "short"
    assert digest(s) != digest(capped)


def test_steps_number_up_and_attribute_to_the_item(stdb, actors, tmp_path):
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    with rec.run("t"):
        with rec.on_item(42):
            rec.record("read", "sql:gl_line")
        rec.record("note", "outside")
    calls = _step_calls(stdb)
    assert [c[1] for c in calls] == [1, 2, 3, 4]
    assert [c[2] for c in calls] == ["run_start", "read", "note", "run_end"]
    assert calls[1][7] == {"some": 42} and calls[2][7] == {"none": []}


def test_failed_recording_degrades_to_file_and_drops_nothing(stdb, actors, tmp_path):
    stdb.raise_on.add(R.RECORD_STEP)
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    for i in range(3):
        rec.record("note", f"n{i}")
    lines = [json.loads(x) for x in (tmp_path / "steps.jsonl").read_text().splitlines()]
    assert [l["step"] for l in lines] == [1, 2, 3]
    assert all("recordStep failed" in l["fallback_reason"] for l in lines)
    # after the first failure it stops trying the module, so order stays intact in one place
    assert len(_step_calls(stdb)) == 1 and rec.sink == "file"


def test_dry_run_records_to_file_only(stdb, actors, tmp_path):
    rec = _rec(stdb, actors["cap_analyst"], tmp_path, to_file=True)
    rec.record("note", "x")
    assert not _step_calls(stdb) and (tmp_path / "steps.jsonl").exists()


def test_policy_run_records_reads_then_decision_then_propose(stdb, actors, tmp_path):
    item = seed_line(stdb, gl(), vendor())
    stdb.tables["policy"].append(policy(id=3, version=1))
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    tools = AgentTools(actors["cap_analyst"], stdb, recorder=rec)
    with rec.run("cap_analyst"):
        [d] = CapAnalyst(tools, offline=True).run_once()
    assert d.action == "propose"

    kinds = [s.kind for s in rec.steps]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    assert "read" in kinds and "tool_call" in kinds
    i_dec = kinds.index("decision")
    decision = rec.steps[i_dec]
    assert decision.work_item_id == item["id"] and decision.name == "propose:policy"
    body = json.loads(decision.input)
    assert body["chosen"]["policy_id"] == 3
    weighed = {c["kind"]: c for c in body["considered"]}
    assert weighed["house_policies"]["chosen"] == "pol-3 v1"
    assert weighed["related_party_fair_value"]["applies"] is False
    # the decision is recorded before the propose reducer is called, and the tool_call after it
    order = [name for _, name, _ in stdb.calls if name in (R.RECORD_STEP, R.PROPOSE)]
    first_propose = order.index(R.PROPOSE)
    assert any(s.kind == "decision" for s in rec.steps[: first_propose])
    names_after = [s.name for s in rec.steps[i_dec:]]
    assert "propose_classification" in names_after


def test_ask_run_records_a_decision_with_no_match(stdb, actors, tmp_path):
    seed_line(stdb, gl(memo="Offsite lunch, wind tunnel session"), vendor())
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    tools = AgentTools(actors["cap_analyst"], stdb, recorder=rec)
    [d] = CapAnalyst(tools, offline=True).run_once()
    assert d.action == "ask"
    dec = next(s for s in rec.steps if s.kind == "decision")
    body = json.loads(dec.input)
    assert body["action"] == "ask" and body["chosen"]["question"] == d.question
    assert next(c for c in body["considered"] if c["kind"] == "house_policies")["matched"] == []


def test_llm_path_records_model_calls_and_a_decision_before_the_write(stdb, actors, tmp_path):
    item = seed_line(stdb, gl(memo="Offsite lunch, wind tunnel session"), vendor())
    rec = _rec(stdb, actors["cap_analyst"], tmp_path)
    tools = AgentTools(actors["cap_analyst"], stdb, recorder=rec)
    script = [
        ("read_item", {"work_item_id": item["id"]}),
        ("propose_classification", {"work_item_id": item["id"], "category_code": "RELEVANT",
                                    "rulebook_entry_id": "RELEVANT@SECD-ISS07",
                                    "reason": "Lunch at an offsite wind tunnel session, not at team premises.",
                                    "evidence_refs": ["gl-000001"]}),
    ]
    [d] = CapAnalyst(tools, client=FakeAnthropic(script), offline=False).run_once()
    assert d.action == "propose" and d.path == "llm"
    model_calls = [s for s in rec.steps if s.kind == "model_call"]
    assert model_calls and all(s.model for s in model_calls)
    assert json.loads(model_calls[0].output_excerpt)["tool_calls"][0]["name"] == "read_item"
    kinds_names = [(s.kind, s.name) for s in rec.steps]
    i_dec = kinds_names.index(("decision", "propose:llm"))
    i_write = kinds_names.index(("tool_call", "propose_classification"))
    assert i_dec < i_write
