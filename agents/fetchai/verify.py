"""How a sponsor's accounts-payable agent decides whether to pay a Meridian bonus invoice.

The sponsor does not take Meridian's word for it. It checks the claim against
its own copy of the contract and against the race result from a public source
(the Jolpica-F1 API; a cached copy of the same data when offline):

    1. the clause exists in the contract in force for that round, and covers that session
    2. the amount is exactly what the clause pays
    3. the car finished where the clause requires, in the final classification
    4. the invoice came after the result was final
    5. the same bonus has not been paid before

Pure functions, so the logic is tested without running any agent.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
JOLPICA = "https://api.jolpi.ca/ergast/f1"


@dataclass
class Verdict:
    pay: bool
    reasons: list[str] = field(default_factory=list)
    checks: dict[str, bool] = field(default_factory=dict)
    source: str = ""

    def summary(self) -> str:
        if self.pay:
            return f"Verified against {self.source}: " + "; ".join(self.reasons)
        return "Not paying: " + "; ".join(r for r in self.reasons if r)


def contracts(world_dir: Path = REPO / "world") -> dict:
    return {s["id"]: s for s in json.loads((Path(world_dir) / "sponsors.json").read_text())["sponsors"]}


def contract_for(sponsor: dict, rnd: int) -> dict:
    versions = [c for c in sponsor["contracts"] if c["effective_from_round"] <= rnd]
    return max(versions, key=lambda c: c["version"])


def _disqualified(r: dict) -> bool:
    return r.get("positionText") in ("D", "DSQ") or str(r.get("status", "")).lower().startswith("disqualified")


def result_row(season: int, rnd: int, session: str, car: int, http: httpx.Client | None = None,
               results_dir: Path = REPO / "world" / "results", offline: bool = False) -> tuple[dict | None, str]:
    """(row for that car with position, positionText, points, status; source) from Jolpica-F1, else the cached copy."""
    if not offline:
        try:
            path = f"{season}/{rnd}/{'sprint' if session == 'sprint' else 'results'}/"
            data = (http or httpx.Client(timeout=8)).get(f"{JOLPICA}/{path}", params={"limit": 100}).json()["MRData"]["RaceTable"]["Races"]
            if data:
                rows = data[0].get("SprintResults" if session == "sprint" else "Results", [])
                row = next((r for r in rows if int(r["number"]) == int(car)), None)
                if row:
                    return {"position": int(row["position"]), "positionText": row["positionText"], "points": float(row["points"]),
                            "status": row.get("status", ""), "constructor": row["Constructor"]["constructorId"]}, "Jolpica-F1 (public)"
        except (httpx.HTTPError, KeyError, ValueError, IndexError):
            pass
    path = Path(results_dir) / f"{season}.json"
    if not path.exists():
        return None, "no result source"
    for r in json.loads(path.read_text())["rounds"]:
        if int(r["round"]) == int(rnd):
            row = next((x for x in r.get(session, []) if int(x["number"]) == int(car)), None)
            if row:
                return {"position": int(row["position"]), "positionText": row["position_text"], "points": float(row["points"]),
                        "status": row.get("status", ""), "constructor": row["constructor_id"]}, "cached Jolpica-F1 results"
    return None, "cached Jolpica-F1 results"


def earned(clause: dict, row: dict) -> bool:
    if _disqualified(row) or not str(row.get("positionText", "")).isdigit():
        return False
    pos, t = row["position"], clause["type"]
    return ((t == "win" and pos == 1) or (t == "podium" and (pos in (2, 3) if clause.get("excludes_win") else pos <= 3))
            or (t == "points_finish" and row["points"] > 0) or (t == "top6" and pos <= 6))


def check_invoice(inv: dict, paid_refs: set[str], *, sponsors: dict | None = None, http=None, offline: bool = False,
                  team: str = "mercedes") -> Verdict:
    """inv: the invoice fields Meridian sent (sponsor_id, season, round, session, car, clause_id, amount_orig, currency,
    final_classification_at, invoiced_at, reference)."""
    v = Verdict(pay=False)
    sponsors = sponsors or contracts()
    sponsor = sponsors.get(inv["sponsor_id"])
    if sponsor is None:
        v.reasons.append(f"we are not {inv['sponsor_id']}'s payer")
        return v
    rnd, session = int(inv["round"]), inv["session"]
    contract = contract_for(sponsor, rnd)
    clause = next((c for c in contract["clauses"] if c["id"] == inv["clause_id"]), None)
    v.checks["clause_exists"] = clause is not None
    if clause is None:
        v.reasons.append(f"clause {inv['clause_id']} is not in {contract['contract_ref']}")
        return v
    covers = session == "race" or clause["scope"] == "grand_prix_and_sprint"
    v.checks["session_covered"] = covers
    if not covers:
        v.reasons.append(f"clause {clause['id']} does not cover sprints (scope: {clause['scope']})")
    v.checks["amount_matches"] = int(inv["amount_orig"]) == int(clause["amount"]) and inv["currency"] == sponsor["currency"]
    if not v.checks["amount_matches"]:
        v.reasons.append(f"amount {int(inv['amount_orig']) / 100:,.2f} {inv['currency']} differs from the contract's "
                         f"{clause['amount'] / 100:,.2f} {sponsor['currency']}")
    row, v.source = result_row(int(inv["season"]), rnd, session, int(inv["car"]), http=http, offline=offline)
    v.checks["result_found"] = row is not None and row.get("constructor") == team
    if not v.checks["result_found"]:
        v.reasons.append(f"no {inv['season']} R{rnd} {session} result for a Meridian car {inv['car']}")
    else:
        v.checks["result_earns_it"] = earned(clause, row)
        if not v.checks["result_earns_it"]:
            shown = "DSQ" if _disqualified(row) else row["positionText"]
            v.reasons.append(f"car {inv['car']} is classified {shown} ({row['status']}), which does not earn a "
                             f"{clause['type'].replace('_', ' ')} bonus")
    fin, billed = inv.get("final_classification_at"), inv.get("invoiced_at")
    v.checks["invoiced_after_final"] = bool(fin and billed and billed >= fin)
    if not v.checks["invoiced_after_final"]:
        v.reasons.append("invoice predates the final classification")
    ref = inv.get("reference") or ""
    v.checks["not_paid_before"] = ref not in paid_refs
    if not v.checks["not_paid_before"]:
        v.reasons.append(f"we already paid {ref}")
    v.pay = all(v.checks.values())
    if v.pay:
        v.reasons = [f"car {inv['car']} classified P{row['position']} in {inv['season']} R{rnd} {session}",
                     f"clause {clause['id']} of {contract['contract_ref']} pays {clause['amount'] / 100:,.2f} {sponsor['currency']}",
                     "invoiced after the final classification", "first payment of this bonus"]
    return v
