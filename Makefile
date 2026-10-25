# Pit Wall: one target per component. Two desks (revenue, cost cap), one evidence feed, one dashboard.
# SCHEMA.md is the cost cap desk's contract; finance/README.md is the revenue desk's.
SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)
# Local dev only. The world mock accepts this key by default; never reuse it anywhere real.
export GATEWAY_KEY ?= dev-gateway-key
# .env (gitignored) holds ANTHROPIC_API_KEY and the integration secrets. Sourced by the shell, not
# included by make, so values such as SLACK_CHANNEL_FINANCE=#pit-wall survive.
ENV := set -a; [ -f .env ] && . ./.env; set +a;
# The agents call Claude when ANTHROPIC_API_KEY is set (and fall back to offline with a warning
# when it is not). OFFLINE=1 forces the deterministic path.
AGENT_MODE := $(if $(OFFLINE),--offline,)

.PHONY: setup test stdb-start bindings dashboard landing \
        rulebook world api stdb-publish stdb-test bootstrap advance sync learner review-policies \
        analyst standing review-items gateway redteam score cost-cap-run \
        revenue-api revenue-sim revenue-demo evidence-publish evidence-replay \
        race-publish race-grant race-fixtures race-replay race-tape race-live race-onboard race-learn race-review-policies race-test

# ---------------------------------------------------------------- shared

setup:            ## install python deps and every node package
	uv sync
	cd system_of_work/spacetimedb && npm install
	cd spacetimedb && npm install
	cd frontend && npm install
	cd landing && npm install

test:             ## every python test (both desks, evidence pipeline, rulebook, world)
	uv run pytest -q

stdb-start:       ## run a local SpacetimeDB on :3000 (foreground); hosts cost-cap-desk and pit-wall
	spacetime start

bindings:         ## regenerate the dashboard's TypeScript bindings for both modules
	spacetime generate --lang typescript --out-dir frontend/src/module_bindings --module-path spacetimedb
	spacetime generate --lang typescript --out-dir frontend/src/cost_cap_bindings --module-path system_of_work/spacetimedb

dashboard:        ## the Pit Wall dashboard on :5173 (both desks, evidence, audit)
	npm run dev --prefix frontend

landing:          ## the marketing page on :5175
	npm run dev --prefix landing

# ---------------------------------------------------------------- cost cap desk (agents/, system_of_work/)

rulebook:         ## build rulebook/rulebook.json from research/fia/*.txt
	uv run python -m rulebook.build_rulebook

world:            ## generate the cost side's systems of record (2025 history + 2026 stream + answer key)
	uv run python -m world.generate --seed 7 --out world/out

api:              ## serve the cost side's systems-of-record cursor API on :8010
	uv run uvicorn world.api:app --port 8010 --reload

stdb-publish:     ## publish the cost cap module as cost-cap-desk (wipes its data and agents/state/)
	cd system_of_work && spacetime publish cost-cap-desk --server local --delete-data=always --yes
	rm -rf agents/state
	@echo "removed agents/state/ (sync cursors, dead letters, gateway ledger belonged to the old db_epoch); run 'make bootstrap' next"

stdb-test:        ## in-memory unit tests for the cost cap module (vitest)
	cd system_of_work/spacetimedb && npm test

bootstrap:        ## create identities, claim roles, load rulebook + settings, mint the dashboard's seat codes
	uv run python -m agents.bootstrap

advance:          ## move the cost world's sim clock forward (DAYS=31 by default)
	curl -s -X POST localhost:8010/clock/advance -H 'content-type: application/json' -d '{"days": $(or $(DAYS),31)}'; echo

sync:             ## run the sync job once (world -> golden rows -> work items)
	uv run python -m agents.sync --once

learner:          ## Policy Learner onboarding pass over 2025 history (Claude reviews each draft)
	$(ENV) uv run python -m agents.policy_learner --onboard $(AGENT_MODE)

review-policies:  ## the Head of Cost Cap approves the proposed policies (REJECT="key=reason" to reject one)
	uv run python -m agents.review policies --approve-all $(if $(REJECT),--reject "$(REJECT)",)

analyst:          ## Cap Analyst over the NEW queue once (Claude decides what no policy covers)
	$(ENV) uv run python -m agents.cap_analyst --once --limit 500 --include-rejected $(AGENT_MODE)

standing:         ## approve what an approved rule decided, at any amount; only new scenarios wait for a person
	uv run python -m agents.auto_approver --once

