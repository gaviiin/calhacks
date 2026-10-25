import type { Grid, PartShape } from './kit';

// Turns a part's grids into what the GPU draws: triangles (for depth, glass and picking), construction
// lines (the grid's own rows and columns), edges (open borders, creases, drawn details) and, for the
// three drawing axes, silhouettes. Opposite views share a silhouette (front and rear, top and bottom).

export const SIL_AXES = ['x', 'y', 'z'] as const;
export type SilAxis = (typeof SIL_AXES)[number];

export interface PartMesh {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  /** construction lines, segments xyz xyz */
  iso: Float32Array;
  /** open borders, creases and drawn details */
  edges: Float32Array;
  /** silhouette segments seen along x, y and z */
  sil: Record<SilAxis, Float32Array>;
  /** a lighter mesh for hit testing */
  pickPos: Float32Array;
  pickIdx: Uint32Array;
  bounds: [number, number, number, number, number, number];
}

/** Creases sharper than this between neighbouring faces are drawn as edges. */
const CREASE_DEG = 38;

interface Tri {
  pos: number[];
  idx: number[];
}

/** Ear clipping for a cap: projects the ring onto its own plane (Newell normal). Returns triangle indices into the ring. */
function triangulateRing(ring: number[][]): number[] {
  const n = ring.length;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  // drop the dominant axis
  const proj = (p: number[]): [number, number] => (ax >= ay && ax >= az ? [p[1], p[2]] : ay >= az ? [p[2], p[0]] : [p[0], p[1]]);
  const pts = ring.map(proj);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  const ccw = area > 0;
  const remaining = Array.from({ length: n }, (_, i) => i);
  const tris: number[] = [];
  const cross2 = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p: [number, number], a: [number, number], b: [number, number], c: [number, number]) => {
    const d1 = cross2(a, b, p);
    const d2 = cross2(b, c, p);
    const d3 = cross2(c, a, p);
    return ccw ? d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12 : d1 < -1e-12 && d2 < -1e-12 && d3 < -1e-12;
  };
  let guard = 0;
  while (remaining.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let k = 0; k < remaining.length; k++) {
      const i0 = remaining[(k + remaining.length - 1) % remaining.length];
      const i1 = remaining[k];
      const i2 = remaining[(k + 1) % remaining.length];
      const c = cross2(pts[i0], pts[i1], pts[i2]);
      if (ccw ? c <= 1e-14 : c >= -1e-14) continue; // reflex or flat
      let ear = true;
      for (const j of remaining) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inside(pts[j], pts[i0], pts[i1], pts[i2])) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(i0, i1, i2);
      remaining.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // degenerate leftovers (coincident fillet points): fan the rest
      for (let k = 1; k < remaining.length - 1; k++) tris.push(remaining[0], remaining[k], remaining[k + 1]);
      remaining.length = 0;
      break;
    }
  }
  if (remaining.length === 3) tris.push(remaining[0], remaining[1], remaining[2]);
  return tris;
}

/** Triangles of a grid (optionally every `step`-th row and column, for the pick mesh). */
function gridTris(g: Grid, step = 1): Tri {
  const rowsIdx: number[] = [];
  for (let r = 0; r < g.rows; r += step) rowsIdx.push(r);
  if (rowsIdx[rowsIdx.length - 1] !== g.rows - 1) rowsIdx.push(g.rows - 1);
  const colsIdx: number[] = [];
  for (let c = 0; c < g.cols; c += step) colsIdx.push(c);
  if (!g.closed && colsIdx[colsIdx.length - 1] !== g.cols - 1) colsIdx.push(g.cols - 1);
  const R = rowsIdx.length;
  const C = colsIdx.length;
  const pos: number[] = [];
  for (const r of rowsIdx)
    for (const c of colsIdx) {
      const i = (r * g.cols + c) * 3;
      pos.push(g.p[i], g.p[i + 1], g.p[i + 2]);
    }
  const idx: number[] = [];
  const cmax = g.closed ? C : C - 1;
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < cmax; c++) {
      const a = r * C + c;
      const b = r * C + ((c + 1) % C);
      const d = (r + 1) * C + c;
      const e = (r + 1) * C + ((c + 1) % C);
      idx.push(a, d, b, b, d, e);
    }
  }
  const cap = (row: number, flip: boolean) => {
    const base = pos.length / 3;
    const ring: number[][] = [];
    for (let c = 0; c < C; c++) {
      const i = (row * C + c) * 3;
      ring.push([pos[i], pos[i + 1], pos[i + 2]]);
      pos.push(pos[i], pos[i + 1], pos[i + 2]);
    }
    const t = triangulateRing(ring);
    for (let k = 0; k < t.length; k += 3) {
      if (flip) idx.push(base + t[k], base + t[k + 2], base + t[k + 1]);
      else idx.push(base + t[k], base + t[k + 1], base + t[k + 2]);
    }
  };
  if (g.capStart) cap(0, false);
  if (g.capEnd) cap(R - 1, true);
  return { pos, idx };
}

