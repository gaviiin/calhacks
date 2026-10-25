import { useEffect, useRef } from 'react';
import { RAIL } from '../../data/story';
import { sceneState } from '../../three/state';
import { teardownStatus } from '../../three/car/explode';

export function SiteNav() {
  return (
    <nav className="site-nav" aria-label="Main navigation">
      <a className="brand" href="#start" aria-label="Pit Wall home">
        <span className="brandmark" aria-hidden="true">
          PW
        </span>
        <span>
          <span className="brandword">
            PIT<span>/</span>WALL
          </span>
          <small>RACE FINANCE INTELLIGENCE</small>
        </span>
      </a>
      <div className="nav-mid">
        <a href="#problem">THE PROBLEM</a>
        <a href="#reason">THE SYSTEM</a>
        <a href="#dashboard">THE PRODUCT</a>
      </div>
      <a className="nav-cta" href="#dashboard">
        TRY THE INCIDENT <span aria-hidden="true">↗</span>
      </a>
    </nav>
  );
}

export function ChapterRail({ active }: { active: number }) {
  return (
    // The console needs the full width; the rail steps aside once the product is reached.
    <nav className={`chapter-rail${active === RAIL.length - 1 ? ' chapter-rail--done' : ''}`} aria-label="Story progress">
      {RAIL.map((r, i) => (
        <a key={r.id} className={`rail-item${i === active ? ' active' : ''}${i < active ? ' done' : ''}`} href={`#${r.id}`} aria-label={`Chapter ${r.number}: ${r.label}`} aria-current={i === active ? 'step' : undefined}>
          <span>{r.number}</span>
          <i />
          <em>{r.label}</em>
        </a>
      ))}
    </nav>
  );
}

/** Live readouts from the scene state, written straight to the DOM every frame. */
export function Telemetry() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cells = el.querySelectorAll<HTMLElement>('b');
    let raf = 0;
    let last = 0;
    let lastFactor = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 80) return;
      last = t;
      const s = sceneState;
      const td = teardownStatus();
      const falling = td.factor < lastFactor - 0.002;
      lastFactor = td.factor;
      cells[0].textContent = `${s.fov.toFixed(1)}°`;
      cells[1].textContent = `${Math.hypot(s.camX - s.lookX, s.camY - s.lookY, s.camZ - s.lookZ).toFixed(2)} M`;
      cells[2].textContent = td.detached ? `${td.detached} ${td.detached === 1 ? 'PART' : 'PARTS'} OUT` : 'COMPLETE';
      cells[3].textContent = td.factor > 0.03 ? (falling ? 'REASSEMBLY' : 'TEARDOWN') : s.xray > 0.5 ? 'DIAGNOSTIC' : s.streams > 0.5 ? 'INGEST' : s.audit > 0.5 ? 'AUDIT' : 'NOMINAL';
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="telemetry" ref={ref} aria-hidden="true">
      <div>
        <small>LENS</small>
        <b>24.0°</b>
      </div>
      <div>
        <small>RANGE</small>
        <b>10.8 M</b>
      </div>
      <div>
        <small>ASSEMBLY</small>
        <b>COMPLETE</b>
      </div>
      <div>
        <small>MODE</small>
        <b>NOMINAL</b>
      </div>
    </div>
  );
}
