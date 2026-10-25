import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CostId } from '../../blueprint/catalog';
import type { CarCondition, PartReading } from '../../blueprint/condition';
import { IconPlay } from '../../components/icons';
import type { RaceData } from '../../lib/race';
import { clock, parse } from '../raceday/shared';
import { Hero, LENSES } from './Hero';
import type { DeskCar, DeskLens } from './model';

// The crash, replayed on the car: every version of what the desk believed about it, in order. The telemetry stop,
// race control, the laps that never came, and then the engineer's report: the Chief Mechanic's assessment (Jev's read,
// approved), or a report an engineer uploads here. Each part's probability moves from one version to the next, so the
// parts light up as the evidence lands, the likeliest first. The replay draws on the car only; the books are untouched.

type Inc = RaceData['incidents'][number];

interface Step {
  at: string;
  title: string;
  detail: string;
  kind: 'before' | 'telemetry' | 'race' | 'confirmed' | 'report' | 'upload';
  parts: Record<string, number>;
}

interface Belief {
  impact_kph?: number;
  decel_g?: number;
  parts?: Record<string, number>;
  assessed_by?: string;
  assessed_as?: string;
  severity_by?: string;
}

const STEP_MS = 2200;
const TWEEN_MS = 1100;

// words an engineer uses for a part, longest first ("front wing" before "wing")
const PART_WORDS: [string, CostId][] = (
  [
    ['front suspension', 'front_suspension'], ['rear suspension', 'rear_suspension'], ['front wing', 'front_wing'], ['rear wing', 'rear_wing'],
    ['survival cell', 'chassis'], ['monocoque', 'chassis'], ['power unit', 'power_unit'], ['diffuser', 'floor'], ['sidepod', 'bodywork'],
    ['engine cover', 'bodywork'], ['gearbox', 'gearbox'], ['chassis', 'chassis'], ['tub', 'chassis'], ['floor', 'floor'], ['nose', 'front_wing'],
    ['bodywork', 'bodywork'], ['brakes', 'brakes'], ['brake', 'brakes'], ['loom', 'electronics'], ['electronics', 'electronics'], ['sensor', 'electronics'],
    ['engine', 'power_unit'], ['pu', 'power_unit'], ['wing', 'front_wing'],
  ] as [string, CostId][]
).sort((a, b) => b[0].length - a[0].length);

const NEGATIVE = /\b(intact|ok|okay|fine|undamaged|no damage|not damaged|checked ok|passed)\b/i;

/** An engineer's report in their own words, or as JSON: the parts it says the crash took. */
export function readReport(text: string): Record<string, number> {
  try {
    const j = JSON.parse(text) as { parts?: Record<string, number> | string[] } | string[];
    const list = Array.isArray(j) ? j : j.parts;
    if (Array.isArray(list)) return Object.fromEntries(list.map((p) => [String(p), 1]));
    if (list && typeof list === 'object') return Object.fromEntries(Object.entries(list).map(([k, v]) => [k, Number(v)]));
  } catch {
    /* plain words */
  }
  const out: Record<string, number> = {};
  for (const raw of text.split(/[\n.;]+/)) {
    let line = ` ${raw.toLowerCase().replace(/\b(front|rear)[ -](left|right)\b/g, '$1')} `;
    const no = NEGATIVE.test(line);
    for (const [w, part] of PART_WORDS) {
      const re = new RegExp(`(?<![a-z])${w.replace(/ /g, '[ -]')}(?![a-z])`);
      if (re.test(line)) {
        if (!(part in out) || !no) out[part] = no ? 0 : 1;
        line = line.replace(re, ' ');
      }
    }
  }
  return out;
}

