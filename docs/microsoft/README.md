# Pit Wall for the Microsoft track

> Build a production-minded AI agent that solves a meaningful problem in finance.

Pit Wall is an autonomous revenue accountant. It reads real Formula 1 results and real FIA documents, decides what a team has earned under its sponsor contracts, and books it. Agents can only *propose* entries. A deterministic kernel re-checks every one. A person approves anything material. For this track we added the pieces that take it from a demo to something a finance team could deploy on Microsoft:

| Criterion | What we built | Where | How to see it |
| --- | --- | --- | --- |
| **Customer understanding** | Who the user is, the job they do today, what goes wrong, what they will and won't hand over | [CUSTOMER.md](CUSTOMER.md) | Read it |
| **Measurable usefulness** | `/impact`: straight-through rate, dollars protected, minutes from FIA final to booked, people-minutes spent, cost per entry. Every assumption is labelled and set by an env var | `finance/impact.py` | `GET /api/runs/{id}/impact` |
| **Path to production** | Container image, Bicep for Azure Container Apps (managed identity, Key Vault, Application Insights), a one-command deploy, a Business Central connector, and a list of what changes before real money depends on it | [PATH_TO_PRODUCTION.md](PATH_TO_PRODUCTION.md), `deploy/azure/` | `./deploy/azure/deploy.sh` |
| **Responsible design** | An **independent auditor**: read-only, its own code path, a second opinion from **Azure OpenAI** (a different model family from the Claude preparer), and evidence seals anchored outside the books. Mapped to Microsoft's six Responsible AI principles | [RESPONSIBLE_AI.md](RESPONSIBLE_AI.md), `finance/audit/` | `POST /api/runs/{id}/audit/drill` |
| **End-to-end functionality** | Real 2024 season → ledger → approvals in Teams / Outlook / Slack → audit → general journal in Dynamics 365 Business Central | below | the demo script below |

## Microsoft services used

| Service | Role in Pit Wall | Status |
| --- | --- | --- |
| **Azure OpenAI** | Second-opinion reviewer and audit memo for the independent auditor | Built, tested against a fake client; runs live when `AZURE_OPENAI_*` is set |
| **Microsoft Teams** | Approval cards and the audit summary as Adaptive Cards (Workflows webhook) | Built and tested; live with `TEAMS_WEBHOOK_URL` |
| **Outlook / Exchange Online (Microsoft Graph)** | Approval emails and sponsor credit notes from a finance mailbox (`sendMail`) | Built and tested against a mocked Graph |
| **Dynamics 365 Business Central** | Posted entries become balanced general journal lines; optional journal post; reconciliation back from the G/L | Built and tested against a mocked API; dry run produces the exact request bodies |
| **Microsoft Entra ID** | One app registration (client credentials) or a managed identity in Azure; no secrets in code | Built |
| **Azure Container Apps, Container Registry, Key Vault** | Hosting, image build, secrets by reference | Bicep + deploy script written; not yet deployed from this repo |
| **Azure Monitor / Application Insights** | Request traces plus ledger metrics (entries by status, kernel refusals by check, approvals waiting) | Built; on when the connection string is set |
| **Azure Confidential Ledger** | Optional anchor for the evidence-seal chain heads | Built; local append-only file by default |

"Built and tested" means unit tests with the external service mocked (`finance/tests/test_microsoft.py`). Anything that needs a live Microsoft tenant is marked as such. We'd rather say that plainly than overclaim.

## Results on the real 2024 season

These are offline numbers from the scripted agent, so no model was in the loop. They are reproducible with `python -m finance.sim 2024` and then the endpoints below.

| Measure | Result |
| --- | --- |
| Entries posted | 341, books tie |
| Posted with no person involved | 338 (99.1%) |
| Times a person was needed | 3 material entries (6 approvals, controller and CFO) and 2 answered questions |
| Bonuses due / booked correctly / wrong | 90 / 90 / 0 |
| Commercial team's billing requests | 104; all 19 planted errors caught, 0 false alarms |
| Overturned results never invoiced | 5 (Spa 2024: Russell's win was disqualified after the race) |
| Dollars protected | $9.3M (needs the locally generated answer key; $3.7M from overturned results alone) |
| Bonus booked after the FIA final | same simulated event (seconds); a month-end close books it a median 17 days after the race |
| Independent audit | Unmodified opinion; every posted entry tested for integrity, about 200 re-performed from source (all material and judgment entries plus a random 15%) |
| Tamper drill | 4 of 4 direct database attacks caught; the trial balance still tied after every one |

## Demo, five minutes

```bash
uvicorn finance.api:app --port 8000
RID=$(curl -s -XPOST localhost:8000/api/runs -H 'content-type: application/json' \
      -d '{"season": 2024, "stop_before_round": 14, "auto_people": false}' | jq -r .run_id)
curl -s -XPOST localhost:8000/api/runs/$RID/advance -d '{"round": 14}' -H 'content-type: application/json' >/dev/null   # Spa
curl -s localhost:8000/api/runs/$RID/queue | jq        # what's waiting for Dana (also on her Teams card)
curl -s -XPOST localhost:8000/api/runs/$RID/advance -d '{"n": 10000}' -H 'content-type: application/json' >/dev/null

curl -s -XPOST localhost:8000/api/runs/$RID/audit -H 'content-type: application/json' -d '{}' | jq '.opinion, .summary, .memo'
curl -s -XPOST localhost:8000/api/runs/$RID/audit/drill | jq '.attacks[] | {attack, caught, caught_by, books_still_tie}'
curl -s -XPOST localhost:8000/api/runs/$RID/audit/share -H 'content-type: application/json' -d '{"channels": ["teams"]}'
curl -s localhost:8000/api/runs/$RID/impact | jq .headline
curl -s -XPOST localhost:8000/api/runs/$RID/erp/business-central/export -H 'content-type: application/json' -d '{"mode": "dry"}' | jq '.exported, .entries[0]'
curl -s localhost:8000/api/microsoft/status | jq
```

The beat to land: **"The kernel is the lock on the door. The auditor assumes someone climbed in through the window."** In the drill, someone with database access edits a bonus on both lines, so the books still balance. Then they rewrite the seals to cover it. The trial balance can't see either change. The anchored seal chain catches both.
