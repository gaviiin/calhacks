# FIA Document Monitor

Finds the official FIA Formula 1 documents published for one Grand Prix (stewards' decisions, infringements, summonses, classifications) and outputs clean, consistently shaped metadata with provenance back to fia.com.

Built for **Pit Wall**, an autonomous F1 finance team where a real stewards' decision is the trigger for a finance investigation. The Actor is deliberately narrow: it records *that* an official document exists and where, and never claims what it decided.

## What it does

1. Opens the FIA Formula One documents index and finds the requested season.
2. Finds the requested event by slug (`belgian-grand-prix`, `sao-paulo-grand-prix`, ...).
3. Parses every document row on the event page; skips rows the FIA has **recalled** (no link).
4. Keeps stewards' decisions and classifications (or everything, if asked), newest first, up to `max_items`.
5. Pushes one dataset item per document and stores the exact listing HTML it parsed (`LISTING_SNAPSHOT`) plus a `RUN_SUMMARY` with that page's SHA-256.

No PDFs are downloaded.

## Input

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `season` | integer | `2024` | Season year as listed on fia.com |
| `event_slug` | string | `belgian-grand-prix` | Lower-case, hyphenated event name |
| `max_items` | integer | `10` | 1–100, newest documents first |
| `document_filter` | `decisions_and_classifications` \| `all` | `decisions_and_classifications` | |

## Output (one item per document)

```json
{
  "source": "fia",
  "season": 2024,
  "event_slug": "belgian-grand-prix",
  "event_name": "Belgian Grand Prix",
  "document_number": "44",
  "title": "Doc 44 - Infringement - Car 63 - Technical non-compliance (Weight)",
  "document_url": "https://www.fia.com/sites/default/files/decision-document/2024%20Belgian%20Grand%20Prix%20-%20Infringement%20-%20Car%2063%20-%20Technical%20non-compliance%20%28Weight%29.pdf",
  "source_page_url": "https://www.fia.com/documents/championships/fia-formula-one-world-championship-14/season/season-2024-2043/event/Belgian%20Grand%20Prix",
  "published_at": "28.07.24 18:53 CET",
  "discovered_at": "2026-10-24T06:12:30Z"
}
```

- `document_url` is absolute and percent-encoded, so it is stable across runs and safe to use as a dedupe key.
- `published_at` is copied exactly as the FIA prints it. It is not converted to UTC because the FIA labels every time "CET", including summer races.
- `document_number` is empty when a title has no `Doc NN -` prefix.

The JSON Schema is in `ingestion/schema/fia_document_item.schema.json` in the Pit Wall repo.

### Key-value store

- `RUN_SUMMARY`: event, listing URL, `listing_sha256`, documents listed, recalled rows skipped, items pushed.
- `LISTING_SNAPSHOT`: the exact HTML parsed, for audit.

## Limits

- One event per run, and only the F1 championship.
- Selectors target the current fia.com Drupal markup (`li.document-row`). If the FIA changes its markup the Actor fails loudly rather than emitting partial data.
- Metadata isn't a ruling: a decision document may be a fine, a warning or a procedural note.
