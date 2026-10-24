# Deploy Pit Wall to Azure

## One command

```bash
az login
./deploy/azure/deploy.sh                       # resource group pitwall-rg, westus3
```

This script:
1. creates an Azure Container Registry and builds `deploy/azure/Dockerfile` in it (no local Docker needed);
2. deploys `main.bicep`: a managed identity, Key Vault holding `pitwall-secret`, Log Analytics, Application Insights, and a Container Apps environment and app wired to all of them.

It prints the app URL. If the first run fails pulling the image, the role assignment hadn't propagated yet; run the script again.

With the independent auditor on Azure OpenAI (granted by role, so no key is stored):

```bash
AOAI_ENDPOINT=https://<resource>.openai.azure.com AOAI_DEPLOYMENT=<deployment> \
AOAI_RESOURCE_ID=$(az cognitiveservices account show -n <resource> -g <rg> --query id -o tsv) \
./deploy/azure/deploy.sh
```

Check the template before deploying:

```bash
az bicep build -f deploy/azure/main.bicep --stdout >/dev/null && echo ok
```

## Smoke test

```bash
URL=https://<app>.azurecontainerapps.io
curl -s $URL/api/microsoft/status
RID=$(curl -s -XPOST $URL/api/runs -H 'content-type: application/json' -d '{"season": 2024}' | jq -r .run_id)
curl -s -XPOST $URL/api/runs/$RID/audit -H 'content-type: application/json' -d '{}' | jq .opinion
curl -s $URL/api/runs/$RID/impact | jq .headline
```

## More integrations (set as Container App secrets from Key Vault)

| Integration | Variables | Entra ID permission |
| --- | --- | --- |
| Teams cards | `TEAMS_WEBHOOK_URL` (Workflows: "Post to a channel when a webhook request is received") | none |
| Outlook via Graph | `EMAIL_TRANSPORT=graph`, `GRAPH_SENDER` | Microsoft Graph `Mail.Send` (application), limited to the sender mailbox with an Exchange application access policy |
| Business Central | `BC_ENVIRONMENT`, `BC_COMPANY_ID`, `BC_JOURNAL_ID` | Dynamics 365 Business Central `API.ReadWrite.All` (application); add the app in BC's "Microsoft Entra Applications" page with D365 ACCOUNTANTS permissions |
| Confidential Ledger anchors | `AZURE_CONFIDENTIAL_LEDGER_ENDPOINT` | Contributor role on the ledger |

Outside Azure (laptop, CI), use one app registration: `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`.

## What this deploys, and what it doesn't

- It deploys **one replica with SQLite on an ephemeral volume**: right for a demo, wrong for production. Runs are lost on restart. See `docs/microsoft/PATH_TO_PRODUCTION.md` item 1: Azure Database for PostgreSQL with separate writer and auditor roles.
- The answer key (`keys/`) is never put in the image, so `/scorecard` billing grading is off in Azure. That is on purpose.
