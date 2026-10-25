import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// Public, metadata-only evidence. Anyone allowed to subscribe can read these
// rows, so never put sponsor contracts, ledger data, or secrets here.
const fiaDocuments = table(
  { name: 'fia_documents', public: true },
  {
    // sha256(source|season|event_slug|canonical_document_url), computed by ingest.py
    docKey: t.string().primaryKey(),
    source: t.string(),
    season: t.u32(),
    eventSlug: t.string(),
    eventName: t.string(),
    documentNumber: t.string(),
    title: t.string(),
    // One evidence row per official document; a second key for the same URL is a conflict.
    documentUrl: t.string().unique(),
    sourcePageUrl: t.string(),
    // Exactly as printed by the FIA listing (e.g. "28.07.24 18:53 CET"), or empty.
    publishedAt: t.string(),
    actorRunId: t.string(),
    ingestMode: t.string(),
    ingestedAt: t.string(),
    reviewStatus: t.string(),
  }
);

// Private singleton: who published the module and who may ingest.
const config = table(
  { name: 'config' },
  {
    id: t.u32().primaryKey(),
    owner: t.identity(),
    ingestor: t.identity(),
  }
);

// ---------------------------------------------------------------- ledger read model
// Public mirror of the books the Python kernel posts (finance/). Only the kernel's
// identity can write here, and the reducer re-checks that every entry balances.
// The browser subscribes to these tables, so transactions stream in live.
const journalEntries = table(
  { name: 'journal_entries', public: true },
  {
    jeId: t.string().primaryKey(),
    runId: t.string(),
    kind: t.string(),
    status: t.string(), // posted | parked | refused | rejected
    memo: t.string(),
    sponsorId: t.string(),
    totalCents: t.i64(),
    effectiveDate: t.string(),
    recordedAt: t.string(),
    postedAt: t.string(),
    preparer: t.string(),
    needs: t.string(), // comma-separated roles still required
    reason: t.string(),
    reversesJeId: t.string(),
    policyIds: t.string(),
    answer: t.string(),
    lineCount: t.u32(),
  }
);

const jeLines = table(
  { name: 'je_lines', public: true },
  {
    lineKey: t.string().primaryKey(), // `${jeId}:${lineNo}`
    jeId: t.string(),
    lineNo: t.u32(),
    account: t.string(),
    debitCents: t.i64(),
    creditCents: t.i64(),
    origCurrency: t.string(),
    origAmountCents: t.i64(),
    fxRate: t.string(),
    sponsorId: t.string(),
  }
);

const pitWallItems = table(
  { name: 'pit_wall_items', public: true },
  {
    // memos (expected / at-risk / avoided bonuses, alerts), questions to people, billing decisions
    itemId: t.string().primaryKey(),
    runId: t.string(),
    itemType: t.string(),
    status: t.string(),
    payloadJson: t.string(),
    updatedAt: t.string(),
  }
);

// Private: which identities may write the mirror (role 'kernel') or mark FIA documents reviewed (role 'router').
const writers = table({ name: 'writers' }, { who: t.identity().primaryKey(), role: t.string() });

// One reviewable extract per official document. Text taken from the PDF, not a journal entry.
const fiaDecisionFacts = table(
  { name: 'fia_decision_facts', public: true },
  {
    docKey: t.string().primaryKey(),
    documentUrl: t.string(),
    cars: t.string(),
    offence: t.string(),
    outcome: t.string(),
    excerpt: t.string(),
    pdfHash: t.string(),
    actorRunId: t.string(),
    ingestMode: t.string(),
    extractedAt: t.string(),
    reviewStatus: t.string(),
  }
);


// ---------------------------------------------------------------- race desk (live race cost and revenue)
// Append-only tape of what happened on track, one row per OpenF1 fact (replayed or live). Public:
// it is public data. Money consequences live in race_effects, estimates in race_forecasts.
const raceEvents = table(
  { name: 'race_events', public: true },
  {
    eventKey: t.string().primaryKey(), // sha256(source|sessionKey|kind|driverNumber|lap|at|_key), computed by race/events.py
    sessionKey: t.u32().index('btree'),
    meetingKey: t.u32(),
    at: t.string(), // ISO-8601 UTC, when it happened on track
    lap: t.u32(),
    driverNumber: t.u32().index('btree'), // 0 = the whole field
    teamName: t.string(),
    kind: t.string().index('btree'),
    payloadJson: t.string(),
    source: t.string(), // openf1_replay | openf1_live
    ingestedAt: t.string(),
  }
);

// Current state of every car, upserted by recordRaceEvent. The timing strip reads this.
const carState = table(
  { name: 'car_state', public: true },
  {
    driverNumber: t.u32().primaryKey(),
    teamName: t.string(),
    position: t.u32(),
    lap: t.u32(),
    compound: t.string(),
    tyreAge: t.u32(),
    gapToLeader: t.string(),
    lastPitLap: t.u32(),
    status: t.string(), // running | pit | retired_suspected | retired
    updatedAt: t.string(),
  }
);

// A money consequence of one event, always a band (low <= mid <= high) with its basis and the tier
// that decided it (policy:<id> | jev | claude:<forecastKey>). Corrections never overwrite: they
// mark the row corrected and write a race_precedents row.
const raceEffects = table(
  { name: 'race_effects', public: true },
  {
    effectKey: t.string().primaryKey(), // `${eventKey}:${n}`
    eventKey: t.string().index('btree'),
    driverNumber: t.u32(),
    kind: t.string(), // cost | revenue_projection | bonus | cap_headroom
    bucket: t.string(), // account code | prize_money | sponsor_bonus:<id> | cap_headroom
    lowCents: t.i64(),
    midCents: t.i64(),
    highCents: t.i64(),
    currency: t.string(),
    memo: t.string(),
    basis: t.string(), // press | assumption | contract | ladder
    decidedBy: t.string(),
    jevJson: t.string(),
    why: t.string(),
    status: t.string(), // proposed | needs_person (Jev unsure, a person must confirm) | autonomous | confirmed | corrected
    at: t.string(),
  }
);

// The System Two plan after a big incident: steps on a timeline, parts, totals, prize and cap.
const raceForecasts = table(
  { name: 'race_forecasts', public: true },
  {
    forecastKey: t.string().primaryKey(),
    eventKey: t.string().index('btree'),
    driverNumber: t.u32(),
    teamName: t.string(),
    createdAt: t.string(),
    status: t.string(), // running | ready | failed | offline
    summary: t.string(),
    payloadJson: t.string(),
    model: t.string(),
  }
);

// Learned race policies (Ripple-Down Rules: a child refines its parent). Proposed by the learner,
// granted autonomy by a person, suspended when corrections or Jev contradictions pile up.
const racePolicies = table(
  { name: 'race_policies', public: true },
  {
    policyId: t.string().primaryKey(),
    parentPolicyId: t.string(),
    title: t.string(),
    pattern: t.string(), // JSON
    effectTemplate: t.string(), // JSON
    autonomy: t.string(), // SHADOW | GRANTED | REVOKED | SUSPENDED
    precedentCount: t.u32(),
    consistencyPct: t.u32(), // share of the precedents that ended the way the policy says, 0-100
    licence: t.string(), // "" or "licence(n=52, lb=0.95)": the evidence that granted autonomy without a person
    hits: t.u32(),
    contradictions: t.u32(),
    createdBy: t.string(),
    approvedBy: t.string(),
    createdAt: t.string(),
    updatedAt: t.string(),
  }
);

// A person's correction of an effect: the learner's raw material.
const racePrecedents = table(
  { name: 'race_precedents', public: true },
  {
    precedentKey: t.string().primaryKey(),
    effectKey: t.string().index('btree'),
    eventKey: t.string(),
    policyId: t.string().index('btree'),
    correctedLowCents: t.i64(),
    correctedMidCents: t.i64(),
    correctedHighCents: t.i64(),
    reason: t.string(),
    by: t.string(),
    at: t.string(),
  }
);


// ---------------------------------------------------------------- race-day flow (log, respond, account, ask, re-plan, close)
// One incident per crash or stoppage of a team car, across every message about it. Current belief here; every
// version is also appended to race_beliefs (valid time `at`, system time `recordedAt`): what we believed when.
const raceIncidents = table(
  { name: 'race_incidents', public: true },
  {
    incidentKey: t.string().primaryKey(),
    meetingKey: t.u32().index('btree'),
    sessionKey: t.u32(),
    driverNumber: t.u32(),
    teamName: t.string(),
    firstSeenAt: t.string(),
    status: t.string(), // suspected | corroborated | confirmed | assessed | closed
    version: t.u32(),
    beliefJson: t.string(),
    evidenceJson: t.string(),
    updatedAt: t.string(),
    cause: t.string(),
  }
);

const raceBeliefs = table(
  { name: 'race_beliefs', public: true },
  {
    beliefKey: t.string().primaryKey(), // `${incidentKey}@v${version}`
    incidentKey: t.string().index('btree'),
    version: t.u32(),
    status: t.string(),
    beliefJson: t.string(),
    at: t.string(), // valid time: when the evidence is from
    recordedAt: t.string(), // system time: when the desk learned it
    cause: t.string(),
  }
);

// What the playbook sets off. `auto` runs on its own (reversible, internal); outward-facing or irreversible
// actions wait for ownerRole and are approved through setRaceActionStatus.
const raceActions = table(
  { name: 'race_actions', public: true },
  {
    actionKey: t.string().primaryKey(),
    incidentKey: t.string().index('btree'),
    kind: t.string(),
    title: t.string(),
    detailJson: t.string(),
    dueAt: t.string(),
    status: t.string(), // auto | awaiting_approval | approved | rejected | done | cancelled
    ownerRole: t.string(),
    reversible: t.bool(),
    outward: t.bool(),
    decidedBy: t.string(),
    updatedAt: t.string(),
  }
);

// Provisional, balanced accruals for an incident, with when each counts against the cap.
const raceEntries = table(
  { name: 'race_entries', public: true },
  {
    entryKey: t.string().primaryKey(),
    incidentKey: t.string().index('btree'),
    effectKey: t.string(),
    memo: t.string(),
    effectiveDate: t.string(),
    recognition: t.string(), // first_use | incurred | excluded | already_expensed
    capRelevant: t.bool(),
    amountCents: t.i64(),
    status: t.string(), // proposed | approved | sealed
    evidenceJson: t.string(),
    at: t.string(),
  }
);

