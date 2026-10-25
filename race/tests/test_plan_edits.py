"""A person's edits to a response plan: read into operations, laid over every re-plan, rebuilt, and reported to pit-wall."""

from __future__ import annotations

import json

import pytest

from race import logistics, people, plan as plan_mod, plan_edits
from race.tests.test_erp import fake_erp  # noqa: F401  (the ERP the snapshot posts to)
from race.tests.test_logistics import incident, state
from race.weekend import Weekend

EDITS = ("Hand carry the floor instead of the air freight. The monocoque spare comes from Grove. "
         "Order a second front wing. Tell the press office before 18:00. Change the accrual to $1m.")


def _qualifying():
    st = state()
    inc = incident(car=23, at="2024-11-03T11:57:19Z", kph=315)
    st.incidents[inc.incident_key] = inc
    for a in logistics.plan(inc, st):
        st.actions[a.action_key] = a
    return st, inc


def test_the_reader_turns_a_chief_of_staffs_words_into_operations():
    st, inc = _qualifying()
    ik = inc.incident_key
    ch = plan_edits.offline_interpret(EDITS, plan_edits.lines_of(inc, st))
    assert [c["op"] for c in ch] == ["reroute", "source", "add", "add", "note"]
    assert ch[0] == {"op": "reroute", "ref": f"{ik}:freight", "to": "hand_carry", "parts": ["floor"], "why": "Hand carry the floor instead of the air freight"}
    assert ch[1]["ref"] == f"{ik}:spares_reserve:chassis" and ch[1]["to"] == "factory"
    assert ch[2]["kind"] == "work_order" and ch[2]["part"] == "front_wing"
    assert ch[3]["kind"] == "task" and ch[3]["owner"] == "press_office"
    assert ch[4]["op"] == "note" and "Books" in ch[4]["why"], "money is changed in the Books, not by an edit"
    cancel = plan_edits.offline_interpret("Cancel the parc fermé list", plan_edits.lines_of(inc, st))
    assert cancel == [{"op": "cancel", "ref": f"{ik}:parc_ferme_list", "why": "Cancel the parc fermé list"}]
    assert plan_edits.offline_interpret("cancel the hovercraft", plan_edits.lines_of(inc, st))[0]["op"] == "note"


def test_edits_change_the_operations_and_stay_in_force_when_the_playbook_runs_again():
    st, inc = _qualifying()
    ik = inc.incident_key
    ch = plan_edits.offline_interpret(EDITS, plan_edits.lines_of(inc, st))
    rec = plan_edits.record(st, inc, ch, by="Sam Reyes", edit_key=f"{ik}:1", text=EDITS)
    assert [c["applied"] for c in rec] == [True, True, True, True, False]
    assert all(c["edit_key"] == f"{ik}:1" and c["by"] == "Sam Reyes" for c in rec)
    for _ in range(2):  # the edits are laid over the playbook every time it runs, and the result is the same
        acts = {a.action_key: a for a in logistics.plan(inc, st)}
        for a in acts.values():
            st.actions[a.action_key] = a
        freight, carry = acts[f"{ik}:freight"], acts[f"{ik}:hand_carry"]
        assert "floor" not in freight.detail["parts"] and freight.status == "awaiting_approval"
        assert carry.detail["parts"] == ["floor"] and carry.status == "awaiting_approval" and carry.outward, "a hand carry is still the Head of Logistics' to book"
        assert carry.decided_by == "person:Sam Reyes" and carry.detail["edited"][-1]["edit"] == f"{ik}:1"
        tub = acts[f"{ik}:spares_reserve:chassis"]
        assert tub.detail["source"] == "factory" and "from Grove" in tub.title and "Sam Reyes's edit" in tub.detail["why"]
        added = [a for a in acts.values() if ":edit" in a.action_key]
        assert {a.kind for a in added} == {"work_order", "task"}
        assert next(a for a in added if a.kind == "task").owner_role == "press_office"
        assert all(a.status == "auto" for a in added), "internal operations run on their own once added"
    # the rebuilt plan carries the edits: the hand carry is a line, the press office task is new to the team
    p = plan_mod.build(inc, st)
    kinds = {x["kind"]: x for x in p.lines}
    assert "hand_carry" in kinds and "task" in kinds
    assert kinds["task"]["status"] == "novel", "nothing like it on the record: it waits for the Head of Cost Cap like any novel line"
    note = plan_edits.summary(rec)
    assert note.startswith("4 changes applied") and "Not applied (1): Not an operation: Change the accrual to $1m" in note