function steps(race: RaceData, inc: Inc, upload: { name: string; parts: Record<string, number> } | null): Step[] {
  const versions = race.beliefs.filter((b) => b.incidentKey === inc.incidentKey).sort((a, b) => a.version - b.version);
  const out: Step[] = [{ at: inc.firstSeenAt, title: 'Before the crash', detail: 'Every part nominal', kind: 'before', parts: {} }];
  let last = '';
  for (const v of versions) {
    const b = parse<Belief>(v.beliefJson, {});
    const parts = b.parts ?? {};
    const sig = JSON.stringify(parts);
    const assessed = v.status === 'assessed';
    const kind: Step['kind'] = assessed ? 'report' : v.status === 'suspected' ? 'telemetry' : v.status === 'confirmed' ? 'confirmed' : 'race';
    if (sig === last && v.cause === out[out.length - 1]?.detail) continue; // the same version twice
    last = sig;
    const title =
      kind === 'telemetry'
        ? `Telemetry${b.impact_kph ? `: ${b.impact_kph} → 0 km/h` : ''}`
        : kind === 'report'
          ? `Engineer's report${b.assessed_by ? `: ${b.assessed_by.replace(' (replayed)', '')}` : ''}`
          : kind === 'confirmed'
            ? 'Confirmed'
            : 'Race control';
    const detail = kind === 'report' ? `${b.severity_by === 'jev' ? "Jev's read, approved" : 'Assessed'}${b.assessed_as ? ` as ${b.assessed_as}` : ''}: ${v.cause}` : v.cause;
    if (kind === 'report' && out.some((s) => s.kind === 'report')) continue;
    out.push({ at: v.at, title, detail, kind, parts });
  }
  if (upload) {
    const words = (k: string) => k.replace(/_/g, ' ');
    const named = Object.entries(upload.parts).filter(([, p]) => p >= 0.5).map(([k]) => words(k));
    const cleared = Object.entries(upload.parts).filter(([, p]) => p < 0.5).map(([k]) => words(k));
    const base = out[out.length - 1]!.parts;
    // the report overrides what it names; a part it does not mention keeps the desk's last reading
    out.push({ at: new Date().toISOString(), title: "Engineer's report (uploaded)", detail: `${upload.name}: replace ${named.join(', ') || 'nothing'}${cleared.length ? `; cleared ${cleared.join(', ')}` : ''}`, kind: 'upload',
      parts: { ...Object.fromEntries(Object.keys(base).map((k) => [k, Math.min(base[k]!, 0.1)])), ...upload.parts } });
  }
  return out;
}

function fold(raw: Record<string, number>): Partial<Record<CostId, PartReading>> {
  const out: Partial<Record<CostId, PartReading>> = {};
  for (const [k, p] of Object.entries(raw)) {
    if (k === 'chassis_repair') continue;
    out[k as CostId] = { p };
  }
  const rep = raw.chassis_repair ?? 0;
  const rpl = raw.chassis ?? 0;
  if (rep > 0 || rpl > 0) out.chassis = { p: Math.max(rep, rpl), repair: rep > rpl };
  return out;
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function lerpParts(a: Record<string, number>, b: Record<string, number>, t: number): Record<string, number> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (a[k] ?? 0) + ((b[k] ?? 0) - (a[k] ?? 0)) * ease(t);
  return out;
}

