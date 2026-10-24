"""SCHEMA §10 "Pre-checks" (red team H5): duplicate, changed bank details, lookalike vendor, split
invoice. Shapes follow world/PATTERNS.md plants P21-P24 and P36. Every hit is a question."""

from agents import reducers as R
from agents.cap_analyst import CapAnalyst, fold_name, prechecks

from .conftest import gl, policy, seed_line, vendor


def _bill(id, gl_id, iban, bill_id="bill-1", amount=18_500_000, text="INVOICE"):
    return {"id": id, "bill_id": bill_id, "gl_line_id": gl_id, "line_no": 1, "description": "Upright machining",
            "amount_minor": amount, "bill_text": text, "vendor_id": "ven-011", "bank_iban_on_bill": iban}


def _policy(stdb):
    stdb.tables["policy"].append(policy(id=1, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                        pattern={"account_code": "6020"}))


def test_duplicate_invoice_is_held_not_proposed(stdb, analyst_tools):
    """P21: the same invoice synced twice (same vendor, amount, 30-day window)."""
    _policy(stdb)
    stdb.tables["gl_line"].append(gl(id="gl-000100", vendor_id="ven-011", account_code="6020", amount_minor=18_500_000,
                                     amount_usd_minor=23_495_000, posted_date="2026-02-03", period_key="2026-02",
                                     memo="INV-7781 upright machining"))
    stdb.add_item(subject_ref="gl-000100", period_key="2026-02", amount_usd_minor=23_495_000, state="POSTED")
    item = seed_line(stdb, gl(id="gl-000101", vendor_id="ven-011", account_code="6020", amount_minor=18_500_000,
                              amount_usd_minor=23_495_000, posted_date="2026-02-20", period_key="2026-02",
                              memo="INV-7781 upright machining (copy)"), vendor(id="ven-011", name="Oxon Machining Ltd"))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and d.path == "precheck"
    assert "duplicate" in d.question and "gl-000100" in d.question and "18,500,000 USD" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO" and not stdb.reducer_calls(R.PROPOSE)


def test_same_amount_outside_the_window_or_other_vendor_is_not_a_duplicate(stdb, analyst_tools):
    _policy(stdb)
    stdb.tables["gl_line"] += [
        gl(id="gl-000100", vendor_id="ven-011", account_code="6020", amount_usd_minor=23_495_000, posted_date="2025-12-01"),
        gl(id="gl-000102", vendor_id="ven-012", account_code="6020", amount_usd_minor=23_495_000, posted_date="2026-02-10"),
    ]
    seed_line(stdb, gl(id="gl-000101", vendor_id="ven-011", account_code="6020", amount_usd_minor=23_495_000,
                       posted_date="2026-02-20", period_key="2026-02"), vendor(id="ven-011", name="Oxon Machining Ltd"))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose"


def test_correction_pairs_are_not_duplicates(stdb, analyst_tools):
    """A -A reversal plus a +A repost of a line carry correction_of; they are not duplicates of it."""
    _policy(stdb)
    stdb.tables["gl_line"] += [
        gl(id="gl-000100", vendor_id="ven-011", account_code="6020", amount_usd_minor=3_109_376, posted_date="2026-05-10"),
        gl(id="gl-000100-r", vendor_id="ven-011", account_code="6020", amount_usd_minor=-3_109_376,
           posted_date="2026-06-02", correction_of="gl-000100", memo="Reversal of gl-000100"),
    ]
    seed_line(stdb, gl(id="gl-000100-p", vendor_id="ven-011", account_code="6020", amount_usd_minor=3_109_376,
                       posted_date="2026-06-02", period_key="2026-06", correction_of="gl-000100"),
              vendor(id="ven-011", name="Oxon Machining Ltd"))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose"


def test_changed_bank_details_on_the_bill_are_held(stdb, analyst_tools):
    """P24 / P36: bank_iban_on_bill differs from the vendor master."""
    _policy(stdb)
    item = seed_line(stdb, gl(id="gl-000200", vendor_id="ven-011", account_code="6020", bill_id="bill-1"),
                     vendor(id="ven-011", name="Oxon Machining Ltd", bank_iban="GB29 NWBK 6016 1331 9268 19"),
                     [_bill("bl-1-1", "gl-000200", "LT12 1000 0111 0100 1000",
                            text="Please note our new bank details effective immediately.")])
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and "bank details" in d.question and "LT121000011101001000" in d.question
    assert "GB29NWBK60161331926819" in d.question and stdb.item(item["id"])["state"] == "NEEDS_INFO"


def test_same_iban_with_different_spacing_is_fine(stdb, analyst_tools):
    _policy(stdb)
    seed_line(stdb, gl(id="gl-000200", vendor_id="ven-011", account_code="6020", bill_id="bill-1"),
              vendor(id="ven-011", name="Oxon Machining Ltd", bank_iban="GB29 NWBK 6016 1331 9268 19"),
              [_bill("bl-1-1", "gl-000200", "gb29nwbk60161331926819")])
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose"


