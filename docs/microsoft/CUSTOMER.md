# Who Pit Wall is for

## The customer

The customer is the **revenue team inside a racing team's finance function**: a controller, a revenue accountant or two, and the commercial team that sells and manages sponsorships. Meridian Racing is fictional, but its shape matches a real constructor's: about five headline sponsors, contracts in three currencies, a base fee plus performance bonuses (win, podium, points, top six), and championship prize money that depends on the final standings.

The same problem exists anywhere revenue depends on an outside event that can change after the fact:

- sports teams and leagues (bonus clauses, prize pools, broadcast performance payments);
- media and streaming (audience-tier bonuses restated after measurement audits);
- construction and engineering (milestone payments certified, then disputed);
- SaaS and cloud (usage tiers recomputed after metering corrections).

Under ASC 606 / IFRS 15 these are all **variable consideration**. You recognise it when it is highly probable it won't reverse. An F1 result is the extreme case: it is provisional at the flag, "final" a few hours later, and can still change at an appeal weeks after that.

## The people, and what they need

| Person | Their job today | What hurts | What they want from Pit Wall | What they will not hand over |
| --- | --- | --- | --- | --- |
| **Dana, controller** | Signs off revenue at month end; answers to auditors | Bonuses booked on provisional results and reversed later; invoices sent that later need credit notes; reconstructing *why* an entry exists | Only the decisions that need her, with the evidence attached, wherever she already works (Teams, Outlook) | Approving material entries; ruling on contract ambiguity |
| **Priya, CFO** | Owns the forecast and the board numbers | Prize money estimate swings; surprises in the close | Large items only, on her phone, with a one-line reason | Approving anything over $1M |
| **Luis, commercial director** | Bills sponsors the moment a result lands, because sponsors expect it | Finance holds his invoices with no reason given; he has to chase | An immediate yes, no or hold, with the reason in plain words | The sponsor relationship and every email to a sponsor |
| **External auditor** | Tests revenue once a year | Sampling thousands of entries with no trail | A complete, tamper-evident trail and re-performable evidence | Their own judgment |

## Their week, and where it breaks

1. **Sunday, race ends.** The provisional classification is out. Luis asks for the podium bonus to be invoiced "so it lands this month".
2. **Sunday evening.** The stewards summon a car. Nobody in finance is watching FIA documents. *(Spa 2024: Russell finished first and was disqualified about three hours later.)*
3. **Monday.** The final classification is published. If the invoice already went out, someone now drafts a credit note to the sponsor and explains it.
4. **Month end.** The revenue accountant rebuilds every bonus by hand from results, contracts and FX rates. The controller reviews a spreadsheet. That's typically 2 to 3 weeks after the race.
5. **Year end.** The auditor asks why entry #214 was reversed. The answer lives in someone's inbox.

Pit Wall changes steps 1 to 4:

- It holds Luis's request until the result is final.
- It reads the FIA's documents as they're published and warns Dana that $2.76M is at risk.
- It rejects the overturned bonuses before they're invoiced.
- It books the corrected result as soon as the FIA calls it final.

It changes step 5 by keeping the decision record, the evidence and an audit trail for every entry.

## What we deliberately did not automate

- **Approving material entries.** Pit Wall prepares them; a person approves. The kernel enforces this (K10, K11), not a prompt.
- **Interpreting genuinely ambiguous contract language.** Volta's points-finish clause doesn't say whether sprints count. Pit Wall asks Dana once, records her ruling, and turns it into a rule that applies in code only after she approves it.
- **Talking to sponsors.** Credit-note emails are drafted. Nothing goes to a sponsor until the controller presses send.

## What we still don't know (and would ask a real customer)

- The team's real materiality thresholds and approval matrix. Ours are $250K for the controller and $1M for the CFO.
- Whether sponsors accept a hold-until-final invoicing policy, or whether some contracts require billing on the provisional result.
- Which ERP they run. Business Central is built; NetSuite and SAP connectors would follow the same journal-line pattern.
- How their auditors want evidence delivered. We produce JSON and CSV workpapers; some firms want direct read access.

*Honesty note: the personas, contracts, policies, FX rates and billing requests are synthetic. The race results and FIA documents are real. Nothing here comes from interviews with an actual F1 team.*
