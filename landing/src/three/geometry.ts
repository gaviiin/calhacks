import * as THREE from 'three';

// Procedural-modelling kit. Every body panel is lofted between cross-section
// rings so the surfaces stay smooth; rings are resampled by arc length so a
// round nose can flow into a box-section monocoque without twisting.

export type Ring = THREE.Vector3[];

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Points per body ring; every ring in a loft must share it. */
export const RING_N = 56;

/** Resamples a closed outline to `n` points spaced evenly by arc length, keeping point 0 as the start. */
export function resampleClosed(outline: THREE.Vector3[], n = RING_N): Ring {
  const m = outline.length;
  const cum = [0];
  for (let i = 1; i <= m; i++) cum.push(cum[i - 1] + outline[i - 1].distanceTo(outline[i % m]));
  const total = cum[m];
  const out: Ring = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (seg < m - 1 && cum[seg + 1] < d) seg++;
    const t = (d - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    out.push(outline[seg].clone().lerp(outline[(seg + 1) % m], t));
  }
  return out;
}

type Corner = { a: number; b: number; r: number };

/**
 * Filleted polygon in a 2D plane (coordinates a, b) mapped into 3D by `to`.
 * Corners are given in order; each gets a rounded fillet of radius r.
 * The outline starts at the midpoint of the first edge, so lofts stay aligned.
 */
