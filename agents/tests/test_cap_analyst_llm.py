"""Cap Analyst online path with a FakeAnthropic tool runner: request shape and code-side guards."""

from agents import reducers as R
from agents.cap_analyst import CapAnalyst
from agents.tools import CAP_ANALYST_TOOLS

from .conftest import gl, seed_line, vendor
from .fakes import FakeAnthropic


def _run(stdb, tools, script):
    fake = FakeAnthropic(script)
    decisions = CapAnalyst(tools, client=fake, offline=False).run_once()
    return fake, decisions


def test_request_shape_follows_model_rules(stdb, analyst_tools, monkeypatch):
    monkeypatch.setenv("CCD_MODEL", "claude-opus-5-5")
    item = seed_line(stdb, gl(), vendor())
    fake, _ = _run(stdb, analyst_tools, [("ask", {"work_item_id": item["id"], "question": "Where was it served?"})])
    (kw,) = fake.runner_kwargs
    assert kw["model"] == "claude-opus-5-5"
    assert kw["output_config"] == {"effort": "medium"}
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    for banned in ("tool_choice", "thinking", "temperature", "top_p", "top_k"):
        assert banned not in kw
    assert kw["messages"][0]["role"] == "user" and len(kw["messages"]) == 1  # no assistant prefill
    assert "never write article numbers" in kw["system"].lower()
    assert [t.name for t in kw["tools"]] == list(CAP_ANALYST_TOOLS)
    assert all(t.to_dict()["strict"] for t in kw["tools"])


def test_model_proposal_with_valid_evidence(stdb, analyst_tools):
    item = seed_line(stdb, gl(memo="Offsite lunch, wind tunnel session"), vendor())
    script = [
        ("read_item", {"work_item_id": item["id"]}),
        ("search_rulebook", {"query": "relevant costs", "in_force_on": "2026-01"}),
        ("propose_classification", {"work_item_id": item["id"], "category_code": "RELEVANT",
                                    "rulebook_entry_id": "RELEVANT@SECD-ISS07",
                                    "reason": "Lunch at an offsite wind tunnel session, not at team premises.",
                                    "evidence_refs": ["gl-000001"]}),
    ]
    fake, [d] = _run(stdb, analyst_tools, script)
    assert d.action == "propose" and d.path == "llm" and d.category_code == "RELEVANT"
    row = stdb.item(item["id"])
    assert row["state"] == "PROPOSED"
    # SCHEMA §10: model proposals are tagged and never carry a policy
    assert row["proposal_source"] == "llm" and row["proposed_policy_id"] is None and d.proposal_source == "llm"
    assert all(not err for _, _, err in fake.results)
    assert "policy_id" not in fake.runner_kwargs[0]["tools"][5].to_dict()["input_schema"]["properties"]


def test_model_cannot_call_non_allowlisted_tools(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    script = [("approve", {"work_item_id": item["id"], "reason": "lgtm"}),
              ("post", {"work_item_id": item["id"], "erp_entry_id": "JE-1"}),
              ("lock_period", {"period_key": "2026-01"}),
              ("ask", {"work_item_id": item["id"], "question": "Was this catering at team premises?"})]
    fake, [d] = _run(stdb, analyst_tools, script)
    assert fake.unavailable == ["approve", "post", "lock_period"]
    assert {c[1] for c in stdb.calls} == {R.ASK}  # the only reducer that ran
    assert d.action == "ask"


def test_plug_without_evidence_is_refused_then_model_asks(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    plug = {"work_item_id": item["id"], "category_code": "CATERING", "rulebook_entry_id": "CATERING@SECD-ISS07",
            "reason": "Looks like catering.", "evidence_refs": []}
    script = [("propose_classification", plug),
              ("propose_classification", dict(plug, evidence_refs=["gl-999999"])),  # invented id
              ("propose_classification", dict(plug, evidence_refs=["gl-000001"], reason="Catering per D5.1.1.z")),
              ("propose_classification", dict(plug, evidence_refs=["gl-000001"], rulebook_entry_id="RELEVANT@ISS22",
                                              category_code="RELEVANT")),
              ("propose_classification", dict(plug, evidence_refs=["gl-000001"], work_item_id=item["id"] + 1)),
              ("ask", {"work_item_id": item["id"], "question": "Was the catering served at team premises?"})]
    fake, [d] = _run(stdb, analyst_tools, script)
    errors = [r for name, r, err in fake.results if err]
    assert len(errors) == 5
    assert "plug" in errors[0] and "not part of work item" in errors[1] and "article" in errors[2]
    assert "not in force" in errors[3] and "only act on work item" in errors[4]
    assert not stdb.reducer_calls(R.PROPOSE)
    assert d.action == "ask"


def test_second_terminal_action_is_refused(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    script = [("ask", {"work_item_id": item["id"], "question": "Which site?"}),
              ("ask", {"work_item_id": item["id"], "question": "And again?"})]
    fake, [d] = _run(stdb, analyst_tools, script)
    assert len(stdb.reducer_calls(R.ASK)) == 1 and fake.results[1][2] is True


def test_refusal_or_no_decision_falls_back_to_asking(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    _, [d] = _run(stdb, analyst_tools, ["refusal"])
    assert d.action == "ask" and d.path == "llm_fallback" and "refusal" in d.note
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"

    item2 = seed_line(stdb, gl(id="gl-000002", vendor_id="ven-002"), vendor(id="ven-002", name="Other Supplies Ltd"))
    _, [d2] = _run(stdb, analyst_tools, ["max_tokens"])
    assert d2.work_item_id == item2["id"] and d2.action == "ask" and "max_tokens" in d2.note


def test_related_party_lines_never_reach_the_model(stdb, analyst_tools):
    ven = vendor(id="ven-009", name="Technology Ltd", related_party=True)
    seed_line(stdb, gl(vendor_id="ven-009"), ven)
    stdb.tables["fair_value"].append({"id": "fv-005", "counterparty_vendor_id": "ven-009", "item": "recharge",
                                      "contract_value_minor": 100, "fair_value_minor": 900_000, "currency": "USD",
                                      "effective_from": "2026-01-01", "basis": "b"})
    fake, [d] = _run(stdb, analyst_tools, [])
    assert not fake.runner_kwargs and d.category_code == "ADJ_RELATED_PARTY_FAIR_VALUE"
