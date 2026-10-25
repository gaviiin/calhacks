# Hyphenate workshop deck: "Beyond Agentic Harnesses"

Source: `research/hyphenate-workshop-beyond-agentic-harnesses.pdf` (21 slides, text extracted to `research/hyphenate-workshop.txt`). This is the most specific statement of what the judges want. Treat it as the spec.

## The one idea (slide 9)

**Records hold the truth. A system of work holds the work.**

- **Systems of record** (vertical databases): bank, ERP and ledger, contracts, CRM, inbox. Owned by finance and IT. They disagree with each other. You integrate with them; you don't replace them.
- **System of work** (execution platform): work items, decisions and reasons, questions and approvals, learned policies, the log. Owned by you. Agents and people share it. **"This is what you build."**
- Between them: a **Gateway**. "One door. Every write checked." The gateway is the only thing that posts to a system of record.
- Analogy: GitHub holds the record; the work runs in code.

## The four day-one questions (slide 8)

Harnesses (model + tools + loop + context) made agents capable. Put one inside a company and four questions appear:
1. **WORLD**: where does it act?
2. **TIME**: what does it remember next quarter?
3. **TEAM**: who does it work with?
4. **LIMITS**: what may it do, and can it prove why?

## Why outcome pricing matters to them (slide 10)

Hyphenate prices "on the work," per function or workstream, not per login. "Billing per outcome means proving every outcome. That takes a system of work." So provenance isn't a nice-to-have for them; it's how they get paid.

## The blueprint: one wire, end to end (slides 11-14)

Running example: a $57,975 wire from Acme at J.P. Morgan against NetSuite invoice INV-1042 for $58,000, $25 short.

A good system of work **learns, improves and proves**:

1. **Self-learning at onboarding.** A new accountant shadows for two weeks and reads last year's close binders. The agent instead queries a year of payments vs bank lines, finds how short wires were booked (214 precedents to account 6850 Bank Fees, max gap $48), and **drafts a policy** `pol-001: wire ≤ $50 short → 6850 Bank Fees`, evidence attached, `needs_approval` by the human controller.
2. **Self-improving, every day.** An accountant corrects a match (splits one wire across two invoices). The agent searches precedents, finds three alike, decides the pattern is general not customer-specific, and proposes `pol-014: split a wire across every invoice number in its memo when the amounts add up`, citing the precedent ids. Again `needs_approval`.
3. **Audit trail from day one.** Months later, "why was INV-1042 closed $25 short?" is one query against an append-only `audit_log(at, actor, change, why)`: sync created the bank line; agent proposed pol-001 v1; human approved "intermediary fee"; gateway posted the payment to NetSuite; gateway added the $25 JE. Policy **version** is recorded.

Four build blocks under it: Environment (sync the records, statefully), Agents + Humans (map actors, actions, resources), The Harness (tools are CRUD on the work), Traceability (log every transition as a diff).

## Build 1: the environment (slide 15)

Sync the systems of record into **one shape**: raw (landed as-is) → standardised (typed, signed) → golden (kept current). Entities: bank transaction, invoice & payment, customer, GL account, entity, vendor.

**Stateful, not a one-off export.** Change-only sync with a cursor per source. Stable ids (e.g. `md5(acct|src_id)`) so a re-sync never duplicates. Late bank posts re-read. Every golden row traces to its raw row (`raw_ref`). Schema shown: `bank_transaction(id, source, txn_date, amount, memo, raw_ref)`, `invoice(id, customer, amount, status, raw_ref)`, `sync_cursor(source, cursor, at)`.

## Build 2: agents and humans as one team (slide 16)

A roles matrix: **actors** (sync job, AI agent, accountant, controller, gateway) × **actions** (create, propose, ask/answer, approve, post) × **resources** (bank line, invoice, work item, policy, journal). Checked on every call.

```python
ROLES = {  # role -> resource -> allowed actions
  "sync":              {"work_item": {"create"}},
  "ai_agent":          {"work_item": {"propose", "ask"}, "policy": {"propose"}},
  "human_accountant":  {"work_item": {"approve", "answer"}},
  "human_controller":  {"policy": {"approve"}},
}  # no role can "post": only the gateway does

def can(actor, action, res) -> bool:
    if action not in ROLES[actor.role].get(res.kind, ()):
        return False
    if action == "approve" and res.proposed_by == actor.id:
        return False  # separation of duties
    return True
```

