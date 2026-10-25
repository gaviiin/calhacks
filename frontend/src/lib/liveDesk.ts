import type { FinanceImpactUpdate, Forecast, ForecastLine, IncidentSignal, JevDecisionRecord, Published, RaceStateUpdate, ResultChangeSignal } from './live';
import { BRAZIL, SPA, type LiveState, type StrategyAdvice } from './live';
import { usdShort } from './format';
import { clauseHits, type Crash, type FinalBonus, type Lap, type LapBonus, type RadioCall, type Replay, type SpeedEvent, type Sponsor } from './racedesk';

// Turns the live Jev feed into the Replay Arnav's race desk already draws. The sporting facts and the
// dollar figures come from the feed. The sponsor catalogue is Meridian's synthetic contracts, used
// only to say what one place up or down would pay and to paint the hotspots on the car.

// race-day rates, the same the server uses (finance/world fx table); only the fallback when no strategy advice has arrived
const FX: Record<string, number> = { USD: 1, EUR: 1.0954, GBP: 1.2011 };

const usd = (amount: number, currency: string) => Math.round(amount * (FX[currency] ?? 1));

const clause = (id: string, type: Sponsor['clauses'][number]['type'], amount: number, currency: string, quote: string, excludesWin = false): Sponsor['clauses'][number] => ({
  id,
  type,
  amount,
  usd: usd(amount, currency),
  quote,
  excludes_win: excludesWin,
});

const SPONSORS: Sponsor[] = [
  {
    id: 'halcyon',
    name: 'Halcyon Energy',
    currency: 'USD',
    base_fee: 2_400_000_000,
    base_fee_usd: 2_400_000_000,
    clauses: [
      clause('4.1', 'win', 200_000_000, 'USD', 'USD 2,000,000 for each Grand Prix won by a Meridian car'),
      clause('4.2', 'podium', 100_000_000, 'USD', 'USD 1,000,000 for each Grand Prix podium by a Meridian car, other than a win', true),
    ],
  },
  {
    id: 'arcadia',
    name: 'Arcadia Watches',
    currency: 'GBP',
    base_fee: 500_000_000,
    base_fee_usd: usd(500_000_000, 'GBP'),
    clauses: [clause('4.2', 'podium', 40_000_000, 'GBP', 'GBP 400,000 for each podium finish by a Meridian car, including a win')],
  },
  {
    id: 'northwind',
    name: 'Northwind Cloud',
    currency: 'USD',
    base_fee: 600_000_000,
    base_fee_usd: 600_000_000,
    clauses: [clause('6.3', 'top6', 15_000_000, 'USD', 'USD 150,000 for each top-six finish by a Meridian car')],
  },
  {
    id: 'volta',
    name: 'Volta Telecom',
    currency: 'EUR',
    base_fee: 800_000_000,
    base_fee_usd: usd(800_000_000, 'EUR'),
    clauses: [clause('5.1', 'points_finish', 10_000_000, 'EUR', 'EUR 100,000 for each points finish by a Meridian car')],
  },
  { id: 'ridgeline', name: 'Ridgeline Logistics', currency: 'USD', base_fee: 300_000_000, base_fee_usd: 300_000_000, clauses: [] },
];

const RACE_META: Record<string, { season: number; round: number; name: string; date: string; laps: number }> = {
  [BRAZIL]: { season: 2024, round: 21, name: 'São Paulo Grand Prix', date: '2024-11-03', laps: 71 },
  [SPA]: { season: 2024, round: 14, name: 'Belgian Grand Prix', date: '2024-07-28', laps: 44 },
};

const NAMES: Record<number, string> = { 63: 'Russell', 44: 'Hamilton', 43: 'Colapinto', 1: 'Verstappen', 4: 'Norris', 16: 'Leclerc', 55: 'Sainz', 81: 'Piastri' };

const ROUTE: Record<string, string> = {
  crash_finance: 'crash finance',
  revenue_change: 'revenue change',
  race_forecast: 'the race forecast',
  human_review: 'a person',
  no_action: 'no action',
};

