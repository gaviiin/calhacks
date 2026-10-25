import { PARTS } from '../catalog';
import { buildCarShapes } from './car';
import { buildPartMesh, type PartMesh } from './mesh';

// Builds every drawn part, in catalog order. Runs in the model worker (worker.ts).

export interface BuiltCar {
  parts: PartMesh[];
  ms: number;
}

export function buildCar(): BuiltCar {
  const t0 = performance.now();
  const shapes = buildCarShapes();
  const parts = PARTS.map((p) => {
    const s = shapes[p.id];
    if (!s) throw new Error(`blueprint: no shape for part ${p.id}`);
    return buildPartMesh(s);
  });
  return { parts, ms: performance.now() - t0 };
}

/** Every buffer in the built car, for a zero-copy postMessage. */
export function transferables(car: BuiltCar): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const p of car.parts) {
    for (const a of [p.pos, p.nrm, p.idx, p.iso, p.edges, p.sil.x, p.sil.y, p.sil.z, p.pickPos, p.pickIdx]) out.push(a.buffer as ArrayBuffer);
  }
  return out;
}
