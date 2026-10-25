"""Policy Learner, Tier 1 (SCHEMA §11.2): RDR exceptions mined from 2025 history (memo, bill-line
description, department, account discriminators), rule-version children (social security, bonus
definition, offsite catering), proposal order with parent ids and cornerstones, and corrections
that become children of the policy that fired."""

import json

import pytest

from agents import reducers as R
from agents.cap_analyst import CapAnalyst
from agents.policy_learner import from_corrections, load_history, mine_history, onboard
from agents.rule_versions import BONUS_RELEVANT_REGEX, Nature, Rulebook, map_to_2026
from agents.tools import AgentTools

from .conftest import gl, seed_line, vendor


@pytest.fixture(scope="module")
def rb():
    return Rulebook.from_file()


class H:
    """Writes 2025 history into a FakeWorld."""

    def __init__(self, world):
        self.w, self.i = world, 0

    def account(self, code, name, default):
        self.w.emit("account", {"id": f"acct-{code}", "code": code, "name": name, "default_category_code": default,
                                "kind": "expense"})

    def line(self, account, memo, cat, dept="dept-AERO", vendor_id="ven-001", bills=None, amount=100_000):
        self.i += 1
        gid = f"h25-gl-{self.i:05d}"
        self.w.emit("history_2025_gl_line", {
            "id": gid, "posted_date": "2025-06-10", "period_key": "2025-06", "account_id": f"acct-{account}",
            "department_id": dept, "vendor_id": vendor_id, "bill_id": f"h25-bill-{self.i}" if bills else None,
            "amount_minor": amount, "currency": "USD", "fx_rate_to_usd": 1.0, "amount_usd_minor": amount, "memo": memo,
            "erp_category_code": "", "entity": "RACING", "correction_of": None})
        cats = sorted({c for _, c in bills}) if bills else [cat]
        for k, c in enumerate(cats):
            self.w.emit("history_2025_cap_classification", {
                "id": f"h25-cls-{self.i:05d}-{k}", "gl_line_id": gid, "category_code": c,
                "rulebook_entry_id": f"{c}@ISS22", "decided_by": "analyst", "reason": ""})
        for n, (desc, c) in enumerate(bills or [], start=1):
            blid = f"bl-2025-{self.i:05d}-{n}"
            self.w.emit("history_2025_bill_line", {"id": blid, "bill_id": f"h25-bill-{self.i}", "gl_line_id": gid,
                                                   "line_no": n, "description": desc, "amount_minor": 1000})
            self.w.emit("history_2025_bill_line_classification", {
                "id": f"h25bc-{self.i:05d}-{n}", "bill_line_id": blid, "gl_line_id": gid, "category_code": c,
                "rulebook_entry_id": f"{c}@ISS22", "amount_minor": 1000, "decided_by": "analyst", "reason": ""})
        return gid


def _vendors(world):
    world.emit("vendor", {"id": "ven-001", "name": "Grove Catering Services Ltd", "country": "GB", "related_party": False,
                          "related_party_entity": None, "bank_iban": "GB1", "category_hint": "CATERING"})


def _by_key(cands):
    return {c.policy_key: c for c in cands}


# ---- (a) exceptions from history, (b) offsite catering rule-version child ---------------------------


@pytest.fixture
def canteen_world(world):
    h = H(world)
    _vendors(world)
    h.account("6410", "Catering & canteen", "CATERING")
    for n in range(20):
        h.line("6410", f"Factory canteen service - staff meals week {n}", "RELEVANT", dept="dept-FACILITIES")
    for n in range(5):
        h.line("6410", f"Offsite catering - aero team lunch at Northbrook Wind Tunnel session {n}", "RELEVANT")
    for guest in ("Halcyon Energy", "Arcadia Watches", "Volta Telecom"):
        h.line("6410", f"Factory canteen - partner open day buffet ({guest} guests)", "MARKETING",
               dept="dept-MARKETING")
    return world