function placeValue(pos: number | null): number {
  if (!pos || pos < 1) return 0;
  let sum = 0;
  for (const sp of SPONSORS) for (const c of sp.clauses) if (clauseHits(c, pos)) sum += c.usd;
  return sum;
}

function bonusesOf(lines: ForecastLine[]): LapBonus[] {
  return lines.map((l) => ({ sponsor: l.sponsor_id, clause: l.clause_id, type: l.clause_type, car: l.car, usd: l.amount_usd_cents }));
}

function finalsOf(lines: ForecastLine[]): FinalBonus[] {
  return lines.map((l) => ({
    sponsor: l.sponsor_id,
    clause: l.clause_id,
    car: l.car,
    position: l.position ?? 0,
    amount_orig: l.amount_orig_cents,
    currency: l.currency,
    usd: l.amount_usd_cents,
  }));
}

function valuation(bonus: number, prize: number) {
  return { total: bonus + prize, bonus_usd: bonus, prize_ev: prize };
}

interface BuiltLap {
  lap: Lap;
  flag: string | null;
}

function lapFrom(state: RaceStateUpdate, prevTotal: number): BuiltLap {
  const team = new Set(state.team_cars.length ? state.team_cars : [63, 44]);
  const order: Record<string, number> = {};
  const cars: Lap['cars'] = {};
  for (const d of state.driver_states) {
    if (d.position) order[String(d.driver_number)] = d.position;
    if (!team.has(d.driver_number)) continue;
    const here = placeValue(d.position);
    cars[String(d.driver_number)] = {
      code: d.name_acronym ?? NAMES[d.driver_number] ?? String(d.driver_number),
      position: d.status === 'stopped_candidate' ? null : d.position,
      up_one: d.position && d.position > 1 ? placeValue(d.position - 1) - here : 0,
      down_one: d.position ? placeValue(d.position + 1) - here : 0,
    };
  }
  const bonus = state.forecast.amount_cents ?? state.forecast.lines.reduce((s, l) => s + l.amount_usd_cents, 0);
  const prize = state.forecast.prize?.prize_table_cents ?? 0;
  const total = bonus + prize;
  const pos = state.forecast.prize?.constructors_position;
  return {
    flag: state.flag_status,
    lap: {
      lap: state.lap ?? 0,
      clock: state.event_time_utc,
      order,
      bonus_usd: bonus,
      prize_ev: prize,
      total,
      delta: state.forecast_change?.delta_cents ?? total - prevTotal,
      constructors_position: pos ? { [String(pos)]: 1 } : {},
      cars,
      bonuses: bonusesOf(state.forecast.lines),
    },
  };
}

function lapFromForecast(f: Forecast, lap: number, clock: string, prevTotal: number, team: number[]): BuiltLap {
  const cars: Lap['cars'] = {};
  const order: Record<string, number> = {};
  for (const n of team) {
    const line = f.lines.find((l) => l.car === n && l.position);
    const position = line?.position ?? null;
    const here = placeValue(position);
    cars[String(n)] = {
      code: NAMES[n] ?? String(n),
      position,
      up_one: position && position > 1 ? placeValue(position - 1) - here : 0,
      down_one: position ? placeValue(position + 1) - here : 0,
    };
    if (position) order[String(n)] = position;
  }
  const bonus = f.amount_cents ?? f.lines.reduce((s, l) => s + l.amount_usd_cents, 0);
  const prize = f.prize?.prize_table_cents ?? 0;
  const total = bonus + prize;
  const pos = f.prize?.constructors_position;
  return {
    flag: null,
    lap: {
      lap,
      clock,
      order,
      bonus_usd: bonus,
      prize_ev: prize,
      total,
      delta: total - prevTotal,
      constructors_position: pos ? { [String(pos)]: 1 } : {},
      cars,
      bonuses: bonusesOf(f.lines),
    },
  };
}

