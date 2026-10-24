"""Generator output: determinism, SCHEMA shapes, ids, money, time, scale, patterns, answer key."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import pytest

from world import generate, patterns, plants
from world import company as C

REPO = Path(__file__).resolve().parents[2]
COMMON = {"id", "source", "visible_at", "updated_at"}
GL_FIELDS = {"posted_date", "period_key", "account_id", "department_id", "vendor_id", "bill_id", "amount_minor", "currency",
             "fx_rate_to_usd", "amount_usd_minor", "memo", "erp_category_code", "entity", "correction_of"}
FIELDS = {  # SCHEMA.md section 5, literally
    "account": {"code", "name", "default_category_code", "kind"},
    "department": {"name", "head", "f1_activity_share"},
    "vendor": {"name", "country", "related_party", "related_party_entity", "bank_iban", "category_hint"},
    "gl_line": GL_FIELDS,
    "bill": {"vendor_id", "bill_date", "due_date", "total_minor", "currency", "bank_iban_on_bill", "text"},
    "bill_line": {"bill_id", "gl_line_id", "line_no", "description", "amount_minor"},
    "contract": {"counterparty_vendor_id", "kind", "start", "end", "terms"},
    "fair_value": {"counterparty_vendor_id", "item", "contract_value_minor", "fair_value_minor", "currency", "effective_from", "basis"},
    "bank_txn": {"booked_date", "amount_minor", "currency", "counterparty", "memo", "matched_bill_id"},
    "history_2025_gl_line": GL_FIELDS,
    "history_2025_cap_classification": {"gl_line_id", "category_code", "rulebook_entry_id", "decided_by", "reason"},
    "history_2025_approval": {"gl_line_id", "amount_usd_minor", "escalated_to", "decision", "reason", "decided_on"},
    "rulebook_issue": {"published_on", "effective_from", "path"},
}
ID_FORMAT = {
    "account": r"acct-\d{4}", "department": r"dept-[A-Z]+", "vendor": r"ven-\d{3}", "gl_line": r"gl-\d{6}", "bill": r"bill-\d{5}",
    "bill_line": r"bl-\d{5}-\d+", "contract": r"ctr-\d{3}", "fair_value": r"fv-\d{3}", "bank_txn": r"bank-\d{6}",
    "history_2025_gl_line": r"gl-2025-\d{5}", "history_2025_cap_classification": r"h25c-\d{5}(-nf1)?",
    "history_2025_approval": r"h25a-\d{5}", "rulebook_issue": r"ISS22|SECD-ISS07",
}
RE_EMITTED_SOURCES = {"gl_line", "fair_value"}


def rulebook() -> list[dict]:
    p = REPO / "rulebook" / "rulebook.json"
    if not p.exists():
        pytest.skip("rulebook/rulebook.json not built")
    return json.loads(p.read_text())


# ---- determinism --------------------------------------------------------------------------------
def test_same_seed_is_byte_identical(out_dir, tmp_path):
    again = tmp_path / "again"
    generate.main(["--seed", "7", "--out", str(again), "--quiet"])
    files = sorted(p.name for p in out_dir.iterdir())
    assert files == sorted(p.name for p in again.iterdir())
    assert len(files) == len(generate.SOURCES) + 2
    for name in files:
        assert (out_dir / name).read_bytes() == (again / name).read_bytes(), name


def test_different_seed_differs(out_dir, tmp_path):
    other = tmp_path / "seed8"
    generate.main(["--seed", "8", "--out", str(other), "--quiet"])
    assert (out_dir / "gl_line.jsonl").read_bytes() != (other / "gl_line.jsonl").read_bytes()
    assert (out_dir / "account.jsonl").read_bytes() == (other / "account.jsonl").read_bytes()  # reference data is static


def test_no_global_random_or_clock():
    src = "".join((REPO / "world" / f).read_text() for f in ("generate.py", "plants.py", "company.py"))
    assert not re.search(r"\brandom\.(random|randint|choice|choices|uniform|shuffle|seed|gauss)\(", src)
    for bad in ("datetime.now", "date.today", "time.time(", "utcnow"):
        assert bad not in src


# ---- shapes -------------------------------------------------------------------------------------
def test_every_record_matches_schema_fields(recs):
    for src, rows in recs.items():
        assert rows, src
        for r in rows:
            assert set(r) == FIELDS[src] | COMMON, (src, r["id"], set(r) ^ (FIELDS[src] | COMMON))
            assert r["source"] == src


def test_id_formats(recs):
    for src, rows in recs.items():
        rx = re.compile(ID_FORMAT[src] + r"$")
        bad = [r["id"] for r in rows if not rx.match(r["id"])]
        assert not bad, (src, bad[:5])


def test_ids_unique_except_re_emissions(recs):
    for src, rows in recs.items():
        counts = Counter(r["id"] for r in rows)
        dupes = {k for k, v in counts.items() if v > 1}
        if src not in RE_EMITTED_SOURCES:
            assert not dupes, (src, sorted(dupes)[:5])
            continue
        assert dupes, f"{src} should contain deliberate re-emissions"
        for rid in dupes:
            versions = [r for r in rows if r["id"] == rid]
            stamps = [v["updated_at"] for v in versions]
            assert stamps == sorted(stamps) and len(set(stamps)) == len(stamps), (src, rid, stamps)
            assert [v["visible_at"] for v in versions] == stamps
            assert any(versions[i] != versions[i + 1] for i in range(len(versions) - 1))


def test_dates_and_enums(recs):
    iso = re.compile(r"^\d{4}-\d{2}-\d{2}$")
    for src, rows in recs.items():
        for r in rows:
            assert iso.match(r["visible_at"]) and iso.match(r["updated_at"])
    for src in ("gl_line", "history_2025_gl_line"):
        for r in recs[src]:
            assert r["entity"] in ("RACING", "TECHNOLOGY")
            assert r["currency"] in ("GBP", "EUR", "USD")
            assert r["period_key"] == r["posted_date"][:7]
    assert {r["kind"] for r in recs["contract"]} <= {"PU_SUPPLY", "RECHARGE", "SPONSORSHIP", "FREIGHT"}
    assert {r["decided_by"] for r in recs["history_2025_cap_classification"]} == {"analyst", "head_of_cost_cap"}
    assert {r["escalated_to"] for r in recs["history_2025_approval"]} == {None, "head_of_cost_cap"}
    assert {r["decision"] for r in recs["history_2025_approval"]} == {"approved", "rejected"}


# ---- money --------------------------------------------------------------------------------------
def test_money_is_integer_minor_units_with_usd(recs):
    seen = Counter()
    for src in ("gl_line", "history_2025_gl_line"):
        for r in recs[src]:
            assert isinstance(r["amount_minor"], int) and isinstance(r["amount_usd_minor"], int)
            assert r["fx_rate_to_usd"] == C.fx_rate(r["currency"], r["period_key"])
            assert r["amount_usd_minor"] == generate.to_usd(r["amount_minor"], r["fx_rate_to_usd"])
            seen[r["currency"]] += 1
    assert seen["GBP"] > seen["EUR"] > 50 and seen["USD"] > 50


def test_bills_tie_to_lines_and_ledger(recs, latest):
    gl = latest["gl_line"]
    lines_by_bill = defaultdict(list)
    for bl in recs["bill_line"]:
        lines_by_bill[bl["bill_id"]].append(bl)
        assert bl["gl_line_id"] in gl
    for b in recs["bill"]:
        bls = lines_by_bill[b["id"]]
        assert bls and sum(x["amount_minor"] for x in bls) == b["total_minor"]
        assert [x["line_no"] for x in sorted(bls, key=lambda x: x["line_no"])] == list(range(1, len(bls) + 1))
        assert b["vendor_id"] in latest["vendor"]
        assert b["bank_iban_on_bill"] in b["text"]
    for g in gl.values():
        if g["bill_id"]:
            assert g["bill_id"] in latest["bill"]
            assert latest["bill"][g["bill_id"]]["vendor_id"] == g["vendor_id"]
    for t in recs["bank_txn"]:
        if t["matched_bill_id"]:
            assert -t["amount_minor"] == latest["bill"][t["matched_bill_id"]]["total_minor"]


def test_ibans_are_valid_mod97(recs):
    for v in recs["vendor"]:
        iban = v["bank_iban"]
        num = "".join(str(int(ch, 36)) for ch in iban[4:] + iban[:4])
        assert int(num) % 97 == 1, v["id"]


# ---- time ---------------------------------------------------------------------------------------
def test_file_order_is_visibility_order(recs):
    for src, rows in recs.items():
        vis = [r["visible_at"] for r in rows]
        assert vis == sorted(vis), src


def test_reference_and_history_visible_from_start(recs):
    start = "2026-01-01"
    for src in ("account", "department", "vendor", "contract", "history_2025_gl_line", "history_2025_cap_classification",
                "history_2025_approval"):
        assert all(r["visible_at"] <= start for r in recs[src]), src
    first_fv = {}
    for r in recs["fair_value"]:
        first_fv.setdefault(r["id"], r)
    assert {k for k, r in first_fv.items() if r["visible_at"] <= start} == {"fv-001", "fv-002", "fv-003", "fv-004"}
    issues = {r["id"]: r for r in recs["rulebook_issue"]}
    assert issues["ISS22"]["visible_at"] <= start and issues["ISS22"]["effective_from"] == "2021-01-01"
    # known before the season (earlier issues); the text we carry is Issue 07 of 25 June 2026
    assert issues["SECD-ISS07"]["visible_at"] <= start and issues["SECD-ISS07"]["published_on"] == "2026-06-25"
    assert issues["SECD-ISS07"]["effective_from"] == "2026-01-01"


def test_2026_stream_window_late_postings_and_corrections(recs, latest):
    gl = recs["gl_line"]
    assert all("2026-01-01" <= r["posted_date"] <= "2026-11-30" for r in gl)
    assert all(r["visible_at"] >= r["posted_date"] for r in gl)
    lags = [(date.fromisoformat(r["visible_at"]) - date.fromisoformat(r["posted_date"])).days for r in gl]
    assert sum(1 for x in lags if x >= 10) >= 60  # late arrivals weeks after posted_date
    corr = [r for r in latest["gl_line"].values() if r["correction_of"]]
    assert len(corr) >= 10
    for r in corr:
        orig = latest["gl_line"][r["correction_of"]]
        assert orig["posted_date"] <= r["posted_date"]
    assert all(r["posted_date"][:4] == "2025" for r in recs["history_2025_gl_line"])


def test_season_shape(latest):
    gl = list(latest["gl_line"].values())
    mats = defaultdict(int)
    for r in gl:
        if r["account_id"] in ("acct-6010", "acct-6020", "acct-6030", "acct-6040"):
            mats[r["period_key"]] += r["amount_usd_minor"]
    assert mats["2026-02"] > mats["2026-01"] > mats["2026-04"]  # February build spike
    assert mats["2026-08"] < 0.25 * mats["2026-07"]  # summer shutdown
    shutdown = [r for r in gl if "2026-08-03" <= r["posted_date"] <= "2026-08-16" and r["account_id"] in
                ("acct-6010", "acct-6020", "acct-6030", "acct-6040", "acct-6410", "acct-6200", "acct-6720")]
    assert len(shutdown) <= 3
    crash = sum(r["amount_minor"] for r in gl if r["account_id"] == "acct-6050" and "Sao Paulo" in r["memo"])
    assert crash > 300_000_000  # > GBP 3m of crash damage after Brazil


def test_scale(latest, recs, truth):
    assert 2700 <= len(latest["gl_line"]) <= 3300
    assert 2700 <= len(recs["history_2025_gl_line"]) <= 3300
    assert 35 <= len(C.ACCOUNTS) <= 65 and 40 <= len(C.VENDORS) <= 55
    rel = sum(int(t["relevant_usd_minor"]) for t in truth)
    assert 18_000_000_000 < rel < C.CAP_2026_USD_MINOR  # Jan-Nov Relevant Costs near but under $215m
    assert {t["gl_line_id"] for t in truth} == set(latest["gl_line"])


# ---- 2025 patterns ------------------------------------------------------------------------------
def test_patterns_md_counts_match_generated_history(out_dir):
    assert patterns.md_block() == patterns.render_tables(out_dir).strip(), \
        "PATTERNS.md is stale: run uv run python -m world.patterns --out world/out --write"


def test_key_patterns_have_precedents(out_dir):
    gl, cls, apr = patterns.load_history(out_dir)
    rows = {r["key"]: r for r in patterns.pattern_counts(gl, cls)}
    assert rows["canteen"]["precedents"] >= 100 and 1 <= rows["canteen"]["exceptions"] <= 5
    assert rows["gp_air_hotel"]["precedents"] >= 100 and rows["gp_air_hotel"]["exceptions"] >= 5
    assert rows["non_gp_travel"]["precedents"] >= 50
    assert (rows["related_party_recharge"]["precedents"], rows["related_party_recharge"]["exceptions"]) == (10, 2)
    assert rows["marketing_agency"]["precedents"] >= 30 and rows["law_firm"]["precedents"] >= 30
    assert rows["wind_tunnel_catering"]["precedents"] >= 20 and rows["partner_hospitality"]["precedents"] >= 20
    assert rows["applied_payroll_split"]["precedents"] >= 40 and rows["pe_depreciation"]["precedents"] >= 48
    for r in rows.values():
        assert r["precedents"] + r["exceptions"] > 0, r["key"]
    esc = patterns.escalation_counts(gl, apr)
    assert esc["escalated_at_or_above_250k"] == esc["lines_at_or_above_250k"] > 100
    assert esc["rejected"] >= 15 and esc["rejected_escalated"] >= 2


def test_history_classifications_resolve_in_rulebook(recs):
    rb = {e["id"]: e for e in rulebook()}
    for c in recs["history_2025_cap_classification"]:
        e = rb.get(c["rulebook_entry_id"])
        assert e is not None and e["rule_version"] == "ISS22" and e["category_code"] == c["category_code"], c
    assert not {c["category_code"] for c in recs["history_2025_cap_classification"]} & {"FUEL", "CATERING", "HEALTH_SAFETY", "BCDR"}
    hist = {g["id"] for g in recs["history_2025_gl_line"]}
    assert {c["gl_line_id"] for c in recs["history_2025_cap_classification"]} == hist
    assert {a["gl_line_id"] for a in recs["history_2025_approval"]} == hist


def test_escalation_rule_and_rejections_have_reasons(recs):
    gl = {g["id"]: g for g in recs["history_2025_gl_line"]}
    for a in recs["history_2025_approval"]:
        assert a["amount_usd_minor"] == gl[a["gl_line_id"]]["amount_usd_minor"]
        if abs(a["amount_usd_minor"]) >= C.MATERIALITY_USD_MINOR:
            assert a["escalated_to"] == "head_of_cost_cap"
        if a["decision"] == "rejected":
            assert a["reason"].count("Rejected") == 1 and len(a["reason"]) > 60
    cls = defaultdict(set)
    for c in recs["history_2025_cap_classification"]:
        cls[c["gl_line_id"]].add(c["decided_by"])
    for a in recs["history_2025_approval"]:
        assert cls[a["gl_line_id"]] == {"head_of_cost_cap" if a["escalated_to"] else "analyst"}


def test_account_and_vendor_codes_exist_in_rulebook():
    codes = {e["category_code"] for e in rulebook() if e["rule_version"] == "SECD-ISS07"}
    for a in C.ACCOUNTS:
        assert a[2] in codes, a
    for v in C.VENDORS.values():
        assert v["category_hint"] is None or v["category_hint"] in codes, v["id"]


# ---- answer key ---------------------------------------------------------------------------------
def test_answer_key_rows_reference_existing_records(answer_key, latest):
    assert list(answer_key[0]) == ["plant_id", "source", "record_id", "error_class", "expected_action", "expected_category_code", "note"]
    for row in answer_key:
        assert row["record_id"] in latest[row["source"]], row
        assert row["error_class"] in plants.ERROR_CLASSES, row
        assert row["expected_action"] in plants.EXPECTED_ACTIONS, row
        assert row["note"]
    codes = {e["category_code"] for e in rulebook() if e["rule_version"] == "SECD-ISS07"}
    for row in answer_key:
        assert row["expected_category_code"] in codes | {""}, row


def test_answer_key_covers_the_plan(answer_key, truth):
    plant_ids = {r["plant_id"] for r in answer_key}
    assert 38 <= len(plant_ids) <= 45
    classes = {r["error_class"] for r in answer_key}
    red_bull = set(plants.ERROR_CLASSES[:12])
    assert red_bull <= classes
    for c in ("duplicate_invoice", "split_under_threshold", "bank_details_changed", "backdated_locked_period", "prior_year_catering_in_jan"):
        assert c in classes
    assert {r["expected_action"] for r in answer_key} == set(plants.EXPECTED_ACTIONS)
    truth_plants = {t["plant_id"] for t in truth if t["plant_id"]}
    assert truth_plants == plant_ids


def test_demo_record(recs, latest, answer_key):
    first = recs["gl_line"][0]
    assert first["id"] == "gl-000001" and first["visible_at"] == "2026-01-02"
    assert first["vendor_id"] == C.V_CANTEEN and first["erp_category_code"] == "MARKETING" and first["account_id"] == "acct-6420"
    bls = sorted((b for b in recs["bill_line"] if b["gl_line_id"] == "gl-000001"), key=lambda b: b["line_no"])
    assert [b["amount_minor"] for b in bls] == [1_438_000, 985_000, 720_000]
    assert sum(b["amount_minor"] for b in bls) == first["amount_minor"]
    rows = {r["record_id"]: r["expected_category_code"] for r in answer_key if r["plant_id"] == "P01"}
    assert rows == {"gl-000001": "", bls[0]["id"]: "CATERING", bls[1]["id"]: "MARKETING", bls[2]["id"]: "RELEVANT"}
    vendor_hist = [g for g in recs["history_2025_gl_line"] if g["vendor_id"] == C.V_CANTEEN]
    assert len(vendor_hist) >= 100  # the analyst can know this vendor before day one


def test_planted_bank_change_and_duplicates(answer_key, latest):
    by = defaultdict(list)
    for r in answer_key:
        by[r["error_class"]].append(r)
    for r in by["bank_details_changed"]:
        if r["source"] == "bill":
            b = latest["bill"][r["record_id"]]
            assert b["bank_iban_on_bill"] != latest["vendor"][b["vendor_id"]]["bank_iban"]
    for r in by["duplicate_invoice"]:
        g = latest["gl_line"][r["record_id"]]
        twins = [x for x in latest["gl_line"].values() if x["id"] != g["id"] and x["vendor_id"] == g["vendor_id"]
                 and x["amount_minor"] == g["amount_minor"] and x["memo"] == g["memo"]]
        assert twins
    usd = [latest["gl_line"][r["record_id"]]["amount_usd_minor"] for r in by["split_under_threshold"]]
    assert len(usd) == 3 and all(22_000_000 < u < C.MATERIALITY_USD_MINOR for u in usd)


def test_erp_coding_mostly_right_but_not_always(truth, latest):
    single = defaultdict(list)
    for t in truth:
        single[t["gl_line_id"]].append(t["category_code"])
    agree = total = 0
    for gid, cats in single.items():
        if len(cats) == 1:
            total += 1
            agree += latest["gl_line"][gid]["erp_category_code"] == cats[0]
    assert 0.90 < agree / total < 0.995
