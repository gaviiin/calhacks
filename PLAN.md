# Cost Cap Desk: a cost cap analyst you could hire on Monday

Loose implementation plan for Cal Hacks 13.0 (Oct 23-25, 2026). Primary target: Hyphenate track. Secondary: Microsoft "Built for the Real World", SpacetimeDB, Anthropic. Research is in `research/`; read `research/04-hyphenate-workshop-deck.md` first, it is the judges' own blueprint.

**Status: proposal, not decided.**

---

## 0. The pitch

Every F1 team runs two sets of books: the statutory ledger, and the FIA cost cap overlay where every transaction is classified Relevant or Excluded under one of 27 categories, against a $215m ceiling, with a points deduction if you miss by 2%. Red Bull got that wrong 13 ways in 2021. Teams hire "Financial Regulations Analysts" whose job is monthly cost cap actuals that need no later amendment.

We built that analyst. Three things make it hireable rather than a demo:

1. **It starts knowing the company.** Before its first day it reads last year's ledger and last year's cost cap submission, drafts the house policies it finds there with precedent counts, and asks the controller to approve them. On day one it works the queue under those policies and asks about everything else.
2. **It gets better every month.** Every correction, every answered question and every rule change becomes a versioned policy it proposes and a human approves. Its ask rate falls and its error rate falls, month over month, and we chart it.
3. **It can account for every decision.** Every transition is an append-only event with actor, reason, evidence and policy version, written in the same commit. Months later, "why is this £7,200 in the cap?" is one query. Denied attempts are in the same log.

**Seats line:** "Fills the cost cap analyst seat and the policy desk beside it; reports to a human Head of Cost Cap who approves every policy and every material adjustment."

**Generalization line:** the cost cap is the most dramatic instance of a problem every company has: a second, regulatory classification laid over the GL with a hard budget, related-party rules and locked periods. Swap the FIA rulebook for federal grant cost principles and this is a university research office. The engine does not know it is in F1.

**Why it works for every team (the cash-module argument).** Hyphenate's engineers single out their cash module because it works for dozens of customers unchanged: the task is standard, so it is encoded once. The cost cap has the same property. All eleven teams are bound by the same Financial Regulations, word for word. What differs per team is the chart of accounts, the vendors and the house practice, and that is exactly what onboarding learns from history. Say it in one sentence on stage: "the rulebook is shared by every customer; the company-specific part is learned, not configured."

---

## 0b. What the Hyphenate engineers told us (Oct 24)

From conversations at the venue, paraphrased:

- **They admire the module that works for every customer.** Their cash module works across dozens of customers largely because matching bank lines is a well-defined task. Prepayment amortization is similar: it follows standard accounting rules, so the charge comes out the same however the customer pays. Our read: where the rule is standard, encode it once as deterministic code, and spend the intelligence on the company-specific part.
- **Bulletproof and well thought out beats broad.** They want a few things done very well.
- **A strong wow counts about as much.** The three demo beats and the judge-injected scenario are our wow; the red-team score is our bulletproof.
- **On trust and compliance, transparency is what they look at.** Not certifications or security claims: can a reviewer see why it did what it did.

What we change because of this:

1. **Prove the engine has no F1 in it.** Add a test that fails if the system of work or the agent runtime contains F1-specific logic or category codes outside data files. F1 lives only in `rulebook/rulebook.json` and `world/`. Cheap, boring, and it turns the generalization line from a claim into a fact.
2. **Make transparency the face of Pillar 3, not a back-office log.** Every proposal in the controller UI shows, without clicking: the regulation text it relied on, the policy and version, the precedent count with two sample rows, the alternative it considered and why it lost, and what it was not allowed to do. The roles matrix is visible as a page, live from the module. A denied attempt is shown next to the item, not hidden in a table.
3. **Their onboarding is collect everything, sandboxes, then prod.** The red-team harness becomes the sandbox gauntlet, and its results decide autonomy per policy (Pillar 1).
4. **"The agent should record genuinely everything it does."** Every read, tool call, model call and decision is recorded, not just state changes (Pillar 3, SCHEMA §6b).
5. **Stretch, Sunday only:** load a second, tiny rulebook (US federal grant cost principles, 2 CFR 200 Subpart E: unallowable entertainment, alcohol, lobbying, fundraising) and run the same engine on a ten-line dataset with zero code changes. Only if everything else is frozen.

---

## 1. The three pillars

The deck calls them "learns, improves, proves." We call them hireable, self-improving, accountable. Everything we build serves one of them; anything that doesn't gets cut.

### Pillar 1: Hireable on day one

