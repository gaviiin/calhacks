"""SCHEMA §11.1 allocations: per-bill-line resolution (P01, the demo hospitality invoice), category
limits, share bases, the module's new denials (FakeStdb), and posting one journal pair per allocation."""

import json

import pytest

from agents import reducers as R
from agents.cap_analyst import CapAnalyst
from agents.gateway import Gateway, build_journal_entry
from agents.tools import AgentTools, allocation_problems, split_usd

from .conftest import gl, policy, seed_line, vendor

IBAN = "GB50HBUK74786417620252"
P01_LINES = [("Factory canteen - new-car build shift meals, 2-4 Jan 2026 (build team, 3 days)", 1_438_000),
             ("Sponsor dinner - Halcyon Energy partners season preview, factory atrium, 2 Jan 2026", 985_000),
             ("Engineering offsite lunch - aero team at Northbrook Wind Tunnel session, 2 Jan 2026", 720_000)]


def _p01(stdb):
    """gl-000001 exactly as the world emits it: GBP 31,430.00 at 1.345 = $42,273.35."""
    line = gl(id="gl-000001", account_code="6420", department_id="dept-MARKETING", bill_id="bill-00001",
              amount_minor=3_143_000, currency="GBP", fx_rate_e6=1_345_000, amount_usd_minor=4_227_335,
              memo="Hospitality - Halcyon season preview & build week catering (requester: Marketing)")
    bills = [{"id": f"bl-00001-{n}", "raw_ref": f"bill_line:bl-00001-{n}:1", "bill_id": "bill-00001",
              "gl_line_id": "gl-000001", "line_no": n, "description": d, "amount_minor": a, "bill_text": "INVOICE",
              "vendor_id": "ven-001", "bank_iban_on_bill": IBAN} for n, (d, a) in enumerate(P01_LINES, start=1)]
    return seed_line(stdb, line, vendor(bank_iban=IBAN), bills)


def _hospitality_tree():
    parent = policy(id=10, policy_key="acct:6420", category_code="MARKETING", rulebook_entry_id="MARKETING@SECD-ISS07",
                    pattern={"account_code": "6420"}, rationale="Hospitality for guests and partners is Marketing")
    canteen = policy(id=11, policy_key="acct:6420/desc:canteen", parent_policy_id=10,
                     pattern={"description_regex": r"\bcanteen\b"}, rationale="Canteen at team premises")
    offsite = policy(id=12, policy_key="acct:6420/desc:offsite", parent_policy_id=10, category_code="RELEVANT",
                     rulebook_entry_id="RELEVANT@SECD-ISS07", pattern={"description_regex": r"\boffsite\b"},
                     rationale="Offsite meals are not premises catering")
    return [parent, canteen, offsite]


def test_split_usd_puts_the_rounding_remainder_on_the_largest_part():
    assert split_usd([1_438_000, 985_000, 720_000], 4_227_335, 1_345_000) == [1_934_110, 1_324_825, 968_400]
    assert split_usd([1, 1, 1], 4, 1_333_333) == [2, 1, 1]  # 1.333 each rounds to 1; +1 on the first largest
    assert split_usd([100, 50], 999, 1_000_000) is None  # not a rounding difference: the bill does not tie


def test_p01_resolves_to_three_allocations_offline(stdb, analyst_tools):
    item = _p01(stdb)
    stdb.tables["policy"] += _hospitality_tree()
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose" and d.path == "policy" and d.category_code == "ALLOCATED"
    assert [(a["basis_ref"], a["category_code"], a["policy_id"], a["amount_usd_minor"]) for a in d.allocations] == [
        ("bl-00001-1", "CATERING", 11, 1_934_110),
        ("bl-00001-2", "MARKETING", 10, 1_324_825),
        ("bl-00001-3", "RELEVANT", 12, 968_400)]
    assert sum(a["amount_usd_minor"] for a in d.allocations) == 4_227_335
    assert "Split by bill line" in d.reason and d.proposal_source == "deterministic"
    assert d.result["ok"], stdb.tables["audit_log"][-1]
    wi = stdb.item(item["id"])
    assert (wi["state"], wi["proposed_category_code"], wi["proposed_rulebook_entry_id"]) == \
        ("PROPOSED", "ALLOCATED", "ALLOCATED")
    rows = [r for r in stdb.tables["allocation"] if r["work_item_id"] == item["id"]]
    assert [(r["line_no"], r["basis"], r["category_code"]) for r in rows] == [
        (1, "bill_line", "CATERING"), (2, "bill_line", "MARKETING"), (3, "bill_line", "RELEVANT")]
    (_, _, args), = stdb.reducer_calls(R.PROPOSE_ALLOCATIONS)
    assert len(args) == 5 and args[1][0][:5] == ["bill_line", "bl-00001-1", "CATERING", "CATERING@SECD-ISS07", {"some": 11}]
    assert args[4] == "deterministic"
    assert {"gl-000001", "bl-00001-1", "bl-00001-2", "bl-00001-3"} <= set(json.loads(args[3]))


