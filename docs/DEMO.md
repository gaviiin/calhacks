# Demo: three minutes

**The line:** an autonomous race accountant that keeps the books in step with the car.

**Setup:**
- `make stdb-start`, `make api`, `make dashboard`, then `make race-snapshot BROWSER_ID=<hex>`, or press **Lap 32** in the bar. The dashboard opens on **Garage**, seated as the CFO.
- The incident strip under the bar follows **#23 Q**, Albon's crash. Every step in the strip opens the view of the person who owns it.
- To show it happening instead of frozen, press **Replay São Paulo** (`make race-demo`). Watch the part-life bars move lap by lap. It runs Jev, Claude, OpenF1 and the ERP live; `OFFLINE=1` runs it with none of them.

| Time | Screen | Say |
|---|---|---|
| 0:00 | Garage, strip on #23 Q | "Every F1 team has someone keeping its books against the cost cap. Crashes are the biggest swing, and today they reach finance as invoices, weeks later. Pit Wall is an accountant you hire that keeps the books in step with the car." |
| 0:20 | Strip: **Seen** | "Interlagos 2024, qualifying. Albon hits the wall at 315 km/h. Telemetry sees the car stop nine seconds before the red flag, and the agent has costed it in about a millisecond." |
| 0:35 | Strip: **Hardware**, then the car and Part life | "The car is the ledger. Jev reads the impact and which parts it hit; nine are replaced. Every lap, every trip off the track uses up life: this is what each part has left. Albon's power unit wasn't replaced, but now it runs out before the season ends, and he's already used his allocation. That's a grid penalty, found the moment it happened." |
| 1:00 | Garage: start or withdraw | "Three and a half hours to the start. The Team Principal sees repair, the spare tub, or withdraw, priced side by side. No recommendation: that call is theirs. Withdraw." |
| 1:15 | Strip: **Next steps** | "Execution follows the choice. The notice to the Stewards waits for the Sporting Director to send it. The parc fermé list is no longer needed. Spares reserved, factory work orders, freight against the Las Vegas cut-off." |
| 1:30 | Strip: **Books** → CFO, Waiting for you | "The books kept themselves: balanced entries, each saying when the cap counts it, the inventory moves, the evidence. The morning's crashes were approved between the sessions and are in the ERP. Colapinto's lap-31 crash waits for one click." Click **Approve all**: the journal ids appear in Accounting. |
| 2:00 | CFO: Hardware | "What the hardware means for the cap: parts replaced, replacements due before Abu Dhabi and what they bring into 2024, two grid penalty risks." |
| 2:20 | Strip: **Season** | "Ten thousand seasons re-run after every change: the chance of holding P8 falls from 72% to 54% on Albon's withdrawal, and to zero by the flag. The engineers and the CFO are looking at the same numbers tonight, not next week." |
| 2:40 | CFO | "It's provisional, and it says so. On Sunday night the weekend is sealed and briefed to each role once the CFO approves; weeks later the true-up against actuals: we sealed $3.92m, the press reported nearly $4 million. Vowles said they'd 'take a little bit away from next year's cost cap'. Pit Wall told them how much, that night." |

**If asked:**
- **Is this real?** Timing, telemetry, race control and results are real (OpenF1, Jolpica). Money is press estimates and stated assumptions; every part-life figure is an assumption in `race/life.py`. Not affiliated with Williams.
- **Why isn't wear booked?** The cap excludes depreciation. Wear moves the forecast: when each replacement is fitted is when its cost counts.
- **What if Jev is wrong?** Every figure is a band with its evidence; when Jev is unsure a person is asked, and the answer settles the lines, adjusts the books and teaches the desk.
- **Why no recommendations?** The racing calls stay with the people accountable for them; the agent prices them and does the accounting that follows.
- **Why milliseconds?** Not for the books' sake: so the numbers are never stale when someone decides, on every one of thousands of events a session.
