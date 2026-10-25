"""2025 bill lines and their classifications, the 2026 allocations file, and the Oct 24 truth fixes."""

from __future__ import annotations

from collections import defaultdict

from world import company as C
from world import patterns


def by_gl(rows: list[dict], key: str = "gl_line_id") -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        out[r[key]].append(r)
    return out


def truth_by_gl(truth):
    return by_gl(truth)


# ---- 2025 bill lines ----------------------------------------------------------------------------
def test_every_2025_bill_line_has_exactly_one_matching_classification(recs):
    bls = recs["history_2025_bill_line"]
    cls = recs["history_2025_bill_line_classification"]
    assert len(bls) == len(cls) > 2000
    by_bl = {}
    for c in cls:
        assert c["bill_line_id"] not in by_bl, c["id"]
        by_bl[c["bill_line_id"]] = c
    gl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    for b in bls:
        c = by_bl[b["id"]]
        assert c["gl_line_id"] == b["gl_line_id"] and c["amount_minor"] == b["amount_minor"]
        assert c["decided_by"] in ("analyst", "head_of_cost_cap") and c["reason"]
        assert gl[b["gl_line_id"]]["bill_id"] == b["bill_id"]


def test_2025_bills_tie_to_history_ledger_and_line_classification(recs):
    gl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    bl_by_gl = by_gl(recs["history_2025_bill_line"])
    blc = {c["bill_line_id"]: c for c in recs["history_2025_bill_line_classification"]}
    line_cls = by_gl(recs["history_2025_cap_classification"])
    approval = {a["gl_line_id"]: a for a in recs["history_2025_approval"]}
    for gid, g in gl.items():
        lines = bl_by_gl.get(gid, [])
        assert bool(lines) == (g["bill_id"] is not None) == (g["vendor_id"] is not None and g["account_id"] != "acct-7100"), gid
        if not lines:
            continue
        assert sum(b["amount_minor"] for b in lines) == g["amount_minor"]
        assert sorted(b["line_no"] for b in lines) == list(range(1, len(lines) + 1))
        assert {blc[b["id"]]["category_code"] for b in lines} == {c["category_code"] for c in line_cls[gid]}, gid
        assert {blc[b["id"]]["decided_by"] for b in lines} == {c["decided_by"] for c in line_cls[gid]}
        assert all(blc[b["id"]]["visible_at"] == approval[gid]["decided_on"] for b in lines)
    assert len({g["bill_id"] for g in gl.values() if g["bill_id"]}) == len({b["bill_id"] for b in recs["history_2025_bill_line"]})


def test_2025_mixed_hospitality_and_canteen_invoices(out_dir, recs):
    bls, cls = patterns.load_bill_history(out_dir)
    counts = patterns.mixed_bill_counts(bls, cls)
    assert counts["multi_category_bills"] >= 10 and counts["multi_category_MARKETING+RELEVANT"] == counts["multi_category_bills"]
    assert counts["of_which_single_category_RELEVANT"] >= 10  # canteen invoices that also bill a wind tunnel lunch
    rows = {r["key"]: r for r in patterns.bill_pattern_counts(bls, cls)}
    for key in ("bl_partner_hospitality", "bl_canteen", "bl_offsite_engineering_lunch"):
        assert rows[key]["precedents"] >= 20 and rows[key]["on_mixed"] >= 5, rows[key]
    # the learnable 2025 split on a mixed invoice is MARKETING versus RELEVANT, by description
    gl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    mixed_gl = {c["gl_line_id"] for c in recs["history_2025_cap_classification"] if c["id"].endswith("-2")}
    assert len(mixed_gl) == counts["multi_category_bills"]
    for gid in mixed_gl:
        assert gl[gid]["account_id"] == "acct-6420" and gl[gid]["vendor_id"] == C.V_CANTEEN and gl[gid]["erp_category_code"] == "MARKETING"
    pats = {p.key: p for p in patterns.BILL_PATTERNS}
    for b in bls:
        if b["gl_line_id"] in mixed_gl:
            want = "MARKETING" if pats["bl_partner_hospitality"].match(b) else "RELEVANT"
            assert cls[b["id"]]["category_code"] == want, b