/** Area-weighted vertex normals. */
function normals(pos: number[], idx: number[]): Float32Array {
  const n = new Float32Array(pos.length);
  for (let k = 0; k < idx.length; k += 3) {
    const a = idx[k] * 3;
    const b = idx[k + 1] * 3;
    const c = idx[k + 2] * 3;
    const ux = pos[b] - pos[a];
    const uy = pos[b + 1] - pos[a + 1];
    const uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a];
    const vy = pos[c + 1] - pos[a + 1];
    const vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      n[i] += nx;
      n[i + 1] += ny;
      n[i + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  return n;
}

/** Orients a closed grid so its normals point away from its middle, which keeps caps and silhouettes consistent. */
function orientOutward(g: Grid): Grid {
  if (!g.closed || g.rows < 2) return g;
  // compare a mid-grid face normal with the direction from the ring centre
  const r = Math.floor((g.rows - 1) / 2);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let c = 0; c < g.cols; c++) {
    const i = (r * g.cols + c) * 3;
    cx += g.p[i];
    cy += g.p[i + 1];
    cz += g.p[i + 2];
  }
  cx /= g.cols;
  cy /= g.cols;
  cz /= g.cols;
  let score = 0;
  for (let c = 0; c < g.cols; c++) {
    const a = (r * g.cols + c) * 3;
    const b = (r * g.cols + ((c + 1) % g.cols)) * 3;
    const d = ((r + 1) * g.cols + c) * 3;
    const ux = g.p[d] - g.p[a];
    const uy = g.p[d + 1] - g.p[a + 1];
    const uz = g.p[d + 2] - g.p[a + 2];
    const vx = g.p[b] - g.p[a];
    const vy = g.p[b + 1] - g.p[a + 1];
    const vz = g.p[b + 2] - g.p[a + 2];
    // same orientation as gridTris' (a, d, b)
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    score += nx * (g.p[a] - cx) + ny * (g.p[a + 1] - cy) + nz * (g.p[a + 2] - cz);
  }
  if (score >= 0) return g;
  // reverse the column order (keeping column 0 in place) to flip the winding
  const p = new Float64Array(g.p.length);
  for (let rr = 0; rr < g.rows; rr++) {
    for (let c = 0; c < g.cols; c++) {
      const src = (rr * g.cols + c) * 3;
      const dst = (rr * g.cols + ((g.cols - c) % g.cols)) * 3;
      p[dst] = g.p[src];
      p[dst + 1] = g.p[src + 1];
      p[dst + 2] = g.p[src + 2];
    }
  }
  return { ...g, p, isoCols: g.isoCols.map((c) => (g.cols - c) % g.cols) };
}

const Q = 1e4; // weld at 0.1 mm

/**
 * Welds every triangle of the part by position and classifies its edges: open borders, creases and,
 * per axis, silhouettes. Construction lines that sit on a drawn edge are dropped so nothing is drawn twice.
 */