def test_canteen_policy_carves_out_its_wind_tunnel_and_partner_exceptions(canteen_world, rb):
    cands, near = mine_history(load_history(canteen_world.client()), rb)
    canteen = _by_key(cands)["acct:6410"]
    assert canteen.mapping.category_2026 == "CATERING" and canteen.precedent_count == 28
    assert canteen.consistency == pytest.approx(20 / 28) and canteen.residual_consistency == 1.0
    kids = {c.policy_key: c for c in canteen.children}
    offsite = kids["acct:6410/exc:memo-offsite"]
    assert offsite.pattern == {"memo_regex": r"\boffsite\b"} and offsite.mapping.category_2026 == "RELEVANT"
    assert offsite.kind == "rule_version" and offsite.precedent_count == 5  # same 2025 answer, new 2026 rule
    assert {s["category_code"] for s in offsite.cornerstones} == {"RELEVANT"} and len(offsite.cornerstones) == 5
    partner = kids["acct:6410/exc:memo-partner"]
    assert partner.pattern == {"memo_regex": r"\bpartner\b"} and partner.mapping.category_2026 == "MARKETING"
    assert partner.kind == "exception" and len(partner.cornerstones) == 3
    # parent cornerstones: a sample of its own (majority) lines; no child matches any of them
    assert len(canteen.cornerstones) == 10 and all(s["category_code"] == "CATERING" for s in canteen.cornerstones)
    assert all(s["ref"].startswith("history_2025_gl_line:") for s in canteen.cornerstones)
    assert "vendor:ven-001|acct:6410" not in _by_key(cands)  # the account tree already answers it


def test_two_exceptions_are_not_enough_for_a_child(world, rb):
    h = H(world)
    _vendors(world)
    h.account("6410", "Catering & canteen", "CATERING")
    for n in range(40):
        h.line("6410", f"Factory canteen service week {n}", "RELEVANT")
    for guest in ("Halcyon", "Arcadia"):
        h.line("6410", f"Factory canteen - partner buffet ({guest})", "MARKETING")
    canteen = _by_key(mine_history(load_history(world.client()), rb)[0])["acct:6410"]
    assert canteen.children == [] and len(canteen.exceptions) == 2 and canteen.residual_consistency == 40 / 42


def test_onboard_proposes_parent_then_children_with_cornerstones(canteen_world, rb, stdb, actors, tmp_path):
    tools = AgentTools(actors["policy_learner"], stdb)
    onboard(canteen_world.client(), rb, tools, offline=True, report_path=tmp_path / "r.md")
    calls = [c[2] for c in stdb.reducer_calls(R.PROPOSE_POLICY)]
    assert [c[0] for c in calls] == ["acct:6410", "acct:6410/exc:memo-offsite", "acct:6410/exc:memo-partner"]
    assert all(len(c) == 12 for c in calls)
    parent_row = next(p for p in stdb.tables["policy"] if p["policy_key"] == "acct:6410")
    assert calls[0][10] == {"none": []} and len(json.loads(calls[0][11])) == 10
    assert calls[1][10] == calls[2][10] == {"some": parent_row["id"]}
    assert calls[1][2:4] == ["RELEVANT", "RELEVANT@SECD-ISS07"] and json.loads(calls[1][4]) == {"memo_regex": r"\boffsite\b"}
    assert {s["ref"] for s in json.loads(calls[1][11])} <= {f"history_2025_gl_line:h25-gl-{i:05d}" for i in range(21, 26)}
    assert calls[1][5].startswith("Exception to acct:6410 (CATERING)")
    report = (tmp_path / "r.md").read_text()
    assert "### Policy tree (Ripple-Down Rules)" in report
    assert "- `acct:6410` -> **CATERING** (28 cases, 10 cornerstones)" in report
    assert "`acct:6410/exc:memo-offsite` `{\"memo_regex\": \"\\\\boffsite\\\\b\"}` -> **RELEVANT** (rule version, 5 cases, 5 cornerstones)" in report

    # approved, the tree decides 2026 lines: the canteen is CATERING, the wind tunnel lunch RELEVANT
    head = actors["head_of_cost_cap"]
    for p in stdb.tables["policy"]:
        stdb.call(head.token, R.APPROVE_POLICY, R.approve_policy(p["id"], "agreed"))
    analyst = AgentTools(actors["cap_analyst"], stdb)
    a = seed_line(stdb, gl(id="gl-000010", memo="Factory canteen service - staff meals w/c 2026-01-05"), vendor())
    b = seed_line(stdb, gl(id="gl-000011", amount_usd_minor=300_000,
                           memo="Offsite catering - aero team lunch at Northbrook Wind Tunnel session (week 2)"))
    da, db = CapAnalyst(analyst, offline=True).run_once()
    assert (da.work_item_id, da.category_code, da.policy_id) == (a["id"], "CATERING", parent_row["id"])
    child = next(p for p in stdb.tables["policy"] if p["policy_key"] == "acct:6410/exc:memo-offsite")
    assert (db.work_item_id, db.category_code, db.policy_id) == (b["id"], "RELEVANT", child["id"])
    assert da.result["ok"] and db.result["ok"]