def test_bill_lines_that_agree_propose_the_whole_line(stdb, analyst_tools):
    item = _p01(stdb)
    stdb.tables["policy"].append(_hospitality_tree()[0])  # only the account-level policy
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose" and d.category_code == "MARKETING" and d.policy_id == 10 and not d.allocations
    assert stdb.item(item["id"])["proposed_category_code"] == "MARKETING"


def test_unresolved_bill_line_asks_naming_the_split(stdb, analyst_tools):
    item = _p01(stdb)
    stdb.tables["policy"].append(policy(id=11, policy_key="canteen", pattern={"account_code": "6420",
                                                                          "description_regex": "canteen"}))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and d.path == "bill_lines"
    assert "bl-00001-1" in d.question and "CATERING (pol-11 v1)" in d.question
    assert "bl-00001-2" in d.question and "no approved policy" in d.question
    assert "1,438,000 GBP" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO" and not stdb.reducer_calls(R.PROPOSE_ALLOCATIONS)


def test_bill_lines_that_do_not_tie_to_the_line_ask(stdb, analyst_tools):
    item = _p01(stdb)
    stdb.tables["bill_line"][2]["amount_minor"] = 700_000
    stdb.tables["policy"] += _hospitality_tree()
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and "which amount is right" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"


# ---- module precedence (FakeStdb mirrors §11.2) ----------------------------------------------------


def test_module_denies_citing_a_parent_whose_exception_applies(stdb, analyst_tools):
    item = seed_line(stdb, gl(memo="Offsite lunch - wind tunnel session"), vendor())
    stdb.tables["policy"] += [policy(id=3, pattern={"account_code": "6410"}),
                              policy(id=4, policy_key="exc", parent_policy_id=3, category_code="RELEVANT",
                                     rulebook_entry_id="RELEVANT@SECD-ISS07", pattern={"memo_regex": "offsite"})]
    res = analyst_tools.propose_classification(item["id"], "CATERING", "CATERING@SECD-ISS07", 3, "canteen", ["gl-000001"])
    assert not res["ok"] and stdb.tables["audit_log"][-1]["reason"] == "exception_applies: pol-4"
    # the analyst itself cites the exception (on a fresh line: the denied item is not retried)
    other = seed_line(stdb, gl(id="gl-000002", memo="Offsite lunch - aero", amount_usd_minor=50_000))
    d = CapAnalyst(analyst_tools, offline=True).process(stdb.item(other["id"]))
    assert d.action == "propose" and d.policy_id == 4 and d.category_code == "RELEVANT" and d.result["ok"]


def test_module_denies_a_conflicting_policy(stdb, analyst_tools):
    item = seed_line(stdb, gl(), vendor())
    stdb.tables["policy"] += [policy(id=3, policy_key="a", pattern={"account_code": "6410"}),
                              policy(id=4, policy_key="b", category_code="RELEVANT",
                                     rulebook_entry_id="RELEVANT@SECD-ISS07", pattern={"vendor_id": "ven-001"})]
    res = analyst_tools.propose_classification(item["id"], "CATERING", "CATERING@SECD-ISS07", 3, "x", ["gl-000001"])
    assert not res["ok"] and stdb.tables["audit_log"][-1]["reason"] == "policy_conflict"


