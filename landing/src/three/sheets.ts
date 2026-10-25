import * as THREE from 'three';
import { CAR_ASSETS } from './assets';
import { LIVERIES, type LiveryKey } from './state';

// Generated livery sheets (side + top projections) per livery. Loaded once after
// first paint, kept resident, bound to the paint shader by the Rig each frame.

export type SheetSet = { side: THREE.Texture; top: THREE.Texture };

const ready = new Map<LiveryKey, SheetSet>();
const pending = new Map<LiveryKey, Promise<SheetSet | null>>();
const loader = new THREE.TextureLoader();

/** Transparent placeholder for a projection that has no file yet (alpha 0 → base paint shows). */
const EMPTY = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
EMPTY.needsUpdate = true;

function texture(url: string, maxAniso: number) {
  return loader.loadAsync(url).then(t => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    return t;
  });
}

/** Resolved sheets for a livery, or null until loaded (the shader falls back to the procedural zones). */
export function getSheets(key: LiveryKey): SheetSet | null {
  return ready.get(key) ?? null;
}

export function loadSheets(key: LiveryKey, mobile: boolean, maxAniso = 8): Promise<SheetSet | null> {
  if (!LIVERIES[key].sheets) return Promise.resolve(null);
  const have = pending.get(key);
  if (have) return have;
  const base = CAR_ASSETS.liveries[key] ?? `/liveries/${key}`;
  const suffix = mobile ? '@1k' : '';
  const optional = (url: string) => texture(url, maxAniso).catch(() => null);
  const p = Promise.all([optional(`${base}/side${suffix}.webp`), optional(`${base}/top${suffix}.webp`)]).then(([side, top]) => {
    if (!side && !top) {
      console.warn(`[livery] no sheets found for "${key}" under ${base}`);
      return null;
    }
    const set = { side: side ?? EMPTY, top: top ?? EMPTY };
    ready.set(key, set);
    return set;
  });
  pending.set(key, p);
  return p;
}

/** Loads the liveries in scroll order so the first scenes are ready soonest. */
export function preloadSheets(keys: LiveryKey[], mobile: boolean, maxAniso: number) {
  const unique = [...new Set(keys)];
  return unique.reduce<Promise<unknown>>((chain, key) => chain.then(() => loadSheets(key, mobile, maxAniso)), Promise.resolve());
}