export function filletPolygon(corners: Corner[], to: (a: number, b: number) => THREE.Vector3, n = RING_N): Ring {
  const pts: THREE.Vector3[] = [];
  const k = corners.length;
  for (let i = 0; i < k; i++) {
    const p = corners[(i + k - 1) % k];
    const c = corners[i];
    const q = corners[(i + 1) % k];
    const d1 = new THREE.Vector2(p.a - c.a, p.b - c.b).normalize();
    const d2 = new THREE.Vector2(q.a - c.a, q.b - c.b).normalize();
    const ang = Math.acos(THREE.MathUtils.clamp(d1.dot(d2), -1, 1));
    const lenA = Math.min(new THREE.Vector2(p.a - c.a, p.b - c.b).length() / 2, new THREE.Vector2(q.a - c.a, q.b - c.b).length() / 2);
    const r = Math.min(c.r, lenA * Math.tan(ang / 2) * 0.999);
    const tan = r / Math.tan(ang / 2);
    const start = new THREE.Vector2(c.a + d1.x * tan, c.b + d1.y * tan);
    const end = new THREE.Vector2(c.a + d2.x * tan, c.b + d2.y * tan);
    const bis = new THREE.Vector2(d1.x + d2.x, d1.y + d2.y).normalize();
    const centre = new THREE.Vector2(c.a + bis.x * r / Math.sin(ang / 2), c.b + bis.y * r / Math.sin(ang / 2));
    const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
    let a1 = Math.atan2(end.y - centre.y, end.x - centre.x);
    let diff = a1 - a0;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const steps = r < 1e-4 ? 1 : 8;
    for (let s = 0; s <= steps; s++) {
      const a = a0 + (diff * s) / steps;
      pts.push(to(centre.x + Math.cos(a) * r, centre.y + Math.sin(a) * r));
    }
    void a1;
  }
  // Rotate so the ring starts at the midpoint of the edge between corner 0 and corner 1.
  const mid = new THREE.Vector2((corners[0].a + corners[1].a) / 2, (corners[0].b + corners[1].b) / 2);
  const midP = to(mid.x, mid.y);
  let best = 0;
  let bd = Infinity;
  pts.forEach((p, i) => {
    const d = p.distanceToSquared(midP);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  const rotated = [...pts.slice(best), ...pts.slice(0, best)];
  return resampleClosed(rotated, n);
}

export type BodyStation = {
  x: number;
  top: number;
  bot: number;
  /** Half-widths at the top and bottom edge. */
  hwTop: number;
  hwBot: number;
  /** Fillet radii: top corners and bottom corners. */
  rt: number;
  rb: number;
  /** Optional lateral offset (centre z) and top-edge tumblehome. */
  cz?: number;
};

/** Box-section ring in the YZ plane at station x; the ring starts at top-centre and runs to +z. */
export function bodyRing(s: BodyStation, n = RING_N): Ring {
  const cz = s.cz ?? 0;
  return filletPolygon(
    [
      { a: cz - s.hwTop, b: s.top, r: s.rt },
      { a: cz + s.hwTop, b: s.top, r: s.rt },
      { a: cz + s.hwBot, b: s.bot, r: s.rb },
      { a: cz - s.hwBot, b: s.bot, r: s.rb },
    ],
    (z, y) => V(s.x, y, z),
    n
  );
}

export type PodStation = {
  x: number;
  zIn: number;
  zOut: number;
  /** Top edge heights at the inner and outer edge (downwash slope). */
  yTopIn: number;
  yTopOut: number;
  /** Bottom edge at the outer edge and inner edge (undercut). */
  yBotOut: number;
  yBotIn: number;
  /** Outer corner fillets. */
  rTop: number;
  rBot: number;
  /** Outer lower edge can tuck in (coke-bottle). */
  zOutBot?: number;
};

/** Sidepod section: a rounded quad hung off the chassis side. */
export function podRing(s: PodStation, n = RING_N): Ring {
  return filletPolygon(
    [
      { a: s.zIn, b: s.yTopIn, r: 0.01 },
      { a: s.zOut, b: s.yTopOut, r: s.rTop },
      { a: s.zOutBot ?? s.zOut, b: s.yBotOut, r: s.rBot },
      { a: s.zIn, b: s.yBotIn, r: 0.01 },
    ],
    (z, y) => V(s.x, y, z),
    n
  );
}

/** Rounded-triangle ring (airbox) in the YZ plane: apex at the top. */
export function triRing(x: number, apexY: number, baseY: number, hw: number, r: number, n = RING_N): Ring {
  return filletPolygon(
    [
      { a: -hw * 0.25, b: apexY, r },
      { a: hw * 0.25, b: apexY, r },
      { a: hw, b: baseY, r: r * 1.4 },
      { a: -hw, b: baseY, r: r * 1.4 },
    ],
    (z, y) => V(x, y, z),
    n
  );
}

/** Thin rounded-rectangle ring in the YZ plane (plates lofted along x, e.g. endplates). */
export function plateRing(x: number, z: number, yBot: number, yTop: number, t: number, n = RING_N): Ring {
  return filletPolygon(
    [
      { a: z - t / 2, b: yTop, r: t * 0.45 },
      { a: z + t / 2, b: yTop, r: t * 0.45 },
      { a: z + t / 2, b: yBot, r: t * 0.45 },
      { a: z - t / 2, b: yBot, r: t * 0.45 },
    ],
    (zz, y) => V(x, y, zz),
    n
  );
}

/** Rounded rectangle in the XZ plane at height y (pylons lofted vertically). */
export function ringXZ(y: number, cx: number, cz: number, hx: number, hz: number, r: number, n = RING_N): Ring {
  return filletPolygon(
    [
      { a: cx - hx, b: cz - hz, r },
      { a: cx + hx, b: cz - hz, r },
      { a: cx + hx, b: cz + hz, r },
      { a: cx - hx, b: cz + hz, r },
    ],
    (x, z) => V(x, y, z),
    n
  );
}

const HALF = 22;
/** Points per airfoil ring; every wing station must share it. */
export const AIRFOIL_N = HALF * 2 - 2;

/**
 * Inverted (downforce) airfoil in the XY plane at span station `z`.
 * Leading edge at (x0, y0), chord runs toward -X. Positive `aoa` lowers the trailing edge.
 */
export function airfoilXY(z: number, x0: number, y0: number, chord: number, aoa: number, thick = 0.11, camber = 0.05): Ring {
  const yt = (u: number) => 5 * thick * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);
  const yc = (u: number) => -camber * 4 * u * (1 - u);
  const local: [number, number][] = [];
  for (let i = 0; i < HALF; i++) {
    const u = 0.5 * (1 - Math.cos((Math.PI * i) / (HALF - 1)));
    local.push([-u, yc(u) + yt(u)]);
  }
  for (let i = HALF - 2; i >= 1; i--) {
    const u = 0.5 * (1 - Math.cos((Math.PI * i) / (HALF - 1)));
    local.push([-u, yc(u) - yt(u)]);
  }
  const ca = Math.cos(aoa);
  const sa = Math.sin(aoa);
  return local.map(([lx, ly]) => {
    const px = lx * chord;
    const py = ly * chord;
    return V(x0 + px * ca - py * sa, y0 + px * sa + py * ca, z);
  });
}

/** Skins a series of rings (all the same length) into one smooth surface, with optional flat caps. */
export function loft(rings: Ring[], caps: { start?: boolean; end?: boolean } = {}): THREE.BufferGeometry {
  const n = rings[0].length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  rings.forEach((r, i) => {
    r.forEach((p, j) => {
      pos.push(p.x, p.y, p.z);
      uv.push(j / n, i / (rings.length - 1));
    });
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      const c = (i + 1) * n + j;
      const d = (i + 1) * n + ((j + 1) % n);
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ring: Ring, flip: boolean) => {
    const centre = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / n);
    const base = pos.length / 3;
    pos.push(centre.x, centre.y, centre.z);
    uv.push(0.5, 0.5);
    ring.forEach((p, j) => {
      pos.push(p.x, p.y, p.z);
      uv.push(0.5 + 0.5 * Math.cos((j / n) * Math.PI * 2), 0.5 + 0.5 * Math.sin((j / n) * Math.PI * 2));
    });
    for (let j = 0; j < n; j++) {
      const a = base + 1 + j;
      const b = base + 1 + ((j + 1) % n);
      if (flip) idx.push(base, b, a);
      else idx.push(base, a, b);
    }
  };
  if (caps.start) cap(rings[0], false);
  if (caps.end) cap(rings[rings.length - 1], true);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Smoothly interpolates between a sparse list of stations so lofts get enough rings. */
export function densify<T extends { x: number }>(stations: T[], perGap = 3): T[] {
  const keys = Object.keys(stations[0]) as (keyof T)[];
  const out: T[] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    const p = stations[Math.max(0, i - 1)];
    const q = stations[Math.min(stations.length - 1, i + 2)];
    for (let s = 0; s < perGap; s++) {
      const t = s / perGap;
      const o = {} as T;
      for (const k of keys) {
        const va = a[k] as unknown as number;
        const vb = b[k] as unknown as number;
        if (typeof va !== 'number' || typeof vb !== 'number') {
          (o as Record<string, unknown>)[k as string] = a[k];
          continue;
        }
        // Catmull-Rom so the skin has no creases at the control stations.
        const vp = (p[k] as unknown as number) ?? va;
        const vq = (q[k] as unknown as number) ?? vb;
        const t2 = t * t;
        const t3 = t2 * t;
        (o as Record<string, unknown>)[k as string] =
          0.5 * (2 * va + (-vp + vb) * t + (2 * vp - 5 * va + 4 * vb - vq) * t2 + (-vp + 3 * va - 3 * vb + vq) * t3);
      }
      out.push(o);
    }
  }
  out.push(stations[stations.length - 1]);
  return out;
}

/** A tube between two points: returns the transform for a unit-length box or cylinder along +Z. */
export function strut(a: THREE.Vector3, b: THREE.Vector3) {
  const dir = b.clone().sub(a);
  const length = dir.length();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), dir.normalize());
  const position = a.clone().add(b).multiplyScalar(0.5);
  return { position, quaternion, length };
}

