"""Items that stay NEW (denied or skipped) hold the head of the queue forever; newer items are never reached."""
import json
from agents import config
from agents.cap_analyst import CapAnalyst
from agents.tools import AgentTools
from agents.tests.fakes import FakeStdb
from agents.tests.conftest import gl, vendor, policy, seed_line

RB = json.loads(config.RULEBOOK_PATH.read_text()); RB = RB["entries"] if isinstance(RB, dict) else RB
s = FakeStdb(); s.tables["rulebook_entry"] = [dict(e) for e in RB]
t = AgentTools(s.actor("cap_analyst", "ai_cap_analyst"), s)
s.tables["policy"].append(policy(id=1, category_code="RELEVANT", rulebook_entry_id="RELEVANT@SECD-ISS07",
                                 pattern={"account_code": "6020"}))
s.tables["period"].append({"key": "2026-01", "locked": True})
for k in range(3):   # three late January invoices (P25-style) after January is locked
    seed_line(s, gl(id=f"gl-late-{k}", account_code="6020", period_key="2026-01"), vendor(id=f"ven-{k}"))
fresh = seed_line(s, gl(id="gl-feb-1", account_code="6020", period_key="2026-02", posted_date="2026-02-03"), vendor(id="ven-9"))
an = CapAnalyst(t, offline=True)
for run in range(1, 4):
    ds = an.run_once(limit=3)
    print(f"run {run}: processed {[d.work_item_id for d in ds]} | fresh item {fresh['id']} state {s.item(fresh['id'])['state']}")
