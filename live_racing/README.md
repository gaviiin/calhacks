# live_racing/: the live financial feed of a race

Turns authentic racing inputs (OpenF1) into timestamped, sourced, actionable financial signals for
the two desks that already exist: the revenue desk (`finance/`) and the cost cap desk (`agents/`,
`system_of_work/`). It does not post entries, approve anything or classify costs; it tells the
desks, in time, what the race just did to the money, and hands incidents over with evidence.

```
 OpenF1 REST (2024, cached) ─► openf1_client ─► normalize (stable ids, UTC, masked future) ─► race_state (as-of T)
                                                                                              │
                                   event_triggers (red flag, stopped car, position swing, weather, FIA document)
                                                                                              │  material candidate
                                              finance_projections (if-finished-now sponsor exposure, the desk's own bonuses_for)
                                                                                              │
                                                     jev_router: TypeSafe System One, one typed request ──► route · urgency · needs_evidence
                                                                                              │  (confidence gates; deterministic fallback)
                       publisher ─► JSONL (always) · SpacetimeDB pit-wall `pit_wall_items` (dashboard) · /live API + SSE · FINANCE_AGENT_URL webhook
```

**What is real:** every OpenF1 record (positions, laps, stints, pits, weather, race control, car 43's
car_data and location in the incident window), the FIA documents for Spa, the F1 race report that
corroborates the crash. **What is synthetic:** Meridian Racing, its sponsor contracts, the garage
report and every dollar figure. **What is a calculation:** the if-finished-now exposure
(`status: indicative`, `financial_source: synthetic`). **What is booked:** nothing, here.

## Run it

```bash
make live-fetch                      # once, with internet: cache the 2024 São Paulo GP from OpenF1 (committed under data/openf1)
make live-replay                     # laps 28-34 at 20x; FROM=30 TO=33 SPEED=inf PAUSE=32 to taste
make live-spa                        # P1: Spa 2024, provisional -> Doc 43 summons -> Doc 44 DSQ -> Doc 46 final
make live-api                        # :8020  POST /live/replay, GET /live/state|/strategy|/plans|/feed, GET /live/stream (SSE), POST /live/incidents/{id}/finance-impact
make jev-smoke                       # credentialed Jev smoke test; BLOCKED without TYPESAFE_API_KEY
uv run pytest -q live_racing/tests   # offline: no network, no SpacetimeDB, no key
```

With `spacetime start` running and `pit-wall` published (`make evidence-publish`), the replay also
upserts rows into `pit_wall_items`: `item_type` `live_race_state` (one row per race, latest state),
`live_incident_signal` (one row per incident, versioned), `live_jev_decision`, `live_finance_impact`,
`live_result_change`, `live_replay_status`; `payload_json` is the record below. The dashboard dev
server proxies `/live` to the API.

## The São Paulo story, from the data

| Time (UTC) | Lap | What the feed says | What the finance feed says |
|---|---|---|---|
| 16:29 | 28 | Russell (car 63) P1, inters, rain | if finished now: $2.74M (Halcyon win $2M, Arcadia podium, Northwind top-6, Volta points) |
| 16:30:17 | 29 | Russell pits under the VSC, P2 then P5 | $2.74M -> $1.74M -> $260k; `financial_threshold_crossed`, route `race_forecast` |
| 16:37:03 | 32 | car 43 speed 0 under the Safety Car (car_data) | `driver_stopped` candidate, attribution provisional, route `human_review` |
| 16:37:22 | 32 | RED FLAG, no driver named | same incident, v2, route `crash_finance`; "race control names no driver" is in the evidence |
| +60 s replay | | F1 race report applied | v3 `verified_historical_incident`, Jev asked again as `confirmed`, hand-off `cost_cap_agent` requested, financial impact still `unknown` |
| later | | Person 2 posts `FinanceImpactUpdate` | v4 `assessed`, projected not booked |

