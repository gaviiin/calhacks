"""Policy Learner: onboarding from 2025 history (with the rule-version step) and from corrections."""

import json

import pytest

from agents import reducers as R
from agents.cap_analyst import CapAnalyst
from agents.policy_learner import (GP_REGEX, Case, PolicyReview, from_corrections, mine_history, load_history, onboard,
                                   review_sample)
from agents.rule_versions import Rulebook
from agents.tools import AgentTools

from .conftest import gl, seed_line, vendor
from .fakes import FakeAnthropic


@pytest.fixture(scope="module")
def rb():
    return Rulebook.from_file()


def _h(world, i, account, vendor_id, memo, cat, entry, amount=100_000, period="2025-06"):
    gid = f"h25-gl-{i:05d}"
    world.emit("history_2025_gl_line", {"id": gid, "posted_date": f"{period}-10", "period_key": period,
                                        "account_id": f"acct-{account}", "department_id": "dept-AERO",
                                        "vendor_id": vendor_id, "bill_id": None, "amount_minor": amount,
                                        "currency": "USD", "fx_rate_to_usd": 1.0, "amount_usd_minor": amount,
                                        "memo": memo, "erp_category_code": "", "entity": "RACING",
                                        "correction_of": None})
    world.emit("history_2025_cap_classification", {"id": f"h25-cls-{i:05d}", "gl_line_id": gid, "category_code": cat,
                                                   "rulebook_entry_id": entry, "decided_by": "analyst", "reason": ""})
    return gid


def _jan(world, i, account, vendor_id, memo, amount=100_000):
    world.emit("gl_line", {"id": f"gl-{i:06d}", "posted_date": "2026-01-12", "period_key": "2026-01",
                           "account_id": f"acct-{account}", "department_id": "dept-AERO", "vendor_id": vendor_id,
                           "bill_id": None, "amount_minor": amount, "currency": "USD", "fx_rate_to_usd": 1.0,
                           "amount_usd_minor": amount, "memo": memo, "erp_category_code": "MARKETING",
                           "entity": "RACING", "correction_of": None})


@pytest.fixture
def history_world(world):
    for code, name, default in [("6410", "Catering & canteen", "CATERING"), ("6200", "Travel & accommodation", "RELEVANT"),
                                ("5100", "Wind tunnel consumables", "RELEVANT"), ("7100", "Sick leave cover", "RELEVANT")]:
        world.emit("account", {"id": f"acct-{code}", "code": code, "name": name, "default_category_code": default,
                               "kind": "expense"})
    for vid, name in [("ven-001", "Grove Catering"), ("ven-002", "Globetrotter Travel"), ("ven-003", "Carbon Supplies"),
                      ("ven-004", "Locum Staffing")]:
        world.emit("vendor", {"id": vid, "name": name, "country": "GB", "related_party": False,
                              "related_party_entity": None, "bank_iban": "GB1", "category_hint": None})
    i = 0
    for n in range(15):
        i += 1
        _h(world, i, "6410", "ven-001", f"Factory canteen week {n}", "RELEVANT", "RELEVANT@ISS22")
    for n, gp in enumerate(["Bahrain Grand Prix", "Monaco GP", "Silverstone race weekend", "Suzuka GP"] * 3):
        i += 1
        _h(world, i, "6200", "ven-002", f"Flights and hotel, {gp}", "COMPETITION_TRAVEL", "COMPETITION_TRAVEL@ISS22")
    for n in range(8):
        i += 1
        _h(world, i, "6200", "ven-002", f"Flights LHR-MUC supplier visit {n}", "RELEVANT", "RELEVANT@ISS22")
    for n in range(30):
        i += 1
        _h(world, i, "5100", "ven-003", f"Carbon prepreg batch {n}", "RELEVANT", "RELEVANT@ISS22")
    for n in range(11):
        i += 1
        _h(world, i, "7100", "ven-004", f"Locum cover for sick leave {n}", "SICK_COVER", "SICK_COVER@ISS22")
    world.emit("history_2025_approval", {"id": "h25-ap-1", "gl_line_id": "h25-gl-00001", "amount_usd_minor": 30_000_000,
                                         "escalated_to": "head_of_cost_cap", "decision": "approve", "reason": "",
                                         "decided_on": "2025-06-30"})
    world.emit("history_2025_approval", {"id": "h25-ap-2", "gl_line_id": "h25-gl-00002", "amount_usd_minor": 100_000,
                                         "escalated_to": None, "decision": "approve", "reason": "", "decided_on": "2025-06-30"})
    for j, (acct, ven, memo) in enumerate([("6410", "ven-001", "Factory canteen Jan wk1"),
                                           ("6410", "ven-001", "Factory canteen Jan wk2"),
                                           ("6410", "ven-001", "Factory canteen Jan wk3"),
                                           ("6200", "ven-002", "Flights, Australian Grand Prix"),
                                           ("6200", "ven-002", "Hotel Melbourne GP"),
                                           ("6200", "ven-002", "Flights to supplier"),
                                           ("5100", "ven-003", "Carbon prepreg"), ("5100", "ven-003", "Resin"),
                                           ("7100", "ven-004", "Locum cover")], start=1):
        _jan(world, j, acct, ven, memo)
    return world