const raceEntryLines = table(
  { name: 'race_entry_lines', public: true },
  {
    lineKey: t.string().primaryKey(), // `${entryKey}:${n}`
    entryKey: t.string().index('btree'),
    lineNo: t.u32(),
    account: t.string(),
    debitCents: t.i64(),
    creditCents: t.i64(),
    memo: t.string(),
  }
);

// A question for a person, with the answers on its buttons (for damage: the two nearest precedents that ended
// differently). Answered through answerRaceQuestion; the desk applies the answer and learns from it.
const raceQuestions = table(
  { name: 'race_questions', public: true },
  {
    questionKey: t.string().primaryKey(),
    incidentKey: t.string().index('btree'),
    kind: t.string(), // damage | decision | approval
    prompt: t.string(),
    optionsJson: t.string(),
    routeRole: t.string(),
    expectedLossCents: t.i64(),
    deadlineAt: t.string(),
    effectKeys: t.string(),
    defaultOption: t.string(),
    status: t.string(), // open | answered | defaulted
    answerJson: t.string(),
    answeredBy: t.string(),
    createdAt: t.string(),
  }
);

// The season re-run after each change in the evidence.
const raceSims = table(
  { name: 'race_sims', public: true },
  {
    simKey: t.string().primaryKey(),
    meetingKey: t.u32().index('btree'),
    trigger: t.string(),
    at: t.string(),
    payloadJson: t.string(),
    runtimeMs: t.u32(),
  }
);

// The sealed weekend: Merkle root over its rows, totals, and one brief per role.
const raceCloses = table(
  { name: 'race_closes', public: true },
  {
    closeKey: t.string().primaryKey(),
    meetingKey: t.u32(),
    closedAt: t.string(),
    rootHash: t.string(),
    totalsJson: t.string(),
    briefsJson: t.string(),
    status: t.string(), // draft | approved | sent
    approvedBy: t.string(),
    leaves: t.u32(),
  }
);

// What each pit-wall decision would do right now, per team car: stay out, pit now, other compound, the same stop
// under green (after Varun Sanjeev's decision cockpit). Priced, never recommended; one row per car per decision point.
const raceOptions = table(
  { name: 'race_options', public: true },
  {
    optionKey: t.string().primaryKey(), // `${sessionKey}-${car}-L${lap}-${trigger}`
    sessionKey: t.u32().index('btree'),
    meetingKey: t.u32(),
    driverNumber: t.u32(),
    lap: t.u32(),
    at: t.string(),
    condition: t.string(), // green | sc | vsc | red
    trigger: t.string(), // what opened the window: lap | safety_car | vsc | red_flag | pit_window | incident
    optionsJson: t.string(),
  }
);

// Where each race entry went in the books: posted to the ERP (through the gateway key), held for a person's review,
// approved then posted, or rejected. One row per entry; the ERP's own id is kept.
const racePostings = table(
  { name: 'race_postings', public: true },
  {
    entryKey: t.string().primaryKey(),
    incidentKey: t.string().index('btree'),
    status: t.string(), // posted | held | approved | rejected | failed
    erpEntryId: t.string(),
    costCapRef: t.string(), // the cost cap desk row it landed in, when it did
    reviewRole: t.string(), // who must review a held entry: controller | cfo | head_of_cost_cap
    reason: t.string(), // why it was posted on its own, or why it waits
    amountCents: t.i64(),
    by: t.string(),
    at: t.string(),
  }
);

// Which outside services the desk actually used on this run, and how they did: OpenF1, Jev, Claude, the ERP,
// SpacetimeDB itself, the notification channels. Shown on every view so nothing claims to be live that is not.
const raceHealth = table(
  { name: 'race_health', public: true },
  {
    service: t.string().primaryKey(), // openf1 | jev | claude | erp | spacetimedb | notify
    status: t.string(), // live | degraded | offline | dry_run | not_configured
    detail: t.string(),
    calls: t.u32(),
    errors: t.u32(),
    latencyMs: t.u32(), // mean, when it makes sense
    at: t.string(),
  }
);

// ---------------------------------------------------------------- the race money gate (one door, one audit row)
// Every race decision that moves money or speaks for a person goes through gate(): the module resolves who is calling
// from the connection's identity (never from a `by` argument), checks the rule, then applies the change or refuses it,
// and writes exactly one race_audit row in the same transaction. A refusal is committed, never thrown, so the attempt
// is on the record even when nothing changed.
const raceAudit = table(
  { name: 'race_audit', public: true },
  {
    auditId: t.u64().primaryKey().autoInc(),
    at: t.string(), // commit time
    who: t.string(), // the caller's identity (hex)
    name: t.string(), // the seat's name, or agent:<role>
    role: t.string(), // the role the module resolved for the caller
    action: t.string().index('btree'),
    targetKey: t.string().index('btree'),
    allowed: t.bool(),
    reason: t.string(),
  }
);

// A person's seat: an identity, a name and a role. Decisions are attributed from here, not from what a client claims.
const raceSeats = table(
  { name: 'race_seats', public: true },
  { who: t.identity().primaryKey(), name: t.string(), role: t.string(), grantedAt: t.string() }
);

// The money rules, set by the CFO. One row (id 0); the defaults below apply until it exists.
const raceRules = table(
  { name: 'race_rules', public: true },
  {
    id: t.u32().primaryKey(),
    autoPostMaxCents: t.i64(), // under this the desk may post on its own authority (the $250k materiality)
    cfoCents: t.i64(), // at or above this the CFO decides ($1M)
    modelMayPostAlone: t.bool(), // false: an estimate from Jev or the forecast agent needs a person's sign-off to post
    replayPace: t.f64(), // race seconds per wall second for the running replay (1 = live); scales question deadlines
    updatedBy: t.string(),
    updatedAt: t.string(),
  }
);

// A person signed off an estimate (directly, or by answering the question about it). The posting rule reads this.
const raceSignoffs = table(
  { name: 'race_signoffs', public: true },
  { effectKey: t.string().primaryKey(), who: t.string(), name: t.string(), via: t.string(), at: t.string() }
);

// Who is watching right now: one row per open dashboard connection (agents are not seats and are not listed).
const raceOnline = table(
  { name: 'race_online', public: true },
  { connectionId: t.string().primaryKey(), who: t.string(), name: t.string(), role: t.string(), connectedAt: t.string() }
);

// Measured, not claimed: from the moment the desk read an event to the moment its row committed here.
const raceLatency = table(
  { name: 'race_latency', public: true },
  {
    id: t.u32().primaryKey(),
    events: t.u64(),
    lastEventKey: t.string(),
    lastMs: t.u32(),
    meanMs: t.u32(),
    maxMs: t.u32(),
    lastCommittedAt: t.string(),
  }
);

// A question's deadline, kept by the database itself: when it comes due the module takes the stated default even if
// every agent process is down.
const raceQuestionTimers = table(
  { name: 'race_question_timers' },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(), questionKey: t.string() }
);

const spacetimedb = schema({
  fiaDocuments,
  config,
  journalEntries,
  jeLines,
  pitWallItems,
  writers,
  fiaDecisionFacts,
  raceEvents,
  carState,
  raceEffects,
  raceForecasts,
  racePolicies,
  racePrecedents,
  raceIncidents,
  raceBeliefs,
  raceActions,
  raceEntries,
  raceEntryLines,
  raceQuestions,
  raceSims,
  raceCloses,
  raceOptions,
  racePostings,
  raceHealth,
  raceAudit,
  raceSeats,
  raceRules,
  raceSignoffs,
  raceOnline,
  raceLatency,
  raceQuestionTimers,
});
export default spacetimedb;

const FiaDocumentInput = t.object('FiaDocumentInput', {
  docKey: t.string(),
  source: t.string(),
  season: t.u32(),
  eventSlug: t.string(),
  eventName: t.string(),
  documentNumber: t.string(),
  title: t.string(),
  documentUrl: t.string(),
  sourcePageUrl: t.string(),
  publishedAt: t.string(),
  actorRunId: t.string(),
  ingestMode: t.string(),
  ingestedAt: t.string(),
});

const CONFIG_ID = 0;
const DOC_KEY = /^[0-9a-f]{64}$/;
const EVENT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OFFICIAL_URL = /^https:\/\/www\.fia\.com\/\S+$/;
const APIFY_RUN_ID = /^[A-Za-z0-9]{8,32}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const INGEST_MODES = ['live_actor_run', 'replay_captured_run', 'test_fixture'];
const MAX_TEXT = 512;

function requireText(field: string, value: string, max = MAX_TEXT) {
  if (value.trim().length === 0) throw new SenderError(`invalid document: ${field} is empty`);
  if (value.length > max) throw new SenderError(`invalid document: ${field} exceeds ${max} chars`);
}

export const init = spacetimedb.init(ctx => {
  ctx.db.config.insert({ id: CONFIG_ID, owner: ctx.sender, ingestor: ctx.sender });
});

export const ingestDocument = spacetimedb.reducer(
  { doc: FiaDocumentInput },
  (ctx, { doc }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.ingestor)) {
      throw new SenderError('unauthorized: caller is not the ingestion identity');
    }

    if (!DOC_KEY.test(doc.docKey)) throw new SenderError('invalid document: docKey must be 64 hex chars');
    if (doc.source !== 'fia') throw new SenderError('invalid document: source must be "fia"');
    if (doc.season < 1950 || doc.season > 2100) throw new SenderError('invalid document: season out of range');
    if (!EVENT_SLUG.test(doc.eventSlug)) throw new SenderError('invalid document: eventSlug malformed');
    requireText('eventName', doc.eventName);
    requireText('title', doc.title);
    for (const [field, url] of [['documentUrl', doc.documentUrl], ['sourcePageUrl', doc.sourcePageUrl]]) {
      if (url.length > 2048 || !OFFICIAL_URL.test(url)) {
        throw new SenderError(`invalid document: ${field} must be an https://www.fia.com/ URL`);
      }
    }
    if (doc.documentNumber.length > 16 || doc.publishedAt.length > 64) {
      throw new SenderError('invalid document: documentNumber/publishedAt too long');
    }
    if (!INGEST_MODES.includes(doc.ingestMode)) throw new SenderError('invalid document: unknown ingestMode');
    // Fixtures never carry a run ID, so a test row can't pass as Apify output.
    if (doc.ingestMode === 'test_fixture' ? doc.actorRunId !== '' : !APIFY_RUN_ID.test(doc.actorRunId)) {
      throw new SenderError('invalid document: actorRunId does not match ingestMode');
    }
    if (!ISO_UTC.test(doc.ingestedAt)) throw new SenderError('invalid document: ingestedAt must be ISO-8601 UTC');

    // Idempotent replay: an existing key is left untouched, never overwritten.
    if (ctx.db.fiaDocuments.docKey.find(doc.docKey)) return;

    const sameUrl = ctx.db.fiaDocuments.documentUrl.find(doc.documentUrl);
    if (sameUrl) {
      throw new SenderError(`conflict: documentUrl already recorded under docKey ${sameUrl.docKey}`);
    }

    ctx.db.fiaDocuments.insert({ ...doc, reviewStatus: 'unreviewed' });
  }
);