Example trace: sync create ✓, ai_agent propose ✓, **ai_agent approve ✗**, human_accountant approve ✓, **ai_agent post ✗**.

## Build 3: the harness meets the application (slide 17)

**The agent's tools are CRUD on the work**, not on the record.

State machine: `NEW --propose(ai_agent)--> PROPOSED --ask--> NEEDS_INFO --answer--> PROPOSED --approve(human)--> APPROVED --post(gateway)--> POSTED`. POSTED is "the only write to the record."

- C: sync creates a work item per bank line.
- R: tools read records, policies, precedents.
- U: every change goes through `transition()`.
- D: **never**. A reversal is a new transition.

"The harness sees tools, not tables or keys." Example tool `propose_match(item_id, invoice_id, policy_id)` reads the item, then calls `transition(item, "propose", AI_AGENT, patch={...}, reason=f"{policy_id}: gap within tolerance")`.

## Build 4: permissions and traceability (slide 18)

Log every transition as a **diff**, in the **same commit** as the change itself. Append-only; fixes are new events. **Denied attempts are logged too.** Each log row: at, actor, action, subject, allowed, reason, diff(before, after), evidence (source row ids). The `transition()` function computes the target state, checks `can()`, snapshots before/after, saves and appends the log in one transaction, and raises `Denied` if not allowed.

## Strong vs weak submissions (slide 19)

| Strong | Weak |
|---|---|
| A real company with a messy corner, and an answer key | A chatbot over a spreadsheet, or a one-shot extractor |
| A few roles done deep, named in one line | Ten workflows, none of them deep |
| Asks at the right moment, and handles a no | Clean happy-path data that only works on the script |
| Limits enforced in code; a record of every call | An admin key, and "the prompt tells it not to" |
| A moment on stage, and a score to back it | Memory that ends with the context window; "trust me" |

## Judging (slide 5)

01 Is it real enough? 02 Would you hire it? 03 Did we see something new? 04 Did it have a "wow" moment? Top 5 teams: expedited interview for every member.

## Logistics (slides 20-21)

- Fri Oct 23, 7:00 PM, Theater: technical workshop & office hours with founding engineers (likely already passed).
- Sat 12-2 PM: invite-only lunch for 2027 grads (drop resume at booth). Sat 2-4 PM: boba mixer, Gate 6.
- Booth all weekend. Slack: **#cohost-hyphenate**.
- Hiring: new grad SWE (NY, 2027), SWE intern (Summer 2027).

## What this changes for us

1. **Name the layers.** Our mock ERP/ledger, bank feed and contracts are systems of record. The thing we build is the system of work: work items, policies, precedents, approvals, audit log. The cap sub-ledger postings go to the "ERP" through a gateway, and only the gateway can post.
2. **Tools are CRUD on work items, never on the ledger.** Agents get `propose_classification`, `ask`, `propose_policy`, `search_precedents`, read-only record queries. No agent holds a ledger write path or any key.
3. **State machine, with NEEDS_INFO.** "Asks at the right moment, and handles a no" is a transition, not a prompt instruction. A rejected proposal is a new event with a reason, and the reason feeds precedent search.
4. **Self-learning at onboarding is a feature we were missing.** Give the agent the 2025 statutory ledger and the 2025 cost cap submission; have it draft classification policies from history ("in 2025 this team booked wind-tunnel-session catering to Relevant 214 times") and queue them for controller approval. That is the TIME question answered on day one.
5. **Stateful sync with cursors and late arrivals.** The generator should emit over simulated time with ERP corrections and late postings, and the environment should be a change-only sync with stable ids. Clean batch export is explicitly "weak."
6. **Diffs in the same commit, denied attempts logged.** The red team's SoD probes should show up in the audit log as denied rows. That is the "score to back it."
7. **Policy versions.** Every classification cites policy id and version; a rule change (2025 → 2026 catering) is a new policy version, not an edit.