def _learner(stdb, actors):
    return AgentTools(actors["policy_learner"], stdb)


def test_mining_and_rule_version_step(history_world, rb):
    cands, near = mine_history(load_history(history_world.client()), rb)
    by_key = {c.policy_key: c for c in cands}
    canteen = by_key["acct:6410"]
    assert canteen.precedent_count == 15 and canteen.consistency == 1.0
    assert (canteen.category_2025, canteen.entry_2025_id) == ("RELEVANT", "RELEVANT@ISS22")
    assert canteen.mapping.status == "changed"
    assert (canteen.mapping.category_2026, canteen.mapping.entry_2026_id) == ("CATERING", "CATERING@SECD-ISS07")
    assert "vendor:ven-001|acct:6410" not in by_key  # subsumed by the account-level policy
    gp = by_key["memo:grand_prix|acct:6200"]
    assert gp.pattern == {"account_code": "6200", "memo_regex": GP_REGEX} and gp.precedent_count == 12
    assert gp.mapping.entry_2026_id == "COMPETITION_TRAVEL@SECD-ISS07" and gp.mapping.status == "same"
    assert by_key["acct:5100"].mapping.category_2026 == "RELEVANT"
    sick = by_key["acct:7100"]
    assert sick.mapping.status == "ask" and not sick.proposable
    assert any(c.policy_key == "acct:6200" for c in near)  # 60% consistent: ask per line


def test_onboard_proposes_2026_versions_and_writes_report(history_world, rb, stdb, actors, tmp_path):
    tools = _learner(stdb, actors)
    res = onboard(history_world.client(), rb, tools, offline=True, report_path=tmp_path / "report.md")
    calls = stdb.reducer_calls(R.PROPOSE_POLICY)
    assert all(c[0] == actors["policy_learner"].token for c in calls)
    assert {c[1] for c in stdb.calls} == {R.PROPOSE_POLICY}  # the learner proposes, nothing else
    by_key = {c[2][0]: c[2] for c in calls}
    assert set(by_key) == {"acct:6410", "memo:grand_prix|acct:6200", "acct:5100"}
    canteen = by_key["acct:6410"]
    assert canteen[1] == 0  # version 0 = module assigns the next version
    assert canteen[2:4] == ["CATERING", "CATERING@SECD-ISS07"]
    assert json.loads(canteen[4]) == {"account_code": "6410"}
    assert "DIFFERS FROM 2025 PRACTICE" in canteen[5] and "RELEVANT@ISS22" in canteen[5]
    assert canteen[7] == 15 and canteen[8] == "2026-01-01" and canteen[9] == {"none": []}
    assert "h25-gl-00001" in json.loads(canteen[6])
    # every proposal passed the module's rulebook check (fake mirrors it): rows exist, PROPOSED, v1
    assert {(p["policy_key"], p["version"], p["state"]) for p in stdb.tables["policy"]} == {
        ("acct:6410", 1, "PROPOSED"), ("memo:grand_prix|acct:6200", 1, "PROPOSED"), ("acct:5100", 1, "PROPOSED")}
    cov = res["coverage"]
    assert (cov["covered"], cov["lines"]) == (7, 9)
    report = (tmp_path / "report.md").read_text()
    for section in ("## What I learned", "## What I'm confident on", "## What I'll ask about",
                    "## Estimated coverage of January 2026"):
        assert section in report
    assert "7 of 9 January lines" in report and "SICK_COVER exists only in ISS22" in report
    assert "Where 2026 differs from 2025 practice" in report

    # idempotent: a second onboarding proposes nothing new
    onboard(history_world.client(), rb, tools, offline=True, report_path=tmp_path / "report2.md")
    assert len(stdb.reducer_calls(R.PROPOSE_POLICY)) == 3


def test_onboard_dry_run_calls_nothing(history_world, rb, tmp_path):
    res = onboard(history_world.client(), rb, None, offline=True, dry_run=True, report_path=tmp_path / "r.md")
    assert len([c for c in res["candidates"] if c.proposable]) == 3


def test_online_review_writes_rationale_and_can_veto(history_world, rb, stdb, actors, tmp_path):
    def reply(kwargs):
        payload = json.loads(kwargs["messages"][0]["content"])
        if payload["policy_key"] == "acct:5100":
            return PolicyReview(generalises=False, rationale="", concerns="consumables and tooling mixed")
        return PolicyReview(generalises=True, rationale=f"Reviewed: {payload['description']}.", concerns="")

    fake = FakeAnthropic(parse_reply=reply)
    onboard(history_world.client(), rb, _learner(stdb, actors), client=fake, offline=False,
            report_path=tmp_path / "r.md")
    kw = fake.parse_kwargs[0]
    assert kw["output_format"] is PolicyReview and kw["output_config"] == {"effort": "medium"}
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    assert not {"temperature", "thinking", "tool_choice"} & set(kw)
    keys = {p["policy_key"]: p for p in stdb.tables["policy"]}
    assert "acct:5100" not in keys  # vetoed: becomes a question in the report
    # the rule-change statement stays deterministic and first, even with an LLM rationale
    assert keys["acct:6410"]["rationale"].startswith("DIFFERS FROM 2025 PRACTICE")
    assert "Reviewed:" in keys["acct:6410"]["rationale"]
    assert "consumables and tooling mixed" in (tmp_path / "r.md").read_text()


