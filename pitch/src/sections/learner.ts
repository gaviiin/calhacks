import CASES from '../data/cases.json';

// A line-for-line copy of race/precedents.py (similarity, nearest, match, wilson_lower), run on the
// same 93 cases São Paulo 2024 learns from (race/data/precedents_2024.jsonl and williams_2024_cases.jsonl).

interface Case {
  case_id: string;
  kind: string;
  outcome: string;
  reason: string | null;
  retired_within_laps: number | null;
  pit_within_laps: number | null;
  under: string | null;
  damage_likely: boolean;
  compound: string | null;
  tyre_age: number | null;
  source: string;
  summary: string;
}
type View = Partial<Case>;

const STOP = new Set(['THE', 'A', 'AN', 'AND', 'OF', 'AT', 'IN', 'TO', 'FOR', 'WITH', 'CAR', 'CARS', 'INCIDENT', 'INVOLVING', 'NOTED']);
const W = { kind: 0.3, reason: 0.2, retired: 0.18, pit: 0.1, under: 0.08, damage: 0.08, tyre: 0.06 };
const MIN_SIMILARITY = 0.85;
const MIN_CASES = 3;
const MIN_AGREEMENT = 0.8;
const K = 7;

const tokens = (r: string | null | undefined) =>
  new Set((r || '').toUpperCase().match(/[A-Z]+/g)?.filter((t) => !STOP.has(t) && t.length > 2) ?? []);
const laps = (n: number | null | undefined) => (n == null ? 'no' : n <= 2 ? '0-2' : '3+');
const age = (n: number | null | undefined) => (n == null ? '?' : n === 0 ? 'new' : n < 15 ? 'used' : 'old');

export function similarity(v: View, c: Case): number {
  let s = 0;
  s += W.kind * (v.kind === c.kind ? 1 : 0);
  const a = tokens(v.reason);
  const b = tokens(c.reason);
  if (!a.size && !b.size) s += W.reason;
  else {
    const inter = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    s += W.reason * (inter / union);
  }
  s += W.retired * (laps(v.retired_within_laps) === laps(c.retired_within_laps) ? 1 : 0);
  s += W.pit * (laps(v.pit_within_laps) === laps(c.pit_within_laps) ? 1 : 0);
  const vu = v.under || 'green';
  const cu = c.under || 'green';
  const sc = new Set(['sc', 'vsc']);
  s += W.under * (vu === cu ? 1 : sc.has(vu) && sc.has(cu) ? 0.5 : 0);
  s += W.damage * (!!v.damage_likely === !!c.damage_likely ? 1 : 0);
  if (v.kind === 'pit_stop' || c.kind === 'pit_stop') {
    const sameC = (v.compound || '') === (c.compound || '') || !c.compound ? 1 : 0;
    const sameA = age(v.tyre_age) === age(c.tyre_age) || c.tyre_age == null ? 1 : 0;
    s += W.tyre * (0.5 * sameC + 0.5 * sameA);
  } else s += W.tyre;
  return Math.round(Math.min(s, 1) * 1e4) / 1e4;
}

export function wilsonLower(k: number, n: number, z = 1.645) {
  if (n === 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - spread) / denom);
}
function wilsonUpper(k: number, n: number, z = 1.645) {
  if (n === 0) return 1;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + spread) / denom);
}

const EVENTS: { label: string; view: View; note: string }[] = [
  { label: 'Pit stop under green', view: { kind: 'pit_stop', under: 'green', compound: 'HARD', tyre_age: 0, damage_likely: false }, note: 'New hards, lap 20' },
  { label: 'Pit stop under the safety car', view: { kind: 'pit_stop', under: 'sc', compound: 'HARD', tyre_age: 0, damage_likely: false }, note: 'Colapinto, lap 30' },
  { label: 'Left the track, gained an advantage', view: { kind: 'incident', reason: 'LEAVING THE TRACK AND GAINING AN ADVANTAGE', under: 'green', damage_likely: false }, note: 'Stewards\' message' },
  { label: 'Collision, carried on', view: { kind: 'incident', reason: 'CAUSING A COLLISION', under: 'green', damage_likely: false }, note: 'Stewards\' message' },
  { label: 'Albon stops at 315 km/h', view: { kind: 'car_stopped', reason: '', retired_within_laps: 0, pit_within_laps: null, under: 'green', damage_likely: true }, note: 'Qualifying, the tripwire' },
];

const OUTCOME_WORDS: Record<string, string> = {
  tyre_set: 'a set of tyres, no damage',
  free_stop: 'a cheap stop, no damage',
  none: 'no damage, no cost',
  light: 'light damage',
  moderate: 'moderate damage',
  heavy: 'heavy damage',
};

function seg(box: HTMLElement, labels: string[], onPick: (i: number) => void, start = 0) {
  const buttons = labels.map((l, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = l;
    b.addEventListener('click', () => pick(i));
    box.appendChild(b);
    return b;
  });
  function pick(i: number) {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-checked', String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    onPick(i);
  }
  box.addEventListener('keydown', (e) => {
    const cur = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      pick((cur + 1) % buttons.length);
      buttons[(cur + 1) % buttons.length].focus();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = (cur - 1 + buttons.length) % buttons.length;
      pick(n);
      buttons[n].focus();
    }
  });
  pick(start);
}

