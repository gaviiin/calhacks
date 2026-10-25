"""Stage 8, true-up: the weeks after, the press actuals against the sealed Sunday-night estimate.

    uv run python -m race.trueup --meeting 1249           # reads the sealed close, writes the variance and the calibration

The estimate cannot move after the fact: the close's Merkle root is in pit-wall, and the local snapshot
(race/data/closes/close-<meeting>.json) must still hash to it. The actuals are press figures with URLs
(race/data/actuals_2024_brazil.json); Williams publishes none of its own.

Calibration: one multiplier per damage severity that the price book can apply next time
(`calibration_factor("heavy")`; 1.0 when nothing has been learned). A weekend's actual says only how far the
whole weekend was off, so each severity that contributed to the estimate takes the weekend's multiplier, weighted
by its share of the estimate's mid across weekends, and shrunk toward 1.0 by credibility n / (n + 1) for n
weekends seen. One weekend therefore moves the book half way in log terms: the price book should not be rewritten
by a single press figure.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

from race.close import CLOSES, load_snapshot
from race.events import SimRun, now_iso

DATA = Path(__file__).resolve().parent / "data"
ACTUALS = {1249: DATA / "actuals_2024_brazil.json"}
CALIBRATION = DATA / "price_calibration.json"
CREDIBILITY_K = 1.0


def actual_cents(a: dict, eur_usd: float) -> int | None:
    if a.get("usd") is not None:
        return int(round(a["usd"] * 100))
    if a.get("eur") is not None:
        return int(round(a["eur"] * eur_usd * 100))
    return None


def compare(est: dict, actual: int) -> dict:
    lo, mid, hi = est["low_cents"], est["mid_cents"], est["high_cents"]
    var = actual - mid
    return {
        "actual_cents": actual, "estimate_low_cents": lo, "estimate_mid_cents": mid, "estimate_high_cents": hi,
        "variance_cents": var, "variance_pct": round(var / mid, 4) if mid else None,
        "multiplier": round(actual / mid, 4) if mid else None,
        "inside_band": lo <= actual <= hi,
        "band_position": round((actual - lo) / (hi - lo), 4) if hi > lo else None,  # 0 = at the low end, 1 = at the high end
    }


def true_up(close_totals: dict, actuals: dict) -> dict:
    """Variance of the sealed estimate (race cost band) against the primary actual, plus every other weekend
    figure as a cross-check and the parts the press says were destroyed against the parts the close expected."""
    est = close_totals["race_cost"]
    eur_usd = float(actuals.get("eur_usd", 1.0))
    by_id = {a["id"]: a for a in actuals["actuals"]}
    primary = by_id[actuals["primary"]]
    head = compare(est, actual_cents(primary, eur_usd))
    cross = []
    for a in actuals["actuals"]:
        if a["id"] == primary["id"] or a.get("scope") != "weekend" or actual_cents(a, eur_usd) is None:
            continue
        cross.append({"id": a["id"], "source": a["source"], "url": a["url"], **compare(est, actual_cents(a, eur_usd))})
    parts_est: dict[str, int] = {}
    for inc in close_totals.get("incidents") or []:
        for p in inc.get("parts") or []:
            parts_est[p] = parts_est.get(p, 0) + 1
    bound = next((a for a in actuals["actuals"] if a.get("parts")), None)
    parts = None
    if bound:
        parts = {"source": bound["source"], "url": bound["url"], "scope": bound["scope"],
                 "by_part": {p: {"estimated": parts_est.get(p, 0), "press_upper_bound": n, "within": parts_est.get(p, 0) <= n}
                             for p, n in sorted(bound["parts"].items())}}
    by_sev: dict[str, int] = {}
    for inc in close_totals.get("incidents") or []:
        by_sev[inc.get("severity") or "unknown"] = by_sev.get(inc.get("severity") or "unknown", 0) + int(inc.get("mid_cents") or 0)
    pct = head["variance_pct"]
    words = "the actual is inside the band" if head["inside_band"] else "the actual is outside the band"
    return {
        "meeting_key": close_totals.get("meeting_key"), "weekend": close_totals.get("weekend", ""),
        **head,
        "primary": {"id": primary["id"], "source": primary["source"], "url": primary["url"], "published": primary["published"],
                    "quote": primary.get("quote", ""), "verified": bool(primary.get("verified"))},
        "cross_checks": cross, "parts": parts, "estimate_by_severity_cents": by_sev,
        "summary": (f"Sealed mid ${head['estimate_mid_cents'] / 1e8:.2f}m vs press ${head['actual_cents'] / 1e8:.2f}m"
                    + (f" ({pct:+.0%})" if pct is not None else "") + f"; {words}."),
    }


# ---------------------------------------------------------------------- the calibration file

def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def factors_from(observations: list[dict]) -> dict[str, float]:
    sums: dict[str, list[float]] = {}  # severity -> [sum w*log m, sum w, n]
    for o in observations:
        m = o.get("multiplier")
        if not m or m <= 0:
            continue
        weights = {k: v for k, v in (o.get("by_severity_cents") or {}).items() if v > 0} or {"all": o.get("estimate_mid_cents") or 1}
        if "all" not in weights:
            weights["all"] = sum(weights.values())
        for sev, w in weights.items():
            acc = sums.setdefault(sev, [0.0, 0.0, 0])
            acc[0] += w * math.log(m)
            acc[1] += w
            acc[2] += 1
    out = {}
    for sev, (wl, w, n) in sorted(sums.items()):
        z = n / (n + CREDIBILITY_K)
        out[sev] = round(math.exp(z * wl / w), 4)
    return out


def calibration(result: dict, close_key: str = "", root_hash: str = "", path: Path = CALIBRATION) -> dict:
    """Add this weekend's true-up to the calibration file (one observation per meeting, replaced on a re-run)
    and recompute the factors. Returns the file's contents."""
    cur = _load(path)
    obs = [o for o in cur.get("observations", []) if o.get("meeting_key") != result.get("meeting_key")]
    if result.get("multiplier"):
        obs.append({"meeting_key": result.get("meeting_key"), "weekend": result.get("weekend", ""), "close_key": close_key,
                    "root_hash": root_hash, "actual_cents": result["actual_cents"], "estimate_mid_cents": result["estimate_mid_cents"],
                    "multiplier": result["multiplier"], "by_severity_cents": result.get("estimate_by_severity_cents") or {},
                    "source": result["primary"]["url"]})
    data = {
        "_note": "Written by race/trueup.py. Multiply a price-book band for an incident of this severity by its factor; "
                 "'all' applies when the severity is unknown. 1.0 when nothing has been learned.",
        "method": f"weighted mean of log(actual / sealed mid) per severity, shrunk toward 0 by n / (n + {CREDIBILITY_K:g})",
        "updated_at": now_iso(), "factors": factors_from(obs), "observations": obs,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    return data


def calibration_factor(severity: str, path: Path = CALIBRATION) -> float:
    f = _load(path).get("factors") or {}
    v = f.get(severity, f.get("all"))
    return float(v) if isinstance(v, (int, float)) and v > 0 else 1.0


# ---------------------------------------------------------------------- the sealed close

def sealed_close(meeting: int, sink=None, closes_dir: Path = CLOSES) -> dict | None:
    """The close as pit-wall holds it (root, status, totals), else the local snapshot if it still verifies."""
    key = f"close-{meeting}"
    rows = sink.sql(f"SELECT * FROM race_closes WHERE close_key = '{key}'") if sink else []
    snap = load_snapshot(key, closes_dir)
    if rows:
        r = rows[0]
        totals = json.loads(r.get("totals_json") or r.get("totalsJson") or "{}")
        root = r.get("root_hash") or r.get("rootHash") or ""
        return {"close_key": key, "root_hash": root, "status": r.get("status", ""), "totals": totals, "from": "pit-wall",
                "snapshot_matches": bool(snap and snap["verified"] and snap["root_hash"] == root)}
    if snap and snap["verified"]:
        return {"close_key": key, "root_hash": snap["root_hash"], "status": snap.get("status", "draft"), "totals": snap["totals"],
                "from": "snapshot", "snapshot_matches": True}
    if snap:
        print(f"{key}: the local snapshot no longer hashes to its root; refusing to true it up.")
    return None


def run(meeting: int, sink=None, actuals_path: Path | None = None, calibration_path: Path = CALIBRATION, closes_dir: Path = CLOSES) -> SimRun | None:
    t0 = time.perf_counter()
    close = sealed_close(meeting, sink, closes_dir)
    if close is None:
        print(f"No sealed close for meeting {meeting}. Run the weekend first (python -m race.weekend --meeting {meeting}).")
        return None
    actuals = json.loads((actuals_path or ACTUALS[meeting]).read_text())
    result = true_up(close["totals"], actuals)
    result.update({"close_key": close["close_key"], "root_hash": close["root_hash"], "close_status": close["status"],
                   "close_from": close["from"], "snapshot_matches": close["snapshot_matches"]})
    cal = calibration(result, close["close_key"], close["root_hash"], calibration_path)
    result["calibration"] = cal["factors"]
    published = result["primary"]["published"]
    at = datetime.fromisoformat(published).replace(tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    sim = SimRun(sim_key=f"trueup:{meeting}:{close['root_hash'][:12]}", meeting_key=meeting, trigger=f"trueup:{meeting}", at=at,
                 payload=result, runtime_ms=int((time.perf_counter() - t0) * 1000))
    if sink:
        sink.sim(sim)
    return sim


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--meeting", type=int, default=1249)
    ap.add_argument("--actuals", type=Path)
    ap.add_argument("--no-sink", action="store_true")
    args = ap.parse_args()
    sink = None
    if not args.no_sink:
        from race.sink import RaceSink

        sink = RaceSink()
    sim = run(args.meeting, sink, args.actuals)
    if sim is None:
        raise SystemExit(1)
    p = sim.payload
    print(f"{p['close_key']} (root {p['root_hash'][:16]}, {p['close_status']}, from {p['close_from']}): {p['summary']}")
    print(f"  source: {p['primary']['source']}, {p['primary']['published']}: {p['primary']['url']}")
    for c in p["cross_checks"]:
        print(f"  cross-check {c['id']}: ${c['actual_cents'] / 1e8:.2f}m, variance {c['variance_pct']:+.0%}, inside band: {c['inside_band']}")
    if p["parts"]:
        over = [k for k, v in p["parts"]["by_part"].items() if not v["within"]]
        print(f"  parts vs {p['parts']['source']} ({p['parts']['scope']}): " + (f"over the press count for {', '.join(over)}" if over else "within the press counts"))
    print(f"  calibration -> {CALIBRATION.relative_to(DATA.parent.parent)}: {p['calibration']}")
    if sink:
        print(f"  recorded race_sims {sim.sim_key}" + (" (sink off)" if sink.disabled else ""))


if __name__ == "__main__":
    main()
