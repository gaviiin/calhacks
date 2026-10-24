"""Ground truth, the commercial team's billing requests (with planted errors), and the grader.

The truth calculation here is written separately from finance/bonuses.py on
purpose, so the grader does not mark the engine's homework with the engine's
own answer. The agent and engine never read keys/.

    python -m finance.eval generate 2023 2024     # writes world/requests/<s>.json and keys/<s>.json
"""

from __future__ import annotations

import argparse
import json
import random
from datetime import datetime, timedelta
from pathlib import Path

from .config import KEYS_DIR, WORLD_DIR
from .world import World

# --------------------------------------------------------------------------- truth


def truth_bonuses(world: World, season: int, version: str = "final", overlays: list | None = None,
                  rounds: set[int] | None = None) -> dict[str, dict]:
    """Every bonus the classification earns. Volta's silent sprint clause is excluded (controller ruling)."""
    out = {}
    for rnd in world.rounds(season):
        n = int(rnd["round"])
        if rounds is not None and n not in rounds:
            continue
        for session in ("race", "sprint"):
            if not rnd.get(session):
                continue
            rows = world.classification(season, n, session, version, overlays)
            for sponsor in world.sponsors:
                versions = [c for c in sponsor["contracts"] if c["effective_from_round"] <= n]
                contract = max(versions, key=lambda c: c["version"])
                for clause in contract["clauses"]:
                    if session == "sprint" and clause["scope"] != "grand_prix_and_sprint":
                        continue
                    for row in rows:
                        if row.constructor_id != world.team or row.pos is None:
                            continue
                        t = clause["type"]
                        hit = ((t == "win" and row.pos == 1)
                               or (t == "podium" and (row.pos in (2, 3) if clause.get("excludes_win") else row.pos <= 3))
                               or (t == "points_finish" and row.points > 0)
                               or (t == "top6" and row.pos <= 6))
                        if hit:
                            key = f"bonus|{season}|R{n}|{session}|{sponsor['id']}|{clause['id']}|car{row.number}"
                            out[key] = {"sponsor_id": sponsor["id"], "clause_id": clause["id"], "clause_type": t, "car": row.number,
                                        "round": n, "session": session, "position": row.pos, "amount_orig": clause["amount"],
                                        "currency": sponsor["currency"], "season": season}
    return out


# --------------------------------------------------------------------------- generator


def _times(world: World, season: int) -> dict[tuple[int, str], tuple[str, str]]:
    from .sim import weekend_events

    out = {}
    for rnd in world.rounds(season):
        ev = weekend_events(world, season, rnd)
        for session in ("race", "sprint"):
            prov = next((e["at"] for e in ev if e["type"] == "race_provisional" and e["payload"]["session"] == session), None)
            fin = next((e["at"] for e in ev if e["type"] == "race_final" and e["payload"]["session"] == session), None)
            if prov and fin:
                out[(int(rnd["round"]), session)] = (prov, fin)
    return out


def _at(ts: str, **delta) -> str:
    return (datetime.fromisoformat(ts.replace("Z", "+00:00")) + timedelta(**delta)).strftime("%Y-%m-%dT%H:%M:%SZ")


