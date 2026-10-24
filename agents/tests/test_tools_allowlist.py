"""The authority envelope: tool allowlists per agent, asserted literally."""

import pytest

from agents.tools import (ALLOWLISTS, CAP_ANALYST_TOOLS, FORBIDDEN_TOOLS, POLICY_LEARNER_TOOLS, AgentTools,
                          build_beta_tools, is_forbidden)


def test_allowlists_are_exactly_schema_section_7():
    assert CAP_ANALYST_TOOLS == ("list_queue", "read_item", "search_policies", "search_precedents",
                                 "search_rulebook", "propose_classification", "ask")
    assert POLICY_LEARNER_TOOLS == ("search_policies", "search_precedents", "search_rulebook", "propose_policy")
    assert set(ALLOWLISTS) == {"cap_analyst", "policy_learner"}


def test_no_allowlist_contains_a_record_write_or_decision():
    for agent, names in ALLOWLISTS.items():
        for n in names:
            assert not is_forbidden(n), (agent, n)
        assert not {"approve", "reject", "post", "lock_period", "approve_policy", "answer"} & set(names)
    assert "propose_policy" not in CAP_ANALYST_TOOLS
    assert "propose_classification" not in POLICY_LEARNER_TOOLS and "ask" not in POLICY_LEARNER_TOOLS
    for n in ("approve", "post", "lock_period", "upsert_gl_line", "upsertGlLine", "set_setting", "post_journal_entry"):
        assert is_forbidden(n)


def test_built_tool_lists_match_allowlists(stdb, actors):
    t = AgentTools(actors["cap_analyst"], stdb)
    assert [bt.name for bt in build_beta_tools("cap_analyst", t)] == list(CAP_ANALYST_TOOLS)
    assert [bt.name for bt in build_beta_tools("policy_learner", t)] == list(POLICY_LEARNER_TOOLS)
    for bt in build_beta_tools("cap_analyst", t):
        d = bt.to_dict()
        assert d["strict"] is True
        s = d["input_schema"]
        assert s["additionalProperties"] is False and set(s["required"]) == set(s["properties"])
    with pytest.raises(KeyError):
        build_beta_tools("gateway", t)


def test_agent_tools_has_no_decision_or_record_methods():
    public = {n for n in dir(AgentTools) if not n.startswith("_")}
    for n in public:
        assert not is_forbidden(n), n
    assert not {"approve", "reject", "answer", "post", "lock_period", "approve_policy"} & public


def test_forbidden_set_is_closed_over_decisions():
    assert {"approve", "reject", "answer", "post", "lock_period", "approve_policy", "reject_policy"} <= FORBIDDEN_TOOLS
