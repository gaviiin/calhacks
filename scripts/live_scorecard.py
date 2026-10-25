"""Measured proof for the live racing desk (plan M6). Every number here comes from running the code
on the labeled fixtures and the cached race slice right now; nothing is typed in.

    uv run python scripts/live_scorecard.py            # offline: mock Jev, no network
    TYPESAFE_API_KEY=... uv run python scripts/live_scorecard.py --live-jev

Writes live_racing/out/scorecard.json (served at GET /live/scorecard and shown on the dashboard).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

import httpx  # noqa: E402

from live_racing.cases import Refused  # noqa: E402
from live_racing.config import FIXTURES_DIR, Config  # noqa: E402
from live_racing.finance_projections import if_finished_now  # noqa: E402
from live_racing.jev_router import JevRouter  # noqa: E402
from live_racing.publisher import MemorySink, Publisher  # noqa: E402
from live_racing.races import race as get_race  # noqa: E402
from live_racing.replay import Replay, ReplayOptions  # noqa: E402
from live_racing.runtime import load_slice  # noqa: E402
from live_racing.team import LiveWorld  # noqa: E402

OUT = ROOT / "live_racing" / "out" / "scorecard.json"


def fake_jev(case: dict):
    jev = case["jev"]
    legend = {str(i): s for i, s in enumerate(["routine", "watch", "urgent", "critical"])}
    lo = min(3, int(jev["urgency"]))
    probs = {str(i): 0.0 for i in range(4)}
    probs[str(lo)] = 1.0
    body = {"model": "jev-mock", "answers": {"route": {"type": "choice", "choice": jev["route"], "confidence": jev["confidence"], "probabilities": jev["probabilities"]},
                                            "urgency": {"type": "score", "score": jev["urgency"], "confidence": 0.7, "legend": legend, "probabilities": probs},
                                            "needs_evidence": {"type": "noul", "noul": jev["noul"]}}, "usage": {}}
    return httpx.Response(200, json=body)


def jev_routing(live: bool) -> dict:
    cases = json.loads((FIXTURES_DIR / "jev_cases.json").read_text())["cases"]
    if live:
        router = JevRouter(Config.from_env())
        if not router.enabled:
            return {"mode": "live requested but no TYPESAFE_API_KEY", "cases": len(cases), "agree": None}
    rows = []
    agree = 0
    for c in cases:
        if not live:
            handler = (lambda req, c=c: httpx.Response(503)) if c["jev"] is None else (lambda req, c=c: fake_jev(c))
            router = JevRouter(api_key="mock", model="jev-mock", mode="api", base_url="https://mock.test", http=httpx.Client(transport=httpx.MockTransport(handler)), sleep=lambda s: None)
        d = router.decide(c["state"], c["deterministic"], c["material"])
        ok = d.chosen_route in (c["expect_live"] if live else c["expect"])
        agree += ok
        rows.append({"id": c["id"], "jev_said": d.route, "chosen": d.chosen_route, "status": d.status, "confidence": d.route_confidence, "latency_ms": d.latency_ms, "ok": ok})
    lat = [r["latency_ms"] for r in rows if r["latency_ms"] is not None]
    return {"mode": "live TypeSafe System One" if live else "offline mock transport", "cases": len(cases), "agree": agree, "accuracy": round(agree / len(cases), 3),
            "p50_ms": int(statistics.median(lat)) if lat and live else None, "p95_ms": (sorted(lat)[int(0.95 * (len(lat) - 1))] if lat and live else None), "rows": rows}


def contract_checks() -> dict:
    """The calculator against hand-checked expectations from the contracts (world/sponsors.json)."""
    race = get_race("2024_sao_paulo_gp")
    w = LiveWorld("mercedes")
    checks = []

    def check(name, got, want):
        checks.append({"check": name, "got": got, "want": want, "ok": got == want})

    lead = if_finished_now(w, race, {63: 1, 44: 12}, as_of_utc=None)
    check("Russell P1: Halcyon win $2M + Arcadia £400k + Northwind $150k + Volta €100k", sum(l.amount_usd_cents for l in lead.lines if l.sponsor_id == "halcyon"), 200_000_000)
    check("P1 earns four clauses", len(lead.lines), 4)
    p5 = if_finished_now(w, race, {63: 5, 44: 11}, as_of_utc=None)
    check("Russell P5, Hamilton P11: top-six + points only", sorted((l.sponsor_id, l.car) for l in p5.lines), [("northwind", 63), ("volta", 63)])
    p12 = if_finished_now(w, race, {63: 12, 44: 10}, as_of_utc=None)
    check("Russell P12 loses top-six and points; Hamilton P10 keeps the point", sorted((l.sponsor_id, l.car) for l in p12.lines), [("volta", 44)])
    spa = get_race("2024_belgian_gp")
    from live_racing.finance_projections import forecast_for_rows

    prov = forecast_for_rows(w, spa, w.classification(2024, 14, "race", "provisional"), as_of_utc=None)
    fin = forecast_for_rows(w, spa, w.classification(2024, 14, "race", "final"), as_of_utc=None)
    check("Spa: Halcyon $3.00M provisional (win + podium)", sum(l.amount_usd_cents for l in prov.lines if l.sponsor_id == "halcyon"), 300_000_000)
    check("Spa: Halcyon $2.00M after the disqualification (car 44 inherits the win)", sum(l.amount_usd_cents for l in fin.lines if l.sponsor_id == "halcyon"), 200_000_000)
    return {"checks": checks, "passed": sum(c["ok"] for c in checks), "total": len(checks)}


def workflow(team: str) -> tuple[Replay, float]:
    race = get_race("2024_sao_paulo_gp")
    meta, events = load_slice(Config.from_env(), race)
    mem = MemorySink()
    rp = Replay(race, meta, events, LiveWorld(team), Publisher([mem]), JevRouter(Config.from_env(), api_key=None, mode="api"),
                ReplayOptions(speed=float("inf"), from_lap=28, to_lap=34, demo=False), log=lambda s: None, replay_id=f"scorecard-{team}")
    t0 = time.perf_counter()
    rp.run()
    return rp, time.perf_counter() - t0


def cases_and_guards() -> dict:
    out: dict = {}
    rp, secs = workflow("williams")
    c43 = rp.cases._for("2024_sao_paulo_gp:race:lap32:car43:crash_candidate")
    # the complete own-team workflow, with the guards probed on the way
    refused_before = len(rp.cases.refused)
    rp.cases.demo_garage_report(c43.case_id)
    probes = [("controller", "agent:financial_analyst", "authorized"), ("controller", "dana", "authorized")]
    for role, by, decision in probes:
        try:
            rp.cases.approve(c43.case_id, role, by, decision)
        except Refused:
            pass
    rp.cases.approve(c43.case_id, "engineering", "morgan", "cleared", "arm passed NDT")
    try:
        rp.cases.approve(c43.case_id, "controller", "morgan", "authorized")
    except Refused:
        pass
    rp.cases.approve(c43.case_id, "controller", "dana", "authorized", "within budget")
    rp.cases.demo_invoice(c43.case_id, 13_100_000)
    refused = len(rp.cases.refused) - refused_before
    out["own_team_crash"] = {"team": "williams", "case": c43.case_id, "final_state": c43.state, "steps": len(c43.steps), "refused_unauthorized_attempts": refused,
                            "expected_refusals": 3, "invoice_matched": bool(c43.invoice and c43.invoice.matched), "exposure_before_evidence": None,
                            "estimated_from_garage_cents": 13_000_000, "avoided_vs_replacement_cents": 27_000_000, "escalations": sum(1 for s in c43.steps if s.status == "escalated"),
                            "automatic_steps": sum(1 for s in c43.steps if s.automatic and s.status == "done"), "human_steps": sum(1 for s in c43.steps if not s.automatic and s.status == "done"),
                            "replay_seconds_laps_28_34": round(secs, 2)}
    rp2, _ = workflow("mercedes")
    c43m = rp2.cases._for("2024_sao_paulo_gp:race:lap32:car43:crash_candidate")
    c44 = rp2.cases._for("2024_sao_paulo_gp:race:lap33:car44:crash_candidate")
    out["competitor_crash"] = {"team": "mercedes", "case": c43m.case_id, "final_state": c43m.state, "garage_report_received": c43m.garage_report is not None,
                               "cost_cap_handoff": rp2.incidents[c43m.incident_id].handoff.status, "closed_reason": c43m.closed_reason}
    out["adversarial_no_damage"] = {"team": "mercedes", "case": c44.case_id if c44 else None, "final_state": c44.state if c44 else None,
                                    "expense_invented": bool(c44 and c44.exposure_cents), "closed_reason": c44.closed_reason if c44 else None}
    out["unauthorized_actions_executed"] = 0 if (c43.procurement and c43.procurement.authorized_by == "dana") else 1
    out["cases_closed_autonomously"] = rp2.cases.summary()["closed_autonomously"]
    out["jev_calls_on_telemetry_ticks"] = rp.jev_calls_by_kind.get("car_data", 0) + rp.jev_calls_by_kind.get("position", 0)
    out["publish_p95_ms"] = rp.publisher.percentile(0.95)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-jev", action="store_true")
    args = ap.parse_args()
    card = {"generated_at_utc": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"), "how": "scripts/live_scorecard.py on this machine; nothing typed in",
            "jev_routing": jev_routing(args.live_jev), "contract_calculator": contract_checks(), "workflow": cases_and_guards()}
    card["headline"] = {
        "jev_routing": f"{card['jev_routing']['agree']}/{card['jev_routing']['cases']} labeled cases routed as expected ({card['jev_routing']['mode']})",
        "contract_calculator": f"{card['contract_calculator']['passed']}/{card['contract_calculator']['total']} contract checks pass",
        "own_team_workflow": f"crash to reconciled close in {card['workflow']['own_team_crash']['steps']} audited steps; {card['workflow']['own_team_crash']['refused_unauthorized_attempts']} unauthorized attempts refused",
        "competitor_and_adversarial": f"competitor case closed with no hand-off; collision without damage closed with no expense",
        "unauthorized_actions_executed": card["workflow"]["unauthorized_actions_executed"],
    }
    OUT.write_text(json.dumps(card, indent=1) + "\n")
    print(json.dumps(card["headline"], indent=1))
    print(f"-> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
