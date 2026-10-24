# world/: the systems of record

This directory holds the mock ERP, AP, bank feed, contracts and 2025 cost cap submission for **Kestrel Grand Prix**, a fictional UK constructor based at Upper Heyford. It is scaled to roughly Williams FY2025: about GBP 101m payroll, about 1,150 staff, 24 rounds. There are two entities. `TECHNOLOGY` (Kestrel Technology Ltd, the parent) employs the staff and recharges `RACING` (the F1 Team) monthly as a related party. The contract is SCHEMA.md section 5.

## Generate

```bash
uv run python -m world.generate --seed 7 --out world/out
```

This writes one `<source>.jsonl` per source. File order is cursor order: sorted by `visible_at`, and a re-emitted record appears again later with the same id. It also writes `answer_key.csv` (the planted items) and `truth_2026.csv`, which gives the correct 2026 treatment and the Relevant-Costs amount of every gl_line for scoring; that file is not part of SCHEMA. Output is byte-identical for a given seed. Scale: about 2,950 history lines for 2025, about 2,900 lines for Jan-Nov 2026, and 41 plants.

## Serve

```bash
uv run uvicorn world.api:app --port 8010      # WORLD_OUT_DIR=... to serve another directory
curl localhost:8010/clock                      # {"sim_date":"2026-01-01"}
curl -XPOST localhost:8010/clock/advance -H 'content-type: application/json' -d '{"days":1}'
curl 'localhost:8010/changes/gl_line?after=0&limit=3'
```

- The server refuses to start if `world/out` is missing a file.
- The clock starts at 2026-01-01, is held in memory and only moves forward. Restart the server to reset the clock and the ERP journal.
- History and reference sources are visible from the start. 2026 records appear when the clock reaches their `visible_at`.
- `rulebook_issue/SECD-ISS07` appears on 2026-06-25 (the mid-year rule change). `fv-005` appears on 2026-03-02, and `fv-002` is re-emitted on 2026-07-01.
- `POST /erp/journal_entries` needs `X-Gateway-Key` equal to `$GATEWAY_KEY` (default `dev-gateway-key`). A missing key gets 401 and a wrong key 403; an unbalanced entry, a bad line or an unknown account gets 422.
- Valid ERP accounts are `acct-<code>`, `capcat-<CODE>` and `capadj-<NAME>`. `work_item_id` is idempotent: re-posting the same entry returns the same id, and re-posting different lines gets 409.

## What is planted

See [PATTERNS.md](PATTERNS.md). It covers:

- The demo record: `gl-000001`, `bill-00001`, `bl-00001-1..3`.
- The 2025 patterns, with precedent and exception counts that the tests keep in sync. They include the canteen (RELEVANT in 2025, CATERING in 2026), wind tunnel offsite lunches, Grand Prix travel and its exceptions, related-party recharges at fair value (2 of 12 adjusted), the Applied Technologies 60/40 split, P&E depreciation (DEPRECIATION, then RELEVANT), the escalation rule and the rejections.
- The 2026 plants: all 13 Red Bull 2021 misstatements re-staged, plus duplicates, a split under the threshold, changed bank details, locked-period backdating, a prior-year canteen invoice in January, a late correction that changes category, and lines coded the 2025 way where the 2026 rules changed.

## Files

| file | what |
|---|---|
| `company.py` | entities, chart of accounts (2026 and 2025 defaults), departments, vendors (valid IBANs), contracts, fair value schedule, 2025/2026 calendars (approximate), FX |
| `generate.py` | seeded generator and CLI |
| `plants.py` | `ERROR_CLASSES`, `EXPECTED_ACTIONS`, the plants and the answer key |
| `patterns.py` | executable 2025 pattern matchers and counts; `--write` refreshes PATTERNS.md |
| `api.py` | FastAPI cursor API and ERP mock |
| `tests/` | `uv run pytest world/tests -q` |