function changed(prev: RaceStateUpdate | undefined, next: RaceStateUpdate): boolean {
  if (!prev) return true;
  if (prev.lap !== next.lap || prev.flag_status !== next.flag_status) return true;
  if ((prev.forecast.amount_cents ?? null) !== (next.forecast.amount_cents ?? null)) return true;
  if (next.forecast_change?.text) return true;
  const team = new Set(next.team_cars);
  for (const d of next.driver_states) {
    if (!team.has(d.driver_number)) continue;
    const was = prev.driver_states.find((x) => x.driver_number === d.driver_number);
    if (!was || was.position !== d.position || was.status !== d.status || was.compound !== d.compound || was.last_pit_lap !== d.last_pit_lap) return true;
  }
  return false;
}

const flagWord = (f: string) =>
  ({ GREEN: 'Green flag', SAFETY_CAR: 'Safety car', VIRTUAL_SAFETY_CAR: 'Virtual safety car', VSC: 'Virtual safety car', RED_FLAG: 'Red flag', RED: 'Red flag', CHEQUERED: 'Chequered flag', FINISHED: 'Chequered flag' })[f] ?? f.replace(/_/g, ' ').toLowerCase();

function fieldOf(states: RaceStateUpdate[]): Replay['field'] {
  const field: Replay['field'] = {};
  const latest = states[states.length - 1];
  for (const d of latest?.driver_states ?? []) {
    field[String(d.driver_number)] = {
      code: d.name_acronym ?? NAMES[d.driver_number] ?? String(d.driver_number),
      driver: NAMES[d.driver_number] ?? d.name_acronym ?? String(d.driver_number),
      constructor: (d.team ?? '').toLowerCase().replace(/\s+/g, '_'),
      constructor_name: d.team ?? '',
    };
  }
  for (const n of latest?.team_cars ?? [63, 44]) {
    field[String(n)] ??= { code: NAMES[n] ?? String(n), driver: NAMES[n] ?? String(n), constructor: 'mercedes', constructor_name: 'Mercedes' };
  }
  return field;
}

function teamCars(states: RaceStateUpdate[], fallback: number[]): Record<string, string> {
  const nums = states[states.length - 1]?.team_cars?.length ? states[states.length - 1].team_cars : fallback;
  const out: Record<string, string> = {};
  const drivers = states[states.length - 1]?.driver_states ?? [];
  for (const n of nums) out[String(n)] = drivers.find((d) => d.driver_number === n)?.name_acronym ?? NAMES[n] ?? String(n);
  return out;
}

function jevLine(rec: JevDecisionRecord): string {
  const d = rec.decision;
  const route = ROUTE[d.chosen_route] ?? d.chosen_route;
  const conf = d.route_confidence != null ? ` at ${Math.round(d.route_confidence * 100)}%` : '';
  const ms = d.latency_ms != null ? `, ${d.latency_ms} ms` : '';
  const said = d.used && d.route ? `Jev said ${ROUTE[d.route] ?? d.route}${conf}${ms}` : `Jev ${d.status.replace(/_/g, ' ')}, route by rule: ${route}`;
  return `${said}. ${rec.message}`;
}

const signedShort = (c: number) => (Math.abs(c) < 50 ? '$0' : `${c > 0 ? '+' : '−'}${usdShort(Math.abs(c))}`);

/** The server's strategy advice replaces the desk's own place values on the lap it describes. */
function applyStrategy(lap: Lap, adv: StrategyAdvice): void {
  for (const pl of adv.places) {
    const car = lap.cars[String(pl.car)];
    if (!car) continue;
    const pit = adv.pit.find((x) => x.car === pl.car);
    car.up_one = pl.up_one_cents;
    car.down_one = pl.down_one_cents;
    car.from_feed = true;
    car.up_text = pl.up_one_text;
    car.down_text = pl.down_one_text;
    car.pit_now = pit ? pit.delta_cents : null;
    car.pit_text = pit?.text;
  }
}

