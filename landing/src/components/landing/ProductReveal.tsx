import { useLayoutEffect, useRef, type ReactNode } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const STATIONS = [
  { id: 'capture', n: '01', label: 'CAPTURE', from: [-0.1, -0.08] },
  { id: 'ingest', n: '02', label: 'INGEST', from: [0.04, -0.2] },
  { id: 'reason', n: '03', label: 'REASON', from: [0.18, -0.16] },
  { id: 'control', n: '04', label: 'CONTROL', from: [0.32, -0.02] },
];

/**
 * The product reveal: the sticky stage pins for one viewport while the four
 * engineering stations fly off the car into the console's workspace list, the
 * console boots in behind a clip-path wipe, and the boot log types itself.
 */
export default function ProductReveal({ children, reduceMotion }: { children: ReactNode; reduceMotion: boolean }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const chips = Array.from(el.querySelectorAll<HTMLElement>('.station-chip'));
    const targets = Array.from(el.querySelectorAll<HTMLElement>('.console-side [data-station]'));
    const console_ = el.querySelector<HTMLElement>('.console');
    const boot = Array.from(el.querySelectorAll<HTMLElement>('.boot-line'));
    if (!console_) return;

    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const ctx = gsap.context(() => {
      if (reduceMotion || mobile) {
        gsap.set(chips, { autoAlpha: 0 });
        gsap.set(console_, { clipPath: 'inset(0% 0% 0% 0%)', autoAlpha: 1 });
        gsap.set(boot, { autoAlpha: 1 });
        return;
      }
      const tl = gsap.timeline({
        defaults: { ease: 'power3.inOut' },
        scrollTrigger: { trigger: el, start: 'top top', end: '+=110%', scrub: 0.6, pin: true, anticipatePin: 1, invalidateOnRefresh: true },
      });
      tl.set(console_, { clipPath: 'inset(50% 0% 50% 0%)', autoAlpha: 1 }, 0);
      chips.forEach((chip, i) => {
        const t = targets[i];
        tl.fromTo(
          chip,
          { xPercent: -50, yPercent: -50, autoAlpha: 1, scale: 1 },
          {
            x: () => {
              const r = t.getBoundingClientRect();
              const c = el.getBoundingClientRect();
              return r.left - c.left + 18 - chip.offsetLeft;
            },
            y: () => {
              const r = t.getBoundingClientRect();
              const c = el.getBoundingClientRect();
              return r.top - c.top + r.height / 2 - chip.offsetTop;
            },
            xPercent: 0,
            yPercent: -50,
            scale: 0.72,
            autoAlpha: 0,
            duration: 0.5,
          },
          0.08 + i * 0.05
        );
      });
      tl.to(console_, { clipPath: 'inset(0% 0% 0% 0%)', duration: 0.5 }, 0.25);
      tl.fromTo(targets, { opacity: 0.25, x: -8 }, { opacity: 1, x: 0, duration: 0.18, stagger: 0.06 }, 0.42);
      tl.fromTo(boot, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: 0.12, stagger: 0.07 }, 0.55);
    }, el);
    return () => ctx.revert();
  }, [reduceMotion]);

  return (
    <div className="product-reveal" ref={root}>
      <div className="station-chips" aria-hidden="true">
        {STATIONS.map(s => (
          <div key={s.id} className="station-chip" style={{ left: `${50 + s.from[0] * 100}%`, top: `${50 + s.from[1] * 100}%` }}>
            <span>{s.n}</span>
            {s.label}
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}
