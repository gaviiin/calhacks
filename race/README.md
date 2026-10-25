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

## The three tiers, and who decides

| Tier | Decides | Shown as |
| --- | --- | --- |
| Policy (`race_policies`, GRANTED) | a rule a person approved; no model call | `policy` chip, solid |
| Jev (System One) | typed answers with probabilities for anything no policy covers | `jev` chip with ms and P(severity) |
| Claude (System Two) | the repair and money plan after an incident; policy drafts | forecast panel; `claude` chip |

A policy starts as a SHADOW: it only watches, Jev decides, and the effect row names the draft that would have
matched. The Head of Racing Finance grants autonomy; from then on the policy decides and the row is `autonomous`.
A correction in the dashboard writes a `race_precedents` row and counts a contradiction on the policy; three alike
corrections, or a contradiction rate over 20%, make the learner draft a child policy.

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
