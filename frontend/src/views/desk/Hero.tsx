import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { Callout, ExplodeIcon, Legend, assessing, tonesFor } from '../../blueprint/CarBlueprint';
import { PARTS, PART_INDEX, groupOf, type CostId } from '../../blueprint/catalog';
import { HEALTH_WORDS, partsFor } from '../../blueprint/condition';
import type { BlueprintEngine } from '../../blueprint/engine/engine';
import { hasWebGL2 } from '../../blueprint/load';
import { IconRestart } from '../../components/icons';
import { pct, usdShort } from '../../lib/format';
import { WORDS } from '../roles/carRead';
import { Pill } from '../roles/kit';
import { LifeBar } from './charts';
import { lensTones, lifeCss, type DeskCar, type DeskLens, type DeskPart } from './model';

// The car, front and centre: the blueprint lit by one of three lenses. Condition is what the desk believes about
// each part after the incident (Jev's P(damaged)); Life is how much of each part is used up by the way the car has
// been raced; Cap is when each part's next replacement counts against the cap. One car at a time; the other is a
// click away. Hovering a part in the drawing or in the parts list lights it in both.

const Sheet = lazy(() => import('../../blueprint/Sheet'));

export const LENSES: { id: DeskLens; label: string; title: string }[] = [
  { id: 'condition', label: 'Condition', title: 'What the desk believes about each part after the incident' },
  { id: 'life', label: 'Life', title: 'How much of each part is used up: laps, stress events and crashes' },
  { id: 'cap', label: 'Cap', title: 'When each part’s next replacement counts against the cost cap' },
];

interface Props {
  car: DeskCar;
  lens: DeskLens;
  /** a part lit from outside (a hovered row of the parts list) */
  highlightCost: CostId | null;
  /** a part under the pointer in the drawing, by price-book line */
  onHoverCost: (c: CostId | null) => void;
  /** 'compact' keeps the four drawings under the hero; 'hero' is the angled view alone */
  variant?: 'compact' | 'full';
  corner?: React.ReactNode;
}

export function Hero({ car, lens, highlightCost, onHoverCost, variant = 'compact', corner }: Props) {
  const [exploded, setExploded] = useState(false);
  const [pointer, setPointer] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [webgl] = useState(hasWebGL2);
  const engineRef = useRef<BlueprintEngine | null>(null);
  const c = car.condition;
  const tones = useMemo(() => lensTones(lens, car) ?? tonesFor('condition', c), [lens, car, c]);
  const highlight = useMemo(() => (highlightCost ? partsFor(highlightCost) : []), [highlightCost]);
  const pinned = useMemo(() => (pin ? groupOf(pin) : []), [pin]);
  const active = pointer ?? (highlight[0] || null) ?? pin;
  const onPick = useCallback((id: string | null) => setPin((cur) => (!id || (cur && groupOf(cur).includes(id)) ? null : id)), []);
  const onHover = useCallback(
    (id: string | null) => {
      setPointer(id);
      onHoverCost(id ? PARTS[PART_INDEX[id]]?.cost ?? null : null);
    },
    [onHoverCost],
  );
  const byCost = useMemo(() => new Map(car.parts.map((p) => [p.cost, p])), [car.parts]);
  const w = WORDS[car.read.words];

  if (!webgl || failed) {
    return (
      <div className="hero-nogl" title={failed ?? 'This browser has no WebGL 2'}>
        <Pill tone="neutral">{failed ? 'The 3D drawing could not start' : 'No WebGL 2 here'}</Pill>
        <span>The parts list reads the same belief.</span>
      </div>
    );
  }
  return (
    <div className={`bp-stage hero-stage hero-stage--${lens}`} onKeyDown={(e) => (e.key === 'Escape' ? setPin(null) : e.key === 'e' || e.key === 'E' ? setExploded((x) => !x) : null)}>
      <Suspense fallback={<div className={`bp-sheet bp-sheet--${variant} bp-sheet--wait`} />}>
        <Sheet
          variant={variant}
          tones={tones}
          highlight={highlight}
          highlightPull={false}
          pinned={pinned}
          exploded={exploded}
          active={active}
          onHover={onHover}
          onPick={onPick}
          engineRef={engineRef}
          onError={(e) => setFailed(e.message)}
          callout={(id) => (lens === 'condition' ? <Callout id={id} car={car.stage} /> : <LensCallout id={id} part={byCost.get(PARTS[PART_INDEX[id]]!.cost) ?? null} lens={lens} />)}
          heroTitle={
            <>
              <span className="bp-iso">
                {lens === 'condition' ? `Condition · ${c.label}` : lens === 'life' ? 'Life used · laps, stress, crashes' : 'Cost cap · when each replacement counts'}
              </span>
              <span className="bp-iso-car">
                Car {car.number} · {car.code}
                <Pill tone={w.tone}>{w.word}</Pill>
              </span>
              {lens === 'condition' ? <Legend lens="condition" unknown={assessing(c)} /> : <LensLegend lens={lens} />}
            </>
          }
          heroCorner={
            <div className="bp-replay-tools">
              {corner}
              <button type="button" className={`btn pillbtn bp-explode${exploded ? ' is-on' : ''}`} aria-pressed={exploded} onClick={() => setExploded((x) => !x)} title="E">
                <ExplodeIcon open={exploded} />
                {exploded ? 'Assemble' : 'Explode'}
              </button>
              <button type="button" className="bp-reset" onClick={() => engineRef.current?.resetView()} aria-label="Reset the view">
                <IconRestart size={12} />
              </button>
            </div>
          }
        />
      </Suspense>
    </div>
  );
}

