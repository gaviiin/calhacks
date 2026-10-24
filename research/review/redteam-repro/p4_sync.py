"""Sync: one malformed record wedges every later source; deletes are ignored."""
import tempfile
from pathlib import Path
from agents.sync import Sync
from agents.tests.fakes import FakeStdb, FakeWorld

TMP = Path(tempfile.mkdtemp(dir="/private/tmp/claude-501/-Users-gavinzhou-Desktop-calhacks/c875d98c-7a47-427a-9e39-fe74fb7781b5/scratchpad/review-redteam"))
s, w = FakeStdb(), FakeWorld()
sync_actor = s.actor("sync", "sync")
w.emit("account", {"id": "acct-6010", "code": "6010", "name": "Materials"})
w.emit("fair_value", {"id": "fv-001", "counterparty_vendor_id": "ven-009", "item": "recharge", "contract_value_minor": 1,
                      "fair_value_minor": 2, "effective_from": "2026-01-01"})          # no 'currency' key
for k in range(1, 4):
    w.emit("gl_line", {"id": f"gl-00000{k}", "posted_date": "2026-01-05", "period_key": "2026-01", "account_id": "acct-6010",
                       "department_id": "dept-MFG", "vendor_id": "ven-001", "bill_id": None, "amount_minor": 1000 * k,
                       "currency": "GBP", "fx_rate_to_usd": 1.27, "amount_usd_minor": 1270 * k, "memo": "m"})
w.streams["gl_line"].append({"cursor": 99, "op": "delete", "record": {"id": "gl-000001"}})
sy = Sync(w.client(), s, sync_actor, cursors_path=TMP / "c.json", cache_path=TMP / "k.json")
for run in (1, 2):
    try:
        print("run", run, sy.run_once())
    except Exception as e:
        print(f"run {run}: {type(e).__name__}: {e} | cursors {sy.cursors} | gl lines synced: {len(s.tables['gl_line'])}")
# without the poison record: the delete op is skipped and the deleted line stays a live work item
s2, w2 = FakeStdb(), FakeWorld(); a2 = s2.actor("sync", "sync")
w2.emit("account", {"id": "acct-6010", "code": "6010"})
w2.emit("gl_line", {"id": "gl-000001", "posted_date": "2026-01-05", "period_key": "2026-01", "account_id": "acct-6010",
                    "amount_minor": 1000, "currency": "GBP", "fx_rate_to_usd": 1.27, "amount_usd_minor": 1270, "memo": "m"})
w2.streams["gl_line"].append({"cursor": 99, "op": "delete", "record": {"id": "gl-000001"}})
Sync(w2.client(), s2, a2, cursors_path=TMP / "c2.json", cache_path=TMP / "k2.json").run_once()
print("after delete op: work items", [(i["subject_ref"], i["state"]) for i in s2.tables["work_item"]])
