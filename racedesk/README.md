# Race Desk

Race-day money telemetry for Meridian Racing. A real race is replayed lap by lap. Every lap the running order is priced under Meridian's sponsor contracts and in expected championship prize money. Crashes are booked against the cost cap on the lap they happen. FIA documents are acted on 15 seconds after they are published. A speed scoreboard sets each reaction against the month-end close a finance team runs today.

## Run it

```bash
uvicorn finance.api:app --port 8000          # API, includes /api/racedesk
cd frontend && npm run dev                   # dashboard: http://localhost:5173/#/race
python -m racedesk replay 2024 14            # the same replay in the terminal
python -m pytest racedesk/tests -q
```

## The three demo races

| Race | What happens | What the desk does |
| --- | --- | --- |
| Spa 2024 (`#/race/2024-14`) | Russell wins on the road. The FIA summons his car at 16:23 and disqualifies him. | Holds billing 15s after the summons. $1.76m of bonuses on the road result is never invoiced. $2.76m is booked after the Final Classification (17:56). |
| Spa 2026 (`#/race/2026-10`) | Russell is out on lap 1 after a collision. | Books a $0.9m damage estimate to the cost cap on that lap. Season breach risk goes from 1% to 3%, or 11% if the final upgrade still comes. |
| Singapore 2023 (`#/race/2023-15`) | Russell crashes on the last lap. | Prices the loss exactly: his points-finish and top-six bonuses go, Hamilton inherits the podium, and expected prize money falls. |

## API

- `GET /api/racedesk/races?season=2026`
- `GET /api/racedesk/replay/{season}/{round}?team=mercedes&detail=true`

  Returns `laps`, `radio`, `crashes`, `speed`, `totals`, `classification` and `method`. Money is in USD cents and clocks are UTC. `detail=false` trims each lap to `lap, clock, total, delta, bonus_usd, prize_ev`.

## How the numbers are made

- **Bonuses.** Meridian's contracts (`world/sponsors.json`) are applied per car to each lap's order, using race-day FX. A teammate swap is worth $0.
- **Prize money.** Expected value over the remaining rounds, from a Monte Carlo of each team's real points rate and spread this season. The prize table is synthetic.
- **Clock.** Race start (UTC) plus the leader's cumulative lap times.
- **Crashes.** Heavy incidents (accident, collision, spun off) are estimated at $0.9m and light damage at $0.2m. Power unit failures book nothing, because PU supply costs are excluded from the cap (D5.1.1.n). For 2026 the capsim season forecast is re-run.
- **Speed.** A crash is seen when its lap closes, so time to act is up to one lap. FIA documents are polled every 15 seconds. The manual baseline is booking at month-end close, 5 business days after month end.

## Sources

- Lap charts, classifications, pit stops and safety cars: TracingInsights RaceData (CC0). Built by `scripts/fetch_race_data.py` into `world/race_data/`.
- The 2026 standings were checked against crash.net. The Singapore result was checked against planetf1.
- FIA documents: Apify captures of fia.com.
