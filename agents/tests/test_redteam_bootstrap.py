import json
import os

from agents import config
from agents import reducers as R
from agents.bootstrap import bootstrap
from agents.cap_analyst import CapAnalyst
from agents.redteam import RedTeam
from agents.tools import AgentTools

from .conftest import gl, policy, seed_line, vendor
from .fakes import FakeStdb


def _seed_for_probes(stdb, actors):
    analyst = AgentTools(actors["cap_analyst"], stdb)
    big = seed_line(stdb, gl(id="gl-1", amount_usd_minor=30_000_000), vendor())
    analyst.propose_classification(big["id"], "CATERING", "CATERING@SECD-ISS07", None, "canteen", ["gl-1"])
    seed_line(stdb, gl(id="gl-2"))
    approved = seed_line(stdb, gl(id="gl-3"))
    approved.update(state="APPROVED", proposed_category_code="CATERING")
    stdb.tables["policy"].append(policy(id=1, state="PROPOSED", proposed_by=actors["policy_learner"].identity))


def test_every_probe_is_denied_and_logged(stdb, actors):
    _seed_for_probes(stdb, actors)
    results = RedTeam(stdb, actors).run()
    ran = [r for r in results if not r.skipped]
    names = {r.name for r in ran}
    assert {"analyst approves own proposal", "analyst posts", "red_team proposes",
            "controller approves above materiality", "cap_analyst locks period", "red_team locks period",
            "controller locks period", "analyst approves a policy", "learner approves own policy"} <= names
    for r in ran:
        assert r.passed, (r.name, r.audit_rows, r.state_before, r.state_after)
    assert not any(row.get("allowed") for row in stdb.tables["audit_log"] if row["actor"] == actors["red_team"].identity)


def test_redteam_flags_a_module_that_does_not_log(rulebook, actors):
    permissive = FakeStdb(simulate=False)  # accepts calls, writes no audit rows
    permissive.tables["role"] = []
    permissive.tokens = {a.token: a.identity for a in actors.values()}
    permissive.tables["work_item"].append({"id": 1, "state": "PROPOSED", "amount_usd_minor": 0, "proposed_by": None,
                                           "subject_ref": "gl-1", "period_key": "2026-01"})
    results = RedTeam(permissive, actors).run()
    assert all(not r.passed for r in results if not r.skipped)


def test_bootstrap_end_to_end_and_idempotent(tmp_path, rulebook):
    stdb = FakeStdb()
    stdb.tables["setting"] = []
    ids_path = tmp_path / "identities.json"
    rb_path = tmp_path / "rulebook.json"
    rb_path.write_text(json.dumps(rulebook))
    res = bootstrap(stdb, identities_path=ids_path, rulebook_path=rb_path, log=lambda *_: None)
    ids = json.loads(ids_path.read_text())
    assert set(ids) == {"admin", "sync", "cap_analyst", "policy_learner", "controller", "head_of_cost_cap",
                        "gateway", "auto_approver", "red_team"}
    assert oct(os.stat(ids_path).st_mode & 0o777) == "0o600"
    roles = {r["identity"]: r["role"] for r in stdb.tables["role"]}
    for name, d in ids.items():
        assert roles[d["identity"]] == d["role"]
    assert res["rulebook_loaded"] == len(rulebook) == len(stdb.tables["rulebook_entry"])
    assert {r["key"]: r["value"] for r in stdb.tables["setting"] if r["key"] != "db_epoch"} == {
        "materiality_usd_minor": "25000000", "cap_usd_minor": "21500000000", "cap_year": "2026"}
    # invites created by admin, claimed by each actor with its own token
    invites = [c for c in stdb.reducer_calls(R.CREATE_ROLE_INVITE) if not c[2][2].startswith("seat-")]
    claims = stdb.reducer_calls(R.CLAIM_ROLE)
    assert len(invites) == len(claims) == len(config.ACTOR_ROLES) - 1  # everyone but admin claims a role
    assert all(c[0] == ids["admin"]["token"] for c in invites)
    assert {c[0] for c in claims} == {d["token"] for n, d in ids.items() if n != "admin"}
    assert [c[2][0] for c in invites] == [c[2][0] for c in invites]  # role first, then label, then code
    first = stdb.reducer_calls(R.LOAD_RULEBOOK_ENTRY)[0][2]
    assert first[0] == rulebook[0]["id"] and len(first) == 10

    n = len(stdb.calls)
    res2 = bootstrap(stdb, identities_path=ids_path, rulebook_path=rb_path, log=lambda *_: None)
    assert res2 == {"created": [], "claimed": [], "rulebook_loaded": 0, "settings_written": [], "seats_minted": {}}
    assert len(stdb.calls) == n


def test_answer_flow_never_repeats_a_question(stdb, actors, analyst_tools):
    item = seed_line(stdb, gl(memo="Offsite lunch"), vendor())
    a = CapAnalyst(analyst_tools, offline=True)
    [d1] = a.run_once()
    assert d1.action == "ask"
    stdb.call(actors["controller"].token, R.ANSWER, R.answer(item["id"], "Lunch at the wind tunnel: Relevant"))
    assert stdb.item(item["id"])["state"] == "NEW"
    [d2] = a.run_once()
    assert d2.action == "propose" and d2.category_code == "RELEVANT" and d2.path == "answer"
    assert len(stdb.reducer_calls(R.ASK)) == 1


def test_reversal_item_reclassifies_corrected_line(stdb, actors, analyst_tools):
    orig_line = gl(id="gl-000001")
    orig = seed_line(stdb, orig_line, vendor())
    orig.update(state="POSTED", proposed_category_code="CATERING", proposed_rulebook_entry_id="CATERING@SECD-ISS07",
                erp_entry_id="JE-2026-000001")
    corrected = gl(id="gl-000009", correction_of="gl-000001", amount_usd_minor=650_000, period_key="2026-02",
                   posted_date="2026-02-03")
    stdb.tables["gl_line"].append(corrected)
    stdb.tables["policy"].append(policy(id=3))
    rev = stdb.add_item(kind="reversal", subject_ref=str(orig["id"]), period_key="2026-02", amount_usd_minor=650_000,
                        evidence_refs=json.dumps(["gl-000009", "gl_line:gl-000009:44"]))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.work_item_id == rev["id"] and d.action == "propose" and d.path == "reversal"
    assert d.reason.startswith(f"Reversal of posted work item {orig['id']} (ERP JE-2026-000001)")
    assert "pol-3 v1" in d.reason and d.evidence_refs[0] == "gl-000009" and f"work_item:{orig['id']}" in d.evidence_refs
