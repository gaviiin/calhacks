"""Systems of record for the simulated constructor (SCHEMA.md section 5).

company.py   the fictional company: entities, chart of accounts, departments, vendors, contracts,
             fair value schedule, season calendars, FX
generate.py  seeded generator: 2025 history + 2026 stream + answer key -> world/out/*.jsonl
plants.py    the planted 2026 errors and the answer key
patterns.py  the learnable 2025 patterns (matchers + counts, mirrored in PATTERNS.md)
api.py       FastAPI cursor API + ERP journal endpoint on :8010
"""