// Owner-only: hand ingestion to a dedicated identity so the bridge doesn't
// need the owner's token.
export const setIngestor = spacetimedb.reducer(
  { ingestor: t.identity() },
  (ctx, { ingestor }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.owner)) {
      throw new SenderError('unauthorized: only the module owner can change the ingestor');
    }
    ctx.db.config.id.update({ ...cfg, ingestor });
  }
);

// ---------------------------------------------------------------- ledger mirror reducers

function requireRole(ctx: any, role: string) {
  const cfg = ctx.db.config.id.find(CONFIG_ID);
  if (cfg && ctx.sender.equals(cfg.owner)) return; // the publisher may always write
  const w = ctx.db.writers.who.find(ctx.sender);
  if (!w || w.role !== role) throw new SenderError(`unauthorized: caller lacks role ${role}`);
}

// ---------------------------------------------------------------- who is calling, and the one door

const AGENT_ROLES = ['kernel', 'router', 'race'];
const PERSON_ROLES = ['race_head', 'controller', 'head_of_cost_cap', 'cfo'];
// Who may decide a held posting: the review role it was held for, or a more senior seat. race_head is the
// dashboard's head-of-racing-finance seat and decides at controller level.
const REVIEW_RANK: Record<string, number> = { '': 0, controller: 1, head_of_cost_cap: 2, cfo: 3 };
const SEAT_RANK: Record<string, number> = { race_head: 1, controller: 1, head_of_cost_cap: 2, cfo: 3 };
const RULES_ID = 0;
const DEFAULT_RULES = { autoPostMaxCents: 25_000_000n, cfoCents: 100_000_000n, modelMayPostAlone: false, replayPace: 1 };

type Caller = { who: string; name: string; role: string; person: boolean; owner: boolean };

function callerOf(ctx: any): Caller {
  const cfg = ctx.db.config.id.find(CONFIG_ID);
  const owner = !!cfg && ctx.sender.equals(cfg.owner);
  const w = ctx.db.writers.who.find(ctx.sender);
  const seat = ctx.db.raceSeats.who.find(ctx.sender);
  const role: string = w?.role ?? (owner ? 'owner' : 'none');
  // The publisher's identity is also the agents' identity on a demo laptop, so it never counts as a person.
  const person = !owner && PERSON_ROLES.includes(role);
  const name = seat?.name ?? (person ? role : owner ? 'publisher' : role === 'none' ? 'unknown' : `agent:${role}`);
  return { who: ctx.sender.toHexString(), name, role, person, owner };
}

function rules(ctx: any) {
  return ctx.db.raceRules.id.find(RULES_ID) ?? DEFAULT_RULES;
}

function audit(ctx: any, c: Caller, action: string, targetKey: string, allowed: boolean, reason: string) {
  ctx.db.raceAudit.insert({
    auditId: 0n, at: ctx.timestamp.toISOString(), who: c.who, name: c.name, role: c.role, action, targetKey, allowed, reason: reason.slice(0, 512),
  });
}

/** The one door. `check` returns a refusal reason or null; `apply` makes the change and may return a note. Exactly one
 * race_audit row is written either way, in this transaction. Returns whether the change was applied. */
function gate(ctx: any, action: string, targetKey: string, check: (c: Caller) => string | null, apply: (c: Caller) => string | void): boolean {
  const c = callerOf(ctx);
  const refusal = check(c);
  if (refusal) {
    audit(ctx, c, action, targetKey, false, refusal);
    return false;
  }
  const note = apply(c);
  audit(ctx, c, action, targetKey, true, note || 'allowed');
  return true;
}

const personOnly = (c: Caller) =>
  c.person ? null : c.owner || AGENT_ROLES.includes(c.role) ? 'only a person decides this; an agent identity is refused' : `caller has no seat (${c.role})`;