**What it means for this seat.** A new analyst isn't useful until they know how *this* team classifies things: which vendor is the canteen, which recharges come from the parent, what the Head of Cost Cap escalated last year. A hireable system arrives with that knowledge and a bounded authority to act on it.

**Mechanism: onboarding from history.**
- Inputs: the 2025 statutory ledger with ERP coding, the 2025 Cost Cap Reporting Template (Total Costs → Excluded by category → Relevant), the related-party contracts and fair value schedule, the vendor master, the department tree, the 2025 approvals log (what got escalated and how it was decided).
- The Policy Learner queries that history and drafts policies with evidence: "vendor Grove Catering, GL 6410, 214 lines in 2025, all Excluded (catering) → in 2026 still Excluded under D5.1.1.z"; "Technology Ltd recharges: 12 invoices, all compared to the fair value schedule, 2 adjusted upward → policy: value at max(contract, FV)"; "travel lines with memo containing a race name → Excluded (r); otherwise Relevant, 1,040 precedents, 3 exceptions." Each policy is a proposal with precedent count and sample evidence, queued `needs_approval` for the Head of Cost Cap.
- It also learns operating envelope defaults: the amounts above which 2025 humans escalated, which departments own which GL ranges, FX conventions.
- Output: an onboarding report. What I learned, what I am confident on, what I will ask about, and the share of January's lines that an approved policy already covers.

**Mechanism: sandboxes before prod, then earned autonomy.** This mirrors how Hyphenate onboards a customer: collect everything, run the agents in many sandboxes, then go to prod.
- After the learner drafts policies, the **sandbox gauntlet** replays the agents over N fresh sandboxes: the world generator at different seeds, each with planted errors and red-team mutations, each with its own answer key. For every policy it records lines handled, errors, missed plants and asks.
- The Head of Cost Cap sees that record per policy and decides. A policy with a clean record can be granted **autonomy**: a standing approval, with the sandbox run attached as evidence. A policy without one stays propose-only.
- In prod, the `auto_approver` approves an item only when it cites a policy with granted autonomy and sits below materiality. The proposer still can't approve its own work; the auto-approver is a separate identity, and its audit row names the human who granted the standing approval.
- Autonomy is revocable in one click, and later items go straight back to human review.

The roles matrix gives the analyst `propose` and `ask`, nothing else. The envelope is data (approved policies, autonomy grants and thresholds), not prompt text, so it is inspectable, and it widens only when a human signs off on evidence.

**Demo beat (the "catches" moment).** Day one, first item in the queue: a hospitality invoice coded by the requester as Marketing. The analyst has already learned from 2025 that this vendor is the factory canteen, splits the line items (canteen → Excluded z; sponsor dinner → Excluded a; engineering offsite lunch at a wind tunnel session → **Relevant**), cites the policy it learned at onboarding and the article behind it, posts £7,200 into the cap. It caught on its first morning what the requester missed.

**Score.** Day-one policy coverage of January lines (target ≥ 80%). Day-one precision on covered items vs the answer key. Day-one ask rate on uncovered items (should be high; guessing is the failure). Zero actions outside the envelope.

### Pillar 2: Self-improving

**What it means for this seat.** New information arrives four ways and the system must change behaviour without a redeploy, without anyone writing a rule, and without touching anything already locked.

**Mechanism: every signal becomes a versioned policy proposal.**
1. **Corrections.** The controller rejects or reclassifies a proposal with a reason. That becomes a precedent. When the learner finds k alike precedents (start with 3), it proposes a general policy citing them, `needs_approval`. The deck's slide 13, applied to the cap.
2. **Answers.** A NEEDS_INFO question answered by a human is stored as a precedent against the pattern, so the same question is never asked twice. Ask rate is the headline metric here.
3. **Rule changes.** A new regulation issue or a CCA Determination (2026 moved catering out of the cap; Consideration Factor published 31 Oct; Transferable Component methodology 30 Nov) is ingested as a document. The learner proposes a new *version* of each affected policy with an effective date, lists the open items whose classification would change, and never touches a locked period. Approval is required before any version takes effect.
4. **Late or changed records.** A late ERP correction, an updated fair value schedule or changed vendor bank details re-opens the affected item as a new transition with the new evidence attached. Nothing is edited in place.

**Guardrails.** The learner proposes; it never approves. Policies carry versions and effective windows; classification validity is checked against the version in force for the item's period. Locked periods are immutable in code.

