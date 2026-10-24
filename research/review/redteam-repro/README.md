# Red-team reproductions

Each file here demonstrates a defect found in the Oct 24 review (`research/review/03-red-team.md`). They assert the buggy behaviour, so they pass today. When a defect is fixed, invert the assertion and move the test into the component's own suite as a regression test.

- `ts/redteam.test.ts`: RT1-RT17 against the SpacetimeDB module's in-memory harness. To run, copy `system_of_work/spacetimedb` to a scratch folder, add this file under `test/`, and run `npx vitest run` there.
- `p1_regex_diff.py` to `p7_p15.py`: Python reproductions. Run from the repo root with `PYTHONPATH=. uv run python research/review/redteam-repro/<file>`.