/** The Replay the race desk renders, or null until the live feed has published a lap or a document. */
export function replayFromLive(live: LiveState): Replay | null {
  const raceId = live.replay?.race_id ?? live.race?.race_id ?? live.resultChanges.at(-1)?.payload.race_id ?? '';
  const meta = RACE_META[raceId];
  if (!meta) return null;
  const started = live.replayStartedAt;
  // published_at is when this process saw the record. The payload clocks are the 2024 source times, so they
  // cannot be compared with the replay's start.
  const inThisRun = (published: string) => !started || !published || published >= started;
  const states = live.states.map((s) => s.payload).filter((s) => s.race_id === raceId);
  const incidents = live.incidents.filter((r) => r.payload.race_id === raceId && inThisRun(r.published_at_utc));
  const results = live.resultChanges.filter((r) => r.payload.race_id === raceId && inThisRun(r.published_at_utc));
  const jev = live.jevDecisions.filter((r) => inThisRun(r.published_at_utc));
  const impacts = live.financeImpacts.filter((r) => inThisRun(r.published_at_utc));
  if (!states.length && !results.length) return null;

  const kept: RaceStateUpdate[] = [];
  for (const s of states) if (changed(kept[kept.length - 1], s)) kept.push(s);

  const laps: Lap[] = [];
  const radio: RadioCall[] = [];
  let prevFlag: string | null = null;
  let prevTotal = 0;
  kept.forEach((s, i) => {
    const built = lapFrom(s, prevTotal);
    if (i === 0) radio.push({ lap: built.lap.lap, clock: built.lap.clock, kind: 'lights_out', text: s.forecast.basis || 'If the race ended now, this is what the sponsor contracts would pay. Indicative, unbooked.' });
    if (s.flag_status && s.flag_status !== prevFlag) {
      const safety = /SAFETY|VSC/.test(s.flag_status);
      radio.push({ lap: built.lap.lap, clock: built.lap.clock, kind: safety ? 'safety_car' : s.flag_status.startsWith('RED') ? 'flag' : 'flag', text: flagWord(s.flag_status) });
    }
    if (s.forecast_change?.text) radio.push({ lap: built.lap.lap, clock: built.lap.clock, kind: 'money', text: s.forecast_change.text, delta: s.forecast_change.delta_cents ?? undefined });
    prevFlag = s.flag_status;
    prevTotal = built.lap.total;
    laps.push(built.lap);
  });

  const team = Object.keys(teamCars(kept, [63, 44])).map(Number);
  for (const r of results) {
    const after = r.payload.after;
    const built = lapFromForecast(after, meta.laps, r.payload.event_time_utc, prevTotal, team.length ? team : [63, 44]);
    radio.push({ lap: built.lap.lap, clock: built.lap.clock, kind: r.payload.type === 'result_final' ? 'final_classification' : 'money', text: r.payload.message, delta: r.payload.change.delta_cents ?? undefined });
    prevTotal = built.lap.total;
    laps.push(built.lap);
  }
  if (!laps.length) return null;

  // the server's figures on the latest lap; earlier laps keep the desk's own contract arithmetic
  const adv = live.strategy && live.strategy.race_id === raceId ? live.strategy : null;
  if (adv && !results.length) {
    const target = [...laps].reverse().find((l) => l.clock <= adv.as_of_utc) ?? laps[laps.length - 1];
    applyStrategy(target, adv);
  }
  for (const m of live.strategyMoves.filter((r) => inThisRun(r.published_at_utc))) {
    const a = m.payload;
    const lost = a.lost_from_peak_cents ?? 0;
    if (!lost && !a.exposure_peak_cents) continue;
    radio.push({
      lap: a.lap ?? laps[laps.length - 1].lap,
      clock: a.as_of_utc,
      kind: 'strategy',
      text: lost
        ? `Given up since the peak: ${usdShort(lost)}. Exposure ${usdShort(a.exposure_now_cents)} now against a peak of ${usdShort(a.exposure_peak_cents ?? a.exposure_now_cents)}. Indicative, unbooked.`
        : `Back at the peak: ${usdShort(a.exposure_now_cents)} on the line. Indicative, unbooked.`,
      delta: -lost,
    });
  }
  const plans = live.plans.filter((r) => inThisRun(r.published_at_utc)).map((r) => r.payload);
  for (const plan of plans) {
    const top = plan.scenarios.slice(0, 4).map((sc) => `${sc.label} ${signedShort(sc.delta_cents)}`).join(', ');
    radio.push({
      lap: plan.lap ?? laps[laps.length - 1].lap,
      clock: plan.as_of_utc,
      kind: 'plan',
      text: `Priced outcomes for car ${plan.car}${plan.team_car ? '' : ' (not a Meridian car)'}: ${top}. Damage ${plan.damage_estimate_cents == null ? 'awaits the garage report' : usdShort(plan.damage_estimate_cents)}.`,
      car: plan.car,
    });
    const a = plan.advisor;
    if (a.status === 'ok' && a.headline) {
      const rec = a.recommended_scenario ? plan.scenarios.find((sc) => sc.key === a.recommended_scenario) : null;
      radio.push({
        lap: plan.lap ?? laps[laps.length - 1].lap,
        clock: plan.as_of_utc,
        kind: 'advisor',
        text: `Live finance agent on car ${plan.car}: ${a.headline}${rec ? ` Recommends ${rec.label}.` : ''}${a.confidence ? ` Confidence ${a.confidence}.` : ''}`,
        car: plan.car,
      });
    }
  }

  for (const inc of incidents) {
    const p = inc.payload;
    radio.push({
      lap: p.lap ?? laps[laps.length - 1].lap,
      clock: p.event_time_utc,
      kind: p.type === 'potential_crash' ? 'retirement' : 'flag',
      text: p.message,
      car: p.driver_number ?? undefined,
      status: p.sporting_confirmation,
    });
  }
  for (const j of jev) {
    radio.push({ lap: j.payload.lap ?? laps[0].lap, clock: j.payload.at, kind: 'money', text: jevLine(j.payload), car: j.payload.drivers?.[0] });
  }
  radio.sort((a, b) => a.clock.localeCompare(b.clock));

  const crashes = crashesOf(incidents, impacts);
  const speed = speedOf(jev, results);
  const first = laps[0];
  const last = laps[laps.length - 1];
  const lastResult = results.at(-1)?.payload;
  const finalLines = lastResult ? finalsOf(lastResult.after.lines) : finalsOf(kept.at(-1)?.forecast.lines ?? []);
  const finalBonus = lastResult?.after.amount_cents ?? last.bonus_usd;
  const finalPrize = lastResult?.after.prize?.prize_table_cents ?? last.prize_ev;
  const roadBonus = results[0]?.payload.before.amount_cents ?? last.bonus_usd;
  const roadPrize = results[0]?.payload.before.prize?.prize_table_cents ?? last.prize_ev;
  const protectedSum = speed.reduce((s, e) => s + (e.usd_protected ?? 0), 0);
  const fastest = speed.reduce<number | null>((m, s) => (s.seconds_to_act == null ? m : m === null ? s.seconds_to_act : Math.min(m, s.seconds_to_act)), null);
  const deltas = laps.map((l) => ({ lap: l.lap, delta: l.delta }));
  const worst = deltas.reduce((a, b) => (b.delta < a.delta ? b : a));
  const best = deltas.reduce((a, b) => (b.delta > a.delta ? b : a));
  const official = results.some((r) => r.payload.type === 'result_change' || r.payload.type === 'result_final');

  return {
    season: meta.season,
    round: meta.round,
    race: meta.name,
    date: meta.date,
    start_utc: first.clock,
    race_laps: meta.laps,
    team: 'Meridian',
    team_cars: teamCars(kept, [63, 44]),
    classification: official ? { '63': { position_text: 'D', status: 'Disqualified', grid: null }, '44': { position_text: '1', status: 'Finished', grid: null } } : {},
    remaining_rounds: Math.max(0, 24 - meta.round),
    field: fieldOf(kept),
    sponsors: SPONSORS,
    totals: {
      start: first.total,
      road: roadBonus + roadPrize,
      final: finalBonus + finalPrize,
      money_protected: protectedSum,
      fastest_reaction_seconds: fastest,
    },
    start: valuation(first.bonus_usd, first.prize_ev),
    road: valuation(roadBonus, roadPrize),
    final: { ...valuation(finalBonus, finalPrize), bonuses: finalLines },
    most_expensive_lap: worst.delta < 0 ? worst : null,
    best_lap: best.delta > 0 ? best : null,
    radio,
    crashes,
    speed,
    laps,
    method: {
      data: 'OpenF1 and the FIA documents, replayed by the live feed with the source clock',
      bonuses: 'if the race ended now, from Meridian’s synthetic sponsor contracts, indicative and unbooked',
      prize_money: 'the synthetic constructors’ prize table at the place the running order would hold',
      clock: 'the source event time, UTC',
      speed: 'Pit Wall’s bar is Jev’s measured latency. The month-end bar is the close a finance team would still be waiting on',
    },
  };
}