review-items:     ## (by hand) the Controller approves code-decided proposals below materiality in one batch
	uv run python -m agents.review items --approve-all --source deterministic --below-materiality

gateway:          ## post APPROVED items to the ERP mock once
	uv run python -m agents.gateway --once

redteam:          ## probe the roles matrix: every forbidden action must be denied and logged
	uv run python -m agents.redteam --probe

score:            ## score proposals against the truth file (writes agents/out/scorecard.json for the dashboard)
	uv run python -m agents.score

cost-cap-run:     ## January end to end against a fresh module (needs stdb-start and api running)
	$(MAKE) stdb-publish bootstrap advance sync learner review-policies analyst standing gateway redteam score

# ---------------------------------------------------------------- revenue desk (finance/) and evidence (ingestion/, spacetimedb/)

evidence-publish: ## publish the evidence + revenue mirror module as pit-wall (wipes its data)
	spacetime publish --server local --module-path spacetimedb --delete-data=always -y pit-wall

evidence-replay:  ## replay every saved Apify capture (FIA documents, then decision extracts) into pit-wall
	@for f in ingestion/captures/*.json; do uv run python ingestion/ingest.py replay "$$f" | tail -1; done
	@for f in ingestion/captures/decisions/*.json; do uv run python ingestion/ingest.py replay-decisions "$$f" | tail -1; done

revenue-api:      ## the revenue desk API on :8000, streaming entries into pit-wall for the dashboard
	$(ENV) SPACETIME_MIRROR=$${SPACETIME_MIRROR:-1} uv run uvicorn finance.api:app --port 8000

revenue-sim:      ## train on 2023 (controller rulings become rules), then score the 2024 season
	$(ENV) uv run python -m finance.sim 2023 --fresh
	$(ENV) uv run python -m finance.sim 2024

revenue-demo:     ## Act 1: replay the real Spa 2024 weekend, narrated
	$(ENV) uv run python -m finance.demo --round 14 --pace 120

# ---------------------------------------------------------------- race desk (race/): live race cost and revenue for Williams

RACE_SESSION ?= 11291
RACE_PACE ?= 60
RACE_FROM_LAP ?= 0

race-publish:     ## publish pit-wall with the race tables (keeps data when the schema allows), then regenerate bindings
	spacetime publish --server local --module-path spacetimedb -y pit-wall
	$(MAKE) bindings

race-grant:       ## give this machine's CLI identity the 'race' writer role in pit-wall
	uv run python scripts/race_grant.py

race-fixtures:    ## download one OpenF1 session into race/fixtures/ (free tier, about 30 requests a minute)
	uv run python -c "from pathlib import Path; from race.openf1 import save_fixture; print(save_fixture($(RACE_SESSION), Path('race/fixtures')))"

race-replay:      ## replay RACE_SESSION at RACE_PACE into pit-wall (RACE_FROM_LAP=10 jumps ahead; OFFLINE=1 for no Jev/Claude)
	$(ENV) uv run python -m race.replay --session $(RACE_SESSION) --pace $(RACE_PACE) --from-lap $(RACE_FROM_LAP) $(if $(OFFLINE),--offline,)

race-tape:        ## print the tape only, nothing written (quick check of a session)
	uv run python -m race.replay --session $(RACE_SESSION) --pace 0 --no-sink --offline --no-forecast --fixtures-only

race-live:        ## subscribe to OpenF1's live MQTT feed (needs OPENF1_USERNAME / OPENF1_PASSWORD, paid tier)
	$(ENV) uv run python -m race.live --team $(or $(RACE_TEAM),Williams)

race-onboard:     ## the learner drafts race policies from Williams' 2025-26 history (Claude reviews each; OFFLINE=1 skips review)
	$(ENV) uv run python -m race.policy_learner --onboard $(if $(OFFLINE),--offline,)

race-learn:       ## turn corrections and Jev contradictions since the last run into proposed child policies
	$(ENV) uv run python -m race.policy_learner --learn $(if $(OFFLINE),--offline,)

race-review-policies: ## the Head of Racing Finance grants autonomy to every shadow policy (REJECT="id=reason" to refuse one)
	uv run python -m race.policy_learner --approve-all $(if $(REJECT),--reject "$(REJECT)",)

race-test:        ## race desk tests: pytest race/tests + the module's vitest
	uv run pytest -q race/tests
	cd spacetimedb && npm test