def generate(world: World, season: int, seed: int = 13) -> tuple[list[dict], list[dict]]:
    rng = random.Random(seed * 1000 + season)
    final = truth_bonuses(world, season, "final")
    prov = truth_bonuses(world, season, "provisional")
    times = _times(world, season)
    requests, key = [], []

    def add(b: dict, *, at: str, amount: int | None = None, note: str = "", expect: str, reason: str, held: bool = False, planted: str | None = None):
        rid = f"BR-{season}-{len(requests) + 1:03d}"
        requests.append({"request_id": rid, "submitted_at": at, "requested_by": "luis.ferreira", "season": season,
                         "round": b["round"], "session": b["session"], "sponsor_id": b["sponsor_id"], "clause_id": b["clause_id"],
                         "car": b["car"], "amount_orig": amount if amount is not None else b["amount_orig"], "currency": b["currency"],
                         "note": note})
        key.append({"request_id": rid, "expect": expect, "reason": reason, "expect_hold_first": held, "planted": planted,
                    "requested_orig": amount if amount is not None else b["amount_orig"], "contract_orig": b["amount_orig"],
                    "currency": b["currency"]})

    earned = sorted(final.values(), key=lambda b: (b["round"], b["session"], b["sponsor_id"], b["car"]))
    early = set(rng.sample(range(len(earned)), min(3, len(earned))))
    dupes = set(rng.sample(range(len(earned)), min(3, len(earned))))
    fat_pool = [i for i, b in enumerate(earned) if b["sponsor_id"] in ("arcadia", "northwind") and i not in early | dupes]
    fat = rng.choice(fat_pool) if fat_pool else None
    for i, b in enumerate(earned):
        prov_at, fin_at = times[(b["round"], b["session"])]
        if i == fat:
            _, fin_at = times[(b["round"], b["session"])]
            add(b, at=_at(fin_at, hours=rng.randint(2, 48)), amount=int(b["amount_orig"] * 1.1), note="Bonus per contract.",
                expect="billed", reason="amount_corrected", planted="wrong_amount")
        elif i in early:
            add(b, at=_at(prov_at, minutes=10), note="Result's in, please invoice now.", expect="billed", reason="approved", held=True, planted="early_request")
        elif b["sponsor_id"] == "halcyon" and b["clause_type"] == "podium" and b["round"] >= 12 and not any(k.get("planted") == "stale_rate" for k in key):
            add(b, at=_at(fin_at, hours=rng.randint(2, 48)), amount=75_000_000, note="Podium bonus per contract.",
                expect="billed", reason="amount_corrected", planted="stale_rate")
        else:
            add(b, at=_at(fin_at, hours=rng.randint(2, 72)), expect="billed", reason="approved")
        if i in dupes:
            add(b, at=_at(fin_at, days=3, hours=rng.randint(0, 12)), note="Resending in case the first one was lost.",
                expect="rejected", reason="duplicate", planted="duplicate")

    for k, b in sorted(prov.items()):
        if k not in final:
            prov_at, _ = times[(b["round"], b["session"])]
            add(b, at=_at(prov_at, minutes=5), note="Podium's basically confirmed, invoice it now so it lands this month.",
                expect="rejected", reason="overturned", held=True, planted="billed_on_provisional_result")

    # Fabricated claims: a podium bonus for a car that finished P4 to P6.
    near = []
    for rnd in world.rounds(season):
        for row in world.team_rows(world.classification(season, int(rnd["round"]), "race")):
            if row.pos and 4 <= row.pos <= 6:
                near.append((int(rnd["round"]), row))
    for rnd_n, row in rng.sample(near, min(2, len(near))):
        _, fin_at = times[(rnd_n, "race")]
        add({"round": rnd_n, "session": "race", "sponsor_id": "arcadia", "clause_id": "4.2", "car": row.number,
             "amount_orig": 40_000_000, "currency": "GBP"}, at=_at(fin_at, days=2), note="Podium bonus.",
            expect="rejected", reason="not_earned", planted="not_earned")

    # Sprint claims: Northwind excludes sprints; Volta's clause is silent (controller rules they don't count).
    sprint_top6, sprint_points = [], []
    for rnd in world.rounds(season):
        if not rnd.get("sprint"):
            continue
        for row in world.team_rows(world.classification(season, int(rnd["round"]), "sprint")):
            if row.pos and row.pos <= 6:
                sprint_top6.append((int(rnd["round"]), row))
            if row.points > 0:
                sprint_points.append((int(rnd["round"]), row))
    for rnd_n, row in sprint_top6[:2]:
        _, fin_at = times[(rnd_n, "sprint")]
        add({"round": rnd_n, "session": "sprint", "sponsor_id": "northwind", "clause_id": "6.3", "car": row.number,
             "amount_orig": 15_000_000, "currency": "USD"}, at=_at(fin_at, hours=6), note="Top six bonus.",
            expect="rejected", reason="sprint_excluded", planted="sprint_excluded")
    for rnd_n, row in sprint_points[:2]:
        _, fin_at = times[(rnd_n, "sprint")]
        add({"round": rnd_n, "session": "sprint", "sponsor_id": "volta", "clause_id": "5.1", "car": row.number,
             "amount_orig": 10_000_000, "currency": "EUR"}, at=_at(fin_at, hours=8), note="Points finish bonus.",
            expect="rejected", reason="excluded_by_ruling", planted="sprint_ambiguous")
    return requests, key


def write(world: World, seasons: list[int], keys_dir: Path = KEYS_DIR) -> None:
    (Path(world.dir) / "requests").mkdir(parents=True, exist_ok=True)
    keys_dir.mkdir(parents=True, exist_ok=True)
    for s in seasons:
        requests, key = generate(world, s)
        (Path(world.dir) / "requests" / f"{s}.json").write_text(json.dumps(
            {"_note": "SYNTHETIC billing requests from Meridian's commercial team. Some are wrong on purpose.", "season": s,
             "requests": requests}, indent=1) + "\n")
        (keys_dir / f"{s}.json").write_text(json.dumps({"season": s, "requests": key}, indent=1) + "\n")
        planted = sum(1 for k in key if k["planted"])
        print(f"{s}: {len(requests)} billing requests ({planted} planted errors) -> world/requests/{s}.json, keys/{s}.json")