# ---- (c) bill-line history: description children on the hospitality account, then P01 -----------------


def test_bill_line_history_teaches_description_children_and_p01_splits(world, rb, stdb, actors, tmp_path):
    h = H(world)
    _vendors(world)
    h.account("6420", "Hospitality - guests & partners", "MARKETING")
    for n, who in enumerate(["Halcyon Energy", "Arcadia Watches", "Volta Telecom", "Northwind Cloud"] * 5):
        h.line("6420", f"Partner dinner - {who} partners evening", "MARKETING", dept="dept-MARKETING",
               bills=[(f"Partner dinner - {who} partners evening - factory atrium", "MARKETING")])
    for n in range(4):
        h.line("6420", f"Hospitality - partner evening & build week catering {n}", None, dept="dept-MARKETING",
               bills=[("Sponsor dinner - partners evening, factory atrium", "MARKETING"),
                      (f"Factory canteen top-up - extended build shift service, week {n}", "RELEVANT"),
                      ("Engineering offsite lunch - aero team at Northbrook Wind Tunnel session", "RELEVANT")])
    hist = load_history(world.client())
    assert len(hist.cases()) == 32 and hist.split_lines() == []  # mixed invoices are taught bill line by bill line
    cands, _ = mine_history(hist, rb)
    hosp = _by_key(cands)["acct:6420"]
    assert hosp.mapping.category_2026 == "MARKETING"
    kids = {c.mapping.category_2026: c for c in hosp.children}
    assert kids["CATERING"].pattern == {"description_regex": r"\bcanteen\b"}  # RELEVANT in 2025, CATERING in 2026
    assert kids["RELEVANT"].pattern["description_regex"] in (r"\boffsite\b", r"\bengineering\b")
    assert all(s["ref"].startswith("history_2025_bill_line:") for s in kids["CATERING"].cornerstones)

    tools = AgentTools(actors["policy_learner"], stdb)
    onboard(world.client(), rb, tools, offline=True, report_path=tmp_path / "r.md")
    for p in stdb.tables["policy"]:
        stdb.call(actors["head_of_cost_cap"].token, R.APPROVE_POLICY, R.approve_policy(p["id"], "agreed"))
    from .test_allocations import _p01

    item = _p01(stdb)
    [d] = CapAnalyst(AgentTools(actors["cap_analyst"], stdb), offline=True).run_once()
    assert d.action == "propose" and d.category_code == "ALLOCATED" and d.result["ok"]
    assert [(a["basis_ref"], a["category_code"], a["amount_usd_minor"]) for a in d.allocations] == [
        ("bl-00001-1", "CATERING", 1_934_110), ("bl-00001-2", "MARKETING", 1_324_825),
        ("bl-00001-3", "RELEVANT", 968_400)]
    assert stdb.item(item["id"])["proposed_category_code"] == "ALLOCATED"


# ---- (b) social security under department policies; bonus definition --------------------------------


def test_social_security_lines_under_a_department_policy_become_a_child(world, rb):
    h = H(world)
    h.account("5010", "Salaries & wages", "RELEVANT")
    h.account("5050", "Employer pension contributions", "RELEVANT")
    h.account("5040", "Employer NI - base (13.8%)", "SOCIAL_SECURITY")
    for n in range(20):
        h.line("5010", f"Payroll month {n} - Finance - salaries", "HR_FINANCE_LEGAL", dept="dept-FINANCE", vendor_id=None)
    for n in range(12):
        h.line("5050", f"Payroll month {n} - Finance - employer pension", "HR_FINANCE_LEGAL", dept="dept-FINANCE",
               vendor_id=None)
    for n in range(6):
        h.line("5040", f"Payroll month {n} - Finance - employer NI (13.8% base)", "HR_FINANCE_LEGAL",
               dept="dept-FINANCE", vendor_id=None)
    cands, _ = mine_history(load_history(world.client()), rb, kinds=("department", "account_department"))
    dept = _by_key(cands)["dept:dept-FINANCE"]
    assert dept.mapping.category_2026 == "HR_FINANCE_LEGAL"
    (ss,) = dept.children
    assert ss.pattern == {"account_code": "5040"} and ss.mapping.category_2026 == "SOCIAL_SECURITY"
    assert ss.kind == "rule_version" and ss.mapping.status == "changed" and "all mandatory employer" in ss.mapping.explanation
    # a policy pinned to the NI account itself maps whole to SOCIAL_SECURITY, whatever the department did
    pinned = _by_key(cands).get("acct:5040|dept:dept-FINANCE")
    assert pinned is None or pinned.mapping.category_2026 == "SOCIAL_SECURITY"
    n = Nature(account_code="5040", account_name="Employer NI - base (13.8%)", memos=["Payroll - Marketing - employer NI"])
    assert map_to_2026("MARKETING", n, rb).category_2026 == "SOCIAL_SECURITY"
    assert map_to_2026("EXCLUDED_PERSONS", n, rb).category_2026 == "EXCLUDED_PERSONS"  # ranking comes first
    pension = Nature(account_code="5050", account_name="Employer pension contributions", memos=["employer pension"])
    assert map_to_2026("RELEVANT", pension, rb).category_2026 == "RELEVANT"  # pensions are not social security