function crashesOf(incidents: Published<IncidentSignal>[], impacts: Published<FinanceImpactUpdate>[]): Crash[] {
  const latest = new Map<string, IncidentSignal>();
  for (const r of incidents) {
    const cur = latest.get(r.payload.incident_id);
    if (!cur || r.payload.version >= cur.version) latest.set(r.payload.incident_id, r.payload);
  }
  const out: Crash[] = [];
  for (const p of latest.values()) {
    if (p.driver_number == null) continue;
    if (p.type !== 'potential_crash' && p.driver_attribution === 'none') continue;
    const impact = [...impacts].reverse().find((u) => u.payload.incident_id === p.incident_id);
    out.push({
      incident_id: p.incident_id,
      lap: p.lap ?? 0,
      clock: p.event_time_utc,
      car: p.driver_number,
      driver: p.driver_name ?? NAMES[p.driver_number] ?? String(p.driver_number),
      status: p.sporting_confirmation.replace(/_/g, ' '),
      lap_ms: p.jev.latency_ms,
      damage_estimate: impact?.payload.selected_recovery_cost_cents ?? p.financial_impact.amount_cents,
      p_breach_before: null,
      p_breach_after: null,
      p_breach_after_with_final_package: null,
    });
  }
  return out.sort((a, b) => a.clock.localeCompare(b.clock));
}

