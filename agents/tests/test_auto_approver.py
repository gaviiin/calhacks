"""The standing-approval job asks the module to approve only what a rule backs."""

from __future__ import annotations

from agents import reducers as R
from agents.auto_approver import backing, run_once
from agents.identities import Actor
from agents.recorder import NullRecorder


def item(id, **over):
    row = {"id": id, "kind": "classification", "state": "PROPOSED", "proposal_source": "deterministic",
           "proposed_policy_id": None, "proposed_category_code": "RELEVANT", "answered_by": None}
    row.update(over)
    return row


def test_backing():
    assert backing(item(1, proposed_policy_id=7)) == "policy"
    assert backing(item(2, proposed_category_code="ALLOCATED")) == "allocations"
    assert backing(item(3, proposal_source="human_text", answered_by="c200aa")) == "answer"
    assert backing(item(4, proposal_source="human_text")) is None  # no answer on record
    assert backing(item(5, proposal_source="llm", proposed_policy_id=7)) is None  # Claude: a person decides
    assert backing(item(6)) is None  # deterministic but no policy (fair value, say): a person decides
    assert backing(item(7, kind="reversal", proposed_policy_id=7)) is None


class StubStdb:
    def __init__(self, items, policies, roles):
        self.items = {int(i["id"]): i for i in items}
        self.policies, self.roles, self.calls = policies, roles, []

    def sql(self, token, q):
        if q.startswith("SELECT * FROM work_item WHERE state"):
            return [i for i in self.items.values() if i["state"] == "PROPOSED"]
        if q.startswith("SELECT * FROM work_item WHERE id"):
            return [self.items[int(q.rsplit("=", 1)[1])]]
        if "FROM policy" in q:
            return self.policies
        if "FROM role" in q:
            return self.roles
        raise AssertionError(q)

    def call(self, token, reducer, args):
        self.calls.append((reducer, args))
        self.items[int(args[0])]["state"] = "APPROVED"  # the module would re-check; here it agrees


def test_run_once_approves_what_a_rule_backs_and_names_who_stands_behind_it():
    stdb = StubStdb(
        [item(1, proposed_policy_id=7), item(2, proposal_source="llm"), item(3, proposal_source="human_text", answered_by="c2dd")],
        [{"id": 7, "policy_key": "acct:6010", "version": 1, "decided_by": "c2bb"}],
        [{"identity": "c2bb", "label": "Head of Cost Cap"}, {"identity": "c2dd", "label": "Financial Controller"}],
    )
    counts = run_once(stdb, NullRecorder(), Actor("auto_approver", "c2ee", "tok", "auto_approver"))
    assert counts == {"approved": 2, "refused": 0, "left": 1}
    assert [c[0] for c in stdb.calls] == [R.APPROVE, R.APPROVE]
    assert stdb.calls[0][1] == [1, "standing approval: acct:6010 v1 (approved by Head of Cost Cap)"]
    assert stdb.calls[1][1] == [3, "standing approval: proposal built from Financial Controller's answer on this line"]
    assert stdb.items[2]["state"] == "PROPOSED"