def test_module_denies_share_apportionment_outside_apportionable(stdb, analyst_tools):
    item = seed_line(stdb, gl(account_code="5010", amount_usd_minor=1_000_000, department_id="dept-APPLIED"))
    split = [{"basis": "share", "basis_ref": "dept-APPLIED:0.6", "category_code": "CATERING",
              "rulebook_entry_id": "CATERING@SECD-ISS07", "policy_id": None, "amount_usd_minor": 600_000},
             {"basis": "share", "basis_ref": "dept-APPLIED:0.4", "category_code": "RELEVANT",
              "rulebook_entry_id": "RELEVANT@SECD-ISS07", "policy_id": None, "amount_usd_minor": 400_000}]
    problems = allocation_problems(analyst_tools, work_item_id=item["id"], period_key="2026-01",
                                   line=stdb.tables["gl_line"][0], bill_lines=[], allocations=split)
    assert any("apportionment_not_permitted" in p for p in problems)
    res = analyst_tools.propose_allocations(item["id"], split, "60/40", ["gl-000001"])
    assert not res["ok"] and "apportionment_not_permitted: CATERING" in stdb.tables["audit_log"][-1]["reason"]
    split[0].update(category_code="NON_F1", rulebook_entry_id="NON_F1@SECD-ISS07")
    assert allocation_problems(analyst_tools, work_item_id=item["id"], period_key="2026-01",
                               line=stdb.tables["gl_line"][0], bill_lines=[], allocations=split) == []
    assert analyst_tools.propose_allocations(item["id"], split, "60/40", ["gl-000001"])["ok"]


def test_module_denies_allocations_that_do_not_sum(stdb, analyst_tools):
    item = _p01(stdb)
    allocs = [{"basis": "bill_line", "basis_ref": f"bl-00001-{n}", "category_code": "RELEVANT",
               "rulebook_entry_id": "RELEVANT@SECD-ISS07", "policy_id": None, "amount_usd_minor": 1_000_000}
              for n in (1, 2, 3)]
    res = analyst_tools.propose_allocations(item["id"], allocs, "x", ["gl-000001"])
    assert not res["ok"] and "do not sum" in stdb.tables["audit_log"][-1]["reason"]


# ---- category limits -------------------------------------------------------------------------------


def _party(stdb, used, amount=15_000_000, bills=((10_000_000, "Marquee and band"), (5_000_000, "Food at the party"))):
    stdb.tables["limit_ledger"].append({"key": "2026|STAFF_ENTERTAINMENT", "cap_year": 2026,
                                        "category_code": "STAFF_ENTERTAINMENT", "excluded_usd_minor": used})
    rows = [{"id": f"bl-00400-{n}", "bill_id": "bill-00400", "gl_line_id": "gl-000400", "line_no": n, "description": d,
             "amount_minor": a, "bank_iban_on_bill": ""} for n, (a, d) in enumerate(bills or (), start=1)]
    item = seed_line(stdb, gl(id="gl-000400", account_code="6400", amount_usd_minor=amount, memo="All-staff Christmas party",
                              department_id="dept-CORP", bill_id="bill-00400" if rows else None), vendor(), rows)
    stdb.tables["policy"].append(policy(id=20, policy_key="acct:6400", category_code="STAFF_ENTERTAINMENT",
                                        rulebook_entry_id="STAFF_ENTERTAINMENT@SECD-ISS07",
                                        pattern={"account_code": "6400"}, rationale="All-staff events"))
    return item


def test_limit_excess_is_split_as_cap_limit_excess(stdb, actors, analyst_tools, world, tmp_path):
    item = _party(stdb, used=110_000_000)  # $1.1m of the $1.2m limit already excluded
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose" and d.category_code == "ALLOCATED" and d.result["ok"], stdb.tables["audit_log"][-1]
    # the sibling is a bill line (REDUCERS.md: the module needs one); the second bill line gets 0
    assert [(a["basis"], a["basis_ref"], a["category_code"], a["amount_usd_minor"]) for a in d.allocations] == [
        ("bill_line", "bl-00400-1", "STAFF_ENTERTAINMENT", 10_000_000),
        ("bill_line", "bl-00400-2", "STAFF_ENTERTAINMENT", 0),
        ("cap_limit_excess", "STAFF_ENTERTAINMENT", "RELEVANT", 5_000_000)]
    assert d.allocations[0]["policy_id"] == 20 and "cap_limit_excess" in d.reason

    stdb.call(actors["controller"].token, R.APPROVE, R.approve(item["id"], "ok"))
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "p.json")
    [r] = gw.run_once()
    assert r["status"] == "posted"
    body = world.journal[str(item["id"])]
    assert body["lines"] == [
        {"account_id": "capcat-STAFF_ENTERTAINMENT", "debit_minor": 10_000_000, "credit_minor": 0},
        {"account_id": "acct-6400", "debit_minor": 0, "credit_minor": 10_000_000},
        {"account_id": "capcat-RELEVANT", "debit_minor": 5_000_000, "credit_minor": 0},
        {"account_id": "acct-6400", "debit_minor": 0, "credit_minor": 5_000_000}]
    assert stdb.tables["limit_ledger"][0]["excluded_usd_minor"] == 120_000_000