function usd(cents: bigint): string {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  const dollars = a / 100n;
  const s = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${s}`;
}

export const setWriter = spacetimedb.reducer(
  { who: t.identity(), role: t.string() },
  (ctx, { who, role }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.owner)) throw new SenderError('unauthorized: only the module owner can grant roles');
    if (![...AGENT_ROLES, ...PERSON_ROLES].includes(role)) throw new SenderError('unknown role');
    if (ctx.db.writers.who.find(who)) ctx.db.writers.who.update({ who, role });
    else ctx.db.writers.insert({ who, role });
  }
);

// A person's seat: the role and the name every decision of theirs is recorded under. Owner only.
export const grantSeat = spacetimedb.reducer(
  { who: t.identity(), role: t.string(), name: t.string() },
  (ctx, { who, role, name }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.owner)) throw new SenderError('unauthorized: only the module owner can grant seats');
    if (!PERSON_ROLES.includes(role)) throw new SenderError('unknown seat role');
    if (name.trim().length === 0 || name.length > 64) throw new SenderError('invalid seat name');
    if (who.equals(cfg.owner)) throw new SenderError('the publisher identity runs the agents; give the person their own identity');
    if (ctx.db.writers.who.find(who)) ctx.db.writers.who.update({ who, role });
    else ctx.db.writers.insert({ who, role });
    const row = { who, name, role, grantedAt: ctx.timestamp.toISOString() };
    if (ctx.db.raceSeats.who.find(who)) ctx.db.raceSeats.who.update(row);
    else ctx.db.raceSeats.insert(row);
    // a dashboard already open under this identity is now that person
    const hex = who.toHexString();
    const open = [...ctx.db.raceOnline.iter()].filter((o: any) => o.who === hex);
    for (const o of open) ctx.db.raceOnline.connectionId.update({ ...o, name, role });
    audit(ctx, callerOf(ctx), 'grant_seat', hex, true, `${name} seated as ${role}`);
  }
);

// The CFO sets the money rules; every change is audited.
export const setRaceRules = spacetimedb.reducer(
  { autoPostMaxCents: t.i64(), cfoCents: t.i64(), modelMayPostAlone: t.bool() },
  (ctx, { autoPostMaxCents, cfoCents, modelMayPostAlone }) => {
    if (autoPostMaxCents < 0n || cfoCents < autoPostMaxCents) throw new SenderError('invalid rules: 0 <= auto-post limit <= CFO threshold');
    gate(ctx, 'set_rules', 'race_rules',
      (c) => (c.role === 'cfo' && c.person) || c.owner ? null : 'only the CFO changes the money rules',
      (c) => {
        const cur = rules(ctx);
        const row = { id: RULES_ID, autoPostMaxCents, cfoCents, modelMayPostAlone, replayPace: cur.replayPace, updatedBy: c.name, updatedAt: ctx.timestamp.toISOString() };
        if (ctx.db.raceRules.id.find(RULES_ID)) ctx.db.raceRules.id.update(row);
        else ctx.db.raceRules.insert(row);
        return `auto-post under ${usd(autoPostMaxCents)}, CFO from ${usd(cfoCents)}, model estimates ${modelMayPostAlone ? 'may' : 'may not'} post alone`;
      });
  }
);

// The replay tells the module how fast race time runs, so a question's deadline (in race time) comes due on the wall clock.
export const setRaceClock = spacetimedb.reducer(
  { pace: t.f64() },
  (ctx, { pace }) => {
    requireRole(ctx, 'race');
    if (!(pace > 0 && pace <= 1000)) throw new SenderError('invalid pace');
    const cur = ctx.db.raceRules.id.find(RULES_ID);
    if (cur) ctx.db.raceRules.id.update({ ...cur, replayPace: pace });
    else ctx.db.raceRules.insert({ id: RULES_ID, ...DEFAULT_RULES, replayPace: pace, updatedBy: 'defaults', updatedAt: ctx.timestamp.toISOString() });
  }
);

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const c = callerOf(ctx);
  if (!ctx.connectionId || c.owner || AGENT_ROLES.includes(c.role)) return; // agents are not seats
  const row = { connectionId: ctx.connectionId.toHexString(), who: c.who, name: c.person ? c.name : 'observer', role: c.person ? c.role : 'observer', connectedAt: ctx.timestamp.toISOString() };
  if (ctx.db.raceOnline.connectionId.find(row.connectionId)) ctx.db.raceOnline.connectionId.update(row);
  else ctx.db.raceOnline.insert(row);
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  if (ctx.connectionId) ctx.db.raceOnline.connectionId.delete(ctx.connectionId.toHexString());
});

const EntryInput = t.object('EntryInput', {
  jeId: t.string(), runId: t.string(), kind: t.string(), status: t.string(), memo: t.string(), sponsorId: t.string(),
  totalCents: t.i64(), effectiveDate: t.string(), recordedAt: t.string(), postedAt: t.string(), preparer: t.string(),
  needs: t.string(), reason: t.string(), reversesJeId: t.string(), policyIds: t.string(), answer: t.string(),
});
const LineInput = t.object('LineInput', {
  account: t.string(), debitCents: t.i64(), creditCents: t.i64(), origCurrency: t.string(),
  origAmountCents: t.i64(), fxRate: t.string(), sponsorId: t.string(),
});
const STATUSES = ['posted', 'parked', 'refused', 'rejected'];

export const mirrorEntry = spacetimedb.reducer(
  { entry: EntryInput, lines: t.array(LineInput) },
  (ctx, { entry, lines }) => {
    requireRole(ctx, 'kernel');
    if (!STATUSES.includes(entry.status)) throw new SenderError('invalid entry: unknown status');
    let dr = 0n;
    let cr = 0n;
    for (const l of lines) {
      if (l.debitCents < 0n || l.creditCents < 0n) throw new SenderError('invalid entry: negative amount');
      dr += l.debitCents;
      cr += l.creditCents;
    }
    // Defense in depth: even with the kernel's identity, an unbalanced entry never lands.
    if (lines.length < 2 || dr !== cr) throw new SenderError(`invalid entry: debits ${dr} != credits ${cr}`);
    const existing = ctx.db.journalEntries.jeId.find(entry.jeId);
    if (existing) {
      if (existing.lineCount !== lines.length) throw new SenderError('invalid update: lines are immutable');
      if (existing.status === 'posted' && entry.status !== 'posted') throw new SenderError('invalid update: posted entries are final');
      ctx.db.journalEntries.jeId.update({ ...entry, lineCount: existing.lineCount });
      return;
    }
    ctx.db.journalEntries.insert({ ...entry, lineCount: lines.length });
    lines.forEach((l, i) => ctx.db.jeLines.insert({ ...l, lineKey: `${entry.jeId}:${i}`, jeId: entry.jeId, lineNo: i }));
  }
);

export const mirrorItem = spacetimedb.reducer(
  { itemId: t.string(), runId: t.string(), itemType: t.string(), status: t.string(), payloadJson: t.string(), updatedAt: t.string() },
  (ctx, row) => {
    requireRole(ctx, 'kernel');
    if (row.payloadJson.length > 8192) throw new SenderError('payload too large');
    if (ctx.db.pitWallItems.itemId.find(row.itemId)) ctx.db.pitWallItems.itemId.update(row);
    else ctx.db.pitWallItems.insert(row);
  }
);

const REVIEW_STATUSES = ['unreviewed', 'routed', 'linked_to_entry', 'no_financial_impact', 'reviewed'];

// Fixes the evidence feed's permanent "Needs review": the router marks what it did with each document.
export const setReviewStatus = spacetimedb.reducer(
  { docKey: t.string(), reviewStatus: t.string() },
  (ctx, { docKey, reviewStatus }) => {
    requireRole(ctx, 'router');
    if (!REVIEW_STATUSES.includes(reviewStatus)) throw new SenderError('unknown review status');
    const doc = ctx.db.fiaDocuments.docKey.find(docKey);
    if (!doc) throw new SenderError('no such document');
    ctx.db.fiaDocuments.docKey.update({ ...doc, reviewStatus });
  }
);

const FiaDecisionInput = t.object('FiaDecisionInput', {
  docKey: t.string(),
  documentUrl: t.string(),
  cars: t.string(),
  offence: t.string(),
  outcome: t.string(),
  excerpt: t.string(),
  pdfHash: t.string(),
  actorRunId: t.string(),
  ingestMode: t.string(),
  extractedAt: t.string(),
});

const DECISION_OUTCOMES = ['', 'no_further_action', 'disqualification', 'time_penalty', 'fine', 'reprimand', 'warning'];
const PDF_SHA256 = /^[0-9a-f]{64}$/;
const CARS = /^(?:\d{1,2}(?:,\d{1,2})*)?$/;

// Evidence from the PDF. The ingestion identity may write it; it never posts a journal entry.
export const ingestDecision = spacetimedb.reducer(
  { fact: FiaDecisionInput },
  (ctx, { fact }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.ingestor)) {
      throw new SenderError('unauthorized: caller is not the ingestion identity');
    }
    if (!DOC_KEY.test(fact.docKey)) throw new SenderError('invalid decision: docKey must be 64 hex chars');
    if (!ctx.db.fiaDocuments.docKey.find(fact.docKey)) {
      throw new SenderError('invalid decision: parent document is not in fia_documents');
    }
    if (fact.documentUrl.length > 2048 || !OFFICIAL_URL.test(fact.documentUrl)) {
      throw new SenderError('invalid decision: documentUrl must be an https://www.fia.com/ URL');
    }
    if (!CARS.test(fact.cars)) throw new SenderError('invalid decision: cars malformed');
    requireText('offence', fact.offence);
    if (!DECISION_OUTCOMES.includes(fact.outcome)) throw new SenderError('invalid decision: unknown outcome');
    if (fact.excerpt.length > 500) throw new SenderError('invalid decision: excerpt exceeds 500 chars');
    if (!PDF_SHA256.test(fact.pdfHash)) throw new SenderError('invalid decision: pdfHash must be 64 hex chars');
    if (!INGEST_MODES.includes(fact.ingestMode)) throw new SenderError('invalid decision: unknown ingestMode');
    if (fact.ingestMode === 'test_fixture' ? fact.actorRunId !== '' : !APIFY_RUN_ID.test(fact.actorRunId)) {
      throw new SenderError('invalid decision: actorRunId does not match ingestMode');
    }
    if (!ISO_UTC.test(fact.extractedAt)) throw new SenderError('invalid decision: extractedAt must be ISO-8601 UTC');

    if (ctx.db.fiaDecisionFacts.docKey.find(fact.docKey)) return;
    ctx.db.fiaDecisionFacts.insert({ ...fact, reviewStatus: 'unreviewed' });
  }
);

// ---------------------------------------------------------------- race desk reducers

const RACE_EVENT_KINDS = [
  'session_status', 'flag', 'safety_car', 'vsc', 'red_flag', 'position', 'overtake', 'pit_stop', 'stint', 'lap',
  'incident', 'penalty', 'retirement_suspected', 'retirement_confirmed', 'standings', 'notice', 'car_stopped',
];
const RACE_SOURCES = ['openf1_replay', 'openf1_live', 'test_fixture'];
const CAR_STATUSES = ['running', 'pit', 'retired_suspected', 'retired'];
const EFFECT_KINDS = ['cost', 'revenue_projection', 'bonus', 'cap_headroom'];
const EFFECT_BASES = ['press', 'assumption', 'contract', 'ladder', 'policy', 'precedent'];
const EFFECT_STATUSES = ['proposed', 'needs_person', 'autonomous', 'confirmed', 'corrected'];
const RECORDABLE_EFFECT_STATUSES = ['proposed', 'needs_person', 'autonomous'];
const FORECAST_STATUSES = ['running', 'ready', 'failed', 'offline'];
const AUTONOMY = ['SHADOW', 'GRANTED', 'REVOKED', 'SUSPENDED'];
const HEX64 = /^[0-9a-f]{64}$/;

function requireIso(field: string, value: string) {
  if (!ISO_UTC.test(value)) throw new SenderError(`invalid ${field}: must be ISO-8601 UTC`);
}

const RaceEventInput = t.object('RaceEventInput', {
  eventKey: t.string(), sessionKey: t.u32(), meetingKey: t.u32(), at: t.string(), lap: t.u32(), driverNumber: t.u32(),
  teamName: t.string(), kind: t.string(), payloadJson: t.string(), source: t.string(), ingestedAt: t.string(),
});
const CarStateInput = t.object('CarStateInput', {
  driverNumber: t.u32(), teamName: t.string(), position: t.u32(), lap: t.u32(), compound: t.string(), tyreAge: t.u32(),
  gapToLeader: t.string(), lastPitLap: t.u32(), status: t.string(), updatedAt: t.string(),
});

// From the desk reading the event (ingestedAt, its wall clock) to this commit. A replay stamps ingestedAt when it
// sends, so this is the transport plus the transaction, measured by the database itself.
function noteLatency(ctx: any, eventKey: string, ingestedAt: string) {
  const sent = Date.parse(ingestedAt);
  if (!Number.isFinite(sent)) return;
  const committed = Number(ctx.timestamp.toMillis());
  const ms = Math.max(0, Math.min(60_000, committed - sent));
  const cur = ctx.db.raceLatency.id.find(0);
  const events = (cur?.events ?? 0n) + 1n;
  const mean = cur ? Math.round((cur.meanMs * Number(cur.events) + ms) / Number(events)) : ms;
  const row = { id: 0, events, lastEventKey: eventKey, lastMs: ms, meanMs: mean, maxMs: Math.max(cur?.maxMs ?? 0, ms), lastCommittedAt: ctx.timestamp.toISOString() };
  if (cur) ctx.db.raceLatency.id.update(row);
  else ctx.db.raceLatency.insert(row);
}

// The tape is append-only and idempotent: replaying a session writes each fact once.
export const recordRaceEvent = spacetimedb.reducer(
  { event: RaceEventInput, state: t.option(CarStateInput) },
  (ctx, { event, state }) => {
    requireRole(ctx, 'race');
    if (!HEX64.test(event.eventKey)) throw new SenderError('invalid event: eventKey must be 64 hex chars');
    if (!RACE_EVENT_KINDS.includes(event.kind)) throw new SenderError(`invalid event: unknown kind ${event.kind}`);
    if (!RACE_SOURCES.includes(event.source)) throw new SenderError('invalid event: unknown source');
    requireIso('event.at', event.at);
    requireIso('event.ingestedAt', event.ingestedAt);
    if (event.payloadJson.length > 4096) throw new SenderError('invalid event: payload too large');
    if (event.teamName.length > 64) throw new SenderError('invalid event: teamName too long');
    if (state !== undefined) {
      if (!CAR_STATUSES.includes(state.status)) throw new SenderError('invalid state: unknown status');
      if (state.driverNumber !== event.driverNumber) throw new SenderError('invalid state: driver differs from event');
    }
    if (!ctx.db.raceEvents.eventKey.find(event.eventKey)) {
      ctx.db.raceEvents.insert(event);
      noteLatency(ctx, event.eventKey, event.ingestedAt);
    }
    if (state !== undefined) {
      const cur = ctx.db.carState.driverNumber.find(state.driverNumber);
      // A later state never goes backwards; a retirement is never undone by a stale position row.
      if (cur && cur.updatedAt > state.updatedAt) return;
      if (cur && cur.status === 'retired' && state.status !== 'retired') return;
      if (cur) ctx.db.carState.driverNumber.update(state);
      else ctx.db.carState.insert(state);
    }
  }
);

const EffectInput = t.object('EffectInput', {
  effectKey: t.string(), driverNumber: t.u32(), kind: t.string(), bucket: t.string(), lowCents: t.i64(), midCents: t.i64(),
  highCents: t.i64(), currency: t.string(), memo: t.string(), basis: t.string(), decidedBy: t.string(), jevJson: t.string(),
  why: t.string(), status: t.string(), at: t.string(),
});

export const recordRaceEffects = spacetimedb.reducer(
  { eventKey: t.string(), effects: t.array(EffectInput) },
  (ctx, { eventKey, effects }) => {
    requireRole(ctx, 'race');
    if (!ctx.db.raceEvents.eventKey.find(eventKey)) throw new SenderError('invalid effect: no such event');
    const hit = new Set<string>(); // one hit per policy per event, however many lines it produced
    for (const e of effects) {
      if (!e.effectKey.startsWith(`${eventKey}:`)) throw new SenderError('invalid effect: effectKey must start with eventKey');
      if (!EFFECT_KINDS.includes(e.kind)) throw new SenderError(`invalid effect: unknown kind ${e.kind}`);
      if (!EFFECT_BASES.includes(e.basis)) throw new SenderError('invalid effect: unknown basis');
      if (!RECORDABLE_EFFECT_STATUSES.includes(e.status)) throw new SenderError('invalid effect: status must be proposed, needs_person or autonomous');
      if (!(e.lowCents <= e.midCents && e.midCents <= e.highCents)) throw new SenderError('invalid effect: band must be low <= mid <= high');
      if (e.jevJson.length > 2048 || e.why.length > 512 || e.memo.length > 512) throw new SenderError('invalid effect: text too long');
      requireIso('effect.at', e.at);
      if (ctx.db.raceEffects.effectKey.find(e.effectKey)) continue; // idempotent replay
      ctx.db.raceEffects.insert({ ...e, eventKey });
      const m = /^policy:(.+)$/.exec(e.decidedBy);
      if (m && !hit.has(m[1]!)) {
        hit.add(m[1]!);
        const pol = ctx.db.racePolicies.policyId.find(m[1]!);
        if (pol) ctx.db.racePolicies.policyId.update({ ...pol, hits: pol.hits + 1, updatedAt: e.at });
      }
    }
  }
);

const ForecastInput = t.object('ForecastInput', {
  forecastKey: t.string(), eventKey: t.string(), driverNumber: t.u32(), teamName: t.string(), createdAt: t.string(),
  status: t.string(), summary: t.string(), payloadJson: t.string(), model: t.string(),
});

export const recordForecast = spacetimedb.reducer(
  { forecast: ForecastInput },
  (ctx, { forecast }) => {
    requireRole(ctx, 'race');
    if (!ctx.db.raceEvents.eventKey.find(forecast.eventKey)) throw new SenderError('invalid forecast: no such event');
    if (!FORECAST_STATUSES.includes(forecast.status)) throw new SenderError('invalid forecast: unknown status');
    if (forecast.summary.length > 1024 || forecast.payloadJson.length > 16384) throw new SenderError('invalid forecast: text too long');
    requireIso('forecast.createdAt', forecast.createdAt);
    const cur = ctx.db.raceForecasts.forecastKey.find(forecast.forecastKey);
    if (cur) {
      if (cur.status === 'ready') throw new SenderError('invalid update: a ready forecast is final');
      ctx.db.raceForecasts.forecastKey.update(forecast);
    } else {
      ctx.db.raceForecasts.insert(forecast);
    }
  }
);

const PolicyInput = t.object('RacePolicyInput', {
  policyId: t.string(), parentPolicyId: t.string(), title: t.string(), pattern: t.string(), effectTemplate: t.string(),
  precedentCount: t.u32(), consistencyPct: t.u32(), createdBy: t.string(), createdAt: t.string(),
});

// The licence: a policy earns autonomy from evidence, not from a signature. With n precedents of which a
// share p ended the way the policy says, the 90% Wilson lower bound of p must clear LICENCE_LB with at least
// LICENCE_MIN_N cases. A person can still revoke or suspend; the learner can never grant more than this.
const LICENCE_MIN_N = 5;
const LICENCE_LB = 0.75;
function wilsonLower(successes: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - spread) / denom);
}
function licenceFor(precedentCount: number, consistencyPct: number): string {
  const successes = Math.round((precedentCount * consistencyPct) / 100);
  const lb = wilsonLower(successes, precedentCount);
  return precedentCount >= LICENCE_MIN_N && lb >= LICENCE_LB ? `licence(n=${precedentCount}, lb=${lb.toFixed(2)})` : '';
}

// The learner proposes; the module decides the starting autonomy from the evidence (licence) or SHADOW.
export const proposeRacePolicy = spacetimedb.reducer(
  { policy: PolicyInput },
  (ctx, { policy }) => {
    requireRole(ctx, 'race');
    if (policy.policyId.length === 0 || policy.policyId.length > 128) throw new SenderError('invalid policy: policyId');
    if (policy.pattern.length > 4096 || policy.effectTemplate.length > 4096) throw new SenderError('invalid policy: too large');
    if (policy.consistencyPct > 100) throw new SenderError('invalid policy: consistencyPct must be 0-100');
    if (policy.parentPolicyId !== '' && !ctx.db.racePolicies.policyId.find(policy.parentPolicyId)) {
      throw new SenderError('invalid policy: parent does not exist');
    }
    requireIso('policy.createdAt', policy.createdAt);
    const licence = licenceFor(policy.precedentCount, policy.consistencyPct);
    const cur = ctx.db.racePolicies.policyId.find(policy.policyId);
    if (cur) {
      // Re-proposing refreshes the draft while no person has decided; a licence may grow with new precedents.
      if (cur.approvedBy !== '' || cur.autonomy === 'REVOKED' || cur.autonomy === 'SUSPENDED') {
        throw new SenderError('invalid policy: already decided by a person');
      }
      ctx.db.racePolicies.policyId.update({ ...cur, ...policy, licence, autonomy: licence ? 'GRANTED' : 'SHADOW', updatedAt: policy.createdAt });
      return;
    }
    ctx.db.racePolicies.insert({
      ...policy, licence, autonomy: licence ? 'GRANTED' : 'SHADOW', hits: 0, contradictions: 0, approvedBy: '', updatedAt: policy.createdAt,
    });
  }
);

export const setRacePolicyAutonomy = spacetimedb.reducer(
  { policyId: t.string(), autonomy: t.string(), by: t.string(), at: t.string() },
  (ctx, { policyId, autonomy, at }) => {
    if (!AUTONOMY.includes(autonomy)) throw new SenderError('unknown autonomy');
    requireIso('at', at);
    const cur = ctx.db.racePolicies.policyId.find(policyId);
    if (!cur) throw new SenderError('no such policy');
    // A licence is granted by a person's seat (race_head or the CFO); the publisher may act for the head from the CLI.
    gate(ctx, 'set_policy_autonomy', policyId,
      (c) => (c.person && (c.role === 'race_head' || c.role === 'cfo')) || c.owner ? null : 'only the head of racing finance or the CFO sets a policy\'s autonomy',
      (c) => {
        ctx.db.racePolicies.policyId.update({ ...cur, autonomy, approvedBy: autonomy === 'GRANTED' ? c.name : cur.approvedBy, updatedAt: at });
        return `${policyId} -> ${autonomy}`;
      });
  }
);

// ---------------------------------------------------------------- sign-offs: a person stands behind an estimate

function signOff(ctx: any, effectKey: string, who: string, name: string, via: string) {
  const row = { effectKey, who, name, via, at: ctx.timestamp.toISOString() };
  if (ctx.db.raceSignoffs.effectKey.find(effectKey)) ctx.db.raceSignoffs.effectKey.update(row);
  else ctx.db.raceSignoffs.insert(row);
}

function writePrecedent(ctx: any, eff: any, precedentKey: string, low: bigint, mid: bigint, high: bigint, reason: string, by: string, at: string) {
  const m = /^policy:(.+)$/.exec(eff.decidedBy);
  const policyId = m ? m[1]! : '';
  ctx.db.racePrecedents.insert({
    precedentKey, effectKey: eff.effectKey, eventKey: eff.eventKey, policyId, correctedLowCents: low, correctedMidCents: mid, correctedHighCents: high, reason, by, at,
  });
  return policyId;
}

function markCorrected(ctx: any, eff: any, precedentKey: string, low: bigint, mid: bigint, high: bigint, reason: string, by: string, at: string) {
  const policyId = writePrecedent(ctx, eff, precedentKey, low, mid, high, reason, by, at);
  ctx.db.raceEffects.effectKey.update({ ...eff, status: 'corrected' });
  if (policyId) {
    const pol = ctx.db.racePolicies.policyId.find(policyId);
    if (pol) ctx.db.racePolicies.policyId.update({ ...pol, contradictions: pol.contradictions + 1, updatedAt: at });
  }
}

const AWAITING_PERSON = ['proposed', 'needs_person', 'autonomous'];

// A person corrects a band. The original row stays (marked corrected), the precedent carries the
// new numbers, and the policy that decided it counts one more contradiction.
export const correctRaceEffect = spacetimedb.reducer(
  { effectKey: t.string(), lowCents: t.i64(), midCents: t.i64(), highCents: t.i64(), reason: t.string(), by: t.string(), at: t.string() },
  (ctx, { effectKey, lowCents, midCents, highCents, reason, at }) => {
    const eff = ctx.db.raceEffects.effectKey.find(effectKey);
    if (!eff) throw new SenderError('no such effect');
    if (!(lowCents <= midCents && midCents <= highCents)) throw new SenderError('invalid correction: band must be low <= mid <= high');
    if (reason.trim().length === 0 || reason.length > 512) throw new SenderError('invalid correction: reason');
    requireIso('at', at);
    const precedentKey = `${effectKey}@${at}`;
    if (ctx.db.racePrecedents.precedentKey.find(precedentKey)) return;
    gate(ctx, 'correct_effect', effectKey, personOnly, (c) => {
      markCorrected(ctx, eff, precedentKey, lowCents, midCents, highCents, reason, c.name, at);
      signOff(ctx, effectKey, c.who, c.name, 'correction');
      reconsiderPostings(ctx, effectKey, c.name);
      return `corrected to ${usd(midCents)} by ${c.name}`;
    });
  }
);

// A person confirms a band. The precedent carries the unchanged numbers (a confirmation teaches as much as a
// correction), the row stays in the totals, and the sign-off may release a posting that was waiting for it.
export const confirmRaceEffect = spacetimedb.reducer(
  { effectKey: t.string(), reason: t.string(), by: t.string(), at: t.string() },
  (ctx, { effectKey, reason, at }) => {
    const eff = ctx.db.raceEffects.effectKey.find(effectKey);
    if (!eff) throw new SenderError('no such effect');
    const precedentKey = `${effectKey}@${at}`;
    if (ctx.db.racePrecedents.precedentKey.find(precedentKey)) return; // the same confirmation twice
    if (reason.trim().length === 0 || reason.length > 512) throw new SenderError('invalid confirmation: reason');
    requireIso('at', at);
    gate(ctx, 'confirm_effect', effectKey,
      (c) => personOnly(c) ?? (AWAITING_PERSON.includes(eff.status) ? null : `effect is ${eff.status}, not waiting for a person`),
      (c) => {
        writePrecedent(ctx, eff, precedentKey, eff.lowCents, eff.midCents, eff.highCents, reason, c.name, at);
        ctx.db.raceEffects.effectKey.update({ ...eff, status: 'confirmed' });
        signOff(ctx, effectKey, c.who, c.name, 'confirmation');
        reconsiderPostings(ctx, effectKey, c.name);
        return `confirmed at ${usd(eff.midCents)} by ${c.name}`;
      });
  }
);

// The desk applies a person's recorded answer to the lines the question covered. It may only apply an answer that
// exists: the question must be answered (or defaulted at its deadline) and must name this effect. A person's answer is
// their sign-off; a deadline default is the desk's own conservative choice and signs nothing off.
export const applyRaceAnswer = spacetimedb.reducer(
  { questionKey: t.string(), effectKey: t.string(), corrected: t.bool(), lowCents: t.i64(), midCents: t.i64(), highCents: t.i64(), at: t.string() },
  (ctx, { questionKey, effectKey, corrected, lowCents, midCents, highCents, at }) => {
    requireIso('at', at);
    if (!(lowCents <= midCents && midCents <= highCents)) throw new SenderError('invalid answer: band must be low <= mid <= high');
    const q = ctx.db.raceQuestions.questionKey.find(questionKey);
    const eff = ctx.db.raceEffects.effectKey.find(effectKey);
    if (!q || !eff) throw new SenderError('no such question or effect');
    const precedentKey = `${effectKey}@${questionKey}`;
    if (ctx.db.racePrecedents.precedentKey.find(precedentKey)) return;
    gate(ctx, 'apply_answer', effectKey,
      (c) => {
        if (c.role !== 'race') return 'only the race desk applies answers';
        if (q.status !== 'answered' && q.status !== 'defaulted') return 'the question has no answer yet';
        if (!q.effectKeys.split(',').includes(effectKey)) return 'the question does not cover this effect';
        if (!corrected && !AWAITING_PERSON.includes(eff.status)) return `effect is ${eff.status}`;
        return null;
      },
      () => {
        const answered = q.status === 'answered';
        const by = answered ? q.answeredBy : 'deadline';
        const reason = `${answered ? `${by} answered` : 'deadline default'} (${questionKey})`.slice(0, 512);
        if (corrected) markCorrected(ctx, eff, precedentKey, lowCents, midCents, highCents, reason, by, at);
        else {
          writePrecedent(ctx, eff, precedentKey, eff.lowCents, eff.midCents, eff.highCents, reason, by, at);
          ctx.db.raceEffects.effectKey.update({ ...eff, status: 'confirmed' });
        }
        if (answered) {
          const who = answererOf(ctx, questionKey);
          signOff(ctx, effectKey, who, by, `question:${questionKey}`);
          reconsiderPostings(ctx, effectKey, by);
          return `${by}'s answer applied${corrected ? `: corrected to ${usd(midCents)}` : ''}`;
        }
        return 'deadline default applied; no person signed this estimate off, so its posting still waits';
      });
  }
);