# ---- allocations ----------------------------------------------------------------------------------
def test_allocations_sum_exactly_and_cover_every_split(allocations, truth, latest, recs):
    assert list(allocations[0]) == ["gl_line_id", "bill_line_id", "basis", "basis_ref", "category_code", "rulebook_entry_id",
                                    "amount_usd_minor", "plant_id", "note"]
    gl = latest["gl_line"]
    bl_by_gl = by_gl(recs["bill_line"])
    alloc = by_gl(allocations)
    t = truth_by_gl(truth)
    split_lines = {gid for gid, rows in t.items() if len(rows) > 1}
    assert set(alloc) == split_lines
    for gid, rows in alloc.items():
        assert len(rows) >= 2
        assert sum(int(r["amount_usd_minor"]) for r in rows) == gl[gid]["amount_usd_minor"], gid
        assert all(r["rulebook_entry_id"] == r["category_code"] + "@SECD-ISS07" for r in rows)
        # the Relevant allocations are exactly the Relevant amount in truth
        rel = sum(int(r["amount_usd_minor"]) for r in rows if r["category_code"] == "RELEVANT")
        assert rel == sum(int(x["relevant_usd_minor"]) for x in t[gid]), gid
        assert sorted(r["category_code"] for r in rows) == sorted(x["category_code"] for x in t[gid])
        bases = {r["basis"] for r in rows}
        if bases == {"bill_line"}:
            assert sorted(r["bill_line_id"] for r in rows) == sorted(b["id"] for b in bl_by_gl[gid])
            assert all(r["basis_ref"] == r["bill_line_id"] for r in rows)
        else:
            assert bases == {"cap_limit", "cap_limit_excess"}, rows
            assert [r["category_code"] for r in rows if r["basis"] == "cap_limit_excess"] == ["RELEVANT"]
            assert len({r["basis_ref"] for r in rows}) == 1
    assert {r["plant_id"] for r in allocations} == {"P01", "P07", "P34", "P43", "P44"}


def test_p01_allocation_rows(allocations, latest):
    rows = sorted((r for r in allocations if r["gl_line_id"] == "gl-000001"), key=lambda r: r["bill_line_id"])
    assert [(r["bill_line_id"], r["category_code"]) for r in rows] == [
        ("bl-00001-1", "CATERING"), ("bl-00001-2", "MARKETING"), ("bl-00001-3", "RELEVANT")]
    fx = latest["gl_line"]["gl-000001"]["fx_rate_to_usd"]
    assert sum(int(r["amount_usd_minor"]) for r in rows) == latest["gl_line"]["gl-000001"]["amount_usd_minor"]
    assert abs(int(rows[2]["amount_usd_minor"]) - 720_000 * fx) <= 1


def test_category_limit_allocations(allocations, latest):
    p07 = [r for r in allocations if r["plant_id"] == "P07"]
    within = next(int(r["amount_usd_minor"]) for r in p07 if r["basis"] == "cap_limit")
    assert within == C.EXCLUDED_BONUS_MAX_USD_MINOR
    assert {r["basis_ref"] for r in p07} == {"BONUS"}
    p34 = [r for r in allocations if r["plant_id"] == "P34"]
    assert {r["category_code"] for r in p34} == {"PU_SUPPLY", "RELEVANT"} and {r["basis_ref"] for r in p34} == {"PU_SUPPLY"}


# ---- the four truth fixes ------------------------------------------------------------------------------
def test_fix_a_bonus_definition(truth, latest, recs):
    gl = latest["gl_line"]
    t = truth_by_gl(truth)
    bonus_lines = [g for g in gl.values() if g["account_id"] == "acct-5060" and g["department_id"] != "dept-EXEC"]
    genuine = [g for g in bonus_lines if "Constructors' Championship scheme" in g["memo"]]
    assert len(genuine) == 1 and "final Constructors' classification" in genuine[0]["memo"]
    assert sorted(x["category_code"] for x in t[genuine[0]["id"]]) == ["BONUS", "RELEVANT"]  # genuine, then capped at $12m
    for g in bonus_lines:
        if g is genuine[0]:
            continue
        assert [x["category_code"] for x in t[g["id"]]] == ["RELEVANT"], g["memo"]
        assert g["erp_category_code"] == "BONUS"  # ERP still codes the account default
    kinds = " ".join(g["memo"] for g in bonus_lines)
    for word in ("Retention", "Podium & race-win", "Annual bonus"):
        assert word in kinds
    excluded = sum(1 for x in truth if x["category_code"] == "BONUS")
    assert excluded == 1
    # 2025 keeps the ISS22 labels: points, podiums and wins schemes were Employee Bonus Costs
    hgl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    for c in recs["history_2025_cap_classification"]:
        g = hgl[c["gl_line_id"]]
        if g["account_id"] == "acct-5060" and g["department_id"] != "dept-EXEC":
            assert c["category_code"] == "BONUS" and "points, podiums & race wins" in g["memo"]


