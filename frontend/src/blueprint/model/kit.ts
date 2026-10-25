// Procedural modelling kit for the blueprint car. Pure numbers, no DOM and no three.js, so the whole
// car is built inside a Web Worker. Every surface is a grid of points (rows of cross-section rings);
// the grid keeps its rows and columns so the drawing can show the surface's own construction lines
// (stations and longerons) instead of a triangle soup.
//
// Car space: metres, nose toward +x, y up, z across the car, ground at y = 0.

export type Vec = [number, number, number];
export type P2 = [number, number];
export type Ring = Vec[];

export interface Grid {
  rows: number;
  cols: number;
  /** rows × cols points, row-major, xyz */
  p: Float64Array;
  /** each row is a closed ring */
  closed: boolean;
  capStart: boolean;
  capEnd: boolean;
  /** rows and columns drawn as construction lines */
  isoRows: number[];
  isoCols: number[];
}

/** One selectable piece of the car: its surfaces plus drawn-only detail lines (seams, louvres, lips). */
export interface PartShape {
  grids: Grid[];
  /** extra segments, xyz xyz, drawn with the part's edges */
  lines: number[];
}

// ---------------------------------------------------------------- small vector helpers

export const v = (x: number, y: number, z: number): Vec => [x, y, z];
export const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec, s: number): Vec => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: Vec): Vec => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerpV = (a: Vec, b: Vec, t: number): Vec => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const smooth = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};

// ---------------------------------------------------------------- 2D profiles

export interface Corner {
  a: number;
  b: number;
  /** fillet radius; 0 keeps a sharp corner */
  r: number;
}

export interface PolyMeta {
  pts: P2[];
  /** index of each corner's first point */
  corner: number[];
  /** index of the first interior point of the edge leaving each corner */
  edge: number[];
}

/**
 * A rounded polygon sampled with a fixed number of points per fillet and per edge, so every station
 * of a loft built from the same corner list has the same point count and the construction lines run
 * along the same features (a corner stays a corner from nose to tail). A corner asked for with r = 0
 * is one point; a rounded corner is always arcN + 1 points, even when its edges vanish (a notch that
 * has closed collapses onto one point instead of changing the count). Starts at corner 0.
 */
export function roundedPolyMeta(corners: Corner[], arcN = 6, segN: number | number[] = 2): PolyMeta {
  const k = corners.length;
  const fill: { pts: P2[]; start: P2; end: P2 }[] = [];
  for (let i = 0; i < k; i++) {
    const p = corners[(i + k - 1) % k];
    const c = corners[i];
    const q = corners[(i + 1) % k];
    const count = c.r <= 0 ? 1 : arcN + 1;
    const copies = (): { pts: P2[]; start: P2; end: P2 } => ({ pts: Array.from({ length: count }, () => [c.a, c.b] as P2), start: [c.a, c.b], end: [c.a, c.b] });
    let d1x = p.a - c.a;
    let d1y = p.b - c.b;
    let d2x = q.a - c.a;
    let d2y = q.b - c.b;
    const l1 = Math.hypot(d1x, d1y);
    const l2 = Math.hypot(d2x, d2y);
    if (count === 1 || l1 < 1e-7 || l2 < 1e-7) {
      fill.push(copies());
      continue;
    }
    d1x /= l1;
    d1y /= l1;
    d2x /= l2;
    d2y /= l2;
    const ang = Math.acos(clamp(d1x * d2x + d1y * d2y, -1, 1));
    if (ang > Math.PI - 1e-4 || ang < 1e-4) {
      fill.push(copies());
      continue;
    }
    const tanHalf = Math.tan(ang / 2);
    const r = Math.min(c.r, Math.min(l1, l2) * 0.5 * tanHalf * 0.999);
    if (r < 1e-7) {
      fill.push(copies());
      continue;
    }
    const t = r / tanHalf;
    const start: P2 = [c.a + d1x * t, c.b + d1y * t];
    const end: P2 = [c.a + d2x * t, c.b + d2y * t];
    let bx = d1x + d2x;
    let by = d1y + d2y;
    const bl = Math.hypot(bx, by) || 1e-9;
    bx /= bl;
    by /= bl;
    const h = r / Math.sin(ang / 2);
    const cx = c.a + bx * h;
    const cy = c.b + by * h;
    const a0 = Math.atan2(start[1] - cy, start[0] - cx);
    const a1 = Math.atan2(end[1] - cy, end[0] - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const pts: P2[] = [];
    for (let s = 0; s <= arcN; s++) {
      const a = a0 + (da * s) / arcN;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    fill.push({ pts, start, end });
  }
  const pts: P2[] = [];
  const corner: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i < k; i++) {
    const f = fill[i];
    corner.push(pts.length);
    for (const q of f.pts) pts.push(q);
    const g = fill[(i + 1) % k];
    const n = Array.isArray(segN) ? segN[i % segN.length] : segN;
    edge.push(pts.length);
    for (let s = 1; s <= n; s++) {
      const t = s / (n + 1);
      pts.push([lerp(f.end[0], g.start[0], t), lerp(f.end[1], g.start[1], t)]);
    }
  }
  return { pts, corner, edge };
}

export function roundedPoly(corners: Corner[], arcN = 6, segN: number | number[] = 2): P2[] {
  return roundedPolyMeta(corners, arcN, segN).pts;
}

/**
 * Monotone cubic interpolation (Fritsch-Carlson) through (x, y) pairs: no overshoot between stations,
 * so a shape curve never bulges past the numbers it was given. Constant beyond the ends.
 */
export function pchip(pairs: [number, number][]): (x: number) => number {
  const p = pairs.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  const xs = p.map((q) => q[0]);
  const ys = p.map((q) => q[1]);
  if (n === 1) return () => ys[0];
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  }
  const m: number[] = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

/** n values from a to b inclusive. */
export function range(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));
}

