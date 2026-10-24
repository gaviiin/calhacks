"""Gateway: stale ledger, fair value uplift arithmetic, currency mismatch, reversal pairs."""
import json, tempfile
from pathlib import Path
from agents.gateway import Gateway, classification_lines, build_journal_entry, fair_value_uplift
from agents.tests.fakes import FakeStdb, FakeWorld
from agents.tests.conftest import gl

TMP = Path(tempfile.mkdtemp(dir="/private/tmp/claude-501/-Users-gavinzhou-Desktop-calhacks/c875d98c-7a47-427a-9e39-fe74fb7781b5/scratchpad/review-redteam"))

def capcat(lines, acct):
    return sum(l["debit_minor"] - l["credit_minor"] for l in lines if l["account_id"] == acct)

print("== a. ledger file survives `make stdb-publish` (--delete-data): new item 1 reuses the old ERP id, nothing posted")
real = json.loads(Path("agents/state/gateway_posted.json").read_text())
ledger = TMP / "gateway_posted.json"; ledger.write_text(json.dumps({"1": real["1"]}))
s, w = FakeStdb(), FakeWorld()
gwa = s.actor("gateway", "gateway")
s.tables["gl_line"].append(gl(id="gl-000500", account_code="6010", amount_usd_minor=9_999_900, memo="new world line"))
s.add_item(subject_ref="gl-000500", period_key="2026-01", amount_usd_minor=9_999_900, state="APPROVED",
           proposed_category_code="RELEVANT", proposed_rulebook_entry_id="RELEVANT@SECD-ISS07", evidence_refs='["gl-000500"]')
res = Gateway(w.client(), s, gwa, "test-gateway-key", ledger_path=ledger).run_once()
print("  ", res, "| ERP posts made:", w.post_count, "| old entry lines:", real["1"]["lines"][0])

print("== b. ADJ_RELATED_PARTY_FAIR_VALUE uplift on a credit note and on a split line")
fv = {"id": "fv-005", "fair_value_minor": 10_000_000, "contract_value_minor": 1_000_000, "currency": "GBP"}
credit = gl(amount_usd_minor=-1_270_000, amount_minor=-1_000_000, currency="GBP", fx_rate_e6=1_270_000)
print("   credit note -GBP10,000, FV GBP100,000 -> uplift USD minor:", fair_value_uplift(credit, fv),
      "| capcat-ADJ_RP:", capcat(classification_lines("ADJ_RELATED_PARTY_FAIR_VALUE", credit, fv), "capcat-ADJ_RELATED_PARTY_FAIR_VALUE"))
half = gl(amount_usd_minor=635_000, amount_minor=500_000, currency="GBP", fx_rate_e6=1_270_000)
print("   one GBP10,000 recharge (FV GBP100,000) as one line -> uplift", fair_value_uplift(gl(amount_usd_minor=1_270_000,
      amount_minor=1_000_000, currency="GBP", fx_rate_e6=1_270_000), fv), "| as two GBP5,000 lines ->", 2 * fair_value_uplift(half, fv))

print("== c. fair value in another currency: error every run, item stays APPROVED, nothing in the system of work")
s, w = FakeStdb(), FakeWorld()
gwa = s.actor("gateway", "gateway")
s.tables["gl_line"].append(gl(id="gl-000700", currency="GBP", amount_minor=1_000_000, fx_rate_e6=1_270_000, amount_usd_minor=1_270_000))
s.tables["fair_value"].append({"id": "fv-009", "counterparty_vendor_id": "ven-001", "item": "x", "contract_value_minor": 1,
                               "fair_value_minor": 2_000_000, "currency": "EUR", "effective_from": "2026-01-01", "basis": "b"})
s.add_item(subject_ref="gl-000700", period_key="2026-01", amount_usd_minor=1_270_000, state="APPROVED",
           proposed_category_code="ADJ_RELATED_PARTY_FAIR_VALUE",
           proposed_rulebook_entry_id="ADJ_RELATED_PARTY_FAIR_VALUE@SECD-ISS07", evidence_refs='["gl-000700","fv-009"]')
g = Gateway(w.client(), s, gwa, "test-gateway-key", ledger_path=TMP / "l2.json")
for run in (1, 2, 3):
    r = g.run_once()[0]
    print(f"   run {run}: {r['status']} {r['note'][:70]} | state {s.item(1)['state']} | audit rows {len(s.tables['audit_log'])}")

print("== d. world reversal/repost pair after the original posted: what the gateway books")
orig = {"id": 1, "kind": "classification", "proposed_category_code": "RELEVANT", "amount_usd_minor": 3_109_376, "erp_entry_id": "JE-1"}
og = gl(id="gl-001340", account_code="6020", amount_usd_minor=3_109_376)
orig_lines = classification_lines("RELEVANT", og)
total = capcat(orig_lines, "capcat-RELEVANT")
for wid, amt in ((2, -3_109_376), (3, 3_109_376)):
    corr = gl(id=f"gl-c{wid}", account_code="6020", amount_usd_minor=amt)
    item = {"id": wid, "kind": "reversal", "subject_ref": "1", "proposed_category_code": "RELEVANT", "amount_usd_minor": amt,
            "period_key": "2026-06", "evidence_refs": json.dumps([corr["id"]])}
    je = build_journal_entry(item, corr, original=orig, original_gl=og, original_lines=orig_lines)
    total += capcat(je["lines"], "capcat-RELEVANT")
print("   ERP capcat-RELEVANT after original + both pair entries:", total, "(should be 3,109,376)")
