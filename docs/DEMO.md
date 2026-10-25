# Demo: two minutes

**The line:** Hyphenate builds the modules a finance team runs on: cash, accruals, prepayments, reporting. We built the module for hardware assets.

**Setup:**
- `make stdb-start`, `make api`, `make dashboard`, then press **Lap 32** in the bar (`make race-snapshot`). The home screen is one crash at a time: the crashes along the top, the car on the left, what the crash did to the hardware on the right, and the one call to make.
- No seats to pick: the browser takes the CFO seat on pit-wall by itself (the chip in the bar says **Full control**), so every call on race day is yours and each is on the record.
- To show it happening instead of frozen, press **Replay São Paulo** (`make race-demo`). It runs Jev, Claude, OpenF1 and the ERP live; `OFFLINE=1` runs it with none of them.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Home, Colapinto's lap-31 crash | "Hyphenate builds the modules a finance team runs on: cash, accruals, prepayments, reporting. We built the module for hardware assets. In Formula 1 the hardware is a car that crashes, gets rebuilt overnight and counts against a cost cap the day each part is fitted. Our agents understand that hardware: its repairs, its cost, the labour that goes into it, what it does to performance, and when it hits the cap." |
| 0:25 | Click **Albon · Qualifying** | "Interlagos 2024. Albon hits the wall at 315 km/h; the telemetry saw it nine seconds before the red flag. Five lines: nine parts to repair, from spares at the track and in Grove. The books, accrued. The crew's overtime. A grid penalty on a power unit that wasn't even hit, because now it runs out before the season ends. And the cap." |
| 0:55 | Click **Colapinto · Race, lap 31**, then **Open the plan** | "Same afternoon, another crash, and this one waits for me. The agent drafted the whole response: every operation and entry, each against what the team has done before. I can read every line, and change it in my own words." Type *Hand carry the floor instead of the air freight. Tell the press office before 18:00.* and press **Approve with these edits**. The plan holds while the agent reads the words (Claude, about 15 s), changes the operations, rebuilds the plan and records what it did with each sentence; then the entries post to the ERP. |
| 1:25 | The car: **Life**, then **Cap** | "The car is the ledger. Every part has a life: laps use it, crashes end it. Wear is never booked, the cap excludes depreciation, but it decides when each replacement is fitted, which is when its cost counts." |
| 1:45 | Top right: the weekend | "Sunday night the module seals the weekend: $3.92m, against the 'nearly $4 million' the press reported weeks later. Vowles said they'd take a little from next year's cap. This told them how much, that night." |

**If asked** (each is a click away, off the home screen):
- **How accurate is it?** The **Learned** tab: tested on Williams' 2024 races in order, learning only from the races before each one (`make race-backtest`). 96% of 93 events right with nothing known after the event; 83% of the 24 damage events; 88% of the parts each crash destroyed reserved (95% of their value); São Paulo's estimate 6% under Auto Motor und Sport. The honest part: learning covered the routine (every pit stop, right) but only 2 of 24 damage events, and the split of São Paulo's cost between crashes is off (Albon +97%, Colapinto's race −40% against PlanetF1). Public data teaches routine; damage needs the team's own records, and the page lists which.
- **Show me the books.** Books › Entries: every entry, its debit and credit, posted or waiting.
- **Who did what?** Audit: one row per decision, refusals included. Or "things the agents did on their own" on the home screen for every instrument on one page.
- **Is this real?** Timing, telemetry, race control and results are real (OpenF1, Jolpica). Money is press estimates and stated assumptions; every part-life figure is an assumption in `race/life.py`. Not affiliated with Williams.
- **Why isn't wear booked?** The cap excludes depreciation (Art. 3.1(o)). Wear moves the forecast: when each replacement is fitted is when its cost counts.
- **What if Jev is wrong?** Every figure is a band with its evidence; when Jev is unsure a person is asked, and the answer settles the lines, adjusts the books and teaches the desk.
- **Why no recommendations?** The racing calls stay with the people accountable for them; the agent prices them and does the accounting that follows.
- **What can an edit do?** Cancel an operation, move parts between the air freight and the hand carry, change where a spare comes from, add a spare, a work order, a check or a task for someone, change a deadline or an owner. Money is not edited in words: a request about an entry comes back as "change it in Books". Every edit and what the agent did with it is a row in pit-wall (`race_plan_edits`), and an edit stays in force when later events re-plan the crash.
- **Isn't one person approving everything a problem?** In the demo one operator holds the CFO seat. pit-wall still enforces separation of duties: whoever signed off an estimate cannot also approve its posting, and that refusal lands in the audit log.