/** Sample positions from a to b with roughly `step` spacing, plus any `extra` positions, sorted from a toward b. */
export function stations(a: number, b: number, step: number, extra: number[] = []): number[] {
  const n = Math.max(2, Math.round(Math.abs(b - a) / step) + 1);
  const xs = range(a, b, n);
  for (const e of extra) if ((e - a) * (e - b) < 0 && !xs.some((x) => Math.abs(x - e) < 1e-6)) xs.push(e);
  return xs.sort((p, q) => (a > b ? q - p : p - q));
}

/** Indices of the samples nearest to each multiple of `step` (construction stations at round positions). */
export function nearestRows(xs: number[], step: number, keep: number[] = []): number[] {
  const out = new Set<number>([0, xs.length - 1]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) {
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    if (Math.abs(xs[best] - t) < step * 0.4) out.add(best);
  }
  for (const k of keep) {
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - k) < Math.abs(xs[best] - k)) best = i;
    out.add(best);
  }
  return [...out].sort((a, b) => a - b);
}

/** Superellipse ring: e = 2 is an ellipse, larger is squarer. Starts at the top and runs toward +a. */
export function superEllipse(ha: number, hb: number, e: number, n: number, ca = 0, cb = 0): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.PI / 2 - (i / n) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([ca + ha * Math.sign(c) * Math.abs(c) ** (2 / e), cb + hb * Math.sign(s) * Math.abs(s) ** (2 / e)]);
  }
  return out;
}

/**
 * Inverted (downforce) aerofoil in chord units: u = 0 at the leading edge, 1 at the trailing edge,
 * camber toward -y. Ring starts at the trailing edge, runs over the pressure (upper) side to the leading
 * edge and back along the suction side. The trailing edge is a sharp crease.
 */
export function aerofoil(n: number, thick = 0.1, camber = 0.06, camberAt = 0.4): P2[] {
  const half = Math.floor(n / 2);
  const yt = (u: number) => 5 * thick * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const yc = (u: number) =>
    u < camberAt ? (camber / (camberAt * camberAt)) * (2 * camberAt * u - u * u) : (camber / (1 - camberAt) ** 2) * (1 - 2 * camberAt + 2 * camberAt * u - u * u);
  const station = (i: number) => 0.5 * (1 - Math.cos((Math.PI * i) / half));
  const out: P2[] = [];
  // upper (pressure side on an inverted wing): TE → LE
  for (let i = half; i >= 0; i--) {
    const u = station(i);
    out.push([u, -yc(u) + yt(u) * (1 - 0.15 * u)]);
  }
  // lower (suction side): LE → TE, skipping both ends already placed
  for (let i = 1; i < half; i++) {
    const u = station(i);
    out.push([u, -yc(u) - yt(u) * (1 - 0.15 * u)]);
  }
  return out;
}

/**
 * Places aerofoil points: leading edge at (x, y), chord toward -x, at span z. A positive `aoa` (rad)
 * raises the trailing edge, as on an inverted wing.
 */