function answererOf(ctx: any, questionKey: string): string {
  const rows = [...ctx.db.raceAudit.targetKey.filter(questionKey)].filter((a: any) => a.action === 'answer_question' && a.allowed);
  return rows.length ? rows[rows.length - 1].who : '';
}

// ---------------------------------------------------------------- race-day flow reducers

const INCIDENT_STATUSES = ['suspected', 'corroborated', 'confirmed', 'assessed', 'closed'];
const ACTION_KINDS = ['garage_check', 'spares_reserve', 'work_order', 'freight', 'hand_carry', 'withdraw_car', 'parc_ferme_list',
  'pu_check', 'td017_move', 'fia_notice', 'evidence_pack'];
const ACTION_STATUSES = ['auto', 'awaiting_approval', 'approved', 'rejected', 'done', 'cancelled'];
const RECOGNITION = ['first_use', 'incurred', 'excluded', 'already_expensed'];
const QUESTION_KINDS = ['damage', 'decision', 'approval'];

function requireLen(field: string, value: string, max: number) {
  if (value.length > max) throw new SenderError(`invalid ${field}: longer than ${max}`);
}

const IncidentInput = t.object('RaceIncidentInput', {
  incidentKey: t.string(), meetingKey: t.u32(), sessionKey: t.u32(), driverNumber: t.u32(), teamName: t.string(), firstSeenAt: t.string(),
  status: t.string(), version: t.u32(), beliefJson: t.string(), evidenceJson: t.string(), updatedAt: t.string(), cause: t.string(),
});