def test_bonus_definition_2026(rb):
    def m(memo):
        return map_to_2026("BONUS", Nature(account_code="5060", account_name="Employee bonuses", memos=[memo]), rb,
                           "BONUS@ISS22")

    annual = m("Annual bonus 2025 performance - Aerodynamics")
    assert (annual.status, annual.category_2026, annual.narrow_memo_regex) == ("changed", "RELEVANT", BONUS_RELEVANT_REGEX)
    assert m("Retention bonus - regulation-change programme, tranche 2").category_2026 == "RELEVANT"
    assert m("Podium bonus - Italian Grand Prix").category_2026 == "RELEVANT"
    champ = m("Championship bonus scheme - final Constructors' classification P3, paid after Abu Dhabi")
    assert (champ.status, champ.category_2026) == ("same", "BONUS")
    assert m("Constructors' points and race wins bonus").category_2026 == "RELEVANT"  # not solely the classification
    unclear = m("Bonus payment Q3")
    assert unclear.status == "ask" and unclear.category_2026 is None


def test_bonus_policy_is_narrowed_so_unclear_memos_are_asked(world, rb, stdb, actors, tmp_path):
    h = H(world)
    h.account("5060", "Employee bonuses", "BONUS")
    for n in range(12):
        h.line("5060", f"Annual bonus 2025 performance - department {n}", "BONUS", vendor_id=None)
    cands, _ = mine_history(load_history(world.client()), rb)
    (c,) = [c for c in cands if c.pattern.get("account_code") == "5060"]
    assert c.policy_key == "acct:5060|memo:relevant-definition"
    assert c.pattern == {"account_code": "5060", "memo_regex": BONUS_RELEVANT_REGEX}
    assert (c.mapping.category_2026, c.mapping.status) == ("RELEVANT", "changed")
    onboard(world.client(), rb, AgentTools(actors["policy_learner"], stdb), offline=True, report_path=tmp_path / "r.md")
    stdb.call(actors["head_of_cost_cap"].token, R.APPROVE_POLICY, R.approve_policy(stdb.tables["policy"][0]["id"], "ok"))
    analyst = AgentTools(actors["cap_analyst"], stdb)
    seed_line(stdb, gl(id="gl-000020", account_code="5060", vendor_id=None, memo="Annual bonus 2026 performance - Aero"))
    seed_line(stdb, gl(id="gl-000021", account_code="5060", vendor_id=None, amount_usd_minor=5,
                       memo="Bonus payment Q3"))
    d1, d2 = CapAnalyst(analyst, offline=True).run_once()
    assert d1.action == "propose" and d1.category_code == "RELEVANT"
    assert d2.action == "ask" and "No approved policy" in d2.question


# ---- (d) corrections become children of the policy that fired --------------------------------------


def _canteen_policy(stdb, actors, cornerstones):
    learner = AgentTools(actors["policy_learner"], stdb)
    res = learner.propose_policy("acct:6410", "CATERING", "CATERING@SECD-ISS07", {"account_code": "6410"},
                                 "Canteen at team premises", ["h25-gl-1"], 100, "2026-01-01", None,
                                 cornerstones=cornerstones)
    stdb.call(actors["head_of_cost_cap"].token, R.APPROVE_POLICY, R.approve_policy(res["policy_id"], "ok"))
    return res["policy_id"]


