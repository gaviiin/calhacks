import { useEffect, useRef, useState } from 'react';

/** True when the person asked the OS for less motion; every animation here checks it. */
export function useReducedMotion(): boolean {
  const [reduce, set] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => set(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduce;
}

/** Eases a number toward its target over `ms`, so figures count instead of jumping. */
export function useTween(target: number, ms = 700): number {
  const reduce = useReducedMotion();
  const [value, set] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduce || !Number.isFinite(target)) {
      from.current = target;
      set(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const u = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - u, 3);
      const v = a + (target - a) * e;
      set(v);
      if (u < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduce]);
  return value;
}

/** Element width from a ResizeObserver, for charts that fill their panel. */
export function useWidth<T extends HTMLElement>(fallback = 760, min = 320): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(min, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w];
}