**Demo beat (the "recovers" moment).** March: the analyst classifies an offsite catering line as Excluded; the Head of Cost Cap rejects it, reason "not at a Competition, Relevant." April: two more alike corrections; the learner proposes pol-031 v1 with three precedents; approved. June: the same pattern arrives and is handled with no question, citing pol-031 v1 and the March ruling. Then the rule-change variant: the 2026 Section D issue is dropped in; the learner proposes catering v2 (Excluded from 1 Jan 2026), shows 38 open January items that flip and that December 2025 is locked and untouched.

**Score.** Replay the whole year month by month. Chart ask rate and correction rate per month: both should fall. AccountingBench showed models drifting *worse* over sequential months; our chart is the inverse, and we say so. Time-to-policy: number of alike corrections before a general policy is proposed. Repeat-question rate: should be zero.

### Pillar 3: Accountable

**What it means for this seat.** The FIA can ask, in October, why a line from February is where it is, and the Head of Cost Cap signs a declaration that can be sanctioned personally. Accountability isn't a log; it is the ability to answer "why" with evidence for any number, any time, including about things the system was *not allowed* to do.

**Mechanism: record genuinely everything.** Hyphenate's engineers put it in exactly those words. Transitions are only half of it: every read, tool call, model call and decision is an `agent_step` row linked to its run and work item (SCHEMA §6b). Each proposal is preceded by a decision step listing the candidates it considered and why the winner won. So "why" also answers "what did it look at, and what else did it consider."

**Mechanism: the transition log is the system.** Every state change goes through one `transition()` reducer: look up the allowed next state, check the roles matrix with the authenticated caller as actor, snapshot before and after, apply, append `audit_log(at, actor, action, subject, allowed, reason, diff, evidence, policy_id, policy_version)` **in the same transaction**, roll back and still log if denied. Append-only; a reversal is a new event. Agents have no path to the ledger or the gateway and hold no keys, so the record of their work is complete by construction.

**Mechanism: "why" is one query, at any depth.** From any posted journal entry: gateway post (ERP entry id) ← approval (who, reason) ← question/answer if any ← proposal (policy id + version, reason, evidence row ids) ← golden rows ← raw source rows with cursor position. Also upward: from any number on the monthly FIA Financial Report to the lines, from the lines to the decisions. The Cost Cap Reporting Template reconciliation (Total Costs → Excluded by category → Relevant) ties to the ledger and every cell drills down.

**Mechanism: independent checks.** Posted entries export to Beancount; `bean-check` and balance assertions compare against the generator's known truth, so the proof isn't our code grading itself. The red team probes the roles matrix (agent tries to approve, agent tries to post, agent tries to edit a locked period) and every probe must appear in the log as a denied event.

**Demo beat (the "defends" moment).** An auditor persona (or the judge) picks a line from the February report in October and asks why. One query returns the chain, ending at the controller's approval reason and the policy version in force in February. Then they ask "did the agent ever try to approve its own work?" and the log shows the denied attempts from the red-team run, timestamped.

**Score.** 100% of posted entries have a complete chain (automated check). 100% of SoD probes denied and logged. An auditor agent asks 20 random "why" questions and a checker verifies each answer against the log. Beancount check passes on the exported journal.

---

## 2. The seat and the world

**Corner:** cost cap compliance. The statutory ledger already exists with ERP coding on every line, the way real teams have it. The analyst's job is the overlay: classify, adjust, hold, report. No 3-way matching, no payments, no rev rec, no payroll, no bank reconciliation unless a demo beat needs it.

**Company:** fictional UK constructor, calendar year end, 2026 regs, scaled from real filings (Williams FY2025: £244m turnover, £107.5m payroll, £37.4m capex, ~1,150 staff). A parent Technology Ltd that employs staff and recharges, so related-party invoices are natural. A PU supplier, a sponsor, FOM.

**Rulebook:** the 27 Excluded categories (D5.1.1 a-aa), Relevant, and the Adjustment types (D6.1.1), each with article reference and text from `research/fia/secD_iss07.txt`, plus the 2025 equivalents from Issue 22 so rule changes are real. Policies reference rulebook entries; the LLM never types an article number.

**Data:** a seeded generator emitting ~3,000 GL lines, bills with line text, contracts, a fair value schedule and a bank feed over Jan-Nov 2026, driven by the season calendar (February build spike, August shutdown, a crash in Brazil), with late postings and ERP corrections. Plus the full 2025 year as history for onboarding.

**Answer key:** ~40 planted items in 3,000. The 13 Red Bull misstatements re-staged (catering as marketing, PU below fair value, sick pay, tax credit not grossed up, parts moved to heritage, non-Competition travel, maintenance in HR/finance/legal, and the rest), plus duplicates, splits under threshold, backdating into a locked period, bank-detail changes, prior-year catering arriving in January. CSV with expected behaviour per item: reclassify / ask / hold / deny.