// A newer version replaces the current belief and is appended to race_beliefs; an older or equal one is ignored,
// so a replay is idempotent and a late writer never rolls the belief back.
export const upsertRaceIncident = spacetimedb.reducer(
  { incident: IncidentInput },
  (ctx, { incident }) => {
    requireRole(ctx, 'race');
    if (incident.incidentKey.length === 0 || incident.incidentKey.length > 128) throw new SenderError('invalid incident: key');
    if (!INCIDENT_STATUSES.includes(incident.status)) throw new SenderError('invalid incident: unknown status');
    requireIso('incident.firstSeenAt', incident.firstSeenAt);
    requireIso('incident.updatedAt', incident.updatedAt);
    requireLen('incident.beliefJson', incident.beliefJson, 4096);
    requireLen('incident.evidenceJson', incident.evidenceJson, 4096);
    requireLen('incident.cause', incident.cause, 512);
    const cur = ctx.db.raceIncidents.incidentKey.find(incident.incidentKey);
    if (cur && cur.version >= incident.version) return;
    if (cur) ctx.db.raceIncidents.incidentKey.update(incident);
    else ctx.db.raceIncidents.insert(incident);
    const beliefKey = `${incident.incidentKey}@v${incident.version}`;
    if (!ctx.db.raceBeliefs.beliefKey.find(beliefKey)) {
      ctx.db.raceBeliefs.insert({
        beliefKey, incidentKey: incident.incidentKey, version: incident.version, status: incident.status, beliefJson: incident.beliefJson,
        at: incident.updatedAt, recordedAt: ctx.timestamp.toISOString(), cause: incident.cause,
      });
    }
  }
);

const ActionInput = t.object('RaceActionInput', {
  actionKey: t.string(), incidentKey: t.string(), kind: t.string(), title: t.string(), detailJson: t.string(), dueAt: t.string(),
  status: t.string(), ownerRole: t.string(), reversible: t.bool(), outward: t.bool(), decidedBy: t.string(), updatedAt: t.string(),
});

// The playbook's actions. An outward-facing or irreversible action can only be recorded as awaiting approval:
// the desk never sends, withdraws or orders on its own authority. A person's decision is never overwritten.
export const recordRaceActions = spacetimedb.reducer(
  { actions: t.array(ActionInput) },
  (ctx, { actions }) => {
    requireRole(ctx, 'race');
    for (const a of actions) {
      if (!ACTION_KINDS.includes(a.kind)) throw new SenderError(`invalid action: unknown kind ${a.kind}`);
      if (!ACTION_STATUSES.includes(a.status)) throw new SenderError('invalid action: unknown status');
      if ((a.outward || !a.reversible) && a.status !== 'awaiting_approval' && a.status !== 'cancelled') {
        throw new SenderError('invalid action: an outward-facing or irreversible action must wait for approval');
      }
      if (a.status === 'approved' || a.status === 'rejected') throw new SenderError('invalid action: only a person approves or rejects');
      requireLen('action.title', a.title, 256);
      requireLen('action.detailJson', a.detailJson, 4096);
      if (a.dueAt !== '') requireIso('action.dueAt', a.dueAt);
      requireIso('action.updatedAt', a.updatedAt);
      const cur = ctx.db.raceActions.actionKey.find(a.actionKey);
      if (cur) {
        if (cur.status === 'approved' || cur.status === 'rejected') continue;
        ctx.db.raceActions.actionKey.update(a);
      } else {
        ctx.db.raceActions.insert(a);
      }
    }
  }
);

export const setRaceActionStatus = spacetimedb.reducer(
  { actionKey: t.string(), status: t.string(), by: t.string(), at: t.string() },
  (ctx, { actionKey, status, at }) => {
    if (!['approved', 'rejected', 'done', 'cancelled'].includes(status)) throw new SenderError('invalid status');
    requireIso('at', at);
    const cur = ctx.db.raceActions.actionKey.find(actionKey);
    if (!cur) throw new SenderError('no such action');
    gate(ctx, `action_${status}`, actionKey,
      (c) => personOnly(c) ?? ((status === 'approved' || status === 'rejected') && cur.status !== 'awaiting_approval' ? 'action is not awaiting approval' : null),
      (c) => {
        ctx.db.raceActions.actionKey.update({ ...cur, status, decidedBy: `person:${c.name}`, updatedAt: at });
        return `${cur.title}: ${status} by ${c.name}`;
      });
  }
);

// A decision with priced options (start or withdraw a car): the owner picks one. The choice is written into the
// action's detail with who made it; the desk prices options but never picks, so only race_head may call this.
export const chooseRaceActionOption = spacetimedb.reducer(
  { actionKey: t.string(), option: t.string(), by: t.string(), at: t.string() },
  (ctx, { actionKey, option, at }) => {
    requireIso('at', at);
    const cur = ctx.db.raceActions.actionKey.find(actionKey);
    if (!cur) throw new SenderError('no such action');
    let detail: Record<string, unknown>;
    try {
      detail = JSON.parse(cur.detailJson) as Record<string, unknown>;
    } catch {
      throw new SenderError('invalid choice: action detail is not JSON');
    }
    const options = Array.isArray(detail.options) ? (detail.options as { id?: string }[]) : [];
    gate(ctx, 'choose_option', actionKey,
      (c) => personOnly(c) ?? (cur.status !== 'awaiting_approval' ? 'action is not awaiting a decision' : !options.some((o) => o.id === option) ? 'not one of the priced options' : null),
      (c) => {
        const detailJson = JSON.stringify({ ...detail, chosen: option, chosen_by: c.name, chosen_at: at });
        if (detailJson.length > 4096) throw new SenderError('invalid choice: detail too large');
        ctx.db.raceActions.actionKey.update({ ...cur, status: 'approved', detailJson, decidedBy: `person:${c.name}`, updatedAt: at });
        return `${cur.title}: ${c.name} chose ${option}`;
      });
  }
);