export function wingRing(foil: P2[], x: number, y: number, z: number, chord: number, aoa: number): Ring {
  const c = Math.cos(aoa);
  const s = Math.sin(aoa);
  return foil.map(([u, t]) => {
    const px = -u * chord;
    const py = t * chord;
    return [x + px * c + py * s, y - px * s + py * c, z];
  });
}

/** Places 2D (a, b) points on the plane x = const as (x, b, a): a across the car, b up. */
export const atX = (x: number, pts: P2[], cz = 0, cy = 0): Ring => pts.map(([a, b]) => [x, cy + b, cz + a]);
/** Places 2D (a, b) points on the plane z = const as (a, b, z): a along the car, b up. */
export const atZ = (z: number, pts: P2[]): Ring => pts.map(([a, b]) => [a, b, z]);
/** Places 2D (a, b) points on the plane y = const as (a, y, b): a along the car, b across. */
export const atY = (y: number, pts: P2[]): Ring => pts.map(([a, b]) => [a, y, b]);

// ---------------------------------------------------------------- curves

/** Centripetal Catmull-Rom through `pts`, `n` samples, ends included. */
export function spline(pts: Vec[], n: number, closed = false): Vec[] {
  const m = pts.length;
  if (m < 2) return pts.slice();
  const get = (i: number): Vec => {
    if (closed) return pts[((i % m) + m) % m];
    if (i < 0) return add(pts[0], sub(pts[0], pts[1]));
    if (i >= m) return add(pts[m - 1], sub(pts[m - 1], pts[m - 2]));
    return pts[i];
  };
  const segs = closed ? m : m - 1;
  const out: Vec[] = [];
  const total = closed ? n : n - 1;
  for (let k = 0; k < (closed ? n : n); k++) {
    const gt = (k / total) * segs;
    const i = Math.min(segs - 1, Math.floor(gt));
    const t = gt - i;
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    // centripetal parametrisation
    const d01 = Math.max(1e-6, Math.sqrt(len(sub(p1, p0))));
    const d12 = Math.max(1e-6, Math.sqrt(len(sub(p2, p1))));
    const d23 = Math.max(1e-6, Math.sqrt(len(sub(p3, p2))));
    const t0 = 0;
    const t1 = t0 + d01;
    const t2 = t1 + d12;
    const t3 = t2 + d23;
    const tt = t1 + (t2 - t1) * t;
    const A1 = lerpV(p0, p1, (tt - t0) / (t1 - t0));
    const A2 = lerpV(p1, p2, (tt - t1) / (t2 - t1));
    const A3 = lerpV(p2, p3, (tt - t2) / (t3 - t2));
    const B1 = lerpV(A1, A2, (tt - t0) / (t2 - t0));
    const B2 = lerpV(A2, A3, (tt - t1) / (t3 - t1));
    out.push(lerpV(B1, B2, (tt - t1) / (t2 - t1)));
  }
  return out;
}

/** Catmull-Rom interpolation of every numeric field between sparse stations (keyed by x). */
export function densify<T extends Record<string, number>>(stations: T[], perGap = 3): T[] {
  const keys = Object.keys(stations[0]) as (keyof T)[];
  const out: T[] = [];
  const m = stations.length;
  for (let i = 0; i < m - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const p = stations[Math.max(0, i - 1)];
    const q = stations[Math.min(m - 1, i + 2)];
    for (let s = 0; s < perGap; s++) {
      const t = s / perGap;
      const o = {} as T;
      for (const k of keys) {
        const va = a[k];
        const vb = b[k];
        // at the ends, mirror the neighbour so the curve leaves the end station along its chord
        const vp = i === 0 ? 2 * va - vb : p[k];
        const vq = i + 2 >= m ? 2 * vb - va : q[k];
        const t2 = t * t;
        const t3 = t2 * t;
        (o as Record<string, number>)[k as string] = 0.5 * (2 * va + (-vp + vb) * t + (2 * vp - 5 * va + 4 * vb - vq) * t2 + (-vp + 3 * va - 3 * vb + vq) * t3);
      }
      out.push(o);
    }
  }
  out.push({ ...stations[m - 1] });
  return out;
}

// ---------------------------------------------------------------- grids

