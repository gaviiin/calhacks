"""Analyst: late line in a locked period is re-proposed (and denied) every run; --loop serves stale gl lines."""
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
                                 pattern={"vendor_id": "ven-011", "account_code": "6020"}))
it = seed_line(s, gl(id="gl-P25", vendor_id="ven-011", account_code="6020", amount_usd_minor=5_372_100,
                     memo="PO-26-40118 - upright machining (invoice received late)"), vendor(id="ven-011"))
s.tables["period"].append({"key": "2026-01", "locked": True})
an = CapAnalyst(t, offline=True)
for run in (1, 2, 3):
    [d] = an.run_once()
    print(f"run {run}: {d.action} {d.path} {d.category_code} applied={d.result.get('ok')} state={s.item(it['id'])['state']} "
          f"denied audit rows={sum(1 for a in s.tables['audit_log'] if not a['allowed'])}")

print("-- --loop keeps one AgentTools: gl lines are cached for the life of the process")
line = s.tables["gl_line"][0]
t.gl_line("gl-P25")
line["memo"] = "CORRECTED: sponsor hospitality"; line["account_code"] = "6420"
print("   golden row now:", line["memo"], "| analyst sees:", t.read_item(it["id"])["gl_line"]["memo"])