const EntryLineInput = t.object('RaceEntryLineInput', { account: t.string(), debitCents: t.i64(), creditCents: t.i64(), memo: t.string() });
const RaceEntryInput = t.object('RaceEntryInput', {
  entryKey: t.string(), incidentKey: t.string(), effectKey: t.string(), memo: t.string(), effectiveDate: t.string(), recognition: t.string(),
  capRelevant: t.bool(), amountCents: t.i64(), status: t.string(), evidenceJson: t.string(), at: t.string(),
});

// A balanced provisional accrual. Lines are immutable; a sealed entry is final.
export const postRaceEntry = spacetimedb.reducer(
  { entry: RaceEntryInput, lines: t.array(EntryLineInput) },
  (ctx, { entry, lines }) => {
    requireRole(ctx, 'race');
    if (!RECOGNITION.includes(entry.recognition)) throw new SenderError('invalid entry: unknown recognition');
    if (entry.status !== 'proposed') throw new SenderError('invalid entry: the desk only proposes');
    let dr = 0n;
    let cr = 0n;
    for (const l of lines) {
      if (l.debitCents < 0n || l.creditCents < 0n) throw new SenderError('invalid entry: negative amount');
      dr += l.debitCents;
      cr += l.creditCents;
    }
    if (lines.length < 2 || dr !== cr) throw new SenderError(`invalid entry: debits ${dr} != credits ${cr}`);
    if (entry.amountCents !== dr) throw new SenderError('invalid entry: amount differs from its lines');
    requireIso('entry.at', entry.at);
    requireLen('entry.memo', entry.memo, 512);
    if (ctx.db.raceEntries.entryKey.find(entry.entryKey)) return; // idempotent replay
    ctx.db.raceEntries.insert(entry);
    lines.forEach((l, i) => ctx.db.raceEntryLines.insert({ ...l, lineKey: `${entry.entryKey}:${i}`, entryKey: entry.entryKey, lineNo: i }));
  }
);

const QuestionInput = t.object('RaceQuestionInput', {
  questionKey: t.string(), incidentKey: t.string(), kind: t.string(), prompt: t.string(), optionsJson: t.string(), routeRole: t.string(),
  expectedLossCents: t.i64(), deadlineAt: t.string(), effectKeys: t.string(), defaultOption: t.string(), status: t.string(),
  answerJson: t.string(), answeredBy: t.string(), createdAt: t.string(),
});

export const askRaceQuestion = spacetimedb.reducer(
  { question: QuestionInput },
  (ctx, { question }) => {
    requireRole(ctx, 'race');
    if (!QUESTION_KINDS.includes(question.kind)) throw new SenderError('invalid question: unknown kind');
    if (question.status !== 'open') throw new SenderError('invalid question: the desk only opens questions');
    requireLen('question.prompt', question.prompt, 1024);
    requireLen('question.optionsJson', question.optionsJson, 4096);
    requireIso('question.createdAt', question.createdAt);
    if (question.deadlineAt !== '') requireIso('question.deadlineAt', question.deadlineAt);
    if (ctx.db.raceQuestions.questionKey.find(question.questionKey)) return; // never ask twice
    ctx.db.raceQuestions.insert(question);
    // The database keeps the deadline itself. Deadlines are in race time; the replay's pace maps them to the wall clock.
    if (question.deadlineAt !== '') {
      const raceSecs = (Date.parse(question.deadlineAt) - Date.parse(question.createdAt)) / 1000;
      if (Number.isFinite(raceSecs) && raceSecs > 0) {
        const wallMicros = BigInt(Math.round((raceSecs / rules(ctx).replayPace) * 1_000_000));
        ctx.db.raceQuestionTimers.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch + wallMicros), questionKey: question.questionKey });
      }
    }
  }
);

// A person picks an option (or "neither", with their own band in answerJson). The desk reads the answer, applies
// it and learns from it. The answer is recorded under the seat's name, not a name the client sends.
export const answerRaceQuestion = spacetimedb.reducer(
  { questionKey: t.string(), answerJson: t.string(), by: t.string(), at: t.string() },
  (ctx, { questionKey, answerJson, at }) => {
    requireIso('at', at);
    requireLen('answerJson', answerJson, 2048);
    const q = ctx.db.raceQuestions.questionKey.find(questionKey);
    if (!q) throw new SenderError('no such question');
    gate(ctx, 'answer_question', questionKey,
      (c) => personOnly(c) ?? (q.status !== 'open' ? `question is ${q.status}` : null),
      (c) => {
        ctx.db.raceQuestions.questionKey.update({ ...q, status: 'answered', answerJson, answeredBy: c.name });
        return `answered by ${c.name}`;
      });
  }
);

function takeDefault(ctx: any, q: any) {
  ctx.db.raceQuestions.questionKey.update({ ...q, status: 'defaulted', answerJson: JSON.stringify({ option: q.defaultOption, defaulted: true }), answeredBy: 'deadline' });
}

// Past its deadline, the desk takes the stated default (the conservative, reversible option) and says so.
export const defaultRaceQuestion = spacetimedb.reducer(
  { questionKey: t.string(), at: t.string() },
  (ctx, { questionKey, at }) => {
    requireRole(ctx, 'race');
    requireIso('at', at);
    const q = ctx.db.raceQuestions.questionKey.find(questionKey);
    if (!q) throw new SenderError('no such question');
    if (q.status !== 'open') return;
    if (q.deadlineAt === '' || q.deadlineAt > at) throw new SenderError('invalid default: deadline not reached');
    takeDefault(ctx, q);
  }
);

// The database's own timer: the deadline came due on the wall clock. No agent needs to be running.
export const questionDeadlineDue = spacetimedb.reducer(
  { name: 'question_deadline_due', onSchedule: raceQuestionTimers },
  { timer: raceQuestionTimers.rowType },
  (ctx, { timer }) => {
    if (!ctx.sender.equals(ctx.databaseIdentity)) throw new SenderError('only the database schedules this');
    const q = ctx.db.raceQuestions.questionKey.find(timer.questionKey);
    if (!q || q.status !== 'open') return;
    takeDefault(ctx, q);
    audit(ctx, { who: ctx.sender.toHexString(), name: 'pit-wall timer', role: 'scheduler', person: false, owner: false }, 'question_default', q.questionKey, true,
      `deadline reached with no answer: the database took the default (${q.defaultOption})`);
  }
);

export const recordRaceSim = spacetimedb.reducer(
  { simKey: t.string(), meetingKey: t.u32(), trigger: t.string(), at: t.string(), payloadJson: t.string(), runtimeMs: t.u32() },
  (ctx, row) => {
    requireRole(ctx, 'race');
    requireIso('at', row.at);
    requireLen('payloadJson', row.payloadJson, 16384);
    // A re-run of the same weekend recomputes the same run: the newer model's numbers replace the old.
    if (ctx.db.raceSims.simKey.find(row.simKey)) ctx.db.raceSims.simKey.update(row);
    else ctx.db.raceSims.insert(row);
  }
);

const CloseInput = t.object('RaceCloseInput', {
  closeKey: t.string(), meetingKey: t.u32(), closedAt: t.string(), rootHash: t.string(), totalsJson: t.string(), briefsJson: t.string(),
  status: t.string(), approvedBy: t.string(), leaves: t.u32(),
});

// A draft close may be re-sealed (new root) until a person approves it; an approved close is final.
export const recordRaceClose = spacetimedb.reducer(
  { close: CloseInput },
  (ctx, { close }) => {
    requireRole(ctx, 'race');
    if (close.status !== 'draft') throw new SenderError('invalid close: the desk only drafts');
    if (!HEX64.test(close.rootHash)) throw new SenderError('invalid close: rootHash must be 64 hex chars');
    requireIso('close.closedAt', close.closedAt);
    requireLen('close.briefsJson', close.briefsJson, 32768);
    const cur = ctx.db.raceCloses.closeKey.find(close.closeKey);
    if (cur && cur.status !== 'draft') throw new SenderError('invalid close: already approved');
    if (cur) ctx.db.raceCloses.closeKey.update(close);
    else ctx.db.raceCloses.insert(close);
  }
);

export const approveRaceClose = spacetimedb.reducer(
  { closeKey: t.string(), by: t.string(), at: t.string() },
  (ctx, { closeKey, at }) => {
    requireIso('at', at);
    const cur = ctx.db.raceCloses.closeKey.find(closeKey);
    if (!cur) throw new SenderError('no such close');
    gate(ctx, 'approve_close', closeKey,
      (c) => personOnly(c) ?? (cur.status !== 'draft' ? 'not a draft' : null),
      (c) => {
        ctx.db.raceCloses.closeKey.update({ ...cur, status: 'approved', approvedBy: c.name });
        return `weekend close approved by ${c.name}`;
      });
  }
);

export const markRaceCloseSent = spacetimedb.reducer(
  { closeKey: t.string(), at: t.string() },
  (ctx, { closeKey, at }) => {
    requireRole(ctx, 'race');
    requireIso('at', at);
    const cur = ctx.db.raceCloses.closeKey.find(closeKey);
    if (!cur) throw new SenderError('no such close');
    if (cur.status !== 'approved') throw new SenderError('invalid send: a person must approve the close first');
    ctx.db.raceCloses.closeKey.update({ ...cur, status: 'sent' });
  }
);

const OptionsInput = t.object('RaceOptionsInput', {
  optionKey: t.string(), sessionKey: t.u32(), meetingKey: t.u32(), driverNumber: t.u32(), lap: t.u32(), at: t.string(),
  condition: t.string(), trigger: t.string(), optionsJson: t.string(),
});

export const recordRaceOptions = spacetimedb.reducer(
  { options: OptionsInput },
  (ctx, { options }) => {
    requireRole(ctx, 'race');
    requireIso('options.at', options.at);
    requireLen('options.optionsJson', options.optionsJson, 8192);
    if (/recommend/i.test(options.optionsJson)) throw new SenderError('invalid options: the desk prices options, it does not recommend');
    if (ctx.db.raceOptions.optionKey.find(options.optionKey)) ctx.db.raceOptions.optionKey.update(options);
    else ctx.db.raceOptions.insert(options);
  }
);