# --------------------------------------------------------------------------- grader


def scorecard(run, keys_dir: Path = KEYS_DIR) -> dict:
    ledger, world, season = run.ledger, run.world, run.season
    finals = {(r["round"], r["session"]) for r in ledger.q("SELECT round, session FROM finals WHERE season=?", season)}
    truth = truth_bonuses(world, season, "final", ledger.overlays(), rounds={r for r, _ in finals})
    truth = {k: v for k, v in truth.items() if (v["round"], v["session"]) in finals}
    active = {}
    for je in ledger.entries(kind="bonus", status="posted"):
        if not je["reversed_by"]:
            line = next(x for x in je["lines"] if x["account"] == "1300")
            active[je["key"]] = line["orig_amount_cents"]
    correct = [k for k, v in truth.items() if active.get(k) == v["amount_orig"]]
    wrong = [k for k in active if k not in truth or active[k] != truth[k]["amount_orig"]]
    missing = [k for k in truth if k not in active]

    key_path = keys_dir / f"{season}.json"
    billing = {"graded": False}
    protected = 0
    if key_path.exists():
        key = {k["request_id"]: k for k in json.loads(key_path.read_text())["requests"]}
        got = {b["request_id"]: b for b in ledger.billings()}
        rows, caught, planted = [], 0, 0
        for rid, k in key.items():
            b = got.get(rid)
            status, reason = (b["status"], b["reason_code"]) if b else ("missing", None)
            held = any(h["status"] == "hold" for h in b["history"]) if b else False
            ok = status == k["expect"] and reason == k["reason"] and (held or not k["expect_hold_first"])
            if k["planted"]:
                planted += 1
                caught += ok
                if ok:
                    rate = world.fx(k["currency"], ledger.today)
                    excess = k["requested_orig"] if k["expect"] == "rejected" else max(0, k["requested_orig"] - k["contract_orig"])
                    protected += int(rate * excess)
            rows.append({"request_id": rid, "expect": f"{k['expect']}/{k['reason']}", "got": f"{status}/{reason}", "ok": ok, "planted": k["planted"]})
        false_alarms = [r for r in rows if not r["planted"] and not r["ok"]]
        billing = {"graded": True, "requests": len(rows), "correct": sum(r["ok"] for r in rows), "planted": planted,
                   "planted_caught": caught, "false_alarms": len(false_alarms),
                   "misses": [r for r in rows if not r["ok"]][:20]}
    avoided = [m for m in ledger.memos("expected_bonus", season) if m["status"] == "avoided"]
    avoided_usd = sum(int(world.fx(m["payload"]["currency"], ledger.today) * m["payload"]["amount_orig"]) for m in avoided)
    tb = ledger.trial_balance()
    entries = ledger.q("SELECT status, preparer, COUNT(*) n FROM journal_entries GROUP BY status, preparer")
    by_status: dict[str, int] = {}
    by_preparer: dict[str, int] = {}
    for r in entries:
        by_status[r["status"]] = by_status.get(r["status"], 0) + r["n"]
        by_preparer[r["preparer"]] = by_preparer.get(r["preparer"], 0) + r["n"]
    questions = ledger.q("SELECT COUNT(*) n FROM questions WHERE to_role='controller' AND subject LIKE 'bonus|%'")[0]["n"]
    return {
        "run_id": run.run_id, "season": season, "books_tie": tb["ties"], "debits_cents": tb["debits"],
        "bonuses": {"truth": len(truth), "correct": len(correct), "missing": missing[:20], "wrong_postings": wrong},
        "billing": billing,
        "dollars_protected_cents": protected + avoided_usd,
        "expected_bonuses_avoided": len(avoided),
        "entries": by_status, "prepared_by": by_preparer,
        "router": run.router.stats,
        "controller_questions": questions,
        "rules_approved": sorted(run.store.approved()),
        "model": run.store.costs(run.run_id),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate")
    g.add_argument("seasons", type=int, nargs="+")
    args = ap.parse_args()
    if args.cmd == "generate":
        write(World(WORLD_DIR), args.seasons)


if __name__ == "__main__":
    main()
