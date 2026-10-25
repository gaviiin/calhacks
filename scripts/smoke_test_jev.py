"""Credentialed smoke test of the Jev router against TypeSafe System One (milestone P0-B).

    TYPESAFE_API_KEY=... uv run python scripts/smoke_test_jev.py

Lists the models, sends each labeled fixture in live_racing/fixtures/jev_cases.json as one typed
request, asserts the response parses, and reports agreement with `expect_live`, request count,
error rate and p50/p95 latency. Without a key it reports BLOCKED and exits 2; it never fakes a result.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from live_racing.config import FIXTURES_DIR, Config  # noqa: E402
from live_racing.jev_router import JevRouter  # noqa: E402


def main() -> int:
    cfg = Config.from_env()
    router = JevRouter(cfg)
    if not router.enabled:
        print(f"BLOCKED: {router.describe()}. Set TYPESAFE_API_KEY in .env to run the live smoke test; the pipeline runs with the deterministic fallback meanwhile.")
        return 2
    print("models:", router.list_models())
    cases = json.loads((FIXTURES_DIR / "jev_cases.json").read_text())["cases"]
    agree = 0
    rows = []
    for c in cases:
        d = router.decide(c["state"], c["deterministic"], c["material"])
        ok = d.used and d.chosen_route in c["expect_live"]
        agree += ok
        rows.append((c["id"], d.status, d.route, d.chosen_route, d.route_confidence, d.urgency, d.needs_evidence, d.latency_ms, d.model, ok, d.error))
        print(f"{'OK ' if ok else 'XX '} {c['id']:<42} jev={d.route!s:<15} conf={d.route_confidence!s:<6} urgency={d.urgency!s:<9} "
              f"needs_evidence={d.needs_evidence!s:<5} chosen={d.chosen_route:<15} {d.latency_ms}ms status={d.status} {d.error or ''}")
    s = router.stats.summary()
    print(f"\n{agree}/{len(cases)} agree with expect_live; {s['requests']} requests, {s['errors']} errors, p50 {s['p50_ms']}ms, p95 {s['p95_ms']}ms; "
          f"models seen: {sorted({r[8] for r in rows if r[8]})}")
    return 0 if s["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