def test_from_corrections_generalises_three_alike_rejections(stdb, actors):
    analyst = AgentTools(actors["cap_analyst"], stdb)
    head = actors["head_of_cost_cap"]
    for n, month in enumerate(["2026-03", "2026-04", "2026-05"], start=1):
        item = seed_line(stdb, gl(id=f"gl-00010{n}", memo=f"Offsite lunch, wind tunnel session {month}",
                                  period_key=month, posted_date=f"{month}-10"),
                         vendor() if n == 1 else None)
        analyst.propose_classification(item["id"], "CATERING", "CATERING@SECD-ISS07", None, "canteen policy",
                                       [f"gl-00010{n}"])
        stdb.call(head.token, R.REJECT, R.reject(item["id"], "Offsite, away from team premises: Relevant."))
    assert len(stdb.tables["precedent"]) == 3

    cands = from_corrections(_learner(stdb, actors), offline=True)
    (c,) = cands
    assert c.category_2025 == "RELEVANT" and c.precedent_count == 3
    assert c.pattern == {"account_code": "6410", "vendor_id": "ven-001", "memo_regex": r"\boffsite\b"}
    (call,) = stdb.reducer_calls(R.PROPOSE_POLICY)
    refs = json.loads(call[2][6])
    assert {"prec-1", "prec-2", "prec-3"} <= set(refs)
    assert call[2][2:4] == ["RELEVANT", "RELEVANT@SECD-ISS07"] and call[2][8] == "2026-03-01"
    # running again does not propose a duplicate
    from_corrections(_learner(stdb, actors), offline=True)
    assert len(stdb.reducer_calls(R.PROPOSE_POLICY)) == 1

    # once approved, the next alike line is proposed silently, citing the learned policy
    pol_row = stdb.tables["policy"][0]
    stdb.call(head.token, R.APPROVE_POLICY, R.approve_policy(pol_row["id"], "agreed"))
    item = seed_line(stdb, gl(id="gl-000200", memo="Offsite lunch, wind tunnel session June", period_key="2026-06",
                              posted_date="2026-06-10"))
    [d] = CapAnalyst(analyst, offline=True).run_once()
    assert d.work_item_id == item["id"] and d.action == "propose" and d.policy_id == pol_row["id"]


def test_two_alike_corrections_are_not_enough(stdb, actors):
    analyst = AgentTools(actors["cap_analyst"], stdb)
    for n in (1, 2):
        item = seed_line(stdb, gl(id=f"gl-00030{n}", memo="Offsite lunch"), vendor() if n == 1 else None)
        analyst.propose_classification(item["id"], "CATERING", "CATERING@SECD-ISS07", None, "x", [f"gl-00030{n}"])
        stdb.call(actors["head_of_cost_cap"].token, R.REJECT, R.reject(item["id"], "Relevant"))
    assert from_corrections(_learner(stdb, actors), offline=True) == []


def test_online_reviews_run_concurrently_and_record_in_candidate_order(history_world, rb, stdb, actors, tmp_path):
    import threading
    import time

    lock, active, peak = threading.Lock(), [0], [0]

    def reply(kwargs):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.05)
        with lock:
            active[0] -= 1
        payload = json.loads(kwargs["messages"][0]["content"])
        return PolicyReview(generalises=True, rationale=f"Reviewed {payload['policy_key']}.", concerns="")

    class ListRecorder:
        def __init__(self):
            self.steps = []

        def record(self, kind, name, input=None, output=None, **_):
            self.steps.append((kind, name, input))

    rec = ListRecorder()
    res = onboard(history_world.client(), rb, _learner(stdb, actors), client=FakeAnthropic(parse_reply=reply),
                  offline=False, report_path=tmp_path / "r.md", rec=rec)
    reviewed = [c.policy_key for c in res["candidates"] if c.mapping and c.mapping.status in ("same", "changed")]
    recorded = [inp["policy_key"] for kind, name, inp in rec.steps if name == "policy_learner.review"]
    assert len(reviewed) > 1 and peak[0] > 1
    assert recorded == reviewed


def test_reviewer_sees_the_invoice_a_bill_line_is_on():
    line = {"memo": "Carbon prepreg batch 14"}
    carriage = Case("history_2025_bill_line:b1", line, {"description": "Carriage, packaging & handling"}, "RELEVANT", None)
    goods = Case("history_2025_bill_line:b0", line, {"description": "Carbon prepreg batch 14"}, "RELEVANT", None)
    whole = Case("history_2025_gl_line:g1", line, None, "RELEVANT", None)
    assert review_sample(carriage) == "Carriage, packaging & handling [a line on the supplier invoice for: Carbon prepreg batch 14]"
    assert review_sample(goods) == review_sample(whole) == "Carbon prepreg batch 14"