Measured on this machine on 2026-10-24, laps 28-34 at `--speed inf`, Jev live (`jev-latest` answered as
`jev-1.14.0`): 2,873 events, 228 state updates, 2 incidents, 15 duplicates suppressed, 0 Jev calls on
telemetry ticks, 9 Jev requests (one per material candidate, plus one at corroboration), 0 errors,
Jev p50 67 ms / p95 98 ms, adapter received to published p95 1 ms. The labeled fixtures: 11 of 11
routed as expected live, 11 requests, p50 68 ms, p95 167 ms (`make jev-smoke`). Without a key the
same replay runs with every decision labelled `unavailable`.

## The strategic layer: what every lever costs, and what a crash could cost

Added on 2026-10-24 for the pit wall's "instant financial advisor" use. All of it is arithmetic on the
timing feed and the synthetic contracts; none of it predicts pace or tyre wear.

- **`strategy_advice`** (`strategy.py`, published on every team-car position change, flag change and
  pit stop; `GET /live/strategy`): the sponsor exposure now, at the join and at its peak, and what has
  been given up since the peak; for each team car the value of one place up and one place down
  (`places[]`), what pitting now would cost (`pit[]`: this race's median pit-lane time, halved under
  the Safety Car, free under a red flag, the cars that would get past from their lap-start gaps, the
  rejoin position and the dollar delta), and the tyre context (`tyres[]`: compound, age, field median;
  no degradation model is pretended).
- **`incident_plan`** (`incident_planner.py`, published for every incident on a watched car;
  `GET /live/plans`): the outcomes priced against the same contracts: continue, pit now, repair and
  rejoin (kept position under a red flag, a 90 s stop otherwise, stated as an assumption), 5 s and
  10 s penalties, a drive-through, retiring, disqualification; each with the position after, the
  exposure after, the delta, the clauses lost or gained and the constructors' position. The damage
  estimate stays `null` until a garage report arrives; the cost-cap note says why.
- **The live finance agent** (`advisor.py`): a Claude draft on each plan, off the ticker thread, so a
  plan is published at once with `advisor.status: pending` and republished when the model answers
  (`recommended_scenario`, `headline`, `rationale`, `what_we_need`, `confidence`, latency, model).
  It may only pick a scenario code priced and may only use the figures in the plan; `used` is false
  and the status says why whenever it did not answer. `claude-opus-5-5` (or `LIVE_ADVISOR_MODEL`),
  adaptive thinking at low effort, the desks' server-side refusal fallback; `LIVE_ADVISOR=off` silences it.
  Measured live on 2026-10-24: two plans answered in 6.5 s and 6.7 s, both grounded (the car-43 plan
  said "not ours; prepare for retirement, exposure unchanged").
- **`feed_health`** (`health.py`, every 5 s of wall time while running; `GET /live/feed`): how alive the
  feed is, measured: publishes per minute and per second, seconds since the last publish, the race
  clock, every sink's rows written / errors / last write (`spacetimedb` is the dashboard's table),
  Jev's request stats, the advisor's mode, and the exposure tally.

## Contracts (plan section 6, frozen in `schemas.py`)

- `RaceStateUpdate` (Person 1 -> Person 3): lap, flag, weather, every driver's position/tyre/status as
  known at `event_time_utc`, the `Forecast` (if finished now) and the `ForecastChange` since the last
  publish, `timestamps` (source_event, adapter_received, finance_recomputed, state_published).
- `IncidentSignal` (Person 1 -> Person 2 + 3): stable `incident_id`
  (`<race>:race:lap32:car43:crash_candidate`), `version`, `driver_attribution`, `source_evidence`
  (exact endpoints and times), `sporting_confirmation`, `damage_confirmation`, the `jev` decision
  (or the honest record that Jev was unavailable), `financial_impact` (`unknown` until a garage
  report), `handoff`.
- `FinanceImpactUpdate` (Person 2 -> Person 1): by `incident_id`, strict schema (extra fields are
  refused, so no journal entry or approval can ride along), stored and republished as `assessed`.
- `ResultChangeSignal` (Person 1 -> revenue desk + 3): the FIA document, the before/after
  forecasts and the message `Provisional expected bonus corrected; awaiting recognized-revenue policy gate`.