/** Lathe profile for a slick tyre: crowned tread, rounded shoulders, bulged sidewalls. Revolve axis Y. */
export function tyreProfile(radius: number, width: number, rim: number): THREE.Vector2[] {
  const w = width / 2;
  const pts: THREE.Vector2[] = [];
  // inner sidewall: from the rim bead outward
  pts.push(new THREE.Vector2(rim, -w + 0.03));
  pts.push(new THREE.Vector2(rim + 0.03, -w + 0.012));
  pts.push(new THREE.Vector2(radius - 0.12, -w));
  pts.push(new THREE.Vector2(radius - 0.05, -w + 0.004));
  pts.push(new THREE.Vector2(radius - 0.018, -w + 0.02));
  pts.push(new THREE.Vector2(radius - 0.005, -w + 0.045));
  // tread, slightly crowned
  const treadN = 6;
  for (let i = 0; i <= treadN; i++) {
    const t = i / treadN;
    const z = -w + 0.06 + (width - 0.12) * t;
    pts.push(new THREE.Vector2(radius + 0.004 * Math.sin(Math.PI * t), z));
  }
  pts.push(new THREE.Vector2(radius - 0.005, w - 0.045));
  pts.push(new THREE.Vector2(radius - 0.018, w - 0.02));
  pts.push(new THREE.Vector2(radius - 0.05, w - 0.004));
  pts.push(new THREE.Vector2(radius - 0.12, w));
  pts.push(new THREE.Vector2(rim + 0.03, w - 0.012));
  pts.push(new THREE.Vector2(rim, w - 0.03));
  return pts;
}

/** Aero wheel cover: flat disc with a shallow dish and a raised hub, sitting just inside the tyre face. */
export function wheelCoverProfile(rim: number, width: number): THREE.Vector2[] {
  const face = width / 2 - 0.018;
  return [
    new THREE.Vector2(0.0, face - 0.008),
    new THREE.Vector2(0.045, face - 0.008),
    new THREE.Vector2(0.058, face - 0.02),
    new THREE.Vector2(0.15, face - 0.024),
    new THREE.Vector2(rim - 0.014, face - 0.01),
    new THREE.Vector2(rim, face - 0.004),
    new THREE.Vector2(rim, -face),
    new THREE.Vector2(rim - 0.03, -face),
  ].reverse();
}

export function plateShape(points: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

/** Extruded plate with a small bevel so edges catch light. */
export function plate(points: [number, number][], depth: number, bevel = 0.003): THREE.ExtrudeGeometry {
  return new THREE.ExtrudeGeometry(plateShape(points), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
  });
}
