# Cost Cap Desk: one target per component. See SCHEMA.md for the contract.
SHELL := /bin/bash
export PATH := $(HOME)/.local/bin:$(PATH)
# Local dev only. The world mock accepts this key by default; never reuse it anywhere real.
export GATEWAY_KEY ?= dev-gateway-key

.PHONY: setup rulebook world api stdb-start stdb-publish stdb-test bootstrap sync analyst learner gateway test advance redteam

setup:            ## install python deps and module deps
	uv sync
	cd system_of_work/spacetimedb && npm install

rulebook:         ## build rulebook/rulebook.json from research/fia/*.txt
	uv run python -m rulebook.build_rulebook

world:            ## generate the simulated company (2025 history + 2026 stream + answer key)
	uv run python -m world.generate --seed 7 --out world/out

api:              ## serve the systems-of-record cursor API on :8010
	uv run uvicorn world.api:app --port 8010 --reload

stdb-start:       ## run a local SpacetimeDB on :3000 (foreground)
	spacetime start

stdb-publish:     ## publish the module to the local server as cost-cap-desk (wipes data and agents/state/)
	cd system_of_work && spacetime publish cost-cap-desk --server local --delete-data=always --yes
	rm -rf agents/state
	@echo "removed agents/state/ (sync cursors, dead letters, gateway ledger belonged to the old db_epoch); run 'make bootstrap' next"

stdb-test:        ## in-memory unit tests for the module (vitest)
	cd system_of_work/spacetimedb && npm test

bootstrap:        ## create identities, claim roles, load rulebook + settings into the module
	uv run python -m agents.bootstrap

sync:             ## run the sync job once (world -> golden rows -> work items)
	uv run python -m agents.sync --once

analyst:          ## run the Cap Analyst over the NEW queue once (offline: no API key needed)
	uv run python -m agents.cap_analyst --once --offline --limit 500

learner:          ## run the Policy Learner onboarding pass over 2025 history
	uv run python -m agents.policy_learner --onboard --offline

gateway:          ## post APPROVED items to the ERP mock once
	uv run python -m agents.gateway --once

test:             ## python tests
	uv run pytest -q

advance:          ## move the world's sim clock forward (DAYS=31 by default)
	curl -s -X POST localhost:8010/clock/advance -H 'content-type: application/json' -d '{"days": $(or $(DAYS),31)}'; echo

redteam:          ## probe the roles matrix: every forbidden action must be denied and logged
	uv run python -m agents.redteam --probe