**Humans:** Head of Cost Cap (approves policies and material adjustments, rejects ~15% with a reason), Financial Controller, Head of Aero (sloppy requisitions), External Auditor (asks why). Played by the model, or by a judge at the controller's screen.

---

## 3. Architecture

The deck's one idea: records hold the truth, a system of work holds the work, a gateway is the one door. We build the system of work.

```
 SYSTEMS OF RECORD (mocked, emit over simulated time)
   ERP ledger · bills · contracts & FV schedule · bank feed · 2025 ledger + 2025 submission · rulebook issues
                 │ change-only sync, cursor per source, stable ids, late posts re-read, raw_ref on every row
                 ▼
 ┌────────────────────── SYSTEM OF WORK (SpacetimeDB, TypeScript module) ──────────────────────┐
 │ golden rows · work_item state machine · policy (versioned, effective window) · precedent     │
 │ roles matrix checked in every reducer · transition() logs a diff in the same commit          │
 │ NEW → PROPOSED → NEEDS_INFO ⇄ PROPOSED → APPROVED → POSTED · no delete · denials logged      │
 └──────┬──────────────────────────┬─────────────────────────────────┬─────────────────────────┘
        │ tools = CRUD on work     │ subscriptions                   │ post (gateway only)
        ▼                          ▼                                 ▼
  Agents (Claude Agent SDK)   Controller UI (React)           Gateway → ERP mock
  Cap Analyst: propose, ask   work queue · onboarding report  posts reclass / FV adjustment JEs
  Policy Learner: propose     policy approvals · cap burn     writes monthly FIA report
  Red Team: mutate, probe     "why?" chain · auditor mode     the only writer
        │
        ▼
  Beancount export → bean-check (independent verifier)
```

**Which pillar each piece serves.**
- Onboarding ingest of 2025 data + Policy Learner draft mode → Pillar 1.
- Precedent table, correction scanner, rulebook ingest, policy versions with effective windows → Pillar 2.
- `transition()` with same-commit audit rows, roles matrix, append-only tables, gateway as sole writer, "why" query, Beancount check, red-team probes → Pillar 3.
- Cap Analyst day-to-day proposing and asking → all three.

**SpacetimeDB as the system of work.** Reducers are atomic and the only write path, so the roles matrix, the state machine, the period lock and the same-commit audit row are enforced where the data lives. `ctx.sender` is the authenticated actor on every row. Subscriptions drive the controller's queue live. **Fallback:** Postgres + FastAPI with the same `transition()` if the module isn't passing its tests by Saturday noon.

**Agents: Claude Agent SDK, Python**, each an `AgentDefinition` with an explicit tool allowlist. Tools are CRUD on work items and read-only on records: `read_item`, `search_records`, `search_precedents`, `search_policies`, `propose_classification(item, policy_id, category, evidence_refs, reason)`, `ask(item, question)`, `propose_policy(...)`. Structured JSON outputs. Confidence below threshold or no applicable policy → ask, don't guess; plugs score as failures.

**Deterministic core, LLM at the edges.** Cap arithmetic, FX, materiality, period locks, max(contract, FV), SoD and the state machine are code. The LLM reads documents, selects a policy, writes the reason, decides whether to ask.

---

## 4. The demo: three beats, one per pillar

Under three minutes, in this order, opening cold on beat 1.

1. **Day one, it catches** (hireable). Onboarding report on screen: 2025 ingested, 47 policies drafted, controller approves a batch, coverage 82%. First queue item: the hospitality invoice. Split, cited, £7,200 into the cap. Fifteen seconds of "it knew this vendor before it started."
2. **Month three to six, it recovers** (self-improving). The controller's March rejection, the April policy proposal with three precedents, the June item handled silently with the citation. Cut to the chart: ask rate and correction rate falling by month.
3. **October, it defends** (accountable). Auditor asks why about a February line. One query, full chain to the approval reason and the policy version. "Did it ever try to approve its own work?" The denied events from the red-team run.

Then the live scenario: the judge drops in their own invoice or rule change through the red-team injector and watches the queue.

---

## 5. Proof it works

