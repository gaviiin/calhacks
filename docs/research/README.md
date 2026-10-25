# docs/research: F1 finance review (snapshot, 24 Oct 2026)

A dated snapshot from before the Anneal pivot. It was written against the revenue and cost cap desks (Meridian, Spa 2024), which now sit behind **Books**. The current product and pitch are in `README.md`, `docs/PITCH.md` and `docs/DEMO.md`; where they differ, they win.

There are two research folders in this repo. They don't replace each other.

| Folder | Owner | What it is |
| --- | --- | --- |
| `research/` (repo root) | Gavin | The team's background research, written before and during the build: F1 team finance (`01`), Hyphenate and sponsors (`02`), tooling (`03`), the Hyphenate workshop deck (`04`), and the FIA regulation texts in `research/fia/`. The rulebook in `rulebook/` is built from it. |
| `docs/research/` (this folder) | Alex | A source-checked review of an external F1-finance deep dive, done by a read-only reviewer agent against FIA primary sources and this repo's code. |

## How they relate

- **They agree on nearly every fact.** Cap levels, the 2% / 5% overspend bands, the 2026 catering and health-and-safety exclusions, the Red Bull, Aston Martin and Williams settlements, the fair-value rule, and the 31 March deadline match in both.
- **This folder cites newer FIA issues.** `research/` and `rulebook/rulebook.json` use Section D **Issue 07**, Section A **Issue 02** and the 2021–25 Financial Regulations **Issue 22**. This folder verified against Section D **Issue 08** (1 Oct 2026), Section A **Issue 03** and the 2025 Financial Regulations **Issue 25**. The Issue 07→08 diff is already in `research/fia/secD_iss07_to_iss08.diff.txt`. The visible difference so far is the power unit supply price: €22m for 2026–28 and €20.75m from 2029 (Section A Issue 03), which `research/01` lists as uncertain.
- **This folder adds code-level findings.** Each deep dive says how the revenue desk's code handled the case on 24 Oct (file:line) and gives given/when/then acceptance tests.

## What's here

- `f1-finance-leads.md`: verification, corrections that affect the code, a pitch fact-check, lead triage, and six deep dives. File and line references are as of 24 Oct and may have moved.

Nothing in `research/` was changed or removed. If the two folders ever disagree, say so in a PR and check the FIA source; don't silently pick one.