def test_limit_excess_on_a_line_without_bill_lines_asks(stdb, analyst_tools):
    item = _party(stdb, used=110_000_000, bills=None)
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and d.path == "cap_limit" and "$100,000.00 STAFF_ENTERTAINMENT" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"


def test_limit_counts_open_proposals_and_exhausted_limit_goes_relevant(stdb, analyst_tools):
    stdb.add_item(subject_ref="gl-000399", period_key="2026-01", state="APPROVED", amount_usd_minor=10_000_000,
                  proposed_category_code="STAFF_ENTERTAINMENT")
    _party(stdb, used=110_000_000, amount=3_000_000)
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose" and d.category_code == "RELEVANT" and d.policy_id is None and d.result["ok"]
    assert "limit" in d.reason


def test_within_limit_is_a_plain_proposal(stdb, analyst_tools):
    _party(stdb, used=0)
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.category_code == "STAFF_ENTERTAINMENT" and d.policy_id == 20 and not d.allocations


def test_module_denies_a_post_past_the_limit(stdb, actors, analyst_tools, world, tmp_path):
    item = _party(stdb, used=0)
    CapAnalyst(analyst_tools, offline=True).run_once()
    stdb.call(actors["controller"].token, R.APPROVE, R.approve(item["id"], "ok"))
    stdb.tables["limit_ledger"][0]["excluded_usd_minor"] = 119_000_000  # someone else posted meanwhile
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "p.json")
    [r] = gw.run_once()
    assert r["status"] == "skipped" and "cap_limit_exceeded" in r["note"] and not world.journal
    stdb.call(actors["gateway"].token, R.POST, R.post(item["id"], "JE-X"))
    assert stdb.tables["audit_log"][-1]["reason"].startswith("cap_limit_exceeded: remaining 1000000")


# ---- gateway ---------------------------------------------------------------------------------------


def _alloc_rows(wid):
    return [{"id": 1, "work_item_id": wid, "line_no": 1, "basis": "bill_line", "basis_ref": "bl-1",
             "category_code": "CATERING", "rulebook_entry_id": "CATERING@SECD-ISS07", "amount_usd_minor": 600_000,
             "cap_effect_usd_minor": None},
            {"id": 2, "work_item_id": wid, "line_no": 2, "basis": "bill_line", "basis_ref": "bl-2",
             "category_code": "MARKETING", "rulebook_entry_id": "MARKETING@SECD-ISS07", "amount_usd_minor": 120_000,
             "cap_effect_usd_minor": None}]


def test_allocated_entry_has_one_pair_per_allocation():
    item = {"id": 5, "kind": "classification", "subject_ref": "gl-000001", "period_key": "2026-01",
            "proposed_category_code": "ALLOCATED", "proposed_rulebook_entry_id": "ALLOCATED", "reason": "split",
            "evidence_refs": "[]", "amount_usd_minor": 720_000}
    je = build_journal_entry(item, gl(), allocations=_alloc_rows(5))
    assert je["lines"] == [{"account_id": "capcat-CATERING", "debit_minor": 600_000, "credit_minor": 0},
                           {"account_id": "acct-6410", "debit_minor": 0, "credit_minor": 600_000},
                           {"account_id": "capcat-MARKETING", "debit_minor": 120_000, "credit_minor": 0},
                           {"account_id": "acct-6410", "debit_minor": 0, "credit_minor": 120_000}]
    assert "allocation:1" in je["evidence_refs"] and "ALLOCATED[" in je["memo"]


