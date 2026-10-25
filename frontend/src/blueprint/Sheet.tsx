import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BlueprintEngine, type OrthoId, type PartTone, type V3, type ViewId } from './engine/engine';
import { DIM } from './model/car';
import { loadCar } from './load';

// The drawing sheet: the angled hero view on top, the four rigid views below, one WebGL canvas under
// all of them (the engine). Everything readable on the sheet (titles, dimensions, the callout) is HTML
// and SVG laid over the canvas, positioned from the engine's projections.

export interface SheetProps {
  tones: PartTone[];
  /** parts lit from outside the canvas (a hovered row of the parts list) */
  highlight: string[];
  /** whether lit parts also pull out (default true) */
  highlightPull?: boolean;
  /** pinned parts */
  pinned: string[];
  exploded: boolean;
  /** the part the callout points at */
  active: string | null;
  /** a part under the pointer in any view, or null */
  onHover: (id: string | null) => void;
  /** a click in any view: the part under it, or null for empty paper */
  onPick: (id: string | null) => void;
  /** the engine, for the rare outside call (reset the view) */
  engineRef?: React.MutableRefObject<BlueprintEngine | null>;
  callout: (id: string) => ReactNode;
  heroTitle: ReactNode;
  heroCorner?: ReactNode;
  titleBlock?: ReactNode;
  /** 'compact': the hero with one strip of small drawings under it */
  variant?: 'full' | 'compact';
  /** buttons pinned to points on the car (sponsor zones), following the part they sit on */
  markers?: SheetMarker[];
  onMarker?: (id: string) => void;
  onMarkerHover?: (id: string | null) => void;
  onReady?: () => void;
  onError?: (e: Error) => void;
}

export interface SheetMarker {
  id: string;
  /** the part it rides on */
  part: string;
  /** car-space point at rest */
  at: V3;
  label: string;
  on: boolean;
  /** a lime ring: this zone is paying */
  live: boolean;
}

const VIEW_TITLES: Record<OrthoId, { letter: string; name: string }> = {
  side: { letter: 'A', name: 'Side elevation' },
  front: { letter: 'B', name: 'Front' },
  rear: { letter: 'C', name: 'Rear' },
  bottom: { letter: 'D', name: 'Underside' },
};

function useReducedMotion(): boolean {
  const [r, setR] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}

// ------------------------------------------------------------------------------------------ dimensions

interface Dim {
  a: V3;
  b: V3;
  /** offset of the dimension line from the measured points, CSS px, along the screen normal */
  off: number;
  label?: string;
}

interface Centre {
  a: V3;
  b: V3;
}

const W = DIM.width / 2;
type DimSpec = Record<OrthoId, { dims: Dim[]; centres: Centre[]; ground?: [V3, V3] }>;
const DIMS: DimSpec = {
  side: {
    dims: [
      { a: [DIM.noseTip, 0, W], b: [DIM.tail, 0, W], off: 34 },
      { a: [DIM.frontAxle, 0, W], b: [DIM.rearAxle, 0, W], off: 16 },
      { a: [DIM.tail, 0, W], b: [DIM.tail, DIM.height, W], off: 16 },
    ],
    centres: [
      { a: [DIM.frontAxle, -0.06, W], b: [DIM.frontAxle, 0.78, W] },
      { a: [DIM.rearAxle, -0.06, W], b: [DIM.rearAxle, 0.78, W] },
    ],
    ground: [
      [DIM.noseTip + 0.12, 0, W],
      [DIM.tail - 0.12, 0, W],
    ],
  },
  front: {
    dims: [
      { a: [2, 0, W], b: [2, 0, -W], off: 30, label: 'width' },
      { a: [2, 0, DIM.front.z], b: [2, 0, -DIM.front.z], off: 14 },
      { a: [2, 0, -W], b: [2, DIM.height, -W], off: 14 },
    ],
    centres: [{ a: [2, -0.05, 0], b: [2, 1.02, 0] }],
    ground: [
      [2, 0, W + 0.1],
      [2, 0, -W - 0.1],
    ],
  },
  rear: {
    dims: [
      { a: [-3, 0, -DIM.rear.z], b: [-3, 0, DIM.rear.z], off: 14 },
      { a: [-3, 0, -W], b: [-3, 0, W], off: 30 },
      { a: [-3, 0.97, -0.517], b: [-3, 0.97, 0.517], off: -12 },
    ],
    centres: [{ a: [-3, -0.05, 0], b: [-3, 1.02, 0] }],
    ground: [
      [-3, 0, -W - 0.1],
      [-3, 0, W + 0.1],
    ],
  },
  bottom: {
    dims: [
      { a: [DIM.noseTip, 0, -W], b: [DIM.tail, 0, -W], off: 30 },
      { a: [DIM.frontAxle, 0, -W], b: [DIM.rearAxle, 0, -W], off: 14 },
      { a: [DIM.tail, 0, -0.862], b: [DIM.tail, 0, 0.862], off: 14, label: 'floor' },
    ],
    centres: [
      { a: [DIM.noseTip + 0.1, 0, 0], b: [DIM.tail - 0.1, 0, 0] },
      { a: [DIM.frontAxle, 0, -1.02], b: [DIM.frontAxle, 0, 1.02] },
      { a: [DIM.rearAxle, 0, -1.02], b: [DIM.rearAxle, 0, 1.02] },
    ],
  },
};