export function ReplayStage({ race, inc, car }: { race: RaceData; inc: Inc | null; car: DeskCar }) {
  const [lens, setLens] = useState<DeskLens>('condition');
  const [hoverCost, setHoverCost] = useState<CostId | null>(null);
  const [upload, setUpload] = useState<{ name: string; parts: Record<string, number> } | null>(null);
  const [play, setPlay] = useState<{ t0: number; steps: Step[] } | null>(null);
  const [now, setNow] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const start = useCallback(
    (u: typeof upload = upload) => {
      if (!inc) return;
      setLens('condition');
      setPlay({ t0: performance.now(), steps: steps(race, inc, u) });
    },
    [race, inc, upload],
  );

  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const tick = (t: number) => {
      setNow(t);
      if (t - play.t0 < play.steps.length * STEP_MS + 2600) raf = requestAnimationFrame(tick);
      else setPlay(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play]);

  useEffect(() => setPlay(null), [inc?.incidentKey]);

  const frame = useMemo(() => {
    if (!play) return null;
    const el = Math.max(0, now - play.t0);
    const i = Math.min(play.steps.length - 1, Math.floor(el / STEP_MS));
    const prev = play.steps[Math.max(0, i - 1)]!;
    const cur = play.steps[i]!;
    const parts = i === 0 ? {} : lerpParts(prev.parts, cur.parts, (el - i * STEP_MS) / TWEEN_MS);
    return { i, cur, parts };
  }, [play, now]);

  const shown: DeskCar = useMemo(() => {
    if (!frame) return car;
    const condition: CarCondition = { ...car.condition, source: 'jev', label: frame.cur.title, parts: fold(frame.parts), status: frame.i === 0 ? 'running' : 'stopped' };
    return { ...car, condition, stage: { ...car.stage, condition } };
  }, [frame, car]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const parts = readReport(await f.text());
    const u = { name: f.name, parts };
    setUpload(u);
    start(u);
  };
  const sample = async () => {
    const r = await fetch('/engineer-report-sample.txt');
    const text = await r.text();
    const u = { name: 'engineer-report-sample.txt', parts: readReport(text) };
    setUpload(u);
    start(u);
  };

  const likely = frame ? Object.entries(fold(frame.parts)).filter(([, r]) => (r?.p ?? 0) >= 0.5).length : 0;
  return (
    <section className={`glass--dark hstage pv-stage ${frame ? 'is-replaying' : ''}`} aria-label={`Car ${car.number}`}>
      <div className="pv-lens gseg gseg--dark" role="radiogroup" aria-label="Lens">
        {LENSES.map((l) => (
          <button key={l.id} type="button" role="radio" aria-checked={lens === l.id} className={lens === l.id ? 'is-on' : ''} onClick={() => setLens(l.id)} title={l.title} disabled={!!frame}>
            {l.label}
          </button>
        ))}
      </div>
      {inc ? (
        <div className="rp-tools">
          <button type="button" className="rp-play" onClick={() => start()} disabled={!!frame}>
            <IconPlay size={12} /> {frame ? 'Replaying…' : 'Replay the crash'}
          </button>
          <button type="button" className="rp-up" onClick={() => fileRef.current?.click()} disabled={!!frame} title="A damage report in plain words (or JSON): the parts it names light up as the last step">
            Upload engineer report
          </button>
          <button type="button" className="rp-sample" onClick={sample} disabled={!!frame}>
            sample
          </button>
          <input ref={fileRef} type="file" accept=".txt,.md,.json,.csv" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
      ) : null}
      <Hero car={shown} lens={frame ? 'condition' : lens} highlightCost={hoverCost} onHoverCost={setHoverCost} />
      {frame && play ? (
        <div className="rp-caption" role="status" aria-live="polite">
          <ol className="rp-steps">
            {play.steps.map((s, i) => (
              <li key={i} className={`${i < frame.i ? 'is-done' : i === frame.i ? 'is-on' : ''} rp-step--${s.kind}`}>
                <span>{s.kind === 'before' ? 'Before' : s.kind === 'telemetry' ? 'Telemetry' : s.kind === 'race' ? 'Race control' : s.kind === 'confirmed' ? 'Confirmed' : s.kind === 'upload' ? 'Uploaded' : 'Engineer'}</span>
              </li>
            ))}
          </ol>
          <div className="rp-now">
            <b>{frame.cur.title}</b>
            <span>
              {frame.cur.kind !== 'before' && frame.cur.kind !== 'upload' ? `${clock(frame.cur.at)} UTC · ` : ''}
              {frame.cur.detail}
            </span>
          </div>
          <span className="rp-count mono">{likely} likely damaged</span>
        </div>
      ) : upload && !frame ? (
        <div className="rp-caption rp-caption--rest">
          <div className="rp-now">
            <b>Last replayed with {upload.name}</b>
            <span>
              {Object.entries(upload.parts)
                .filter(([, p]) => p >= 0.5)
                .map(([k]) => k.replace(/_/g, ' '))
                .join(', ') || 'no parts named'}
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