def _reject_three(stdb, actors, memo="Offsite lunch, wind tunnel session"):
    analyst = AgentTools(actors["cap_analyst"], stdb)
    ids = []
    for n, month in enumerate(["2026-03", "2026-04", "2026-05"], start=1):
        item = seed_line(stdb, gl(id=f"gl-00010{n}", memo=f"{memo} {month}", period_key=month,
                                  posted_date=f"{month}-10", amount_usd_minor=700_000 + n),
                         vendor() if n == 1 else None)
        [d] = CapAnalyst(analyst, offline=True).run_once()
        assert d.policy_id is not None and d.result["ok"]
        stdb.call(actors["head_of_cost_cap"].token, R.REJECT, R.reject(item["id"], "Offsite, away from team premises: Relevant."))
        ids.append(f"gl-00010{n}")
    return ids


def test_corrections_become_a_child_of_the_policy_that_fired(stdb, actors):
    seed_line(stdb, gl(id="gl-000050", memo="Factory canteen service - January", amount_usd_minor=111))
    pid = _canteen_policy(stdb, actors, [{"ref": "gl-000050", "category_code": "CATERING"}])
    stdb.tables["work_item"] = [w for w in stdb.tables["work_item"] if w["subject_ref"] != "gl-000050"]
    corrected = _reject_three(stdb, actors)
    (c,) = from_corrections(AgentTools(actors["policy_learner"], stdb), offline=True)
    assert c.kind == "correction" and c.parent_policy_id == pid and c.pattern == {"memo_regex": r"\boffsite\b"}
    assert c.policy_key == "acct:6410/corr:RELEVANT:memo-offsite"
    (call,) = [x[2] for x in stdb.reducer_calls(R.PROPOSE_POLICY) if x[2][0] != "acct:6410"]
    assert call[10] == {"some": pid}
    assert sorted(json.loads(call[11]), key=lambda s: s["ref"]) == [{"ref": g, "category_code": "RELEVANT"}
                                                                   for g in corrected]
    child = next(p for p in stdb.tables["policy"] if p["policy_key"] == c.policy_key)
    assert child["state"] == "PROPOSED" and child["parent_policy_id"] == pid

    stdb.call(actors["head_of_cost_cap"].token, R.APPROVE_POLICY, R.approve_policy(child["id"], "agreed"))
    item = seed_line(stdb, gl(id="gl-000200", memo="Offsite lunch, wind tunnel session June", period_key="2026-06",
                              posted_date="2026-06-10", amount_usd_minor=12_345))
    d = CapAnalyst(AgentTools(actors["cap_analyst"], stdb), offline=True).process(stdb.item(item["id"]))
    assert d.action == "propose" and d.policy_id == child["id"] and d.category_code == "RELEVANT" and d.result["ok"]


def test_correction_child_that_would_swallow_a_parent_cornerstone_is_not_proposed(stdb, actors):
    # the parent was made for an offsite canteen line too: an "offsite" exception would contradict it
    seed_line(stdb, gl(id="gl-000050", memo="Offsite lunch served from the factory canteen", amount_usd_minor=111))
    _canteen_policy(stdb, actors, [{"ref": "gl-000050", "category_code": "CATERING"}])
    stdb.tables["work_item"] = [w for w in stdb.tables["work_item"] if w["subject_ref"] != "gl-000050"]
    _reject_three(stdb, actors, memo="Offsite lunch wind tunnel")
    learner = AgentTools(actors["policy_learner"], stdb)
    (c,) = from_corrections(learner, offline=True)
    # "offsite" (the longest shared word) would match the parent's cornerstone; the next one does not
    assert c.pattern == {"memo_regex": r"\btunnel\b"} and c.parent_policy_id == stdb.tables["policy"][0]["id"]
    # the module would have denied it as well (FakeStdb mirrors conflicting_cornerstone)
    args = R.propose_policy("x", 0, "RELEVANT", "RELEVANT@SECD-ISS07", {"memo_regex": "offsite"}, "r", ["p"], 3,
                            "2026-03-01", None, stdb.tables["policy"][0]["id"], [])
    stdb.call(actors["policy_learner"].token, R.PROPOSE_POLICY, args)
    assert stdb.tables["audit_log"][-1]["reason"].startswith("conflicting_cornerstone: gl-000050")
