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

const spacetimedb = schema({ fiaDocuments, config });
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
