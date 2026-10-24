import { schema, table, t, SenderError } from 'spacetimedb/server';

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

const spacetimedb = schema({ fiaDocuments, config, journalEntries, jeLines, pitWallItems, writers });
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

export const setWriter = spacetimedb.reducer(
  { who: t.identity(), role: t.string() },
  (ctx, { who, role }) => {
    const cfg = ctx.db.config.id.find(CONFIG_ID);
    if (!cfg || !ctx.sender.equals(cfg.owner)) throw new SenderError('unauthorized: only the module owner can grant roles');
    if (!['kernel', 'router'].includes(role)) throw new SenderError('unknown role');
    if (ctx.db.writers.who.find(who)) ctx.db.writers.who.update({ who, role });
    else ctx.db.writers.insert({ who, role });
  }
);

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