function LensLegend({ lens }: { lens: DeskLens }) {
  if (lens === 'life')
    return (
      <span className="bp-legend" aria-label="Fresh parts read cyan, worn parts amber, parts at their limit coral">
        <span className="bp-legend-ramp" style={{ background: `linear-gradient(90deg, ${lifeCss(0)}, ${lifeCss(75)}, ${lifeCss(100)})` }} />
        <span className="mono">0%</span>
        <span className="muted">to</span>
        <span className="mono">100%</span>
        <span className="muted">of life used</span>
      </span>
    );
  return (
    <span className="bp-legend">
      <span className="bp-health bp-health--damaged">
        <i className="hero-swatch hero-swatch--booked" aria-hidden /> Booked this weekend
      </span>
      <span className="bp-health bp-health--watch">
        <i className="hero-swatch hero-swatch--this" aria-hidden /> Due in 2024
      </span>
      <span className="bp-health bp-health--ok">
        <i className="hero-swatch hero-swatch--next" aria-hidden /> Lasts to 2025
      </span>
    </span>
  );
}

const CAP_WORDS: Record<NonNullable<DeskPart['capYear']>, string> = { booked: 'Counted in 2024, fitted this weekend', this: 'Replacement counts in 2024', next: 'Replacement falls in the 2025 cap' };

/** The callout under the life and cap lenses: the part's life, when it is due, its spare and what it brings into the cap. */
function LensCallout({ id, part, lens }: { id: string; part: DeskPart | null; lens: DeskLens }) {
  const def = PARTS[PART_INDEX[id]]!;
  if (!part || !part.life)
    return (
      <div className="bp-co">
        <div className="bp-co-top">
          <span>{def.label}</span>
        </div>
        <p className="bp-co-line">Not followed by the life model</p>
      </div>
    );
  const h = part.health;
  return (
    <div className={`bp-co bp-co--${h === 'unknown' ? 'ok' : h}`}>
      <div className="bp-co-top">
        <span>{def.label}</span>
        <span className="bp-basis">{part.lifeStatus === 'replaced' ? 'New' : part.penalty ? 'Grid penalty' : part.dueShort}</span>
      </div>
      <h4>{part.label}</h4>
      <div className="hero-co-life">
        <LifeBar used={part.usedPct} size="lg" />
        <span className="mono">{Math.round(part.usedPct)}%</span>
      </div>
      <dl className="bp-co-kv">
        <div>
          <dt>Left</dt>
          <dd className="mono">{part.remainingKm > 0 ? `${part.remainingKm.toLocaleString('en-US')} km` : '0 km'}</dd>
        </div>
        <div>
          <dt>Replacement</dt>
          <dd className="mono">{usdShort(part.replacementCents)}</dd>
        </div>
        <div>
          <dt>Spare</dt>
          <dd>{part.spare && !part.spare.released ? (part.spare.source === 'at_track' ? 'at the track' : part.spare.source === 'factory' ? 'at Grove' : 'to be made') : '—'}</dd>
        </div>
        {lens === 'condition' || part.p === null ? null : (
          <div>
            <dt>Damage</dt>
            <dd className="mono">{h === 'unknown' ? 'not read' : `${HEALTH_WORDS[h]} ${pct(part.p, 0)}`}</dd>
          </div>
        )}
      </dl>
      <p className="bp-co-line">{part.capYear ? CAP_WORDS[part.capYear] : ''}</p>
      {part.stress.length ? <p className="bp-co-line">{part.stress.length} stress {part.stress.length === 1 ? 'event' : 'events'} · −{part.stress.reduce((t, s) => t + s.taken, 0).toFixed(0)}% life</p> : null}
    </div>
  );
}
