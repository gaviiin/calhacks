import type { BuiltCar } from './model/build';

// The car is built once per page load, in a worker, and shared by every blueprint on the page.

let pending: Promise<BuiltCar> | null = null;

export function loadCar(): Promise<BuiltCar> {
  if (!pending) {
    pending = new Promise<BuiltCar>((resolve, reject) => {
      const w = new Worker(new URL('./model/worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ ok: true; car: BuiltCar } | { ok: false; error: string }>) => {
        w.terminate();
        if (e.data.ok) resolve(e.data.car);
        else reject(new Error(e.data.error));
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || 'the blueprint worker failed'));
      };
      w.postMessage(null);
    }).catch((e) => {
      pending = null;
      throw e;
    });
  }
  return pending;
}

export function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}