/** Small drawings carry one dimension each: the car's length, or its width. */
const DIMS_COMPACT: DimSpec = {
  side: { ...DIMS.side, dims: [{ a: [DIM.noseTip, 0, W], b: [DIM.tail, 0, W], off: 14 }] },
  front: { ...DIMS.front, dims: [{ a: [2, 0, W], b: [2, 0, -W], off: 14 }] },
  rear: { ...DIMS.rear, dims: [{ a: [-3, 0, -W], b: [-3, 0, W], off: 14 }] },
  bottom: { ...DIMS.bottom, dims: [{ a: [DIM.noseTip, 0, -W], b: [DIM.tail, 0, -W], off: 14 }] },
};

interface DimDraw {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  nx: number;
  ny: number;
  text: string;
  angle: number;
}

interface ViewDraw {
  dims: DimDraw[];
  centres: { x1: number; y1: number; x2: number; y2: number }[];
  ground: { x1: number; y1: number; x2: number; y2: number } | null;
  scale: number;
}

function drawFor(engine: BlueprintEngine, id: OrthoId, compact: boolean): ViewDraw {
  const spec = (compact ? DIMS_COMPACT : DIMS)[id];
  const proj = (p: V3) => engine.project(id, p);
  const dims: DimDraw[] = spec.dims.map((d) => {
    const a = proj(d.a);
    const b = proj(d.b);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    // the normal points away from the car: down for horizontal dimensions, outward for vertical ones
    let nx = -dy / L;
    let ny = dx / L;
    if (Math.abs(ny) > Math.abs(nx) ? ny < 0 : nx * (a.x - engine.project(id, [0, 0.4, 0]).x) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const len = Math.hypot(d.a[0] - d.b[0], d.a[1] - d.b[1], d.a[2] - d.b[2]);
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    return {
      ax: a.x,
      ay: a.y,
      bx: b.x,
      by: b.y,
      x1: a.x + nx * d.off,
      y1: a.y + ny * d.off,
      x2: b.x + nx * d.off,
      y2: b.y + ny * d.off,
      nx,
      ny,
      text: Math.round(len * 1000)
        .toLocaleString('en-US')
        .replace(/,/g, ' '),
      angle: angle > 90 || angle < -90 ? angle + 180 : angle,
    };
  });
  const centres = spec.centres.map((c) => {
    const a = proj(c.a);
    const b = proj(c.b);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  });
  let ground: ViewDraw['ground'] = null;
  if (spec.ground) {
    const a = proj(spec.ground[0]);
    const b = proj(spec.ground[1]);
    ground = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
  // drawing scale at 96 dpi: one CSS px is 0.2646 mm on paper
  const m = engine.scaleOf(id);
  return { dims, centres, ground, scale: m > 0 ? Math.round((m * 1000) / 0.2646) : 0 };
}

function Dimensions({ draw }: { draw: ViewDraw | null }) {
  if (!draw) return null;
  return (
    <svg className="bp-dims" aria-hidden="true">
      {draw.ground && <line className="bp-ground" x1={draw.ground.x1} y1={draw.ground.y1} x2={draw.ground.x2} y2={draw.ground.y2} />}
      {draw.centres.map((c, i) => (
        <line key={`c${i}`} className="bp-centre" x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} />
      ))}
      {draw.dims.map((d, i) => {
        const ext = 5;
        const gap = 3;
        const mx = (d.x1 + d.x2) / 2;
        const my = (d.y1 + d.y2) / 2;
        const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
        const ux = (d.x2 - d.x1) / (len || 1);
        const uy = (d.y2 - d.y1) / (len || 1);
        const arrow = (x: number, y: number, s: number) =>
          `M${x} ${y} L${x + s * (ux * 6 - uy * 2.2)} ${y + s * (uy * 6 + ux * 2.2)} L${x + s * (ux * 6 + uy * 2.2)} ${y + s * (uy * 6 - ux * 2.2)} Z`;
        const tx = mx + d.nx * 7;
        const ty = my + d.ny * 7;
        return (
          <g key={i} className="bp-dim">
            <line x1={d.ax + d.nx * gap} y1={d.ay + d.ny * gap} x2={d.x1 + d.nx * ext} y2={d.y1 + d.ny * ext} />
            <line x1={d.bx + d.nx * gap} y1={d.by + d.ny * gap} x2={d.x2 + d.nx * ext} y2={d.y2 + d.ny * ext} />
            <line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} />
            <path d={arrow(d.x1, d.y1, 1)} />
            <path d={arrow(d.x2, d.y2, -1)} />
            <text x={tx} y={ty} transform={`rotate(${d.angle} ${tx} ${ty})`} dominantBaseline="middle" textAnchor="middle">
              {d.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------ sheet

export default function Sheet(props: SheetProps) {
  const { tones, highlight, pinned, exploded, active, onHover, onPick, callout, heroTitle, heroCorner, titleBlock, onReady, onError, engineRef: outerRef } = props;
  const compact = props.variant === 'compact';
  const markers = props.markers ?? [];
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const markerEls = useRef(new Map<string, HTMLButtonElement>());
  const reducedMotion = useReducedMotion();
  const hostRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const viewRefs = useRef<Partial<Record<OrthoId, HTMLElement | null>>>({});
  const engineRef = useRef<BlueprintEngine | null>(null);
  const [ready, setReady] = useState(false);
  const [draws, setDraws] = useState<Partial<Record<OrthoId, ViewDraw>>>({});
  const cb = useRef({ onHover, onPick, onReady, onError, onMarker: props.onMarker, onMarkerHover: props.onMarkerHover });
  cb.current = { onHover, onPick, onReady, onError, onMarker: props.onMarker, onMarkerHover: props.onMarkerHover };

  // callout plumbing, written straight to the DOM every frame
  const activeRef = useRef<string | null>(active);
  activeRef.current = active;
  const sideRef = useRef<{ id: string | null; side: 'l' | 'r' }>({ id: null, side: 'r' });
  const [side, setSide] = useState<'l' | 'r'>('r');
  const cardRef = useRef<HTMLDivElement>(null);
  const leaderRef = useRef<SVGPathElement>(null);
  const dotRef = useRef<SVGCircleElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);

  const placeCallout = useCallback(() => {
    const eng = engineRef.current;
    const hero = heroRef.current;
    const card = cardRef.current;
    const path = leaderRef.current;
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!eng || !hero || !card || !path || !dot || !ring) return;
    for (const m of markersRef.current) {
      const el = markerEls.current.get(m.id);
      if (!el) continue;
      const o = eng.offsetOf(m.part);
      const q = eng.project('hero', [m.at[0] + o[0], m.at[1] + o[1], m.at[2] + o[2]]);
      el.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px)`;
      el.style.visibility = q.visible ? 'visible' : 'hidden';
    }
    const id = activeRef.current;
    if (!id) {
      path.setAttribute('d', '');
      dot.setAttribute('r', '0');
      ring.setAttribute('r', '0');
      return;
    }
    const p = eng.project('hero', eng.anchor(id));
    const w = hero.clientWidth;
    if (sideRef.current.id !== id) {
      const s = p.x < w / 2 ? 'l' : 'r';
      sideRef.current = { id, side: s };
      setSide(s);
    }
    const s = sideRef.current.side;
    const cx = card.offsetLeft;
    const cy = card.offsetTop;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const ax = s === 'l' ? cx + cw : cx;
    const ay = cy + Math.min(ch - 14, 30);
    const ex = ax + (s === 'l' ? 26 : -26);
    path.setAttribute('d', `M${ax} ${ay} L${ex} ${ay} L${p.x} ${p.y}`);
    dot.setAttribute('cx', String(p.x));
    dot.setAttribute('cy', String(p.y));
    dot.setAttribute('r', '2.6');
    ring.setAttribute('cx', String(p.x));
    ring.setAttribute('cy', String(p.y));
    ring.setAttribute('r', '7');
  }, []);

  useLayoutEffect(() => {
    let cancelled = false;
    let engine: BlueprintEngine | null = null;
    const offs: (() => void)[] = [];
    loadCar()
      .then((car) => {
        if (cancelled || !hostRef.current || !heroRef.current) return;
        const v = viewRefs.current;
        if (!v.side || !v.front || !v.rear || !v.bottom) return;
        engine = new BlueprintEngine(car, {
          host: hostRef.current,
          views: { hero: heroRef.current, side: v.side, front: v.front, rear: v.rear, bottom: v.bottom } as Record<ViewId, HTMLElement>,
          reducedMotion,
          compact,
        });
        engineRef.current = engine;
        if (outerRef) outerRef.current = engine;
        if (import.meta.env.DEV) (window as unknown as { __bp?: BlueprintEngine }).__bp = engine;
        const relayout = () => {
          const e = engineRef.current;
          if (!e) return;
          setDraws({ side: drawFor(e, 'side', compact), front: drawFor(e, 'front', compact), rear: drawFor(e, 'rear', compact), bottom: drawFor(e, 'bottom', compact) });
        };
        offs.push(engine.on('hover', (id) => cb.current.onHover(id)));
        offs.push(engine.on('select', (id) => cb.current.onPick(id)));
        offs.push(engine.on('frame', placeCallout));
        offs.push(engine.on('layout', relayout));
        relayout();
        setReady(true);
        cb.current.onReady?.();
      })
      .catch((e: Error) => {
        if (!cancelled) cb.current.onError?.(e);
      });
    return () => {
      cancelled = true;
      for (const o of offs) o();
      engine?.dispose();
      engineRef.current = null;
      if (outerRef) outerRef.current = null;
    };
    // the engine is built once; everything else reaches it through the effects below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) engineRef.current?.setTones(tones);
  }, [tones, ready]);
  const highlightPull = props.highlightPull ?? true;
  useEffect(() => {
    if (ready) engineRef.current?.setHighlight(highlight, highlightPull);
  }, [highlight, highlightPull, ready]);
  useEffect(() => {
    if (ready) engineRef.current?.setSelected(pinned);
  }, [pinned, ready]);
  useEffect(() => {
    if (ready) engineRef.current?.setExploded(exploded);
  }, [exploded, ready]);
  useEffect(() => {
    placeCallout();
  }, [active, side, placeCallout, markers]);

  return (
    <div className={`bp-sheet${compact ? ' bp-sheet--compact' : ''}${ready ? ' is-ready' : ''}`} ref={hostRef}>
      <div
        className="bp-hero"
        ref={heroRef}
        tabIndex={0}
        role="img"
        aria-label="Angled 3D drawing of the car. Drag or use the arrow keys to turn it; hover a part to pull it out, click to pin it."
        onKeyDown={(e) => {
          const eng = engineRef.current;
          if (!eng) return;
          const step = e.shiftKey ? 0.5 : 0.18;
          const turn: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, 0.08], ArrowDown: [0, -0.08] };
          const t = turn[e.key];
          if (t) {
            e.preventDefault();
            eng.nudge(t[0], t[1]);
          } else if (e.key === 'Home') {
            e.preventDefault();
            eng.resetView();
          }
        }}
      >
        <div className="bp-hero-title">{heroTitle}</div>
        {heroCorner && <div className="bp-hero-corner">{heroCorner}</div>}
        {markers.length > 0 && (
          <div className="bp-markers">
            {markers.map((m) => (
              <button
                key={m.id}
                type="button"
                ref={(el) => {
                  if (el) markerEls.current.set(m.id, el);
                  else markerEls.current.delete(m.id);
                }}
                className={`bp-marker${m.on ? ' is-on' : ''}${m.live ? ' is-live' : ''}`}
                aria-pressed={m.on}
                aria-label={m.label}
                title={m.label}
                onPointerEnter={() => cb.current.onMarkerHover?.(m.id)}
                onPointerLeave={() => cb.current.onMarkerHover?.(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  cb.current.onMarker?.(m.id);
                }}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
        <svg className="bp-leader" aria-hidden="true">
          <path ref={leaderRef} />
          <circle ref={ringRef} className="bp-leader-ring" r="0" />
          <circle ref={dotRef} r="0" />
        </svg>
        <div ref={cardRef} className={`bp-callout bp-callout--${side}${active ? ' is-on' : ''}`} aria-live="polite">
          {active ? callout(active) : null}
        </div>
        {!ready && (
          <div className="bp-loading">
            <span className="bp-loading-bar" />
            Drafting the car
          </div>
        )}
      </div>
      <div className="bp-views">
        {(['side', 'front', 'bottom', 'rear'] as OrthoId[]).map((id) => {
          const t = VIEW_TITLES[id];
          const d = draws[id];
          return (
            <figure key={id} className={`bp-view bp-view--${id}`} ref={(el) => (viewRefs.current[id] = el)}>
              <Dimensions draw={d ?? null} />
              <figcaption>
                <b>{t.letter}</b> {t.name}
                {d?.scale ? <span className="mono">1:{d.scale}</span> : null}
              </figcaption>
            </figure>
          );
        })}
        {titleBlock && <div className="bp-titleblock">{titleBlock}</div>}
      </div>
    </div>
  );
}
