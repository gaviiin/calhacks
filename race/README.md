# Race desk: live race cost and revenue for Williams

Every race condition that touches the car or the team's money is recorded as it happens, priced as a band, and
written to SpacetimeDB so the dashboard (`#/race`) moves live. After a big incident an agent plans the repair
and the money: parts, spares, lead time against the next race, cost-cap headroom, projected prize money.

```
OpenF1 (replay of a past session | live MQTT) -> race/normalize.py -> RaceEvent
   -> race/policies.py   approved policies decide without a model (Ripple-Down Rules, learned from history)
   -> race/jev.py        System One: Jev (TypeSafe AI) answers typed questions in 70-500 ms, with probabilities
   -> race/effects.py    bands on account 6050/5200/6300, projected prize money, sponsor bonuses, cap headroom
   -> race/sink.py       pit-wall tables race_events, car_state, race_effects, race_forecasts, race_policies, race_precedents
   -> race/forecast_agent.py   System Two: Claude plans the repair and the season after an incident (offline fallback)
   -> race/policy_learner.py   onboarding from 2025-26 history; children from corrections and Jev contradictions
```

## The race-day flow (race/weekend.py)

`make race-demo` replays a whole weekend (São Paulo 2024: qualifying 9627, then the race 9636) and runs seven stages
after every event, each its own module writing its own pit-wall table:

| Stage | Module | Table | Decides |
|---|---|---|---|
| 1 Detect | `telemetry.py` (in `normalize.py`) | `race_events` (`car_stopped`) | code: 100+ km/h to under 25 with the brake on, or telemetry frozen on OpenF1's sentinel values |
| 2 Log | `incidents.py` | `race_incidents`, `race_beliefs` | code; a person's answer assesses |
| 3 Respond | `logistics.py` | `race_actions` | the playbook; outward or irreversible actions wait for their owner (the module refuses anything else) |
| 4 Account | `ledger.py` | `race_entries`, `race_entry_lines` | code; balanced, with when the cap counts each line |
| 5 Ask | `questions.py` | `race_questions` | a person, when expected loss tops `RACE_ASK_PRICE_USD` or Jev is below `RACE_ASK_FLOOR` |
| 6 Re-plan | `season_sim.py`, `cap_forecast.py` | `race_sims` | code (numpy, 10,000 seasons, one seed per weekend) |
| 7 Close | `close.py`, later `trueup.py` | `race_closes` | Claude drafts, a check rejects any figure not in the snapshot; the CFO approves |

Execution follows a person's call. When the Team Principal chooses repair, spare tub or withdraw (in the dashboard, or
replayed from `data/snapshot_1249.json`), `Weekend.follow_decisions` reads the choice back from `race_actions` and
re-plans the incident: the FIA notice becomes the one draft for that choice, still waiting for the Sporting Director to
send it, and the parc fermé list is cancelled once the car is withdrawn. The dashboard's incident strip follows one
incident through the same modules as six steps: seen, engineering call, race call, next steps, books, season.

Learning has eras (`policy_learner.ERAS`): São Paulo 2024 learns only from Williams' 2024 races before it
(`make race-onboard-2024`, store `data/precedents_2024.jsonl`, policies `race-y2024-*`) plus two press-sourced practice
crashes, so a replay never matches its own future. Every assumption is in `data/williams_2024.json` with its basis.

## pit-wall is the backend, not a store

The rules that must hold no matter which process misbehaves live in the pit-wall module (`spacetimedb/src/index.ts`),
not in Python:

- **One door, one audit row.** Every decision that moves money or speaks for a person goes through `gate()`: the module
  resolves who is calling from the connection's identity (never from a `by` argument), checks the rule, then applies the
  change or refuses it, and writes exactly one `race_audit` row in the same transaction. A refusal is committed, never
  thrown, so the attempt is on the record even when nothing changed.