export function initLearner(root: HTMLElement) {
  const cases = CASES as Case[];
  const list = root.querySelector<HTMLElement>('[data-matches]')!;
  const verdict = root.querySelector<HTMLElement>('[data-verdict]')!;

  const run = (i: number) => {
    const ev = EVENTS[i];
    const t0 = performance.now();
    const near = cases
      .map((c) => ({ s: similarity(ev.view, c), c }))
      .sort((a, b) => b.s - a.s)
      .slice(0, K);
    const close = near.filter((x) => x.s >= MIN_SIMILARITY);
    const votes = new Map<string, number>();
    close.forEach((x) => votes.set(x.c.outcome, (votes.get(x.c.outcome) ?? 0) + 1));
    const [top, n] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    const agreement = close.length ? n / close.length : 0;
    const ms = performance.now() - t0;
    const fires = close.length >= MIN_CASES && agreement >= MIN_AGREEMENT;

    list.innerHTML = near
      .map(
        (x, j) => `<div class="mrow ${x.s >= MIN_SIMILARITY ? 'near' : ''}" style="animation-delay:${j * 40}ms">
          <span><em>${x.c.source === 'press' ? 'press' : x.c.outcome}</em>${x.c.summary}</span>
          <span class="mbar" style="--s:${x.s}"><i></i></span><b>${x.s.toFixed(2)}</b></div>`,
      )
      .join('');
    verdict.innerHTML = fires
      ? `<h4>Protocol</h4><div class="v">Books on precedent</div>
         <p>${close.length} near-identical cases agree: ${OUTCOME_WORDS[top] ?? top}. No model is asked; the entry names the cases.</p>
         <dl><dt>Close cases</dt><dd>${close.length} of ${K}</dd><dt>Agreement</dt><dd>${Math.round(agreement * 100)}%</dd><dt>Matched in</dt><dd>${ms.toFixed(2)} ms</dd></dl>`
      : `<h4>No protocol</h4><div class="v jev">Falls to Jev</div>
         <p>${close.length ? `Only ${close.length} case${close.length > 1 ? 's' : ''} score 0.85 or more; it takes ${MIN_CASES}.` : 'Nothing in the team\'s history is close enough.'} Jev classifies it, and below its confidence floor a person is asked. Their answer becomes the next case.</p>
         <dl><dt>Close cases</dt><dd>${close.length} of ${K}</dd><dt>Needed</dt><dd>${MIN_CASES}, 80% agreeing</dd><dt>Matched in</dt><dd>${ms.toFixed(2)} ms</dd></dl>`;
  };
  seg(root.querySelector('[data-events]')!, EVENTS.map((e) => e.label), run);

  // the licence
  const POLICIES = [
    { label: 'Routine pit stop', n: 52, k: 52 },
    { label: 'Safety-car stop', n: 33, k: 33 },
    { label: 'Procedural infringement', n: 16, k: 16 },
    { label: 'Collision, carried on', n: 12, k: 12 },
    { label: 'Stopped, no stewards\' message', n: 6, k: 6 },
  ];
  const nIn = root.querySelector<HTMLInputElement>('[data-in="n"]')!;
  const kIn = root.querySelector<HTMLInputElement>('[data-in="k"]')!;
  const nOut = root.querySelector<HTMLOutputElement>('[data-out="n"]')!;
  const kOut = root.querySelector<HTMLOutputElement>('[data-out="k"]')!;
  const dot = root.querySelector<SVGCircleElement>('[data-dot]')!;
  const ci = root.querySelector<SVGRectElement>('[data-ci]')!;
  const out = root.querySelector<HTMLElement>('[data-licence]')!;
  const X = (v: number) => 20 + v * 480;
  const draw = () => {
    const n = +nIn.value;
    if (+kIn.value > n) kIn.value = String(n);
    kIn.max = String(n);
    const k = +kIn.value;
    nOut.value = String(n);
    kOut.value = String(k);
    for (const el of [nIn, kIn]) el.style.setProperty('--pct', `${((+el.value - +el.min) / (+el.max - +el.min || 1)) * 100}%`);
    const lb = wilsonLower(k, n);
    const ub = wilsonUpper(k, n);
    dot.setAttribute('cx', String(X(lb)));
    ci.setAttribute('x', String(X(lb)));
    ci.setAttribute('width', String(Math.max(2, X(ub) - X(lb))));
    const licensed = lb >= 0.75 && n >= 5;
    out.innerHTML = `<span>${k} of ${n} agree · lower bound</span><b>${lb.toFixed(2)}</b><span class="lic ${licensed ? '' : 'shadow'}">${licensed ? 'LICENSED: decides on its own' : 'SHADOW: watches, drawn dashed'}</span>`;
  };
  nIn.addEventListener('input', draw);
  kIn.addEventListener('input', draw);
  seg(
    root.querySelector('[data-policies]')!,
    POLICIES.map((p) => p.label),
    (i) => {
      nIn.value = String(POLICIES[i].n);
      kIn.max = String(POLICIES[i].n);
      kIn.value = String(POLICIES[i].k);
      draw();
    },
    3,
  );
}
