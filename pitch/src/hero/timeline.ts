// One scroll axis, p from 0 to 1, drives the whole opening: the lap, the crash, the paperwork, the garage.
// Everything in the hero reads these marks, so the 3D scene and the HTML over it never drift apart.

export const T = {
  titleOut: 0.05,
  snap: 0.1, // the rear steps out
  impact: 0.155,
  redFlag: 0.255,
  debrisEnd: 0.34,
  chaosIn: 0.35,
  chaosFull: 0.55,
  collapse: 0.6,
  oneLedger: 0.66,
  garageIn: 0.68,
  garageSet: 0.8,
  tags: 0.82,
  end: 1,
} as const;

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const span = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
export const smooth = (x: number) => x * x * (3 - 2 * x);
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const expoOut = (x: number) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x));

/** 1 inside [a, b], ramping over `r` at each end. */
export function window01(p: number, a: number, b: number, r = 0.015) {
  return Math.min(span(p, a - r, a), 1 - span(p, b, b + r));
}

/** Seeded random, so the crash is the same crash every time the page loads. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speed on the telemetry readout, km/h, as the scroll runs through the crash. */
export function speedAt(p: number) {
  if (p < T.snap) return 315 - 3 * Math.sin(p * 90);
  if (p < T.impact) return 315 - 12 * span(p, T.snap, T.impact);
  const u = span(p, T.impact, T.impact + 0.02);
  return Math.max(0, 303 * (1 - easeOut(u)));
}

/** The session clock (Interlagos, qualifying), seconds after midnight local. The stop is at 11:57:19. */
export function clockAt(p: number) {
  const stop = 11 * 3600 + 57 * 60 + 19;
  if (p < T.impact) return stop - 2.4 + 2.4 * span(p, 0, T.impact);
  if (p < T.redFlag) return stop + 9 * span(p, T.impact, T.redFlag);
  return stop + 9 + 40 * span(p, T.redFlag, T.collapse);
}

export function fmtClock(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}