- **The database authorizes postings.** The desk asks (`request_race_posting`); the module answers `authorized` or
  `held` for a named review role from the entry, the estimate behind it and the CFO's rules (`race_rules`): under
  $250,000 the desk may post; from $250,000 the head of cost cap decides; from $1,000,000 the CFO; an estimate that is
  only Jev's or the forecast agent's needs a person's sign-off (`race_signoffs`) first. A sign-off re-runs the decision
  in the same transaction. The ERP (`world/api.py`) accepts a race entry only when pit-wall authorized it, so an agent
  holding the gateway key still cannot post around the rule (403; 503 if pit-wall cannot be asked).
- **People are seats.** `grant_seat` gives an identity a role and a name (`race_seats`); decisions are recorded under that
  name. The publisher's identity runs the agents and never counts as a person. Agents are refused every person
  decision, a seat must be at least as senior as the role an entry was held for, and the person who signed off an
  estimate cannot also approve its posting.
- **The database keeps time.** A question's deadline is a scheduled reducer (`race_question_timers`): when it comes due the
  module takes the stated default even if no agent is running. The replay's pace (`set_race_clock`) maps race time to
  the wall clock. A default applies the conservative option but signs nothing off.
- **Measured, live.** `race_latency` is measured inside the transaction (desk read -> commit); `race_online` is kept by
  the connect/disconnect hooks. The race-day views show both, the dashboard's own commit-to-screen time, and the audit
  trail (`views/roles/PitWallProof.tsx`).

Seat people on their own devices (each browser has its own pit-wall identity, shown on the strip):

```bash
uv run python scripts/race_grant.py --role race_head --identity <hex> --name "Morgan Hale"
uv run python scripts/race_grant.py --role head_of_cost_cap --identity <hex> --name "Priya Shah"
uv run python scripts/race_grant.py --role cfo --identity <hex> --name "Dana Okafor"
```

## Run

```bash
make stdb-start                         # SpacetimeDB on :3000 (another terminal)
make race-publish                       # pit-wall with the race tables, bindings for the dashboard
make race-grant                         # this machine's CLI identity may write race rows
make dashboard                          # :5173, then open #/race
make race-replay                        # 2026 Canada (session 11291) at 60x: Albon out on lap 12
make race-replay RACE_FROM_LAP=10       # jump to the crash
make race-replay RACE_SESSION=9693      # 2025 Australia: Sainz lap-1 crash, race control names no car
OFFLINE=1 make race-replay              # no Jev, no Claude, no network (fixtures only)
make race-onboard && make race-review-policies   # learn race policies from history; the head grants autonomy
make race-test
```

Env (`.env`, gitignored): `TYPESAFE_API_KEY` (Jev; a TypeSafe console key, or a Vercel AI Gateway `vck_` key,
routed automatically), `ANTHROPIC_API_KEY` (forecast agent and policy review), `OPENF1_USERNAME` /
`OPENF1_PASSWORD` (live MQTT, OpenF1 paid tier), `RACE_TEAM` (default Williams), `RACE_OFFLINE=1`.

## What OpenF1 says, and does not

- **Retirements are never announced.** Race control posts collisions, penalties, flags and safety cars, but no
  "car stopped". The normaliser flags `retirement_suspected` when a car's laps stop for 2.5 median laps while
  the track is not red, and confirms from `session_result.dnf`. In Canada 2026 that call lands two minutes before
  the stewards' first message about Albon; in Melbourne 2025 race control never names Sainz at all.
- **Incident messages lag and are free text**: `TURN 10 INCIDENT INVOLVING CARS 81 (PIA) AND 23 (ALB) NOTED -
  CAUSING A COLLISION (16:25:37)` arrives at lap 16 for a lap-12 crash; the bracketed clock is the real time.
- Historical data is free (about 30 requests a minute, cached under `race/.cache`); live data needs the paid
  tier (MQTT `mqtt.openf1.org:8883`, topics `v1/<endpoint>`). Fixtures for sessions 11291 and 9693 are checked in.

