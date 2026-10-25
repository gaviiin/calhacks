import { HeroOverlay } from './hero/overlay';
import { CrashScene, loadCar } from './hero/scene';
import { clamp } from './hero/timeline';
import { initCapSim } from './sections/capsim';
import { initFeatures } from './sections/features';
import { initFlow } from './sections/flow';
import { initLearner } from './sections/learner';
import { initStack } from './sections/stack';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector<T>(s)!;

// ------------------------------------------------------------------ the opening

function hasWebGL2() {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function initHero() {
  const hero = $('#hero');
  const pin = hero.querySelector<HTMLElement>('.hero-pin')!;
  const canvas = $<HTMLCanvasElement>('#crash');
  const overlay = new HeroOverlay(pin);
  let scene: CrashScene | null = null;

  const progress = () => {
    const r = hero.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - innerHeight));
  };
  let target = progress();
  let p = target;
  Object.defineProperty(window, '__heroP', { get: () => p });
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { rootMargin: '100px' }).observe(hero);
  addEventListener('scroll', () => (target = progress()), { passive: true });

  const size = () => {
    const w = pin.clientWidth;
    const h = pin.clientHeight;
    scene?.resize(w, h);
    pin.querySelector('.tag-lines')!.setAttribute('viewBox', `0 0 ${w} ${h}`);
  };
  addEventListener('resize', () => {
    size();
    target = progress();
  });

  let last = performance.now();
  let frame: ReturnType<CrashScene['render']> | null = null;
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible) return;
    // ease toward the scroll position so a flick of the wheel reads as motion, not a jump
    p += (target - p) * (reduced ? 1 : 1 - Math.exp(-dt * 9));
    if (Math.abs(target - p) < 1e-5) p = target;
    const narrow = pin.clientWidth < 760;
    if (scene) frame = scene.render(p, now / 1000, dt);
    overlay.update(p, frame, narrow);
  };
  requestAnimationFrame(tick);

  if (!hasWebGL2()) {
    pin.querySelector<HTMLElement>('.nogl')!.hidden = false;
    return;
  }
  try {
    const parts = await loadCar();
    scene = new CrashScene(canvas, parts);
    size();
    canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
  } catch (e) {
    console.error(e);
    pin.querySelector<HTMLElement>('.nogl')!.hidden = false;
  }
}

// ------------------------------------------------------------------ one crash, step by step

const HITS: [string, number, string][] = [
  ['Floor and diffuser', 0.9, '279,400'],
  ['Front wing', 0.9, '127,000'],
  ['Front suspension corner', 0.9, '82,550'],
  ['Bodywork panels', 0.9, '44,450'],
  ['Gearbox', 0.8, '495,300'],
  ['Rear wing', 0.7, '82,550'],
  ['Rear suspension corner', 0.7, '82,550'],
  ['Survival cell (new)', 0.6, '1,079,500'],
  ['Loom and sensors', 0.6, '44,450'],
  ['Power unit elements', 0.35, '571,500'],
];

function initMethod() {
  $('[data-hits]').innerHTML = HITS.map(
    ([name, p, mid]) => `<tr><td>${name}</td><td><span class="pbar"><span><i style="--p:${p}"></i></span><b>${p.toFixed(2)}</b></span></td><td class="num">$${mid}</td></tr>`,
  ).join('');
  const steps = [...document.querySelectorAll<HTMLElement>('.steps li')];
  const panels = [...document.querySelectorAll<HTMLElement>('.panel')];
  const setActive = (i: number) => {
    steps.forEach((s, j) => {
      s.classList.toggle('on', j === i);
      s.classList.toggle('done', j < i);
    });
    panels.forEach((pn, j) => pn.classList.toggle('on', j === i));
    const active = steps[i];
    const strip = active.parentElement!;
    if (strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: active.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' });
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(panels.indexOf(e.target as HTMLElement));
    },
    { rootMargin: '-45% 0px -45% 0px' },
  );
  panels.forEach((pn) => io.observe(pn));
  steps.forEach((s, i) => s.addEventListener('click', () => panels[i].scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })));
  setActive(0);
}

// ------------------------------------------------------------------ small things

function initCounters() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-count]')];
  if (reduced) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const el = e.target as HTMLElement;
        const to = +el.dataset.count!;
        const t0 = performance.now();
        const step = (now: number) => {
          const u = Math.min(1, (now - t0) / 1200);
          const v = Math.round(to * (1 - Math.pow(2, -10 * u)));
          el.textContent = (u >= 1 ? to : v).toLocaleString('en-US');
          if (u < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    },
    { threshold: 0.6 },
  );
  els.forEach((el) => io.observe(el));
}

function initNav() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav nav a')];
  const map = new Map(links.map((a) => [a.getAttribute('href')!.slice(1), a]));
  const learnerFeat = new Set(['features', 'learner', 'cap', 'system']);
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const id = learnerFeat.has(e.target.id) ? 'features' : e.target.id === 'different' ? 'tracks' : e.target.id;
        links.forEach((a) => a.removeAttribute('aria-current'));
        map.get(id)?.setAttribute('aria-current', 'true');
      }
    },
    { rootMargin: '-40% 0px -55% 0px' },
  );
  document.querySelectorAll('main > section').forEach((s) => io.observe(s));
}

function initTracks() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-track]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-track-panel]')];
  const pick = (id: string, focus = false) => {
    tabs.forEach((t) => {
      const on = t.dataset.track === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    panels.forEach((pn) => (pn.hidden = pn.dataset.trackPanel !== id));
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => pick(t.dataset.track!));
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        pick(tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].dataset.track!, true);
      }
    });
  });
  pick('hyphenate');
}

function initReveal() {
  if (reduced || !('IntersectionObserver' in window)) return;
  const targets = document.querySelectorAll<HTMLElement>(
    '.section .display, .section .sub, .rc, .lanes, .mod, .acc, .tower, .services, .screen, .feat, .learn, .capfc, .flow, .track-grid, .compare-wrap, .unique, .stack-list, .tests, .close-inner > *',
  );
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  targets.forEach((t) => {
    if (t.getBoundingClientRect().top > innerHeight) {
      t.classList.add('reveal');
      io.observe(t);
    }
  });
}

initHero();
initMethod();
initFeatures($('[data-feat]'));
initLearner($('#learner'));
initCapSim($('#cap'));
initFlow($('[data-flow]'), reduced);
initTracks();
initStack($('#stack'));
initCounters();
initNav();
initReveal();
