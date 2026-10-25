import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { IconRestart } from '../components/icons';
import { usdShort } from '../lib/format';
import { groupOf } from './catalog';
import { Callout, ExplodeIcon, Legend, assessing, tonesFor, type Lens, type StageCar } from './CarBlueprint';
import { templateCondition, type CarCondition } from './condition';
import type { BlueprintEngine, V3 } from './engine/engine';
import { hasWebGL2 } from './load';
import type { SheetMarker } from './Sheet';
import './blueprint.css';

// The blueprint inside the replay's car stage: the angled drawing with one strip of small drawings under
// it, the sponsors' zones as buttons riding on the parts their names are painted on, and the car's
// condition read from the replay's crash through the price book's severity template.

const Sheet = lazy(() => import('./Sheet'));

/** Where each sponsor's name is painted, on the side facing the default view. */
const ZONES: Record<string, { part: string; at: V3; lit: string[] }> = {
  halcyon: { part: 'sidepod_r', at: [0.12, 0.6, 0.72], lit: ['sidepod_r', 'sidepod_l'] },
  arcadia: { part: 'rear_wing', at: [-2.3, 0.7, 0.52], lit: ['rear_wing'] },
  volta: { part: 'nose', at: [2.1, 0.39, 0.1], lit: ['nose'] },
  northwind: { part: 'engine_cover', at: [-0.78, 0.86, 0.07], lit: ['engine_cover'] },
  ridgeline: { part: 'front_wing', at: [2.6, 0.16, 0.66], lit: ['front_wing'] },
};

// racedesk/crash.py: which retirements break the car, and how badly
const HEAVY = new Set(['Accident', 'Collision', 'Spun off']);
const LIGHT = new Set(['Collision damage', 'Damage', 'Puncture']);

export interface ReplaySponsor {
  id: string;
  name: string;
  /** paying at the car's position now */
  earning: boolean;
}

interface Props {
  car: string;
  code: string;
  team: string;
  position: number | null;
  lap: number | null;
  state: 'running' | 'crashed' | 'dsq' | 'out';
  crash: { status: string; clock: string; damage_estimate: number | null } | null;
  sponsors: ReplaySponsor[];
  sponsor: string | null;
  onSponsor: (id: string) => void;
}

export function ReplayBlueprint({ car, code, team, position, lap, state, crash, sponsors, sponsor, onSponsor }: Props) {
  const [lensChoice, setLensChoice] = useState<Lens | null>(null);
  const [exploded, setExploded] = useState(false);
  const [pointer, setPointer] = useState<string | null>(null);
  const [zone, setZone] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [webgl] = useState(hasWebGL2);
  const engineRef = useRef<BlueprintEngine | null>(null);

  const crashKey = crash ? `${crash.status}|${crash.clock}` : '';
  const condition = useMemo<CarCondition>(() => {
    if (state === 'crashed' && crash) {
      const sev = HEAVY.has(crash.status) ? 'heavy' : LIGHT.has(crash.status) ? 'light' : 'moderate';
      const c = templateCondition(sev, 'stopped', crash.clock);
      c.label = `${crash.status}, severity ${sev}`;
      return c;
    }
    const status = state === 'dsq' ? 'dsq' : state === 'out' ? 'out' : 'running';
    return {
      source: 'none',
      label: state === 'running' ? 'No incident' : 'No damage reported',
      at: null,
      severity: null,
      parts: {},
      expected: null,
      booked: null,
      status,
      tyre: null,
    };
    // the crash is read by value: a new lap with the same crash keeps the same reading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, crashKey]);

  const stageCar = useMemo<StageCar>(() => ({ number: Number(car), code, team, position, lap, gap: null, lastPit: null, condition }), [car, code, team, position, lap, condition]);
  const lens: Lens = lensChoice ?? (condition.source !== 'none' ? 'condition' : 'cost');
  const tones = useMemo(() => tonesFor(lens, condition), [lens, condition]);
  const highlight = useMemo(() => (zone ? (ZONES[zone]?.lit ?? []) : []), [zone]);
  const pinned = useMemo(() => (pin ? groupOf(pin) : []), [pin]);
  // over a sponsor's button the callout names the part it sits on, whatever the pointer is above
  const active = (zone ? (ZONES[zone]?.part ?? null) : null) ?? pointer ?? pin;

  const markers = useMemo<SheetMarker[]>(
    () =>
      sponsors
        .filter((s) => ZONES[s.id])
        .map((s) => ({
          id: s.id,
          part: ZONES[s.id].part,
          at: ZONES[s.id].at,
          label: `${s.name}${s.earning ? ', paying now' : ''}: open the contract`,
          on: s.id === sponsor,
          live: s.earning,
        })),
    [sponsors, sponsor],
  );

  const onPick = useCallback((id: string | null) => setPin((cur) => (!id || (cur && groupOf(cur).includes(id)) ? null : id)), []);

  if (!webgl || failed) {
    return <p className="muted small bp-replay-off">{failed ? `The 3D drawing could not start: ${failed}` : 'This browser has no WebGL 2, so the 3D drawing is off.'}</p>;
  }
  const zoneName = zone ? sponsors.find((s) => s.id === zone)?.name : null;
  return (
    <div className="bp-stage bp-stage--replay" onKeyDown={(e) => (e.key === 'Escape' ? setPin(null) : e.key === 'e' || e.key === 'E' ? setExploded((x) => !x) : null)}>
      <Suspense fallback={<div className="bp-sheet bp-sheet--compact bp-sheet--wait" />}>
        <Sheet
          variant="compact"
          tones={tones}
          highlight={highlight}
          highlightPull={false}
          pinned={pinned}
          exploded={exploded}
          active={active}
          onHover={setPointer}
          onPick={onPick}
          engineRef={engineRef}
          markers={markers}
          onMarker={onSponsor}
          onMarkerHover={setZone}
          onError={(e) => setFailed(e.message)}
          callout={(id) => (
            <>
              {zoneName && ZONES[zone!]?.lit.includes(id) && <p className="bp-co-sponsor">{zoneName} is painted here</p>}
              <Callout id={id} car={stageCar} />
            </>
          )}
          heroTitle={
            <>
              <span className="bp-iso">Iso view</span>
              <span className="bp-iso-car">
                Car {car} · {code}
              </span>
              <Legend lens={lens} unknown={assessing(condition)} />
              {crash?.damage_estimate ? <span className="bp-replay-damage mono">Damage estimate {usdShort(crash.damage_estimate)} · booked to the cap</span> : null}
            </>
          }
          heroCorner={
            <div className="bp-replay-tools">
              <div className="seg-ctl" role="group" aria-label="Lens">
                {(['condition', 'cost'] as Lens[]).map((l) => (
                  <button key={l} type="button" className={lens === l ? 'seg-btn seg-btn--on' : 'seg-btn'} aria-pressed={lens === l} onClick={() => setLensChoice(l)}>
                    {l === 'condition' ? 'Condition' : 'Cost'}
                  </button>
                ))}
              </div>
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
