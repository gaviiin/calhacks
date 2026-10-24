#!/usr/bin/env bash
# Standing-approval + agent-step smoke test over plain HTTP (see REDUCERS.md).
# Needs: spacetime start on :3000, then from system_of_work/:
#   spacetime publish cost-cap-desk --server local --yes --delete-data=always
# and curl + jq.
set -euo pipefail
STDB=http://localhost:3000
DB=cost-cap-desk
CALL="$STDB/v1/database/$DB/call"
SQL="$STDB/v1/database/$DB/sql"
J='Content-Type: application/json'

# Identities: admin, sync, analyst, policy learner, head of cost cap, auto_approver.
ADMIN=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
SYNC=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
ANALYST=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
LEARNER=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
HEAD=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)
AUTO=$(curl -sS -X POST "$STDB/v1/identity" | jq -r .token)

curl -sS -X POST "$CALL/bootstrapAdmin" -H "Authorization: Bearer $ADMIN" -H "$J" -d '[]'
curl -sS -X POST "$CALL/createRoleInvite" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["sync","Sync job","inv-sync-1"]'
curl -sS -X POST "$CALL/claimRole" -H "Authorization: Bearer $SYNC" -H "$J" -d '["inv-sync-1"]'
curl -sS -X POST "$CALL/createRoleInvite" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["ai_cap_analyst","Cap Analyst","inv-analyst-1"]'
curl -sS -X POST "$CALL/claimRole" -H "Authorization: Bearer $ANALYST" -H "$J" -d '["inv-analyst-1"]'
curl -sS -X POST "$CALL/createRoleInvite" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["ai_policy_learner","Policy Learner","inv-learner-1"]'
curl -sS -X POST "$CALL/claimRole" -H "Authorization: Bearer $LEARNER" -H "$J" -d '["inv-learner-1"]'
curl -sS -X POST "$CALL/createRoleInvite" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["human_head_of_cost_cap","Head of Cost Cap","inv-head-1"]'
curl -sS -X POST "$CALL/claimRole" -H "Authorization: Bearer $HEAD" -H "$J" -d '["inv-head-1"]'
curl -sS -X POST "$CALL/createRoleInvite" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["auto_approver","Standing approvals","inv-auto-1"]'
curl -sS -X POST "$CALL/claimRole" -H "Authorization: Bearer $AUTO" -H "$J" -d '["inv-auto-1"]'
curl -sS -X POST "$CALL/loadRulebookEntry" -H "Authorization: Bearer $ADMIN" -H "$J" \
  -d '["CATERING@SECD-ISS07","CATERING","EXCLUDED","SECD-ISS07","D5.1.1.z","2026-01-01",{"none":[]},"Catering","all costs ...",{"none":[]}]'
curl -sS -X POST "$CALL/setSetting" -H "Authorization: Bearer $ADMIN" -H "$J" -d '["materiality_usd_minor","5000000"]'

# Learner proposes a policy (version 0 = next), head approves it.
curl -sS -w 'proposePolicy HTTP %{http_code}\n' -X POST "$CALL/proposePolicy" -H "Authorization: Bearer $LEARNER" -H "$J" \
  -d '["grove-canteen-catering",0,"CATERING","CATERING@SECD-ISS07","{\"vendor_id\":\"ven-017\",\"account_code\":\"6410\"}","Grove Catering on 6410 is the factory canteen","[\"hist-2025-0001\"]",214,"2026-01-01",{"none":[]}]'
PID=$(curl -sS -X POST "$SQL" -H "Authorization: Bearer $HEAD" \
  -d "SELECT id FROM policy WHERE policy_key = 'grove-canteen-catering'" | jq '.[0].rows[0][0]')
curl -sS -w 'approvePolicy HTTP %{http_code}\n' -X POST "$CALL/approvePolicy" -H "Authorization: Bearer $HEAD" -H "$J" \
  -d '['"$PID"',"matches 2025 practice"]'

# grantAutonomy: policyId, evidence (sandbox record JSON, as a string), reason.
curl -sS -w 'grantAutonomy HTTP %{http_code}\n' -X POST "$CALL/grantAutonomy" -H "Authorization: Bearer $HEAD" -H "$J" \
  -d '['"$PID"',"{\"sandbox_run_id\":\"sbx-2026-03-01-a1b2c3d4\",\"sandboxes\":5,\"lines\":1200,\"errors\":0,\"missed_plants\":0}","0 errors over 5 sandboxes"]'