## Money, stated plainly

Every number is a band with a basis. Part prices (`race/prices.py`) are press figures or our assumptions,
calibrated to Vowles' "more than three, less than ten" million for five 2024 crashes. The prize ladder is the
synthetic `world/prize_table.json` (real constructors' payouts are confidential; press estimates put a place at
$8-9m). Sponsors and bonus clauses are Meridian's synthetic contracts. Spares (`race/data/williams_spares.json`)
are an assumption. Live revenue is therefore a change in *projected* season prize money and bonus status.

## Learned first: the tiers, and who decides

| Tier | Decides | Shown as |
| --- | --- | --- |
| Policy (`race_policies`, GRANTED) | a learned rule with a licence (or a person's grant); no model call | `policy` chip, solid |
| Precedent (`race/data/precedents.jsonl`) | the team did this before and it scored the same: the nearest cases' protocol | `precedent` chip, solid |
| Jev (System One) | typed answers with probabilities for anything nothing learned covers | `jev` chip with ms and P(severity) |
| Claude (System Two) | the repair and money plan after an incident; policy drafts | forecast panel; `claude` chip |

**The licence.** A policy earns autonomy from its evidence, inside the database: with n precedents of which a share
p ended the way the policy says, the 90% Wilson lower bound of p must clear 0.75 with at least 5 cases. 12 of 12
passes (lb 0.82), 52 of 52 is 0.95, 3 of 3 (lb 0.53) stays a SHADOW that only watches. A person can revoke or
suspend, and the learner can never grant more than the evidence does. On the 2025-26 Williams history four of the
five drafted policies are licensed on day one (routine pit stop 52/52, safety-car stop 33/33, procedural
infringement 16/16, collision-and-carried-on 12/12); "stopped with no stewards' message" (6/6, lb 0.69) is not.

**Precedents.** Every historical case and every correction is a stored case with a small feature vector (kind, the
stewards' reason words, retired within two laps, pitted straight after, track status, damage likely, compound and
tyre age for pit stops). For a new event the store takes the seven nearest cases; when at least three score 0.85 or
above and 80% agree, their outcome is the protocol and it books the money on its own authority, naming the cases.
Albon's lap-12 stop in Canada matched six earlier Williams stops (Melbourne 2025, Austria 2025, Austria 2026...) at
similarity 0.99 and was booked heavy, $1.7m mid, before any model was asked. A wing replacement after light contact
or a tyre set under the safety car work the same way.

A correction in the dashboard writes a `race_precedents` row, becomes a stored case carrying the band the person
booked, and counts a contradiction on the policy; three alike corrections, or a contradiction rate over 20%, make the
learner draft a child policy.

The forecast agent runs twice when the evidence changes: once on our own retirement call (minutes before the
stewards speak, so the first plan usually reads "no contact recorded, likely mechanical") and again when the
stewards' collision message lands with who hit whom. Each run is its own `race_forecasts` row; the dashboard
shows the latest. Measured on 2026 Canada: 15 Jev decisions at about 150 ms each, two Claude plans at 45-55 s.

Replay vs replay: `#/replay` is the teammate's race replay (Meridian's sponsors on the car, the speed
scoreboard, `racedesk/` API over Jolpica data); `#/race` is this live desk over OpenF1 and SpacetimeDB. The
car drawing, figures strip, running order and line chart on `#/race` come from the replay's components.

## Future: quantitative finance on the event stream

`capsim/` already runs Monte Carlo ends of season for the cap. The next steps, in order: re-run a season
simulation after every event (pace model from OpenF1 lap times, a DNF hazard from 2023-26 history) for P10/P50/P90
bands on constructors' position, prize money and cap headroom; fit part-damage frequencies from history and Jev's
per-part probabilities; value repair-vs-build and upgrade-vs-spares as real options under the remaining-season cost
distribution; a backtest harness over 2023-26 that Brier-scores Jev's severity calls against `session_result`.