Delivery is at least once with stable ids and versions; every consumer upserts.

## Jev (TypeSafe System One)

`jev_router.py` sends one request per material candidate to `POST /v1/systemone` with three typed
questions: `route` (Choice over `crash_finance`, `revenue_change`, `race_forecast`, `human_review`,
`no_action`), `urgency` (Score over four levels) and `needs_evidence` (Noul). Code keeps control
(`JevRouter.policy`, tuned on the labeled cases after the first live run, where correct answers at
confidence 0.56 to 0.60 were being demoted by a flat 0.75 gate; on five options 0.75 means p_max 0.8):

- Jev picking the same route code did is two signals: accepted from confidence 0.40;
- a different route needs 0.75 and a top-2 gap of 0.15; otherwise a person decides, unless code's
  own route was only a forecast refresh, which then stands;
- `no_action` never wins a material event; a `crash_finance` or `revenue_change` trigger can at most
  be sent to a person first, never turned into a forecast refresh; taking "a person verifies" down
  to "refresh the forecast" needs 0.90;
- 401/422/429/5xx/timeout/odd shapes give `used=false, status=unavailable` and the deterministic
  route, with no invented confidence; race-control text is sent as quoted data under
  `untrusted_text_fields`.

Labeled cases: `fixtures/jev_cases.json` (11, run offline by `tests/test_jev_router_mock.py` and live
by `scripts/smoke_test_jev.py`). Live on 2026-10-24: the correlated red flag came back at 0.47 and went
to a person; after corroboration Jev is asked again with `driver_attribution: confirmed`.

## Honesty rules the code enforces

- A record's `event_time_utc` is the source's; `observed_at_utc` is when the replay saw it.
- A stint's end lap, a lap's time before it ends, and `session_result` are never visible to the
  state (`tests/test_race_state_no_lookahead.py`).
- "RED FLAG" alone yields `red_flag:needs_confirmation`; a driver is attached only from car_data
  (`provisionally_correlated`) or a race-control message that names a car, and is `confirmed` only
  after the corroborating public source is applied.
- No Jev call on a position tick, a weather sample or a car_data sample: candidates only.
- The two Williams facts the fiction borrows (the car, the crash) are labelled; Williams' costs are
  not public and no figure here is presented as theirs.

## Layout

| File | What it is |
|---|---|
| `races.py` | the races, how to discover their sessions, the focus window, the corroborating sources |
| `openf1_client.py` | cached REST client (manifest with `source_url`, `retrieved_at`, sha256), rate limit, bounded retries |
| `normalize.py` | stable ids, UTC, lookahead masking, deterministic order |
| `race_state.py` | the as-of reducer; stopped-car detection from car_data outside pit stops and red flags |
| `event_triggers.py` | deterministic candidates, incident ids, cooldowns, stewards' follow-ups |
| `finance_projections.py` | if-finished-now exposure through `finance.bonuses.bonuses_for`; `diff` |
| `jev_router.py` | the TypeSafe adapter, gates, fallback, cache, budget, latency |
| `publisher.py` | memory bus, JSONL, SpacetimeDB `mirror_item`, webhook |
| `strategy.py`, `incident_planner.py`, `advisor.py`, `health.py` | place and pit-stop values, priced accident outcomes, the Claude advisor, feed health |
| `replay.py`, `result_replay.py` | the OpenF1 replay and the FIA-document (Spa) replay |
| `api.py` | the `/live` FastAPI app (:8020) |
| `scripts/fetch_openf1_brazil_2024.py`, `scripts/replay_brazil_2024.py`, `scripts/replay_spa_2024.py`, `scripts/smoke_test_jev.py` | the commands |
| `data/openf1/2024_brazil/raw`, `derived` | the cache (manifest + raw responses) and the replayable slice (`events.jsonl`, `meta.json`) |

Not built (stretch, by design): live MQTT, a crash predictor, a tyre strategy engine, learned
probabilities. The dashboard panels for this feed are Person 3's; the data is on `/live/state`,
`/live/stream` and in `pit_wall_items`.
