import { DEMO, usd } from './demo';
import { LIVERIES, type LiveryKey, type Station } from '../three/state';

// The scroll story: six scenes on the pinned car, then the product.
// Copy lives here; the components only lay it out.

export type Callout = {
  /** Anchor on the car, metres. Nose is +X, the visitor's side is +Z. */
  at: [number, number, number];
  /** Label offset in px from the anchor. */
  dx: number;
  dy: number;
  label: string;
  value: string;
  delta?: string;
  tone?: 'neg' | 'pos' | 'hold';
};

export type Scene = {
  id: string;
  number: string;
  focus: string;
  livery: LiveryKey;
  station: Station;
  overline: string;
  /** Headline lines; [bracketed] words take the accent colour. */
  headline: string[];
  body: string;
  facts?: { k: string; v: string }[];
  callouts: Callout[];
};

export const SCENES: Scene[] = [
  {
    id: 'start',
    number: '00',
    focus: 'FULL CAR',
    livery: 'pitwall',
    station: { cam: [2.4, 0.85, 11.4], look: [0.1, 0.42, 0], fov: 23, screenX: 0.08, screenY: -0.22, idle: 1, mobile: { cam: [4.8, 1.5, 7.2], look: [0.5, 0.42, 0], fov: 30 } },
    overline: 'PIT WALL / AUTONOMOUS RACE FINANCE',
    headline: ['THE RACE ENDS.', '[THE BOOKS DON’T.]'],
    body: 'Race results change. Contracts react. Pit Wall is the finance crew that follows the money from the chequered flag to the ledger, and knows when to hand the pen to a human.',
    callouts: [],
  },
  {
    id: 'problem',
    number: '01',
    focus: 'FRONT WING',
    livery: 'scarlet',
    station: { cam: [5.9, 1.15, 4.4], look: [2.3, 0.32, 0.25], fov: 26, roll: -0.03, screenX: 0.32, screenY: -0.08, explodeFront: 1, mobile: { cam: [5.8, 1.3, 2.6], look: [2.4, 0.3, 0.1], fov: 32 } },
    overline: '01 / THE PROBLEM',
    headline: ['EVERY RESULT', 'HAS A [PRICE.]'],
    body: `A stewards' decision three weeks after the flag turns P3 into DSQ. The podium bonus, the prize estimate and last month's entries do not update themselves.`,
    facts: [
      { k: 'EVENT', v: 'Classification amended' },
      { k: 'TRIGGER', v: `Clause ${DEMO.clause} · podium bonus` },
      { k: 'EXPOSURE', v: `${usd(DEMO.bonus)} · simulated` },
    ],
    callouts: [
      { at: [2.82, 0.2, 0.98], dx: 60, dy: 90, label: 'RACE EVENT', value: 'P3 → DSQ · stewards’ decision', delta: 'T+21 DAYS', tone: 'hold' },
      { at: [2.35, 0.5, 0.45], dx: 70, dy: -110, label: 'CONTRACT TRIGGER', value: `Clause ${DEMO.clause} · podium bonus`, delta: 'NO LONGER MET', tone: 'neg' },
      { at: [2.05, 0.34, 0.9], dx: 110, dy: -10, label: 'CONSEQUENCE', value: 'Reversal proposed', delta: `−${usd(DEMO.bonus)}`, tone: 'neg' },
    ],
  },
  {
    id: 'ingest',
    number: '02',
    focus: 'SIDEPODS',
    livery: 'silver',
    station: { cam: [3.1, 1.6, 5.2], look: [0.35, 0.45, 0.3], fov: 26, screenX: 0.2, screenY: -0.06, explodeMid: 1, streams: 1, mobile: { cam: [3.4, 2.0, 3.6], look: [0.2, 0.45, 0.3], fov: 32 } },
    overline: '02 / INGESTION',
    headline: ['EVIDENCE IN.', '[NOTHING INVENTED.]'],
    body: 'Official FIA documents, sponsor agreements and classifications flow in as they are published. Every record keeps its source URL and run ID. Evidence only; nothing here touches a ledger.',
    facts: [
      { k: 'SOURCES', v: 'FIA documents · Apify monitor' },
      { k: 'STORE', v: 'SpacetimeDB · live subscription' },
      { k: 'CONTRACTS', v: 'Sponsor terms · prize rules' },
    ],
    callouts: [
      { at: [1.0, 0.46, 0.5], dx: -30, dy: 120, label: 'FIA DOCUMENTS', value: 'Apify monitor · provenance kept', delta: 'SOURCE URL + RUN ID', tone: 'pos' },
      { at: [-0.05, 0.92, 0.0], dx: 90, dy: -100, label: 'TELEMETRY + RESULTS', value: 'Classifications as published' },
      { at: [-0.4, 0.62, 0.95], dx: 60, dy: 110, label: 'CONTRACT TERMS', value: 'Clauses parsed · terms linked', delta: 'DEDUP ON INGEST', tone: 'pos' },
    ],
  },
  {
    id: 'reason',
    number: '03',
    focus: 'COCKPIT',
    livery: 'navy',
    station: { cam: [2.3, 2.0, 2.9], look: [0.1, 0.8, 0], fov: 28, screenX: 0.24, screenY: 0.02, xray: 1, graph: 1, explodeTop: 1, mobile: { cam: [2.8, 2.4, 2.4], look: [0.1, 0.8, 0], fov: 34 } },
    overline: '03 / REASONING',
    headline: ['IT THINKS LIKE', '[A PIT WALL.]'],
    body: 'Claude reads the ruling against the clause and proposes the consequence. Deterministic rules do the arithmetic. Anything uncertain is flagged, not guessed.',
    facts: [
      { k: 'INTERPRET', v: 'Ruling ↔ clause match' },
      { k: 'CALCULATE', v: 'Deterministic · replayable' },
      { k: 'UNCERTAINTY', v: 'Flagged for review' },
    ],
    callouts: [
      { at: [0.75, 1.05, 0.45], dx: -40, dy: 130, label: 'INTERPRET', value: `Ruling read against clause ${DEMO.clause}`, delta: 'CONFIDENCE 0.94', tone: 'pos' },
      { at: [-0.35, 1.25, 0.3], dx: 30, dy: -90, label: 'UNCERTAINTY', value: 'One open question · flagged', delta: 'NOT GUESSED', tone: 'hold' },
      { at: [0.2, 0.95, -0.7], dx: 90, dy: 40, label: 'CHECKPOINT', value: `Human above ${usd(DEMO.threshold)}`, delta: 'EXCEPTION PATH', tone: 'hold' },
    ],
  },
  {
    id: 'control',
    number: '04',
    focus: 'REAR WING',
    livery: 'green',
    station: { cam: [-6.2, 2.3, 2.9], look: [-2.5, 0.62, 0.1], fov: 26, roll: 0.035, screenX: 0.22, screenY: -0.04, explodeRear: 1, audit: 1, mobile: { cam: [-6.2, 2.6, 1.8], look: [-2.5, 0.6, 0], fov: 32 } },
    overline: '04 / CONTROL',
    headline: ['FAST. NEVER', '[UNCHECKED.]'],
    body: `Every proposal carries its evidence and its maths. Anything above the ${usd(DEMO.threshold)} limit stops at the Controller. Pit Wall cannot approve itself.`,
    facts: [
      { k: 'GATE', v: `Controller · ${usd(DEMO.threshold)} limit` },
      { k: 'AUDIT', v: 'Every step logged' },
      { k: 'LEDGER', v: 'Proposed · never self-posted' },
    ],
    callouts: [
      { at: [-2.05, 1.28, 0.9], dx: -40, dy: -90, label: 'APPROVAL GATE', value: `Held above ${usd(DEMO.threshold)}`, delta: 'AWAITING CONTROLLER', tone: 'hold' },
      { at: [-3.1, 1.0, 0.95], dx: -70, dy: -60, label: 'AUDIT TRAIL', value: 'Replayable · source attached', delta: 'EVENT 0x3F2A', tone: 'pos' },
      { at: [-3.4, 0.6, 0.75], dx: -30, dy: 90, label: 'LEDGER ACTION', value: 'Journal proposed · not posted', delta: 'DR 450,000 / CR 450,000', tone: 'hold' },
    ],
  },
  {
    id: 'system',
    number: '05',
    focus: 'FULL SYSTEM',
    livery: 'pitwall',
    station: { cam: [4.6, 2.6, 9.8], look: [-0.1, 0.4, 0], fov: 24, screenX: 0.04, screenY: -0.1, mobile: { cam: [5.0, 3.0, 6.4], look: [0.2, 0.4, 0], fov: 30 } },
    overline: '05 / THE SYSTEM',
    headline: ['DECODED INTO', '[SOFTWARE.]'],
    body: 'Capture, interpret, calculate, control. The same four stations, reassembled as an operations desk for the finance team.',
    callouts: [
      { at: [2.5, 0.3, 0.6], dx: -40, dy: 110, label: '01 CAPTURE', value: 'Front wing · race events' },
      { at: [0.5, 0.55, 0.75], dx: 50, dy: 120, label: '02 INGEST', value: 'Sidepods · evidence feed' },
      { at: [0.1, 0.9, 0.2], dx: 60, dy: -120, label: '03 REASON', value: 'Cockpit · agent' },
      { at: [-2.4, 0.95, 0.5], dx: 130, dy: -60, label: '04 CONTROL', value: 'Rear wing · approvals' },
    ],
  },
];

export const PRODUCT_ID = 'dashboard';

/** Camera for the product section: the car recedes behind the console. */
export const PRODUCT_STATION: Station = { cam: [2.4, 3.0, 11.5], look: [0, 0.3, 0], fov: 24, screenX: 0, screenY: 0.14, fade: 1, rim: 0.3 };

/** Palette per scene, then the product (pit wall colours). */
export const LIVERY_SEQUENCE: LiveryKey[] = [...SCENES.map(s => s.livery), 'pitwall'];

export const liveryName = (k: LiveryKey) => LIVERIES[k].name;
export const liveryAccent = (k: LiveryKey) => LIVERIES[k].accent;

export const RAIL = [...SCENES.map(s => ({ id: s.id, number: s.number, label: s.focus })), { id: PRODUCT_ID, number: '06', label: 'THE PRODUCT' }];
