# Anneal: the pitch

Said "uh-NEEL". Annealing takes stress out of metal; Anneal reads stress events off a team's hardware and takes the stress out of three departments asking one question.

## The vision

Hyphenate agents learn how an enterprise runs its books, then improve at, execute and record those financial processes. **Anneal agents learn how a team runs its car**, the whole mechanic lifecycle: how parts are swapped, built, developed and upgraded, how they move between the factory and the track, how long each of those takes and who does it. With that knowledge the agent keeps the record of every hardware operation and turns it into what finance and the pit wall both need: financial expectations (this year's cap, next year's cap, the prize money) and performance expectations (what the car can do at the next race, what the factory has to build to get it there).

Every hardware event is a financial event in a different form. The car is a bank account that goes out and performs every race day: a kerb strike draws on a floor's life, a crash destroys a wing, every replacement counts against the cost cap the day it is fitted. Today that reaches finance as invoices, weeks later, and the engineers, logistics and finance each keep their own version. Anneal keeps one.

What follows from the vision:

1. **The learned object is the mechanical lifecycle, not the money rules.** The money rules (when a part counts, against which account, who signs) sit on top of the team's own repair, build, upgrade and transport processes. The agent learns those processes from the team's history (work orders, part swaps, freight bookings, development cycles) and drafts them as a playbook the chief mechanic and the Head of Cost Cap approve.
2. **Forecasts come from the processes, not from the parts alone.** A grid penalty risk is not just "the power unit runs out at Qatar"; it is "the power unit runs out at Qatar, this team's rebuild takes ten days, the next event is in eleven, so the choice is a penalty or a hand-carry". The team's process knowledge is what changes the number.
3. **A plan a person approves, then execution by precedent.** Seconds after an event the agent drafts the response plan: the hardware operations and the entries that follow, each line against the team's own history. The chief of staff approves the reaction as a whole; after that every line the team has a precedent for executes and posts on its own, whatever its amount, and a line with none (a familiar part at an unfamiliar price, an operation the team has never done) waits for a person, whose decision becomes the precedent. No amount threshold decides anything.
4. **The record is the operations log.** Every swap, build, upgrade and shipment is an audit row with its cost and its effect on life, as every posting is in Hyphenate's log. A new team feeds the agent its history and it drafts the team's playbook; the people approve it; from then on the agent executes and records under it.
5. **Priced, never decided.** The agent prices the racing and engineering calls (repair or withdraw, pit or stay out, build or defer) and leaves them to the people accountable for them. Performance is an expectation the team reads, not a call the agent makes.

F1 is the showcase. Aviation, rail, fleets and heavy equipment ask the same three questions, life left, spares on hand, when it hits the books, and keep the answers in three systems too.

## Where the product is against the vision (25 Oct 2026)

| Vision | Built | Stated assumption, not yet learned |
|---|---|---|
| Learns the mechanical lifecycle | The desk raises the operations that follow a crash (spares reservations at the track or Grove, Grove work orders, inventory moves, hand-carries, freight against the next event's cut-off, parc fermé lists, PU and gearbox checks), each with an owner, a deadline and an audit row | Life per part, wear per stress event, lead times and prices are assumptions in `race/life.py` and `race/prices.py`; a team's work-order history would replace them |
| Learns the team's rules | Race policies drafted from Williams' 2025-26 history as Ripple-Down Rules, approved by the Head of Racing Finance; corrections become precedents; Jev asks a person below its confidence floor | The repair playbook itself (steps, hours, who) is a template per severity |
| Records every hardware operation | 22 parts kept current across 2,549 events at about 1 ms each; 18 replacements booked when fitted; every decision and refusal an audit row in SpacetimeDB | Routine replacements by wear are forecast, not yet booked when fitted |
| Financial expectations | Weekend cost band, cap timing per entry, 10,000-season re-run after every change (cap overspend risk, prize money, the development to defer), the Sunday-night seal and the true-up | Money is press estimates and assumptions until a team's ERP is connected |
| Performance expectations | Each part's remaining life and the race it runs out at; grid-penalty risk the moment a PU or gearbox is heading past its allocation; start-or-withdraw and pit options priced in positions, points, prize and cap | Wear read from telemetry itself (braking, revs, kerb strikes), not only laps |

## The 60-second pitch

> Hyphenate agents learn how a company closes its books. Anneal agents learn how a team runs its car: how parts are swapped, built, upgraded and shipped, the whole mechanic lifecycle. Every hardware event is a financial event in a different form: a kerb strike shortens a floor's life, a crash destroys a wing, and each replacement counts against the cost cap the day it's fitted. Today that reaches finance as invoices, weeks later. Anneal treats the car as the ledger. Every part has a condition, a remaining life, a spare count and a cap status. As the race runs, Jev classifies every event in about a millisecond and takes life off the parts it hit, so the agent knows which replacement lands in this year's cap, which gearbox is heading for a grid penalty, and what the factory needs to build. The books keep themselves, under rules the agent learned from the team's own history and the Head of Cost Cap approved. It prices the racing calls and leaves them to people. On a replay of Williams at São Paulo 2024 it kept 22 parts current across 2,549 events, booked 18 replacements, found two grid penalties the moment they became likely, and sealed the weekend at $3.92m on Sunday night against the "nearly $4m" the press reported weeks later. F1 is the showcase. Aviation, rail and heavy equipment ask the same three questions, life left, spares on hand, when it hits the books, and keep them in three systems too.

## Lines to keep

- "The car is a bank account that goes out and performs every race day."
- "Every hardware event is a financial event in a different form."
- "Hyphenate agents learn how a company closes its books. Anneal agents learn how a team runs its car."
- "It learned Williams' processes from one weekend of public data; it would learn a team's real ones from its work orders."

## Things not to say

- "Instead of cash flows and prepayments": Anneal still does the books; it extends the accounting agent to the assets.
- That Jev writes down the asset's value: the cap excludes depreciation (Financial Regulations Issue 22, Art. 3.1(o)). Jev takes life off parts; life sets when the replacement is fitted; fitting is when the cost counts.
- That the agent picks strategy: it prices the calls and records the choice.
- Anything that sounds like Hyphenate's own loops restated (rules mined from history, never-ask-twice, the same-commit audit log). The new thing is that the learned object is a mechanical process, not a financial one.

## Proof figures (São Paulo 2024 replay, real timing, telemetry and race control)

| Measure | Result |
|---|---|
| Events processed | 2,549, each committed in about 1 ms (11 ms at worst) |
| Parts tracked | 22 (11 per car), updated in under a millisecond per event on average |
| Stress events classified | 7, by Jev, part by part |
| Parts replaced | 18 across three crashes, each booked when fitted |
| Replacements due before Abu Dhabi by wear | 4 parts, $1.2m into the 2024 cap |
| Grid penalty risks found | 2 power units past their allocation |
| Crash seen | 9 to 26 s before the red flag, from telemetry |
| Season re-run | 10,000 seasons in about 80 ms |
| People's touches | 2 damage answers, 2 Team Principal choices, 1 approval per incident's books |
| Weekend crash cost | $3.92m sealed on Sunday night, against nearly $4m reported weeks later |

The demo script is [DEMO.md](DEMO.md); the home screen's design is [DESIGN-HOME.md](DESIGN-HOME.md); the name's reasoning is [NAMES.md](NAMES.md).
