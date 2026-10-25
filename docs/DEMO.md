# Demo: three minutes

**The line:** know what a crash costs, and what it costs the season, before the car is back in the garage.

**Setup:**
- `make stdb-start`, `make api`, `make dashboard`, then `make race-snapshot BROWSER_ID=<hex>`, or press **Lap 32** in the bar. The dashboard opens on **Garage**.
- The incident strip under the bar follows **#23 Q**, Albon's crash. Every step in the strip opens the view of the person who owns it.
- To show it happening instead of frozen, press **Replay São Paulo** (`make race-demo`). It runs Jev, Claude, OpenF1 and the ERP live; `OFFLINE=1` runs it with none of them.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Garage, strip on #23 Q | "A crash costs a team three ways: the parts, the season, and the cost cap. Today finance learns the first from invoices weeks later, and the other two at the year-end forecast. But the calls those numbers should inform are made that night." |
| 0:20 | Strip: **Seen** | "Interlagos 2024, qualifying. Albon hits the wall at 315 km/h. Telemetry sees the car stop nine seconds before the red flag. In the race, race control never names Colapinto's crash at all." |
| 0:35 | Garage: car 23's drawing, parts and spares | "The desk's belief about each part lights the drawing, with the spares left for each one. The chief mechanic confirms heavy damage in one click: a choice between two crashes the team has lived through, not a form." |
| 0:55 | Garage: start or withdraw | "Three and a half hours to the start. The Team Principal sees three options priced side by side: repair, build up the spare tub (about thirteen hours), or withdraw. Each has its hours, points and cost. There is no recommendation: that call is the Team Principal's." |
| 1:15 | Strip: **Next steps**, then the Garage panel | "Withdraw is chosen, and execution follows the choice. The notice to the Stewards waits for the Sporting Director to send it, because it is outward. The parc fermé list is no longer needed. Spares are reserved, Grove has its work orders, and air freight waits against the Las Vegas cut-off." |
| 1:35 | Strip: **Race call** → Strategy (car 43) | "The second call is the strategist's. Lap 30, Safety Car: stay out, pit now, or another compound, each priced in positions, points, prize money and cap. Priced, never recommended. Two laps later Colapinto crashes." |
| 1:55 | Strip: **Books** → Accounting | "Every consequence is booked as it happens: balanced entries that say when the cap counts them. Small ones post straight to the ERP journal. From $250k they are held for the Head of Cost Cap, and from $1m for the CFO." Approve one: the journal id appears. |
| 2:20 | Strip: **Season** → CFO | "Ten thousand seasons re-run after every change. Williams' chance of holding P8 goes from 72% to 54% on Albon's withdrawal, and to zero by the flag. Expected prize money falls $6.1m, most of it from Alpine's double podium rather than our crashes. Here is the chance of a cap overspend, and the development to defer. The CFO and the engineers are looking at the same numbers tonight, not next week." |
| 2:45 | CFO: the sealed weekend | "It is all provisional, and it says so. Sunday night the weekend is sealed under one hash, with a brief for each role that cites the row behind every figure. Weeks later the true-up: we sealed $3.92m, and the press reported nearly $4 million. Vowles said they would 'take a little bit away from next year's cost cap'. Pit Wall told them how much, that night." |

**If asked:**
- **Is this real?** Timing, telemetry and results are real (OpenF1, Jolpica). Money is press estimates and stated assumptions, each sourced in `race/data/`. Not affiliated with Williams.
- **What if the desk is wrong?** Every figure is a band with its evidence. A person is asked only when a wrong call would cost more than the question, and their answer settles the lines, adjusts the books and teaches the desk.
- **Why no recommendations?** The calls stay with the people accountable for them; the desk prices the options and does the work that follows.
- **What runs live?** The bar shows it: OpenF1, SpacetimeDB (every write through a role-checked reducer), Jev, Claude and the ERP journal.
