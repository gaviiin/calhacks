"""Plant P15 (recharge keyed at a tenth of its value): the analyst's related-party check never fires."""
import json
from agents.cap_analyst import related_party_check
from agents.gateway import fair_value_uplift
fvs = {}
for l in open("world/out/fair_value.jsonl"):
    r = json.loads(l); fvs[r["id"]] = r          # upsert: latest version wins, as in the module
gl = next(json.loads(l) for l in open("world/out/gl_line.jsonl") if json.loads(l)["id"] == "gl-001696")
gl = dict(gl, fx_rate_e6=round(gl["fx_rate_to_usd"] * 1_000_000))
ven = next(json.loads(l) for l in open("world/out/vendor.jsonl") if json.loads(l)["id"] == "ven-003")
rp = related_party_check(gl, ven, list(fvs.values()))
print("gl-001696", gl["amount_minor"], gl["currency"], "usd", gl["amount_usd_minor"], "| vendor related_party:", ven["related_party"])
print("fv-002 now: contract", fvs["fv-002"]["contract_value_minor"], "fair", fvs["fv-002"]["fair_value_minor"])
print("analyst related_party_check.applies:", rp.applies, "-> goes to the ordinary policy path at invoiced value")
print("what the gateway would add if it were ever proposed as ADJ_RP: uplift USD minor", fair_value_uplift(gl, fvs["fv-002"]))