function speedOf(jev: Published<JevDecisionRecord>[], results: Published<ResultChangeSignal>[]): SpeedEvent[] {
  const rows: SpeedEvent[] = [];
  for (const r of jev) {
    const p = r.payload;
    const happened = p.timestamps?.source_event ?? p.at;
    const acted = p.timestamps?.jev_finished ?? p.timestamps?.state_published ?? p.at;
    rows.push({
      event: p.message || p.kind.replace(/_/g, ' '),
      happened_at: happened,
      acted_at: acted,
      seconds_to_act: p.decision.latency_ms != null ? p.decision.latency_ms / 1000 : null,
      action: jevLine(p),
      manual_baseline: 'about 10 days later',
      usd_at_stake: null,
      usd_protected: null,
    });
  }
  for (const r of results) {
    const p = r.payload;
    const before = p.before.amount_cents ?? 0;
    const after = p.after.amount_cents ?? 0;
    const happened = p.event_time_utc;
    const acted = p.jev.used ? p.timestamps?.jev_finished ?? p.observed_at_utc : p.observed_at_utc;
    rows.push({
      event: p.type === 'result_final' ? 'FIA Final Classification' : p.document?.title ?? 'Result change',
      happened_at: happened,
      acted_at: acted,
      seconds_to_act: p.jev.latency_ms != null ? p.jev.latency_ms / 1000 : null,
      action: p.message,
      manual_baseline: 'about 10 days later',
      usd_at_stake: Math.abs(after - before) || before || null,
      usd_protected: before > after ? before - after : null,
    });
  }
  return rows.sort((a, b) => (a.happened_at ?? '').localeCompare(b.happened_at ?? ''));
}
