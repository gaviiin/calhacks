"""Score: the cost cap desk's proposals against the world's truth file. Not an agent.

The truth file (`world/out/truth_2026.csv`, one row per category a line splits into, and
`truth_2026_allocations.csv` for the per-bill-line splits) is the answer key the agents never read.
For every classification work item the analyst has decided (proposed, approved or posted) this
compares the proposed categories with the truth, allocation by allocation, and the proposed cap
effect with the truth's Relevant Costs: the dollars on the wrong side of the cap are what a wrong
answer would have cost the submission. Lines asked about are counted, not scored.

Writes agents/out/scorecard.json (the dashboard reads it) and prints the misses.

Usage:
  uv run python -m agents.score [--period 2026-01]
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

from . import config, identities
from .stdb import StdbClient

DECIDED = ("PROPOSED", "APPROVED", "POSTED")
SCORECARD_PATH = config.OUT_DIR / "scorecard.json"


def _read_csv(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def _token(stdb: StdbClient) -> str:
    """Any identity may read the public tables; prefer an existing one over minting another."""
    try:
        return identities.get("controller").token
    except KeyError:
        return stdb.create_identity()[1]


def score(stdb: StdbClient, period: str | None = None, world_out: Path | None = None) -> dict:
    out = Path(world_out or config.WORLD_OUT_DIR)
    truth: dict[str, list[dict]] = defaultdict(list)
    for r in _read_csv(out / "truth_2026.csv"):
        truth[r["gl_line_id"]].append(r)
    truth_alloc: dict[str, dict[str, str]] = defaultdict(dict)
    for r in _read_csv(out / "truth_2026_allocations.csv"):
        truth_alloc[r["gl_line_id"]][r["basis_ref"]] = r["category_code"]

    tok = _token(stdb)
    treatment = {r["id"]: r["treatment"] for r in stdb.sql(tok, "SELECT * FROM rulebook_entry")}
    items = [w for w in stdb.sql(tok, "SELECT * FROM work_item WHERE kind = 'classification'")
             if period is None or w["period_key"] == period]
    allocs: dict[int, list[dict]] = defaultdict(list)
    for a in stdb.sql(tok, "SELECT * FROM allocation"):
        allocs[int(a["work_item_id"])].append(a)

    def cap_effect(entry_id: str | None, amount: int, explicit) -> int:
        t = treatment.get(entry_id or "")
        if t == "RELEVANT":
            return amount
        if t == "ADJUSTMENT":
            return int(explicit or 0)
        return 0

    scored = matched = asked = 0
    wrong_side = proposed_usd = 0
    by_source: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    misses = []
    for w in items:
        gl = w["subject_ref"]
        if w["state"] == "NEEDS_INFO":
            asked += 1
        if w["state"] not in DECIDED or gl not in truth:
            continue
        rows = truth[gl]
        want_relevant = sum(int(r["relevant_usd_minor"]) for r in rows)
        amount = int(w["amount_usd_minor"])
        if w.get("proposed_category_code") == "ALLOCATED":
            parts = allocs.get(int(w["id"]), [])
            got = {a["basis_ref"]: a["category_code"] for a in parts if a["basis"] == "bill_line"}
            want = truth_alloc.get(gl) or {}
            ok = bool(want) and got == want or (not want and {a["category_code"] for a in parts} == {r["category_code"] for r in rows})
            got_relevant = sum(cap_effect(a["rulebook_entry_id"], int(a["amount_usd_minor"]), a.get("cap_effect_usd_minor"))
                               for a in parts)
            label = ", ".join(f"{a['category_code']}" for a in sorted(parts, key=lambda a: int(a["line_no"])))
        else:
            cat = w.get("proposed_category_code")
            ok = len(rows) == 1 and rows[0]["category_code"] == cat
            got_relevant = cap_effect(w.get("proposed_rulebook_entry_id"), amount, w.get("cap_effect_usd_minor"))
            label = cat or "-"
        scored += 1
        matched += ok
        src = w.get("proposal_source") or "unknown"
        by_source[src][0] += 1
        by_source[src][1] += ok
        proposed_usd += abs(amount)
        off = abs(got_relevant - want_relevant)
        wrong_side += off
        if not ok:
            misses.append({"work_item_id": int(w["id"]), "gl_line_id": gl, "proposed": label,
                           "truth": ", ".join(r["category_code"] for r in rows), "source": src,
                           "wrong_side_usd_minor": off, "note": rows[0].get("note", "")})
    card = {
        "period": period, "decided": scored, "matched": matched, "asked": asked,
        "accuracy": round(matched / scored, 4) if scored else None,
        "proposed_usd_minor": proposed_usd, "wrong_side_usd_minor": wrong_side,
        "by_source": {k: {"decided": v[0], "matched": v[1]} for k, v in sorted(by_source.items())},
        "misses": misses,
    }
    return card


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m agents.score", description="Score proposals against the truth file.")
    ap.add_argument("--period", help="only this period key, e.g. 2026-01")
    args = ap.parse_args(argv)
    card = score(StdbClient(), args.period)
    SCORECARD_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCORECARD_PATH.write_text(json.dumps(card, indent=2))
    for m in card["misses"]:
        print(f"  miss {m['work_item_id']:>5} {m['gl_line_id']}  proposed {m['proposed']:<28} truth {m['truth']:<28} "
              f"[{m['source']}] off ${m['wrong_side_usd_minor'] / 100:,.2f}")
    acc = f"{card['accuracy']:.1%}" if card["accuracy"] is not None else "n/a"
    print(f"{card['matched']} of {card['decided']} decided lines match the truth file ({acc}); {card['asked']} asked; "
          f"${card['wrong_side_usd_minor'] / 100:,.2f} on the wrong side of the cap of "
          f"${card['proposed_usd_minor'] / 100:,.2f} proposed")
    for src, v in card["by_source"].items():
        print(f"  {src:<14} {v['matched']}/{v['decided']}")
    print(f"wrote {SCORECARD_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