const POSTING_STATUSES = ['authorized', 'posted', 'held', 'approved', 'rejected', 'failed'];
const PostingInput = t.object('RacePostingInput', {
  entryKey: t.string(), incidentKey: t.string(), status: t.string(), erpEntryId: t.string(), costCapRef: t.string(), reviewRole: t.string(),
  reason: t.string(), amountCents: t.i64(), by: t.string(), at: t.string(),
});

// ---------------------------------------------------------------- posting: the database authorizes, the desk sends
// An entry reaches the ERP only with pit-wall's authorization. The desk asks (requestRacePosting); the module decides
// from the entry, the estimate behind it and the CFO's rules: `authorized` (the desk may send it now) or `held` for the
// named review role. A person's sign-off on the estimate re-runs the decision in the same transaction. The ERP gateway
// checks this row before it accepts a race entry, so even an agent holding the gateway key cannot post around it.

const MODEL_DECIDERS = (decidedBy: string) => decidedBy === 'jev' || decidedBy.startsWith('claude');

function postingDecision(ctx: any, entry: any): { role: string; reasons: string[] } {
  const r = rules(ctx);
  let role = '';
  const reasons: string[] = [];
  const need = (who: string, why: string) => {
    reasons.push(why);
    if ((REVIEW_RANK[who] ?? 0) > (REVIEW_RANK[role] ?? 0)) role = who;
  };
  const eff = entry.effectKey ? ctx.db.raceEffects.effectKey.find(entry.effectKey) : undefined;
  if (eff) {
    const signed = ctx.db.raceSignoffs.effectKey.find(eff.effectKey);
    if (eff.status === 'corrected' && !signed) need('controller', 'the estimate behind it was corrected after the entry was raised');
    else if (eff.status === 'needs_person' && !signed) need('controller', 'Jev was unsure of the estimate: a person confirms it first');
    else if (MODEL_DECIDERS(eff.decidedBy) && !signed && !r.modelMayPostAlone) {
      need('controller', `the estimate is ${eff.decidedBy === 'jev' ? "Jev's" : "the forecast agent's"} alone: a person signs it off before it posts`);
    }
  }
  if (entry.amountCents >= r.cfoCents) need('cfo', `${usd(entry.amountCents)} is at or above the CFO's ${usd(r.cfoCents)} threshold`);
  else if (entry.amountCents >= r.autoPostMaxCents) need('head_of_cost_cap', `${usd(entry.amountCents)} is at or above the ${usd(r.autoPostMaxCents)} materiality`);
  if (entry.recognition === 'excluded') need('head_of_cost_cap', 'booked outside the cap (an FIA fine): the Head of Cost Cap confirms the exclusion');
  return { role, reasons };
}

function authorizedReason(ctx: any, entry: any, after?: string): string {
  const eff = entry.effectKey ? ctx.db.raceEffects.effectKey.find(entry.effectKey) : undefined;
  const signed = eff ? ctx.db.raceSignoffs.effectKey.find(eff.effectKey) : undefined;
  const basis = signed ? `signed off by ${signed.name}` : eff ? `decided by ${eff.decidedBy}` : 'no estimate behind it';
  return `${after ? `${after}: ` : ''}authorized by pit-wall: ${usd(entry.amountCents)} under the ${usd(rules(ctx).autoPostMaxCents)} limit, ${basis}`.slice(0, 512);
}

// A sign-off or correction changed the estimate behind some entries: re-run their posting decision now.
function reconsiderPostings(ctx: any, effectKey: string, by: string) {
  // Collect first: never write while an iterator is open.
  const affected = [...ctx.db.raceEntries.iter()].filter((e: any) => e.effectKey === effectKey);
  for (const entry of affected) {
    const cur = ctx.db.racePostings.entryKey.find(entry.entryKey);
    if (!cur || cur.status !== 'held') continue;
    const d = postingDecision(ctx, entry);
    if (d.role === '') {
      ctx.db.racePostings.entryKey.update({ ...cur, status: 'authorized', reviewRole: '', reason: authorizedReason(ctx, entry, `after ${by}'s sign-off`), by: 'pit-wall', at: ctx.timestamp.toISOString() });
    } else {
      ctx.db.racePostings.entryKey.update({ ...cur, reviewRole: d.role, reason: `held for review: ${d.reasons.join('; ')}`.slice(0, 512) });
    }
  }
}

// The desk asks to post an entry. The module decides, records the decision on race_postings, and audits it.
export const requestRacePosting = spacetimedb.reducer(
  { entryKey: t.string(), at: t.string() },
  (ctx, { entryKey, at }) => {
    requireIso('at', at);
    const entry = ctx.db.raceEntries.entryKey.find(entryKey);
    if (!entry) throw new SenderError('invalid posting: no such entry');
    const cur = ctx.db.racePostings.entryKey.find(entryKey);
    gate(ctx, 'request_posting', entryKey,
      (c) => (c.role !== 'race' ? 'only the race desk requests a posting' : null),
      () => {
        if (cur && cur.status !== 'failed') return `already ${cur.status}; the earlier decision stands`;
        const d = postingDecision(ctx, entry);
        const row = {
          entryKey, incidentKey: entry.incidentKey, status: d.role ? 'held' : 'authorized', erpEntryId: cur?.erpEntryId ?? '', costCapRef: cur?.costCapRef ?? '',
          reviewRole: d.role, reason: (d.role ? `held for review: ${d.reasons.join('; ')}` : authorizedReason(ctx, entry)).slice(0, 512),
          amountCents: entry.amountCents, by: 'pit-wall', at,
        };
        if (cur) ctx.db.racePostings.entryKey.update(row);
        else ctx.db.racePostings.insert(row);
        return d.role ? `held for ${d.role}: ${d.reasons.join('; ')}` : 'authorized: the desk may send it to the ERP';
      });
  }
);

// The desk records what happened when it sent an entry: `posted` (with the ERP id) only for an entry pit-wall
// authorized or a person approved, or `failed` (the authorization stands, so a retry needs no new decision).
// A person's decision is never overwritten, and the module's own hold is never replaced by the desk's.
export const recordRacePosting = spacetimedb.reducer(
  { posting: PostingInput },
  (ctx, { posting }) => {
    if (!POSTING_STATUSES.includes(posting.status)) throw new SenderError('invalid posting: unknown status');
    if (!ctx.db.raceEntries.entryKey.find(posting.entryKey)) throw new SenderError('invalid posting: no such entry');
    if (posting.status === 'posted' && posting.erpEntryId === '') throw new SenderError('invalid posting: a posted entry carries the ERP id');
    requireIso('posting.at', posting.at);
    requireLen('posting.reason', posting.reason, 512);
    const cur = ctx.db.racePostings.entryKey.find(posting.entryKey);
    gate(ctx, `record_${posting.status}`, posting.entryKey,
      (c) => {
        if (c.role !== 'race') return 'only the race desk records postings';
        if (posting.status === 'approved' || posting.status === 'rejected' || posting.status === 'authorized') return `only ${posting.status === 'authorized' ? 'pit-wall' : 'a person'} sets ${posting.status}`;
        if (posting.status === 'posted' && !(cur && (cur.status === 'authorized' || cur.status === 'approved' || cur.status === 'posted'))) {
          return `not authorized in pit-wall (${cur ? cur.status : 'never requested'}): the entry may not be posted`;
        }
        return null;
      },
      () => {
        if (posting.status === 'held') {
          if (cur) return 'the module\'s own decision stands';
          ctx.db.racePostings.insert(posting);
          return 'held by the desk';
        }
        if (posting.status === 'failed') {
          if (cur) ctx.db.racePostings.entryKey.update({ ...cur, reason: posting.reason, at: posting.at });
          else ctx.db.racePostings.insert(posting);
          return `send failed; ${cur ? `still ${cur.status}` : 'recorded'}`;
        }
        // posted
        if (cur!.status === 'posted') return 'already posted';
        ctx.db.racePostings.entryKey.update({ ...cur!, status: 'posted', erpEntryId: posting.erpEntryId, reason: posting.reason, by: posting.by, at: posting.at });
        return `posted as ${posting.erpEntryId}`;
      });
  }
);

// A person reviews a held entry: approved (the desk then posts it) or rejected (it never reaches the ERP). The seat
// must be at least as senior as the role it was held for, and the person who signed off the estimate behind it may
// not also approve its posting (two people, every time).
export const decideRacePosting = spacetimedb.reducer(
  { entryKey: t.string(), status: t.string(), by: t.string(), at: t.string() },
  (ctx, { entryKey, status, at }) => {
    if (!['approved', 'rejected'].includes(status)) throw new SenderError('invalid decision');
    requireIso('at', at);
    const cur = ctx.db.racePostings.entryKey.find(entryKey);
    if (!cur) throw new SenderError('no such posting');
    const entry = ctx.db.raceEntries.entryKey.find(entryKey);
    const signed = entry?.effectKey ? ctx.db.raceSignoffs.effectKey.find(entry.effectKey) : undefined;
    gate(ctx, `posting_${status}`, entryKey,
      (c) => {
        const p = personOnly(c);
        if (p) return p;
        if (cur.status !== 'held') return `the entry is ${cur.status}, not held for review`;
        if ((SEAT_RANK[c.role] ?? 0) < (REVIEW_RANK[cur.reviewRole] ?? 0)) return `held for the ${cur.reviewRole.replace(/_/g, ' ')}; a ${c.role.replace(/_/g, ' ')} cannot decide it`;
        if (status === 'approved' && signed && signed.who === c.who) return `${c.name} signed off the estimate behind this entry; a second person must approve its posting`;
        return null;
      },
      (c) => {
        ctx.db.racePostings.entryKey.update({ ...cur, status, by: c.name, at, reason: `${status} by ${c.name}: ${cur.reason}`.slice(0, 512) });
        return `${status} by ${c.name} (${c.role})`;
      });
  }
);

const HEALTH = ['live', 'degraded', 'offline', 'dry_run', 'not_configured'];
export const recordRaceHealth = spacetimedb.reducer(
  { service: t.string(), status: t.string(), detail: t.string(), calls: t.u32(), errors: t.u32(), latencyMs: t.u32(), at: t.string() },
  (ctx, row) => {
    requireRole(ctx, 'race');
    if (!HEALTH.includes(row.status)) throw new SenderError('invalid health: unknown status');
    requireIso('at', row.at);
    requireLen('detail', row.detail, 512);
    if (ctx.db.raceHealth.service.find(row.service)) ctx.db.raceHealth.service.update(row);
    else ctx.db.raceHealth.insert(row);
  }
);
