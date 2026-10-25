import * as THREE from 'three';
import { AIRBOX_STATIONS, BODY_STATIONS } from './buildCar';

// Fits an internal mesh inside the rear bodywork. Every vertex keeps its position along
// the car (x) and its normalised height / lateral position, which are re-mapped into the
// hull's cross-section at that x: body ring (filleted box) ∪ the lower 60 % of the
// engine-cover triangle. Shapes stay recognisable; nothing can poke through the shell.

const MARGIN = 0.022;
const FLOOR = 0.135;

function lerpStation<T extends { x: number }>(stations: T[], x: number): T | null {
  // Stations run nose → tail (x descending).
  if (x > stations[0].x || x < stations[stations.length - 1].x) return null;
  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    if (x <= a.x && x >= b.x) {
      const t = (a.x - x) / Math.max(1e-6, a.x - b.x);
      const o = {} as Record<string, number>;
      for (const k of Object.keys(a) as (keyof T)[]) o[k as string] = (a[k] as number) + ((b[k] as number) - (a[k] as number)) * t;
      return o as unknown as T;
    }
  }
  return null;
}

/** Vertical range of the hull at x, with margins. */
function range(x: number) {
  const b = lerpStation(BODY_STATIONS, x);
  if (!b) return null;
  const a = lerpStation(AIRBOX_STATIONS, x);
  const bot = Math.max(b.bot + 0.03, FLOOR);
  let top = b.top - MARGIN;
  if (a) top = Math.max(top, a.base + 0.6 * (a.apex - a.base) - MARGIN);
  return { bot, top, b, a };
}

/** Half-width of the hull at (x, y): body ring with its fillets, widened by the engine-cover triangle. */
function halfWidth(y: number, r: NonNullable<ReturnType<typeof range>>) {
  const { b, a } = r;
  const top = b.top - MARGIN;
  const bot = b.bot;
  const hwTop = b.hwTop - MARGIN;
  const hwBot = b.hwBot - MARGIN;
  let w = 0;
  if (y >= bot && y <= top) {
    const t = (y - bot) / Math.max(1e-6, top - bot);
    w = hwBot + (hwTop - hwBot) * t;
    const rt = b.rt;
    if (y > top - rt) {
      const dy = y - (top - rt);
      w = Math.min(w, hwTop - rt + Math.sqrt(Math.max(0, rt * rt - dy * dy)));
    }
    const rb = b.rb;
    if (y < bot + rb) {
      const dy = bot + rb - y;
      w = Math.min(w, hwBot - rb + Math.sqrt(Math.max(0, rb * rb - dy * dy)));
    }
  }
  if (a && y >= a.base && y <= a.apex) {
    const t = (y - a.base) / Math.max(1e-6, a.apex - a.base);
    w = Math.max(w, a.hw * (1 - 0.75 * t) - MARGIN);
  }
  return Math.max(0.01, w);
}

/**
 * Bakes `matrix` into a float copy of the geometry, then remaps it into the hull between
 * `xFront` and `xRear`. Returns the new geometry (normals recomputed).
 */
export function fitGeometryToBody(source: THREE.BufferGeometry, matrix: THREE.Matrix4, bounds: THREE.Box3, xFront: number, xRear: number) {
  const src = source.attributes.position;
  const n = src.count;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const size = bounds.getSize(new THREE.Vector3());
  const zc = (bounds.min.z + bounds.max.z) / 2;
  for (let i = 0; i < n; i++) {
    v.set(src.getX(i), src.getY(i), src.getZ(i)).applyMatrix4(matrix);
    const nx = (v.x - bounds.min.x) / Math.max(1e-6, size.x);
    const ny = (v.y - bounds.min.y) / Math.max(1e-6, size.y);
    const nz = (v.z - zc) / Math.max(1e-6, size.z / 2);
    const x = xRear + nx * (xFront - xRear);
    const r = range(x);
    if (r) {
      const y = r.bot + ny * (r.top - r.bot);
      v.set(x, y, nz * halfWidth(y, r) * 0.97);
    }
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (source.index) g.setIndex(source.index.clone());
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
