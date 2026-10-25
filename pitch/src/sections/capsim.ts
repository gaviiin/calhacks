// A copy of race/cap_forecast.py's year-end model for São Paulo 2024 (meeting 1249), run in the browser.
// Same inputs: $114.6m booked before the weekend (calibrated), the rest-of-year plan to 31 December with
// capsim's noise, Poisson crashes per race with capsim's severity mix, less six sprint adjustments.

const M = 1e6;
const CAP = 140.4 * M; // Issue 22, Art. 2.3(a)(iii): 135m + 1.8m x 3, before indexation
const MATERIAL = 0.05;
const BEFORE = 114.6 * M;
const ADJ = 6 * 0.3 * M;
const DAYS_LEFT = 58; // 3 November to 31 December 2024
const PLAN = (CAP * DAYS_LEFT) / 365;
const PAYROLL_SHARE = 0.55;
const PAYROLL_SD = 0.01;
const OTHER_SD = 0.04;
const SEVERITY: [number, number, number][] = [
  [0.7, 180_000, 0.45],
  [0.25, 900_000, 0.4],
  [0.05, 2_500_000, 0.4],
];
const N = 10_000;
const MAXK = 24;

function mulberry(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// common random numbers: one set of draws, reused for every input, like the desk's seeded runs
const draws = (() => {
  const r = mulberry(1249);
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const payroll = new Float64Array(N);
  const other = new Float64Array(N);
  const u = new Float64Array(N); // for the Poisson count
  const cat = new Float64Array(N * MAXK);
  const z = new Float64Array(N * MAXK);
  for (let i = 0; i < N; i++) {
    payroll[i] = normal();
    other[i] = normal();
    u[i] = r();
    for (let j = 0; j < MAXK; j++) {
      cat[i * MAXK + j] = r();
      z[i * MAXK + j] = normal();
    }
  }
  return { payroll, other, u, cat, z };
})();

function poissonFromU(u: number, lambda: number) {
  // inverse CDF, so the same uniform gives a count that grows smoothly with the rate
  let k = 0;
  let p = Math.exp(-lambda);
  let cdf = p;
  while (u > cdf && k < MAXK) {
    k++;
    p *= lambda / k;
    cdf += p;
  }
  return k;
}

const fmt = (x: number) => `$${(x / M).toFixed(1)}m`;
const fmt2 = (x: number) => `$${(x / M).toFixed(2)}m`;
const pct = (p: number) => (p < 0.001 ? '<0.1%' : p > 0.999 ? '>99.9%' : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`);

export function initCapSim(root: HTMLElement) {
  const inW = root.querySelector<HTMLInputElement>('[data-in="w"]')!;
  const inR = root.querySelector<HTMLInputElement>('[data-in="r"]')!;
  const inL = root.querySelector<HTMLInputElement>('[data-in="l"]')!;
  const out = (k: string) => root.querySelector<HTMLElement>(`[data-out="${k}"]`)!;
  const sim = (k: string) => root.querySelector<HTMLElement>(`[data-sim="${k}"]`)!;
  const sch = (k: string) => root.querySelector<HTMLElement>(`[data-sch="${k}"]`)!;
  const svg = root.querySelector<SVGSVGElement>('[data-hist]')!;
  const ye = new Float64Array(N);
  const shares = SEVERITY.map((s) => s[0]);
  const cum = shares.map((_, i) => shares.slice(0, i + 1).reduce((a, b) => a + b, 0));

  const run = () => {
    const w = +inW.value * M;
    const rate = +inR.value;
    const left = +inL.value;
    for (const el of [inW, inR, inL]) el.style.setProperty('--pct', `${((+el.value - +el.min) / (+el.max - +el.min)) * 100}%`);
    out('w').textContent = fmt2(w);
    out('r').textContent = rate.toFixed(2);
    out('l').textContent = String(left);

    const t0 = performance.now();
    let crashSum = 0;
    for (let i = 0; i < N; i++) {
      const pay = PLAN * PAYROLL_SHARE * (1 + draws.payroll[i] * PAYROLL_SD);
      const oth = PLAN * (1 - PAYROLL_SHARE) * (1 + draws.other[i] * OTHER_SD);
      const k = poissonFromU(draws.u[i], rate * left);
      let crash = 0;
      for (let j = 0; j < k; j++) {
        const c = draws.cat[i * MAXK + j];
        const s = c < cum[0] ? 0 : c < cum[1] ? 1 : 2;
        crash += SEVERITY[s][1] * Math.exp(draws.z[i * MAXK + j] * SEVERITY[s][2]);
      }
      crashSum += crash;
      ye[i] = BEFORE + w + pay + oth + crash - ADJ;
    }
    const sorted = Float64Array.from(ye).sort();
    const q = (x: number) => sorted[Math.min(N - 1, Math.floor(x * N))];
    let over = 0;
    let material = 0;
    for (let i = 0; i < N; i++) {
      if (ye[i] > CAP) over++;
      if (ye[i] >= CAP * (1 + MATERIAL)) material++;
    }
    const ms = performance.now() - t0;
    const p10 = q(0.1);
    const p50 = q(0.5);
    const p90 = q(0.9);

    sim('over').textContent = pct(over / N);
    sim('over').classList.toggle('bad', over / N >= 0.5);
    sim('material').textContent = pct(material / N);
    sim('material').classList.toggle('bad', material / N >= 0.1);
    const head = CAP - p50;
    sim('head').textContent = `${head < 0 ? '−' : ''}${fmt2(Math.abs(head))}`;
    sim('head').classList.toggle('bad', head < 0);
    sim('timing').textContent = `10,000 cap years in ${ms.toFixed(0)} ms in your browser. The desk runs the same model in numpy after every change.`;
    sch('weekend').textContent = fmt2(w);
    sch('crash').textContent = `~${fmt(crashSum / N)}`;
    sch('p50').textContent = fmt(p50);
    sch('plan').textContent = fmt(PLAN);

    // histogram
    const lo = 132 * M;
    const hi = 150 * M;
    const bins = 72;
    const counts = new Array(bins).fill(0);
    for (let i = 0; i < N; i++) {
      const b = Math.floor(((ye[i] - lo) / (hi - lo)) * bins);
      if (b >= 0 && b < bins) counts[b]++;
    }
    const peak = Math.max(...counts, 1);
    const W = 560;
    const H = 220;
    const L = 10;
    const R = 550;
    const B = 186;
    const T = 26;
    const x = (v: number) => L + ((v - lo) / (hi - lo)) * (R - L);
    const bw = (R - L) / bins;
    let s = `<line class="axis" x1="${L}" x2="${R}" y1="${B}" y2="${B}"/>`;
    counts.forEach((c, i) => {
      if (!c) return;
      const h = Math.max(1, (c / peak) * (B - T));
      const v0 = lo + (i / bins) * (hi - lo);
      s += `<rect class="bin ${v0 >= CAP ? 'over' : ''}" x="${(L + i * bw + 0.5).toFixed(1)}" y="${(B - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
    });
    const mark = (v: number, cls: string, label: string, lcls: string, anchor: string, y: number) =>
      `<line class="${cls}" x1="${x(v)}" x2="${x(v)}" y1="${T - 8}" y2="${B}"/><text class="${lcls}" x="${x(v) + (anchor === 'end' ? -4 : 4)}" y="${y}" text-anchor="${anchor}">${label}</text>`;
    s += mark(p10, 'pct', 'P10', '', 'end', B - 4);
    s += mark(p90, 'pct', 'P90', '', 'start', B - 4);
    s += mark(CAP, 'capline', 'cap $140.4m', 'lbl-cap', 'start', T - 10);
    s += mark(CAP * (1 + MATERIAL), 'mat', 'material +5%', 'lbl-mat', 'end', T - 10);
    for (const v of [134, 138, 142, 146, 150]) s += `<text x="${x(v * M)}" y="${H - 14}" text-anchor="middle">$${v}m</text>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = s;
  };
  for (const el of [inW, inR, inL]) el.addEventListener('input', run);
  run();
}
