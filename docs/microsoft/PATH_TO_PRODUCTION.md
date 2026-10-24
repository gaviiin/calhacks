# Path to production

What Pit Wall is today, what it runs on in Azure, and what changes before a real finance team relies on it.

## Today (hackathon build)

- One FastAPI service. Each run's ledger is a SQLite file with a single write path (`propose_entry`) and a deterministic kernel.
- Inputs: cached Jolpica-F1 results and Apify captures of FIA documents.
- People act through the API, Slack, email, Teams and signed links.
- The SpacetimeDB mirror streams the books to the live UI.
- The independent auditor, the Business Central connector and Azure Monitor telemetry are built and tested against mocked services.

## Target architecture on Azure

```
            FIA site ──► Apify actor (scheduled) ──► captures ─┐
     Jolpica-F1 API ──► results fetch (scheduled) ────────────┤
  commercial team ──► billing requests (Teams / API) ─────────┤
                                                              ▼
 ┌──────────────────────── Azure Container Apps ────────────────────────┐
 │  pitwall-api (FastAPI)                                                │
 │    router ─► engine (code) / revenue agent (Claude) ─► propose_entry  │
 │                                     kernel K1-K12 ─► post|park|refuse │
 │    notifier ─► Teams cards · Outlook (Graph) · Slack · SMS            │
 │  pitwall-auditor (job, nightly + on demand)  read-only DB role        │
 │    A1-A7 procedures · Azure OpenAI second opinion · audit memo        │
 │  erp-sync (job)  posted + sealed entries ─► Business Central journal  │
 └───────────────────────────────────────────────────────────────────────┘
        │ managed identity (Entra ID)            │ OpenTelemetry
        ▼                                        ▼
 Key Vault (secrets)                  Application Insights / Log Analytics
 Azure Database for PostgreSQL        alerts: refusals spike, approvals waiting > 4h,
   ledger schema, row-level roles       audit opinion not "unmodified"
 Azure Confidential Ledger (seal anchors)
 Dynamics 365 Business Central (system of record for the close)
```

`deploy/azure/main.bicep` provisions the first box today:
- a user-assigned managed identity;
- Container Registry (pull by role);
- Key Vault (RBAC; secrets by reference, never in app settings);
- Log Analytics and Application Insights;
- a Container Apps environment and app;
- optionally the role "Cognitive Services OpenAI User" on an existing Azure OpenAI account, so the auditor needs no key.

`deploy/azure/deploy.sh` builds the image in ACR and deploys it.

## What changes before real money depends on it

Ordered by risk. Each item names the reason and the done-when.

| # | Change | Why | Done when |
| --- | --- | --- | --- |
| 1 | **SQLite → Azure Database for PostgreSQL** with separate roles: `pitwall_writer` (only through `propose_entry` / `approve`), `pitwall_auditor` (SELECT only), no human write role | Today the seals *detect* a direct edit; database roles *prevent* it. Also: one writer, one replica | The tamper drill's attacks fail with permission errors, and the auditor still runs |
| 2 | **Real identities for approvers**: Entra ID sign-in on the approval page; the approver is the signed-in user, not a name in a link | Signed links prove possession of a link, not identity | K11 compares Entra object IDs; approvals show UPN |
| 3 | **Customer's own policy and approval matrix** loaded as data, reviewed by their auditor | Ours are synthetic | Kernel thresholds and REV policies come from config the controller owns, versioned |
| 4 | **Teams approvals in-app**: a Teams bot with `Action.Execute` (Universal Actions) instead of `Action.OpenUrl` | One tap in Teams, with the user's identity attached | Approve in Teams without leaving it |
| 5 | **Business Central live**: map to the customer's chart of accounts and dimensions (sponsor as a dimension); post via a dedicated journal batch that a person releases | The ERP stays the system of record for the close | Nightly reconcile (`/erp/business-central/reconcile`) shows no differences |
| 6 | **Seal anchors to Azure Confidential Ledger** (`AZURE_CONFIDENTIAL_LEDGER_ENDPOINT`) | A local anchor file is only as safe as the disk it's on | Anchors carry an ACL transaction ID |
| 7 | **Scheduled ingestion** as Container Apps jobs (Apify actor run, results fetch) with dead-letter and alerting | Today captures are cached files | An FIA document reaches the router within 5 minutes of publication |
| 8 | **Model operations**: pin model versions; keep the answer-key grader as a regression suite in CI; shadow-run a new model on the last season before switching | Model updates can change judgments | CI fails if the scorecard drops below 100% on 2023/2024 |
| 9 | **Observability**: dashboards and alerts on the metrics we already emit (`pitwall.entries`, `pitwall.kernel_refusals`, `pitwall.approvals_waiting`) | Ops needs to know before the controller does | Alert rules in Bicep |
| 10 | **Data retention and audit export** per the customer's audit firm | Auditors keep evidence for 7+ years | Audit file export to immutable Blob storage |

## Rollout

1. **Shadow mode, one season.** Pit Wall runs beside the existing process and books nothing in the ERP. Each month-end close, compare its entries with the team's, entry by entry.
2. **Assist mode.** Pit Wall books code-tier entries (base fees, cash receipts) directly. Bonuses and anything judgment-based go to the controller's queue, all approved by a person.
3. **Autonomous within limits.** Code-tier bonuses below materiality post automatically after the FIA final. Judgment calls still need a person. The independent auditor runs nightly; anything other than an "unmodified" opinion pages the controller and pauses ERP sync.

Each step needs a written sign-off from the controller. The kernel's materiality thresholds are her lever for widening or narrowing what runs without her.

## Cost (order of magnitude)

On the 2024 season, the code tier handles almost every entry without a model call. Model calls happen only for:
- unhandled cases (the revenue agent);
- explanations;
- the auditor's second opinion, about a dozen entries per audit plus one memo.

`/api/runs/{id}/costs` and `/impact` report actual calls, tokens and cost per posted entry for any run. Hosting is one Container App at 0.5 vCPU / 1 GiB with one replica, plus Log Analytics ingestion.