export function buildPartMesh(shape: PartShape): PartMesh {
  const grids = shape.grids.map(orientOutward);
  // ---------------------------------------------------------------- render triangles
  const pos: number[] = [];
  const idx: number[] = [];
  const nrmParts: Float32Array[] = [];
  for (const g of grids) {
    const t = gridTris(g);
    const base = pos.length / 3;
    nrmParts.push(normals(t.pos, t.idx));
    for (const v of t.pos) pos.push(v);
    for (const i of t.idx) idx.push(base + i);
  }
  const nrm = new Float32Array(pos.length);
  let off = 0;
  for (const n of nrmParts) {
    nrm.set(n, off);
    off += n.length;
  }

  // ---------------------------------------------------------------- weld
  const weld = new Map<string, number>();
  const wpos: number[] = [];
  const remap = new Int32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const key = `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;
    let w = weld.get(key);
    if (w === undefined) {
      w = wpos.length / 3;
      weld.set(key, w);
      wpos.push(x, y, z);
    }
    remap[i] = w;
  }
  const keyOf = (x: number, y: number, z: number) => weld.get(`${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`);

  // face normals on the welded mesh; degenerate faces are skipped
  const faces: number[] = [];
  const fn: number[] = [];
  for (let k = 0; k < idx.length; k += 3) {
    const a = remap[idx[k]];
    const b = remap[idx[k + 1]];
    const c = remap[idx[k + 2]];
    if (a === b || b === c || a === c) continue;
    const ux = wpos[b * 3] - wpos[a * 3];
    const uy = wpos[b * 3 + 1] - wpos[a * 3 + 1];
    const uz = wpos[b * 3 + 2] - wpos[a * 3 + 2];
    const vx = wpos[c * 3] - wpos[a * 3];
    const vy = wpos[c * 3 + 1] - wpos[a * 3 + 1];
    const vz = wpos[c * 3 + 2] - wpos[a * 3 + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    nx /= l;
    ny /= l;
    nz /= l;
    faces.push(a, b, c);
    fn.push(nx, ny, nz);
  }
  const M = 1 << 21;
  const edgeFaces = new Map<number, number[]>();
  const nf = faces.length / 3;
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = faces[f * 3 + e];
      const b = faces[f * 3 + ((e + 1) % 3)];
      const key = a < b ? a * M + b : b * M + a;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }
  const cosCrease = Math.cos((CREASE_DEG * Math.PI) / 180);
  const edges: number[] = [];
  const drawn = new Set<number>();
  const silX: number[] = [];
  const silY: number[] = [];
  const silZ: number[] = [];
  const push = (arr: number[], a: number, b: number) => arr.push(wpos[a * 3], wpos[a * 3 + 1], wpos[a * 3 + 2], wpos[b * 3], wpos[b * 3 + 1], wpos[b * 3 + 2]);
  for (const [key, fl] of edgeFaces) {
    const a = Math.floor(key / M);
    const b = key - a * M;
    if (fl.length === 1) {
      push(edges, a, b);
      drawn.add(key);
      continue;
    }
    const f1 = fl[0];
    const f2 = fl[1];
    const n1x = fn[f1 * 3];
    const n1y = fn[f1 * 3 + 1];
    const n1z = fn[f1 * 3 + 2];
    const n2x = fn[f2 * 3];
    const n2y = fn[f2 * 3 + 1];
    const n2z = fn[f2 * 3 + 2];
    const cosA = n1x * n2x + n1y * n2y + n1z * n2z;
    // folded-over pairs (two faces of a thin plate meeting at its rim) count as creases too
    if (cosA < cosCrease || fl.length > 2) {
      push(edges, a, b);
      drawn.add(key);
      continue;
    }
    // a silhouette along an axis: one face turns toward it, the other away (or edge-on)
    if (n1x * n2x <= 0 && Math.abs(n1x - n2x) > 1e-6) push(silX, a, b);
    if (n1y * n2y <= 0 && Math.abs(n1y - n2y) > 1e-6) push(silY, a, b);
    if (n1z * n2z <= 0 && Math.abs(n1z - n2z) > 1e-6) push(silZ, a, b);
  }
  for (const v of shape.lines) edges.push(v);

  // ---------------------------------------------------------------- construction lines
  const iso: number[] = [];
  const isoSeg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const a = keyOf(x0, y0, z0);
    const b = keyOf(x1, y1, z1);
    if (a !== undefined && b !== undefined) {
      if (a === b) return;
      const key = a < b ? a * M + b : b * M + a;
      if (drawn.has(key)) return;
    }
    iso.push(x0, y0, z0, x1, y1, z1);
  };
  for (const g of grids) {
    const P = g.p;
    const at = (r: number, c: number) => (r * g.cols + c) * 3;
    for (const r of g.isoRows) {
      if (r < 0 || r >= g.rows) continue;
      const cmax = g.closed ? g.cols : g.cols - 1;
      for (let c = 0; c < cmax; c++) {
        const i = at(r, c);
        const j = at(r, (c + 1) % g.cols);
        isoSeg(P[i], P[i + 1], P[i + 2], P[j], P[j + 1], P[j + 2]);
      }
    }
    for (const c of g.isoCols) {
      if (c < 0 || c >= g.cols) continue;
      for (let r = 0; r < g.rows - 1; r++) {
        const i = at(r, c);
        const j = at(r + 1, c);
        isoSeg(P[i], P[i + 1], P[i + 2], P[j], P[j + 1], P[j + 2]);
      }
    }
  }

  // ---------------------------------------------------------------- pick mesh
  const pickPos: number[] = [];
  const pickIdx: number[] = [];
  for (const g of grids) {
    const t = gridTris(g, g.rows * g.cols > 600 ? 2 : 1);
    const base = pickPos.length / 3;
    for (const v of t.pos) pickPos.push(v);
    for (const i of t.idx) pickIdx.push(base + i);
  }

  const bounds: PartMesh['bounds'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bounds[k] = Math.min(bounds[k], pos[i + k]);
      bounds[k + 3] = Math.max(bounds[k + 3], pos[i + k]);
    }
  }
  return {
    pos: new Float32Array(pos),
    nrm,
    idx: new Uint32Array(idx),
    iso: new Float32Array(iso),
    edges: new Float32Array(edges),
    sil: { x: new Float32Array(silX), y: new Float32Array(silY), z: new Float32Array(silZ) },
    pickPos: new Float32Array(pickPos),
    pickIdx: new Uint32Array(pickIdx),
    bounds,
  };
}
