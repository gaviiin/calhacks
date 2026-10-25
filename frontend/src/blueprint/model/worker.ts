import { buildCar, transferables } from './build';

// Builds the car off the main thread so the page never stalls while ~200k triangles are generated.

const ctx = self as unknown as Worker;

ctx.onmessage = () => {
  try {
    const car = buildCar();
    ctx.postMessage({ ok: true, car }, transferables(car));
  } catch (e) {
    ctx.postMessage({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
};