def test_cancelling_the_whole_air_freight_leaves_it_cancelled_with_the_reason():
    st, inc = _qualifying()
    ik = inc.incident_key
    plan_edits.record(st, inc, plan_edits.offline_interpret("Cancel the air freight", plan_edits.lines_of(inc, st)), by="Sam Reyes", edit_key=f"{ik}:1", text="Cancel the air freight")
    acts = {a.action_key: a for a in logistics.plan(inc, st)}
    st.actions.update(acts)
    assert acts[f"{ik}:freight"].status == "cancelled" and acts[f"{ik}:freight"].detail["why"].startswith("Cancelled (Sam Reyes's edit")
    assert not any(x["kind"] == "freight" for x in plan_mod.build(inc, st).lines), "a cancelled operation is not a line of the plan"


def test_an_edit_that_names_no_line_is_on_the_record_and_changes_nothing():
    st, inc = _qualifying()
    before = {k: a for k, a in st.actions.items()}
    rec = plan_edits.record(st, inc, [{"op": "cancel", "ref": "nope"}, {"op": "teleport"}], by="x", edit_key="k:1", text="?")
    assert [c["applied"] for c in rec] == [False, False]
    assert {a.action_key: a for a in logistics.plan(inc, st)}.keys() == before.keys()


class EditSink:
    """pit-wall for the desk: holds the snapshot's plans, a pending edit, and records what the desk applies."""

    disabled, errors, calls, url = False, 0, 0, "http://fake/v1/database/pit-wall"

    def __init__(self):
        self.edits: dict[str, dict] = {}
        self.applied: list[list] = []
        self.actions_sent: list = []

    def call(self, reducer, args):
        if reducer == "apply_race_plan_edit":
            self.applied.append(args)
            self.edits[args[0]]["status"] = args[1]
        return True

    def actions(self, acts):
        self.actions_sent.extend(acts)
        return True

    def apply_plan_edit(self, edit_key, status, changes, note, model, at):
        return self.call("apply_race_plan_edit", [edit_key, status, json.dumps(changes), note, model, at])

    def sql(self, q):
        if "race_plan_edits" in q:
            return [r for r in self.edits.values() if r["status"] == "pending"]
        return []

    def __getattr__(self, name):
        return lambda *a, **k: True


@pytest.fixture()
def snapshot(fake_erp):
    w = Weekend(1249, pace=0, sink=None, offline=True, forecast=False, quiet=True, script=people.load_script(1249), until="2024-11-03T16:44:00Z")
    w.run()
    return w


def test_the_desk_applies_a_pending_edit_at_execution_and_reports_it_line_by_line(snapshot):
    w = snapshot
    ik = "1249-9636-43-2"  # Colapinto's lap-31 crash: its plan is the draft the snapshot leaves for a person
    assert w.state.plans[ik].status == "draft"
    sink = EditSink()
    w.sink = sink
    text = "Hand carry the floor instead of the air freight. The monocoque spare comes from Grove. Tell the press office before 18:00."
    sink.edits[f"{ik}:1"] = {"edit_key": f"{ik}:1", "incident_key": ik, "text": text, "by": "CFO", "status": "pending"}
    w._edit_poll = 0.0
    w.follow_plan_edits()
    [args] = sink.applied
    key, status, changes, note, model = args[0], args[1], json.loads(args[2]), args[3], args[4]
    assert (key, status, model) == (f"{ik}:1", "applied", "offline-rules")
    assert [c["op"] for c in changes] == ["reroute", "source", "add"] and all(c["applied"] for c in changes)
    assert note.startswith("3 changes applied")
    sent = {a.action_key: a for a in sink.actions_sent}
    assert sent[f"{ik}:hand_carry"].detail["parts"] == ["floor"]
    assert "floor" not in sent[f"{ik}:freight"].detail["parts"]
    assert sent[f"{ik}:spares_reserve:chassis"].detail["source"] == "factory"
    assert any(a.kind == "task" and a.owner_role == "press_office" for a in sent.values())
    plan = w.state.plans[ik]
    assert any(x["kind"] == "hand_carry" for x in plan.lines) and any(x["kind"] == "task" for x in plan.lines)
    # the same edit is never applied twice, and a later answer or event that re-plans keeps it
    w._edit_poll = 0.0
    w.follow_plan_edits()
    assert len(sink.applied) == 1
    again = {a.action_key: a for a in logistics.plan(w.state.incidents[ik], w.state)}
    assert again[f"{ik}:hand_carry"].detail["parts"] == ["floor"]
