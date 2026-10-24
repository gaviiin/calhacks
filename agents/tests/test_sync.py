from agents import reducers as R
from agents.sync import Sync, fx_rate_e6, golden_gl_line


def _world_gl(id="gl-000123", **kw):
    r = {"id": id, "posted_date": "2026-01-15", "period_key": "2026-01", "account_id": "acct-6410",
         "department_id": "dept-AERO", "vendor_id": "ven-017", "bill_id": "bill-00042", "amount_minor": 720000,
         "currency": "GBP", "fx_rate_to_usd": 1.27, "amount_usd_minor": 914400, "memo": "Canteen January",
         "erp_category_code": "MARKETING", "entity": "RACING", "correction_of": None,
         "visible_at": "2026-01-16", "updated_at": "2026-01-16"}
    r.update(kw)
    return r


def _seed(world):
    world.emit("account", {"id": "acct-6410", "code": "6410", "name": "Catering & canteen",
                           "default_category_code": "CATERING", "kind": "expense"})
    world.emit("vendor", {"id": "ven-017", "name": "Grove Catering", "country": "GB", "related_party": False,
                          "related_party_entity": None, "bank_iban": "GB11AAAA", "category_hint": None})
    world.emit("fair_value", {"id": "fv-005", "counterparty_vendor_id": "ven-017", "item": "x",
                              "contract_value_minor": 1, "fair_value_minor": 2, "currency": "GBP",
                              "effective_from": "2026-01-01", "basis": "b"})
    world.emit("bill", {"id": "bill-00042", "vendor_id": "ven-017", "bill_date": "2026-01-10", "due_date": "2026-02-10",
                        "total_minor": 720000, "currency": "GBP", "bank_iban_on_bill": "GB11AAAA",
                        "text": "GROVE CATERING INVOICE 42"})
    world.emit("bill_line", {"id": "bl-00042-1", "bill_id": "bill-00042", "gl_line_id": "gl-000123", "line_no": 1,
                             "description": "Canteen", "amount_minor": 720000})
    return world.emit("gl_line", _world_gl())


def _sync(world, stdb, actors, tmp_path):
    return Sync(world.client(), stdb, actors["sync"], cursors_path=tmp_path / "cursors.json",
                cache_path=tmp_path / "cache.json", dead_letter_path=tmp_path / "dead.jsonl",
                issues_path=tmp_path / "rulebook_issues.json", page_size=2)


def test_conversions():
    assert fx_rate_e6(1.27) == 1_270_000
    assert fx_rate_e6("0.8571425") == 857_143  # half up
    assert fx_rate_e6(1) == 1_000_000
    g = golden_gl_line(_world_gl(amount_usd_minor=None), 17, "6410")
    assert g["amount_usd_minor"] == 914400 and g["raw_ref"] == "gl_line:gl-000123:17"


def test_first_sync_builds_golden_rows(world, stdb, actors, tmp_path):
    gl_cursor = _seed(world)
    stats = _sync(world, stdb, actors, tmp_path).run_once()
    assert stats["gl_line"] == {"records": 1, "calls": 1, "cursor": gl_cursor}
    names = [c[1] for c in stdb.calls]
    assert names == [R.UPSERT_VENDOR, R.UPSERT_FAIR_VALUE, R.UPSERT_BILL_LINE, R.UPSERT_GL_LINE]
    assert all(c[0] == actors["sync"].token for c in stdb.calls)
    (gl_row,) = stdb.tables["gl_line"]
    assert gl_row["account_code"] == "6410" and gl_row["fx_rate_e6"] == 1_270_000
    assert gl_row["raw_ref"] == f"gl_line:gl-000123:{gl_cursor}"
    (bl,) = stdb.tables["bill_line"]
    assert bl["bill_text"] == "GROVE CATERING INVOICE 42" and bl["vendor_id"] == "ven-017"
    assert bl["bank_iban_on_bill"] == "GB11AAAA"
    assert stdb.tables["vendor"][0]["raw_ref"].startswith("vendor:ven-017:")
    assert len(stdb.tables["work_item"]) == 1  # created by the (fake) module on first sight


def test_rerun_with_same_cursor_file_does_nothing(world, stdb, actors, tmp_path):
    _seed(world)
    _sync(world, stdb, actors, tmp_path).run_once()
    n = len(stdb.calls)
    stats = _sync(world, stdb, actors, tmp_path).run_once()  # fresh process, same cursor file
    assert len(stdb.calls) == n
    assert all(s["records"] == 0 for s in stats.values())


def test_only_new_changes_are_sent_and_corrections_upsert(world, stdb, actors, tmp_path):
    _seed(world)
    _sync(world, stdb, actors, tmp_path).run_once()
    n = len(stdb.calls)
    c = world.emit("gl_line", _world_gl(memo="Canteen January (corrected)", amount_minor=700000,
                                        amount_usd_minor=889000))
    _sync(world, stdb, actors, tmp_path).run_once()
    new = stdb.calls[n:]
    assert [x[1] for x in new] == [R.UPSERT_GL_LINE]
    assert new[0][2][1] == f"gl_line:gl-000123:{c}"
    assert len(stdb.tables["gl_line"]) == 1 and stdb.tables["gl_line"][0]["amount_minor"] == 700000
    assert len(stdb.tables["work_item"]) == 1  # an upsert, not a new item


def test_changed_bank_details_on_bill_reupsert_its_lines(world, stdb, actors, tmp_path):
    _seed(world)
    _sync(world, stdb, actors, tmp_path).run_once()
    n = len(stdb.calls)
    world.emit("bill", {"id": "bill-00042", "vendor_id": "ven-017", "bill_date": "2026-01-10", "due_date": "2026-02-10",
                        "total_minor": 720000, "currency": "GBP", "bank_iban_on_bill": "GB99FRAUD",
                        "text": "GROVE CATERING INVOICE 42 - new bank details"})
    _sync(world, stdb, actors, tmp_path).run_once()
    assert [x[1] for x in stdb.calls[n:]] == [R.UPSERT_BILL_LINE]
    assert stdb.tables["bill_line"][0]["bank_iban_on_bill"] == "GB99FRAUD"


def test_bill_line_before_bill_fetches_record(world, stdb, actors, tmp_path):
    world.emit("bill_line", {"id": "bl-7-1", "bill_id": "bill-7", "gl_line_id": None, "line_no": 1,
                             "description": "x", "amount_minor": 5})
    world.streams["bill"].append({"cursor": 999, "op": "upsert", "record": {
        "id": "bill-7", "vendor_id": "ven-1", "bank_iban_on_bill": "GB1", "text": "late bill"}})
    # bill change cursor 999 is not yet processed when bill_line is applied in the same pass? bills come first;
    # but a fresh cache with an unseen bill falls back to /records/bill/{id}
    s = _sync(world, stdb, actors, tmp_path)
    s.cursors["bill"] = 999  # pretend bills were synced elsewhere
    s.run_once()
    assert stdb.tables["bill_line"][0]["bill_text"] == "late bill"