| Pillar | Metric | Target |
|---|---|---|
| Hireable | Day-one policy coverage of January lines | ≥ 80% |
| Hireable | Day-one precision on covered items vs key | ≥ 95% |
| Hireable | Actions outside the authority envelope | 0 |
| Hireable | Policies granted autonomy without a clean sandbox record | 0 |
| Hireable | Sandboxes in the gauntlet before go-live | ≥ 10 seeds |
| Self-improving | Ask rate by month | falling |
| Self-improving | Correction rate by month | falling |
| Self-improving | Repeat questions on an answered pattern | 0 |
| Self-improving | Alike corrections before a general policy is proposed | ≤ 3 |
| Accountable | Posted entries with a complete evidence chain | 100% |
| Accountable | Proposals preceded by a recorded decision step listing the alternatives | 100% |
| Accountable | SoD probes denied and logged | 100% |
| Accountable | Auditor "why" questions answered correctly vs log | 20/20 |
| Accountable | Beancount check on exported journal | pass |
| Accountable | Proposals showing rule text, policy version, precedents and the rejected alternative | 100% |
| General | F1-specific logic or category codes outside `rulebook/` and `world/` | 0 (test) |
| Overall | Planted errors caught or escalated (answer key) | report the number honestly |

What's real: the 2026 FIA Financial Regulations text, the Red Bull misstatements, the scale of the company. What's simulated: the company, its transactions, the humans. How we know: the answer key, the Beancount check, the red-team log, the month-by-month chart.

---

## 6. Sponsor stacking

- **Hyphenate** (primary). Their vocabulary: learns / improves / proves; system of record vs system of work; one door, every write checked; tools are CRUD on the work; it proposes, you approve. Lead with beat 1. Keep the audit query and the red-team table one click away.
- **Microsoft** "Built for the Real World": finance is their first listed domain; criteria are customer understanding, measurable usefulness, path to production, responsible design. One slide: ERP connectors (D365/SAP are what teams use), where humans stay, what the red team found. No Azure requirement.
- **SpacetimeDB**: the system of work is the module. Show a reducer denying a self-approval live and the queue updating from a subscription.
- **Anthropic**: "one thing done well, usable on Monday" is our pitch; "you know where it could go wrong" is the red team.
- Skip Creao, Convex (conflicts), CRS, Nessie, Fetch.ai, x402, Visa.

---

## 7. Timeline (hard deadline Sunday 9:00 AM PDT)

**Friday night → 3 AM.** Decide, name it. Build the rulebook table from Section D and Issue 22 with effective dates. Agree the state machine and roles matrix. One person: `spacetime start` + `transition()` that logs a diff and denies a self-approval. One person: generator emitting 2025 history and 2026 stream with a cursor API. One person: Agent SDK calling `propose_classification` once. Slack #cohost-hyphenate if stuck.

**Saturday morning (Pillar 3 first, it is the foundation).** Sync job (raw → golden, cursors, stable ids). All transitions, roles matrix, same-commit audit rows, tests including denied attempts. Gateway posting to the ERP mock. Cap Analyst end to end on clean data.

**Saturday afternoon (Pillar 1).** Onboarding ingest of 2025 data. Policy Learner draft mode with precedent counts and the onboarding report. Controller UI: queue, policy approvals, evidence drawer, "why" chain.

**Saturday evening (Pillar 2, plus the gauntlet).** Correction scanner → policy proposals. Answer-to-precedent. Rulebook version ingest with effective windows and open-item delta. Beancount export + check. Sandbox gauntlet: replay over ten seeds with red-team mutations, per-policy record, autonomy grants from it, auto-approver job. Full-year replay; month-by-month chart. Freeze at midnight.

**Sunday 0:00-6:00.** Rehearse the three beats. Record the video. README with the proof table and the seats line. Devpost. Submit by 8:00.

**Roles (4).** Rulebook + generator + finance correctness. System of work module + gateway + roles. Agents + learner + red team + replay chart. UI + video + pitch.

---

## 8. Risks

- **Onboarding is the novel part and the hardest to make convincing.** If the learner's drafted policies look generic, Pillar 1 collapses into "we seeded some rules." Mitigation: the 2025 history must contain real patterns to find (vendor habits, past escalations, past FV adjustments), and the onboarding report must show precedent counts and sample rows.
- **SpacetimeDB learning curve.** Hard fallback at Saturday noon.
- **Hallucinated citations.** The LLM picks a policy id; code resolves the article. Never let it type an article number.
- **Demo drift.** Deterministic seed, cached responses for the three rehearsed beats, live calls only for the judge's injected scenario.
- **The simulator eats the weekend.** Cap it at generator + cursor API. No ERP UI.
- **Judge scenario breaks something.** Fine if the system asks instead of guessing. Make "I don't know, here's who decides and why" a visibly good outcome.

---

## 9. Open questions

1. SpacetimeDB-first or Postgres-first for the system of work?
2. How much 2025 history do we fabricate: a full year, or six months with the patterns we need?
3. Who plays the Head of Cost Cap in the video?
4. Team name and constructor name.