/** Every `stride`-th index of 0..n-1, always including the last when `withEnds`. */
export function every(n: number, stride: number, withEnds = true): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += Math.max(1, stride)) out.push(i);
  if (withEnds && out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

export interface GridOpts {
  closed?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
  /** construction lines: a stride or explicit indices */
  isoRows?: number | number[];
  isoCols?: number | number[];
}

/** Skins rings (all the same length) into a grid. */
export function loft(rings: Ring[], o: GridOpts = {}): Grid {
  const rows = rings.length;
  const cols = rings[0].length;
  const p = new Float64Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    const ring = rings[r];
    if (ring.length !== cols) throw new Error(`loft: ring ${r} has ${ring.length} points, expected ${cols}`);
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      p[i] = ring[c][0];
      p[i + 1] = ring[c][1];
      p[i + 2] = ring[c][2];
    }
  }
  const closed = o.closed ?? true;
  const iso = (spec: number | number[] | undefined, n: number, dflt: number, ends: boolean) => (Array.isArray(spec) ? spec : every(n, spec ?? dflt, ends));
  return {
    rows,
    cols,
    p,
    closed,
    capStart: !!o.capStart && closed,
    capEnd: !!o.capEnd && closed,
    isoRows: iso(o.isoRows, rows, 1, true),
    isoCols: iso(o.isoCols, cols, 2, !closed),
  };
}

/** A surface of revolution: `profile` is (radius, along-axis) pairs; the axis runs through `c` along `axis`. */
export function lathe(profile: P2[], segs: number, c: Vec, axis: 'x' | 'y' | 'z', o: GridOpts = {}): Grid {
  const rings: Ring[] = profile.map(([r, h]) => {
    const ring: Ring = [];
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const ca = Math.cos(a) * r;
      const sa = Math.sin(a) * r;
      if (axis === 'z') ring.push([c[0] + ca, c[1] + sa, c[2] + h]);
      else if (axis === 'x') ring.push([c[0] + h, c[1] + ca, c[2] + sa]);
      else ring.push([c[0] + ca, c[1] + h, c[2] + sa]);
    }
    return ring;
  });
  return loft(rings, { closed: true, isoCols: 3, isoRows: 1, ...o });
}

/**
 * Sweeps a 2D section along a path with rotation-minimising frames. The section's a-axis starts along
 * `side` (projected off the tangent); `section(t)` may change with t in [0, 1] (tapers).
 */
export function sweep(path: Vec[], section: (t: number) => P2[], side: Vec = [0, 1, 0], o: GridOpts = {}): Grid {
  const n = path.length;
  const tangents: Vec[] = path.map((_, i) => norm(sub(path[Math.min(n - 1, i + 1)], path[Math.max(0, i - 1)])));
  let u = norm(sub(side, scale(tangents[0], dot(side, tangents[0]))));
  if (!Number.isFinite(u[0]) || len(u) < 0.5) u = norm(cross(tangents[0], [0, 0, 1]));
  const rings: Ring[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i];
    if (i > 0) {
      // project the previous frame onto the new normal plane (double reflection would be steadier; this
      // is enough for the gentle curves on a car)
      u = norm(sub(u, scale(t, dot(u, t))));
    }
    const w = cross(t, u);
    const sec = section(n === 1 ? 0 : i / (n - 1));
    rings.push(sec.map(([a, b]) => add(path[i], add(scale(u, a), scale(w, b)))));
  }
  return loft(rings, { closed: true, ...o });
}

/** A straight faired member (elliptical section `w` × `h`) between two points; `up` orients the chord. */
export function strut(a: Vec, b: Vec, w: number, h: number, up: Vec = [0, 1, 0], segs = 10, n = 12, taper = 1): Grid {
  const path: Vec[] = [];
  for (let i = 0; i <= segs; i++) path.push(lerpV(a, b, i / segs));
  return sweep(path, (t) => superEllipse((w / 2) * lerp(1, taper, t), (h / 2) * lerp(1, taper, t), 2, n), up, {
    capStart: true,
    capEnd: true,
    isoRows: [0, segs],
    isoCols: every(n, 3, false),
  });
}