curl -sS -X POST "$SQL" -H "Authorization: Bearer $HEAD" \
  -d "SELECT id, state, autonomy, autonomy_by, autonomy_reason FROM policy WHERE id = $PID" | jq -c '.[0].rows'

# A line, a proposal citing the policy, and an autonomous approval.
curl -sS -X POST "$CALL/upsertGlLine" -H "Authorization: Bearer $SYNC" -H "$J" \
  -d '["gl-000123","gl_line:gl-000123:17","2026-03-14","2026-03","acct-6410","6410","dept-AERO",{"some":"ven-017"},{"none":[]},720000,"GBP",1270000,914400,"Grove Catering - factory canteen March","MARKETING","RACING",{"none":[]}]'
WID=$(curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id FROM work_item WHERE subject_ref = 'gl-000123'" | jq '.[0].rows[0][0]')

# recordStep: runId, step, kind, name, input, outputDigest, outputExcerpt, workItemId?, model?
curl -sS -w 'recordStep HTTP %{http_code}\n' -X POST "$CALL/recordStep" -H "Authorization: Bearer $ANALYST" -H "$J" \
  -d '["cap_analyst-2026-03-14-0a1b2c3d",1,"decision","propose_classification","{\"candidates\":[\"CATERING\",\"MARKETING\"],\"winner\":\"CATERING\",\"why\":\"policy grove-canteen-catering v1 matches vendor and account\"}","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","CATERING via policy 1",{"some":'"$WID"'},{"some":"claude-opus-5-5"}]'

curl -sS -w 'propose HTTP %{http_code}\n' -X POST "$CALL/propose" -H "Authorization: Bearer $ANALYST" -H "$J" \
  -d '['"$WID"',"CATERING","CATERING@SECD-ISS07",{"some":'"$PID"'},"factory canteen under grove-canteen-catering v1","[\"gl-000123\"]",{"none":[]},"deterministic"]'
curl -sS -w 'approve(auto) HTTP %{http_code}\n' -X POST "$CALL/approve" -H "Authorization: Bearer $AUTO" -H "$J" \
  -d '['"$WID"',"standing approval: grove-canteen-catering v1"]'

curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, state, decided_reason FROM work_item WHERE id = $WID" | jq -c '.[0].rows'
curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, actor_role, action, allowed, from_state, to_state, policy_id, policy_version, evidence FROM audit_log WHERE action = 'approve' OR action = 'grant_autonomy'" | jq -c '.[0].rows[]'
# Steps for the run (SQL can't filter the Option column work_item_id; filter on run_id).
curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, run_id, actor_role, step, kind, name, work_item_id, model FROM agent_step WHERE run_id = 'cap_analyst-2026-03-14-0a1b2c3d'" | jq -c '.[0].rows'

# Revoke; the next autonomous approval is denied (committed, HTTP 200) and the item waits for a human.
curl -sS -w 'revokeAutonomy HTTP %{http_code}\n' -X POST "$CALL/revokeAutonomy" -H "Authorization: Bearer $HEAD" -H "$J" \
  -d '['"$PID"',"catering rule change pending"]'
curl -sS -X POST "$CALL/upsertGlLine" -H "Authorization: Bearer $SYNC" -H "$J" \
  -d '["gl-000124","gl_line:gl-000124:18","2026-03-15","2026-03","acct-6410","6410","dept-AERO",{"some":"ven-017"},{"none":[]},350000,"GBP",1270000,444500,"Grove Catering - factory canteen March wk3","MARKETING","RACING",{"none":[]}]'
WID2=$(curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id FROM work_item WHERE subject_ref = 'gl-000124'" | jq '.[0].rows[0][0]')
curl -sS -X POST "$CALL/propose" -H "Authorization: Bearer $ANALYST" -H "$J" \
  -d '['"$WID2"',"CATERING","CATERING@SECD-ISS07",{"some":'"$PID"'},"factory canteen under grove-canteen-catering v1","[\"gl-000124\"]",{"none":[]},"deterministic"]'
curl -sS -w 'approve(auto, after revoke) HTTP %{http_code}\n' -X POST "$CALL/approve" -H "Authorization: Bearer $AUTO" -H "$J" \
  -d '['"$WID2"',"standing approval: grove-canteen-catering v1"]'
curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, state FROM work_item WHERE subject_ref = 'gl-000124'" | jq -c '.[0].rows'
curl -sS -X POST "$SQL" -H "Authorization: Bearer $ANALYST" \
  -d "SELECT id, actor_role, action, allowed, reason FROM audit_log WHERE allowed = false" | jq -c '.[0].rows[]'