def test_lookalike_vendor_is_held(stdb, analyst_tools):
    """A Cyrillic lookalike of an existing vendor's name under a new id."""
    _policy(stdb)
    stdb.tables["vendor"].append(vendor(id="ven-011", name="Oxon Machining Ltd"))
    fake_name = "Oxоn Mаchining Ltd"  # Cyrillic о and а
    item = seed_line(stdb, gl(id="gl-000300", vendor_id="ven-911", account_code="6020"), vendor(id="ven-911", name=fake_name))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and "same normalised name" in d.question and "ven-011" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"


def test_fold_name_covers_cyrillic_greek_fullwidth_and_punctuation():
    assert fold_name("Oxоn Mаchining Ltd") == fold_name("Oxon Machining Ltd") == "oxonmachiningltd"
    assert fold_name("Αεrο Supplies") == fold_name("Aero Supplies")  # Greek Α ε ο
    assert fold_name("Ｇrove Catering") == fold_name("Grove Catering")  # fullwidth G
    assert fold_name("Grove Catering, Ltd.") == fold_name("Grove Catering Ltd")
    assert fold_name("Café Olé") == fold_name("Cafe Ole")
    assert fold_name("Grove Catering") != fold_name("Grove Caterers")


def test_split_invoice_under_materiality_is_held(stdb, analyst_tools):
    """P23: one order as three same-day invoices of ~$234,950 each (materiality $250,000)."""
    _policy(stdb)
    ven = vendor(id="ven-011", name="Oxon Machining Ltd")
    for k in (1, 2):
        stdb.tables["gl_line"].append(gl(id=f"gl-00040{k}", vendor_id="ven-011", account_code="6020",
                                         amount_usd_minor=23_495_000, posted_date="2026-02-03", period_key="2026-02"))
    item = seed_line(stdb, gl(id="gl-000403", vendor_id="ven-011", account_code="6020", amount_usd_minor=23_495_000,
                              posted_date="2026-02-03", period_key="2026-02"), ven)
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "ask" and "possible split" in d.question and "3 lines" in d.question and "$704,850.00" in d.question
    assert stdb.item(item["id"])["state"] == "NEEDS_INFO"


def test_two_small_same_day_lines_below_materiality_pass(stdb, analyst_tools):
    _policy(stdb)
    stdb.tables["gl_line"].append(gl(id="gl-000401", vendor_id="ven-011", account_code="6020", amount_usd_minor=100_000,
                                     posted_date="2026-02-03"))
    seed_line(stdb, gl(id="gl-000403", vendor_id="ven-011", account_code="6020", amount_usd_minor=200_000,
                       posted_date="2026-02-03", period_key="2026-02"), vendor(id="ven-011", name="Oxon Machining Ltd"))
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose"


def test_prechecks_are_skipped_once_a_human_has_answered(stdb, analyst_tools):
    """The question named the hit; an answer must not loop back into the same question."""
    _policy(stdb)
    stdb.tables["gl_line"].append(gl(id="gl-000100", vendor_id="ven-011", account_code="6020", amount_usd_minor=23_495_000,
                                     posted_date="2026-02-03"))
    item = seed_line(stdb, gl(id="gl-000101", vendor_id="ven-011", account_code="6020", amount_usd_minor=23_495_000,
                              posted_date="2026-02-20", period_key="2026-02"), vendor(id="ven-011", name="Oxon Machining Ltd"))
    item.update(answer="Genuine: two separate uprights, both delivered. RELEVANT.")
    [d] = CapAnalyst(analyst_tools, offline=True).run_once()
    assert d.action == "propose" and d.path == "answer" and d.category_code == "RELEVANT"


def test_prechecks_function_reports_every_hit(stdb, analyst_tools):
    stdb.tables["vendor"] += [vendor(id="ven-011", name="Oxon Machining Ltd", bank_iban="GB1"),
                              vendor(id="ven-912", name="OXON MACHINING LTD")]
    line = gl(id="gl-000500", vendor_id="ven-011", account_code="6020", amount_usd_minor=20_000_000, posted_date="2026-02-03")
    stdb.tables["gl_line"] += [line, gl(id="gl-000501", vendor_id="ven-011", account_code="6020", amount_usd_minor=20_000_000,
                                        posted_date="2026-02-03")]
    hits = prechecks(analyst_tools, line, stdb.tables["vendor"][0], [_bill("bl-5-1", "gl-000500", "DE99")], 25_000_000)
    assert [h.kind for h in hits] == ["duplicate", "bank_details_changed", "lookalike_vendor", "split_invoice"]
    assert all(h.refs for h in hits)