/** Round bar between two points. */
export function rod(a: Vec, b: Vec, r: number, n = 12, segs = 6): Grid {
  return strut(a, b, r * 2, r * 2, Math.abs(norm(sub(b, a))[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], segs, n);
}

/**
 * Box centred at c (sizes along x, y, z), lofted along x. r = 0 gives sharp edges (drawn as creases);
 * a fillet gets one construction line along the middle of each rounded edge.
 */
export function box(c: Vec, sx: number, sy: number, sz: number, r = 0, o: { rows?: number; arcN?: number } = {}): Grid {
  const rr = Math.max(0, Math.min(r, sy / 2 - 1e-4, sz / 2 - 1e-4));
  const arcN = o.arcN ?? 3;
  const meta = roundedPolyMeta(
    [
      { a: -sz / 2, b: sy / 2, r: rr },
      { a: sz / 2, b: sy / 2, r: rr },
      { a: sz / 2, b: -sy / 2, r: rr },
      { a: -sz / 2, b: -sy / 2, r: rr },
    ],
    arcN,
    1,
  );
  const rows = o.rows ?? 2;
  const rings: Ring[] = [];
  for (let i = 0; i < rows; i++) rings.push(atX(c[0] - sx / 2 + (sx * i) / (rows - 1), meta.pts, c[2], c[1]));
  return loft(rings, { capStart: true, capEnd: true, isoRows: [0, rows - 1], isoCols: rr > 0 ? meta.corner.map((i) => i + Math.floor(arcN / 2)) : [] });
}

/** Mirrors a grid across z = 0 (the car's centre plane); column order is reversed to keep the winding. */
export function mirrorZ(g: Grid): Grid {
  const p = new Float64Array(g.p.length);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const src = (r * g.cols + c) * 3;
      const dc = g.closed ? (g.cols - c) % g.cols : g.cols - 1 - c;
      const dst = (r * g.cols + dc) * 3;
      p[dst] = g.p[src];
      p[dst + 1] = g.p[src + 1];
      p[dst + 2] = -g.p[src + 2];
    }
  }
  const mapCol = (c: number) => (g.closed ? (g.cols - c) % g.cols : g.cols - 1 - c);
  return { ...g, p, isoCols: g.isoCols.map(mapCol) };
}

export function mirrorLines(lines: number[]): number[] {
  const out = lines.slice();
  for (let i = 2; i < out.length; i += 3) out[i] = -out[i];
  return out;
}

export function mirrorShape(s: PartShape): PartShape {
  return { grids: s.grids.map(mirrorZ), lines: mirrorLines(s.lines) };
}

/** Moves every point of a shape. */
export function translateShape(s: PartShape, d: Vec): PartShape {
  const grids = s.grids.map((g) => {
    const p = new Float64Array(g.p);
    for (let i = 0; i < p.length; i += 3) {
      p[i] += d[0];
      p[i + 1] += d[1];
      p[i + 2] += d[2];
    }
    return { ...g, p };
  });
  const lines = s.lines.slice();
  for (let i = 0; i < lines.length; i += 3) {
    lines[i] += d[0];
    lines[i + 1] += d[1];
    lines[i + 2] += d[2];
  }
  return { grids, lines };
}

/** Rotates a shape about the axis through `c` along `axis` (unit) by `a` radians. */
export function rotateShape(s: PartShape, c: Vec, axis: Vec, a: number): PartShape {
  const k = norm(axis);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const rot = (x: number, y: number, z: number): Vec => {
    const p: Vec = [x - c[0], y - c[1], z - c[2]];
    const kxp = cross(k, p);
    const kdp = dot(k, p);
    return [c[0] + p[0] * ca + kxp[0] * sa + k[0] * kdp * (1 - ca), c[1] + p[1] * ca + kxp[1] * sa + k[1] * kdp * (1 - ca), c[2] + p[2] * ca + kxp[2] * sa + k[2] * kdp * (1 - ca)];
  };
  const grids = s.grids.map((g) => {
    const p = new Float64Array(g.p.length);
    for (let i = 0; i < p.length; i += 3) {
      const q = rot(g.p[i], g.p[i + 1], g.p[i + 2]);
      p[i] = q[0];
      p[i + 1] = q[1];
      p[i + 2] = q[2];
    }
    return { ...g, p };
  });
  const lines: number[] = [];
  for (let i = 0; i < s.lines.length; i += 3) lines.push(...rot(s.lines[i], s.lines[i + 1], s.lines[i + 2]));
  return { grids, lines };
}

export function shape(...grids: Grid[]): PartShape {
  return { grids, lines: [] };
}

export function merge(...shapes: PartShape[]): PartShape {
  return { grids: shapes.flatMap((s) => s.grids), lines: shapes.flatMap((s) => s.lines) };
}

/** Polyline → segment list. */
export function polyline(pts: Vec[], closed = false): number[] {
  const out: number[] = [];
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  return out;
}