def test_reversal_of_an_allocated_item_reverses_each_allocation():
    orig = {"id": 5, "kind": "classification", "subject_ref": "gl-000001", "period_key": "2026-01", "state": "POSTED",
            "proposed_category_code": "ALLOCATED", "proposed_rulebook_entry_id": "ALLOCATED", "erp_entry_id": "JE-1",
            "amount_usd_minor": 720_000}
    rev = {"id": 9, "kind": "reversal", "subject_ref": "5", "period_key": "2026-01", "proposed_category_code": "RELEVANT",
           "proposed_rulebook_entry_id": "RELEVANT@SECD-ISS07", "reason": "corrected", "evidence_refs": "[]",
           "amount_usd_minor": 700_000}
    je = build_journal_entry(rev, gl(amount_usd_minor=700_000), original=orig, original_gl=gl(),
                             original_allocations=_alloc_rows(5))
    assert je["lines"][:4] == [{"account_id": "capcat-CATERING", "debit_minor": 0, "credit_minor": 600_000},
                               {"account_id": "acct-6410", "debit_minor": 600_000, "credit_minor": 0},
                               {"account_id": "capcat-MARKETING", "debit_minor": 0, "credit_minor": 120_000},
                               {"account_id": "acct-6410", "debit_minor": 120_000, "credit_minor": 0}]
    assert je["lines"][4:] == [{"account_id": "capcat-RELEVANT", "debit_minor": 700_000, "credit_minor": 0},
                               {"account_id": "acct-6410", "debit_minor": 0, "credit_minor": 700_000}]


def test_gateway_posts_p01_with_three_pairs(stdb, actors, analyst_tools, world, tmp_path):
    item = _p01(stdb)
    stdb.tables["policy"] += _hospitality_tree()
    CapAnalyst(analyst_tools, offline=True).run_once()
    stdb.call(actors["controller"].token, R.APPROVE, R.approve(item["id"], "split agreed"))
    assert stdb.item(item["id"])["state"] == "APPROVED"
    gw = Gateway(world.client(), stdb, actors["gateway"], world.gateway_key, ledger_path=tmp_path / "p.json")
    [r] = gw.run_once()
    assert r["status"] == "posted" and stdb.item(item["id"])["state"] == "POSTED"
    lines = world.journal[str(item["id"])]["lines"]
    assert [l["account_id"] for l in lines[::2]] == ["capcat-CATERING", "capcat-MARKETING", "capcat-RELEVANT"]
    assert [l["debit_minor"] for l in lines[::2]] == [1_934_110, 1_324_825, 968_400]
    assert all(r["posted_treatment"] for r in stdb.tables["allocation"])


# ---- online: the propose_allocations tool, validated by code ----------------------------------------


def _alloc_call(wid, amounts, cats=("CATERING", "MARKETING", "RELEVANT"), refs=("gl-000001", "bl-00001-1")):
    return ("propose_allocations", {
        "work_item_id": wid, "reason": "Canteen, sponsor dinner and an offsite lunch on one invoice.",
        "evidence_refs": list(refs),
        "allocations": [{"basis": "bill_line", "basis_ref": f"bl-00001-{n}", "category_code": c,
                         "rulebook_entry_id": f"{c}@SECD-ISS07", "amount_usd_minor": a}
                        for n, (c, a) in enumerate(zip(cats, amounts), start=1)]})


def test_llm_allocations_are_validated_by_code(stdb, analyst_tools):
    from .fakes import FakeAnthropic

    item = _p01(stdb)
    other = seed_line(stdb, gl(id="gl-000777", vendor_id="ven-002", amount_usd_minor=5))  # not this item's evidence
    script = [
        ("read_item", {"work_item_id": item["id"]}),
        _alloc_call(item["id"], [1_934_110, 1_324_825, 968_000]),  # does not sum
        _alloc_call(item["id"], [1_934_110, 1_324_825, 968_400], refs=("gl-000777",)),  # foreign evidence
        _alloc_call(item["id"], [1_934_110, 1_324_825, 968_400], cats=("CATERING", "MARKETING", "ADJ_GRANT_GROSS_UP")),
        _alloc_call(item["id"], [1_934_110, 1_324_825, 968_400]),
    ]
    fake = FakeAnthropic(script)
    d = CapAnalyst(analyst_tools, client=fake, offline=False).process(stdb.item(item["id"]))
    errs = [r for n, r, e in fake.results if e]
    assert len(errs) == 3
    assert "sum" in errs[0] and "not part of work item" in errs[1] and "ADJUSTMENT" in errs[2]
    user = fake.runner_kwargs[0]["messages"][0]["content"]
    assert "Per-bill-line resolution" in user and "bl-00001-2" in user
    assert d.action == "propose" and d.path == "llm" and d.category_code == "ALLOCATED" and d.proposal_source == "llm"
    wi = stdb.item(item["id"])
    assert wi["state"] == "PROPOSED" and wi["proposal_source"] == "llm" and wi["proposed_category_code"] == "ALLOCATED"
    assert all(r["policy_id"] is None for r in stdb.tables["allocation"])
    assert stdb.item(other["id"])["state"] == "NEW"