def test_fix_b_applied_technologies_no_salary_apportionment_in_2026(truth, latest, recs):
    t = truth_by_gl(truth)
    applied = [g for g in latest["gl_line"].values() if g["department_id"] == "dept-APPLIED"
               and g["account_id"] in ("acct-5010", "acct-5050", "acct-5230")]
    assert len(applied) >= 33
    for g in applied:
        assert [x["category_code"] for x in t[g["id"]]] == ["RELEVANT"], g["memo"]
    assert not [x for x in truth if x["note"].startswith("split by f1_activity_share")]
    # Directly Attributable Non-F1 costs (client project contractors, 6810) stay NON_F1
    assert any(x["category_code"] == "NON_F1" for g in latest["gl_line"].values() if g["account_id"] == "acct-6810" for x in t[g["id"]])
    # 2025 history keeps the ISS22 60/40 split
    hgl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    nf1 = [c for c in recs["history_2025_cap_classification"] if c["id"].endswith("-nf1")]
    assert len(nf1) >= 40 and all(hgl[c["gl_line_id"]]["department_id"] == "dept-APPLIED" for c in nf1)
    assert C.DEPARTMENTS["APPLIED"]["share"] == 0.6  # the share is still real; it just cannot be used for 2026 pay


def test_fix_c_building_maintenance_is_never_property(truth, latest, recs):
    t = truth_by_gl(truth)
    bm = [g for g in latest["gl_line"].values() if g["account_id"] == "acct-6730"]
    assert bm and all(x["category_code"] == "RELEVANT" for g in bm for x in t[g["id"]])
    assert any(g["erp_category_code"] == "PROPERTY" for g in bm)  # the ERP habit the analyst must correct
    hgl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    h_bm = [c for c in recs["history_2025_cap_classification"] if hgl[c["gl_line_id"]]["account_id"] == "acct-6730"]
    assert h_bm and all(c["category_code"] == "RELEVANT" for c in h_bm)
    assert C.ACCOUNT["6730"]["default"] == "RELEVANT" and C.VENDORS["ven-025"]["category_hint"] == "RELEVANT"
    # buildings insurance: not Property Costs under ISS22 (rent, lease, rates, taxes), Property Costs under SECD
    ins = [c for c in recs["history_2025_cap_classification"] if hgl[c["gl_line_id"]]["memo"].startswith("Buildings insurance")]
    assert [c["category_code"] for c in ins] == ["RELEVANT"]
    ins26 = [g for g in latest["gl_line"].values() if g["memo"].startswith("Buildings insurance")]
    assert [x["category_code"] for g in ins26 for x in t[g["id"]]] == ["PROPERTY"]


def test_fix_d_health_and_safety_2025_is_hr_activities(truth, latest, recs):
    hgl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    hs = [c for c in recs["history_2025_cap_classification"] if hgl[c["gl_line_id"]]["account_id"] == "acct-6740"]
    assert len(hs) >= 12 and all(c["category_code"] == "HR_FINANCE_LEGAL" for c in hs)
    assert all("health and safety matters" in c["reason"] for c in hs)
    t = truth_by_gl(truth)
    hs26 = [g for g in latest["gl_line"].values() if g["account_id"] == "acct-6740"]
    assert hs26 and all([x["category_code"] for x in t[g["id"]]] == ["HEALTH_SAFETY"] for g in hs26)


def test_answer_key_reflects_the_fixes(answer_key):
    rows = defaultdict(list)
    for r in answer_key:
        rows[r["plant_id"]].append(r)
    assert rows["P10"][0]["expected_category_code"] == "RELEVANT" and "D5.1.1.h.c.A" in rows["P10"][0]["note"]
    assert {r["expected_category_code"] for r in rows["P42"]} == {"RELEVANT"} and len(rows["P42"]) == 15
    assert {r["expected_category_code"] for r in rows["P45"]} == {"RELEVANT"} and len(rows["P45"]) >= 33
    assert rows["P07"][0]["error_class"] == "bonus_above_exclusion_limit"
    for pid, n_lines in (("P43", 3), ("P44", 2)):
        gl_rows = [r for r in rows[pid] if r["source"] == "gl_line"]
        bl_rows = [r for r in rows[pid] if r["source"] == "bill_line"]
        assert gl_rows and len(bl_rows) == n_lines * len(gl_rows) and all(r["expected_category_code"] == "" for r in gl_rows)
