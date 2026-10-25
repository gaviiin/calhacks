import { buildCarShapes } from './car';
import { PARTS } from './catalog';
import { buildPartMesh, type PartMesh } from './mesh';

// The dashboard's blueprint car (frontend/src/blueprint/model), built off the main thread.
// Only what the pitch page draws travels back: triangles for the paper fill, edges and construction lines.

export interface WirePart {
  id: string;
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  edges: Float32Array;
  iso: Float32Array;
  bounds: PartMesh['bounds'];
}

const ctx = self as unknown as Worker;

ctx.onmessage = () => {
  try {
    const shapes = buildCarShapes();
    const parts: WirePart[] = PARTS.map((p) => {
      const m = buildPartMesh(shapes[p.id]);
      return { id: p.id, pos: m.pos, nrm: m.nrm, idx: m.idx, edges: m.edges, iso: m.iso, bounds: m.bounds };
    });
    const buffers = parts.flatMap((p) => [p.pos.buffer, p.nrm.buffer, p.idx.buffer, p.edges.buffer, p.iso.buffer] as ArrayBuffer[]);
    ctx.postMessage({ ok: true, parts }, buffers);
  } catch (e) {
    ctx.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
