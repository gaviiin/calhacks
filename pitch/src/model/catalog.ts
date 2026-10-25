// The blueprint's parts list. Prices, labels and lead times mirror race/prices.py (the race desk's price
// book: GBP bands, "press" where a figure was published, "assumption" otherwise); change a number there
// first, then here. Each drawn part is priced under one price-book line; a few lines cover more than one
// drawn part (the front wing assembly includes the nose, bodywork covers sidepods, cover and mirrors).

export const USD_PER_GBP = 1.27;

export type CostId =
  | 'chassis'
  | 'gearbox'
  | 'floor'
  | 'front_wing'
  | 'rear_wing'
  | 'front_suspension'
  | 'rear_suspension'
  | 'steering_rack'
  | 'bodywork'
  | 'brakes'
  | 'rear_brakes'
  | 'electronics'
  | 'wheel_speed_sensor'
  | 'power_unit'
  | 'tyre';

export interface Price {
  /** GBP */
  low: number;
  mid: number;
  high: number;
  basis: 'press' | 'assumption';
  note?: string;
}

export const PRICES: Record<CostId | 'chassis_repair', Price> = {
  chassis: { low: 600_000, mid: 850_000, high: 1_200_000, basis: 'assumption', note: 'monocoque replacement; repairs priced separately' },
  chassis_repair: { low: 80_000, mid: 150_000, high: 300_000, basis: 'assumption', note: 'chassis returned to the factory and repaired' },
  gearbox: { low: 300_000, mid: 390_000, high: 470_000, basis: 'press', note: 'about $500k quoted in press; casing and internals' },
  floor: { low: 150_000, mid: 220_000, high: 320_000, basis: 'assumption' },
  front_wing: { low: 80_000, mid: 100_000, high: 120_000, basis: 'press', note: 'about $125-150k quoted in press' },
  rear_wing: { low: 45_000, mid: 65_000, high: 90_000, basis: 'assumption' },
  front_suspension: { low: 40_000, mid: 65_000, high: 110_000, basis: 'assumption', note: 'one corner: wishbones, pushrod, upright' },
  rear_suspension: { low: 40_000, mid: 65_000, high: 110_000, basis: 'assumption', note: 'one corner' },
  steering_rack: { low: 15_000, mid: 28_000, high: 45_000, basis: 'assumption' },
  bodywork: { low: 15_000, mid: 35_000, high: 70_000, basis: 'assumption', note: 'sidepods, engine cover, nose panels' },
  brakes: { low: 12_000, mid: 25_000, high: 45_000, basis: 'assumption', note: 'one corner of discs, pads, caliper' },
  rear_brakes: { low: 20_000, mid: 40_000, high: 70_000, basis: 'assumption', note: 'both rear corners' },
  electronics: { low: 15_000, mid: 35_000, high: 70_000, basis: 'assumption', note: 'loom and sensors' },
  wheel_speed_sensor: { low: 1_000, mid: 3_000, high: 6_000, basis: 'assumption' },
  power_unit: { low: 250_000, mid: 450_000, high: 800_000, basis: 'assumption', note: 'crash-damaged PU elements a customer team pays for' },
  tyre: { low: 0, mid: 0, high: 0, basis: 'assumption', note: 'supplied by the tyre maker; no team cost' },
};

/** Manufacturing lead time per replacement, days (low, mid, high). */
export const LEAD_DAYS: Record<CostId, [number, number, number]> = {
  chassis: [10, 14, 21],
  gearbox: [5, 7, 10],
  floor: [3, 5, 8],
  front_wing: [2, 3, 5],
  rear_wing: [2, 3, 5],
  front_suspension: [3, 5, 8],
  rear_suspension: [3, 5, 8],
  steering_rack: [3, 5, 8],
  bodywork: [2, 3, 5],
  brakes: [1, 2, 3],
  rear_brakes: [1, 2, 3],
  electronics: [2, 3, 5],
  wheel_speed_sensor: [1, 1, 2],
  power_unit: [7, 10, 14],
  tyre: [0, 0, 0],
};

/** The price book's lines as the desk names them. */
export const COST_LABELS: Record<CostId, string> = {
  chassis: 'Chassis (monocoque)',
  gearbox: 'Gearbox',
  floor: 'Floor and diffuser',
  front_wing: 'Front wing and nose',
  rear_wing: 'Rear wing',
  front_suspension: 'Front suspension corner',
  rear_suspension: 'Rear suspension corner',
  steering_rack: 'Steering rack',
  bodywork: 'Bodywork panels',
  brakes: 'Front brake corner',
  rear_brakes: 'Rear brakes, both corners',
  electronics: 'Loom and sensors',
  wheel_speed_sensor: 'Wheel speed sensor',
  power_unit: 'Power unit elements',
  tyre: 'Tyres',
};

/** race/prices.py PART_LABELS: the words the effects write into a crash memo, read back here. */
export const BOOK_LABELS: Record<string, CostId | 'chassis_repair'> = {
  'chassis (monocoque) replaced': 'chassis',
  'chassis repaired': 'chassis_repair',
  gearbox: 'gearbox',
  'floor and diffuser': 'floor',
  'front wing': 'front_wing',
  'rear wing': 'rear_wing',
  'front suspension corner': 'front_suspension',
  'rear suspension corner': 'rear_suspension',
  'steering rack': 'steering_rack',
  'bodywork panels': 'bodywork',
  'front brake corner': 'brakes',
  'rear brakes': 'rear_brakes',
  'loom and sensors': 'electronics',
  'wheel speed sensor': 'wheel_speed_sensor',
  'power unit elements': 'power_unit',
  tyres: 'tyre',
};

/** How many of each priced unit one car carries. */
export const UNITS: Record<CostId, number> = {
  chassis: 1,
  gearbox: 1,
  floor: 1,
  front_wing: 1,
  rear_wing: 1,
  front_suspension: 2,
  rear_suspension: 2,
  steering_rack: 1,
  bodywork: 1,
  brakes: 2,
  rear_brakes: 1,
  electronics: 1,
  wheel_speed_sensor: 4,
  power_unit: 1,
  tyre: 4,
};

/** Parts a severity class implies when nothing lists them: race/prices.py SEVERITY_TEMPLATES. */
export const SEVERITY_TEMPLATES: Record<string, [CostId | 'chassis_repair', number][]> = {
  light: [
    ['front_wing', 0.6],
    ['bodywork', 0.5],
    ['brakes', 0.1],
  ],
  moderate: [
    ['front_wing', 0.7],
    ['floor', 0.5],
    ['front_suspension', 0.4],
    ['rear_suspension', 0.25],
    ['rear_wing', 0.3],
    ['bodywork', 0.6],
  ],
  heavy: [
    ['chassis', 0.6],
    ['chassis_repair', 0.4],
    ['gearbox', 0.8],
    ['floor', 0.9],
    ['front_wing', 0.9],
    ['rear_wing', 0.7],
    ['front_suspension', 0.9],
    ['rear_suspension', 0.7],
    ['bodywork', 0.9],
    ['electronics', 0.6],
    ['power_unit', 0.35],
  ],
};

export type System = 'aero' | 'chassis' | 'power' | 'running' | 'electronics';

export const SYSTEM_LABELS: Record<System, string> = {
  aero: 'Aero',
  chassis: 'Chassis',
  power: 'Powertrain',
  running: 'Running gear',
  electronics: 'Electronics',
};

type V3 = [number, number, number];

export interface PartDef {
  id: string;
  label: string;
  /** the price-book line it is priced under */
  cost: CostId;
  /** how the price applies to this drawn part, when it is not the whole line */
  share?: string;
  /** parts that light up and pull out together */
  group?: string;
  system: System;
  /** fully exploded offset, metres */
  explode: V3;
  /** when it leaves during the full teardown, 0..1 */
  delay: number;
}

// Sides are named from the driver's seat. The car points +x with y up, so the driver's right hand is +z.
const R = 1;
const L = -1;

function corner(side: number, base: Omit<PartDef, 'id' | 'label' | 'explode'> & { id: string; label: string; explode: V3 }): PartDef {
  const [x, y, z] = base.explode;
  return { ...base, id: `${base.id}_${side === R ? 'r' : 'l'}`, label: `${base.label}, ${side === R ? 'right' : 'left'}`, explode: [x, y, z * side] };
}

/** Every drawn part, in a fixed order: the order is the part's index on the GPU. */
export const PARTS: PartDef[] = [
  { id: 'chassis', label: 'Survival cell', cost: 'chassis', system: 'chassis', explode: [0, 0, 0], delay: 0 },
  { id: 'halo', label: 'Halo', cost: 'chassis', share: 'part of the survival cell', system: 'chassis', explode: [0.05, 0.62, 0], delay: 0.18 },
  { id: 'nose', label: 'Nose and front crash structure', cost: 'front_wing', share: 'priced with the front wing assembly', system: 'aero', explode: [0.62, 0.02, 0], delay: 0.08 },
  { id: 'front_wing', label: 'Front wing', cost: 'front_wing', system: 'aero', explode: [1.05, -0.04, 0], delay: 0 },
  ...[R, L].map((s) =>
    corner(s, { id: 'fsusp', label: 'Front suspension', cost: 'front_suspension', share: 'one corner', system: 'running', explode: [0.05, 0.06, 0.42], delay: 0.22 }),
  ),
  ...[R, L].map((s) => corner(s, { id: 'fbrake', label: 'Front brake', cost: 'brakes', share: 'one corner', system: 'running', explode: [0.0, 0.0, 0.7], delay: 0.16 })),
  ...[R, L].map((s) =>
    corner(s, { id: 'wheel_f', label: 'Front tyre', cost: 'tyre', share: 'one of four', group: 'tyres', system: 'running', explode: [0.0, 0.0, 1.02], delay: 0.04 }),
  ),
  ...[R, L].map((s) =>
    corner(s, {
      id: 'wss_f',
      label: 'Front wheel speed sensor',
      cost: 'wheel_speed_sensor',
      share: 'one of four',
      group: 'wss',
      system: 'electronics',
      explode: [0.0, 0.1, 0.56],
      delay: 0.24,
    }),
  ),
  { id: 'steering', label: 'Steering rack, column and wheel', cost: 'steering_rack', system: 'chassis', explode: [0.1, 0.5, 0], delay: 0.3 },
  ...[R, L].map((s) => corner(s, { id: 'sidepod', label: 'Sidepod', cost: 'bodywork', system: 'aero', explode: [0.0, 0.1, 0.62], delay: 0.1 })),
  ...[R, L].map((s) => corner(s, { id: 'radiator', label: 'Radiator', cost: 'bodywork', share: 'inside the sidepod', system: 'power', explode: [0.0, 0.08, 0.36], delay: 0.26 })),
  { id: 'engine_cover', label: 'Engine cover and airbox', cost: 'bodywork', system: 'aero', explode: [-0.05, 0.78, 0], delay: 0.06 },
  ...[R, L].map((s) => corner(s, { id: 'mirror', label: 'Mirror', cost: 'bodywork', system: 'aero', explode: [0.02, 0.2, 0.36], delay: 0.12 })),
  { id: 'floor', label: 'Floor, plank and diffuser', cost: 'floor', system: 'aero', explode: [0, -0.52, 0], delay: 0.2 },
  { id: 'power_unit', label: 'Power unit: V6, turbo, MGU-K', cost: 'power_unit', system: 'power', explode: [-0.05, 0.4, 0], delay: 0.3 },
  { id: 'energy_store', label: 'Energy store', cost: 'power_unit', share: 'a power unit element', system: 'power', explode: [0.05, -0.28, 0], delay: 0.34 },
  { id: 'gearbox', label: 'Gearbox and rear crash structure', cost: 'gearbox', system: 'power', explode: [-0.62, 0.0, 0], delay: 0.28 },
  ...[R, L].map((s) =>
    corner(s, { id: 'rsusp', label: 'Rear suspension', cost: 'rear_suspension', share: 'one corner', system: 'running', explode: [-0.3, 0.06, 0.42], delay: 0.3 }),
  ),
  ...[R, L].map((s) =>
    corner(s, {
      id: 'rbrake',
      label: 'Rear brake',
      cost: 'rear_brakes',
      share: 'priced as a pair',
      group: 'rear_brakes',
      system: 'running',
      explode: [-0.12, 0.0, 0.68],
      delay: 0.2,
    }),
  ),
  ...[R, L].map((s) =>
    corner(s, { id: 'wheel_r', label: 'Rear tyre', cost: 'tyre', share: 'one of four', group: 'tyres', system: 'running', explode: [-0.12, 0.0, 1.0], delay: 0.04 }),
  ),
  ...[R, L].map((s) =>
    corner(s, {
      id: 'wss_r',
      label: 'Rear wheel speed sensor',
      cost: 'wheel_speed_sensor',
      share: 'one of four',
      group: 'wss',
      system: 'electronics',
      explode: [-0.12, 0.1, 0.56],
      delay: 0.24,
    }),
  ),
  { id: 'rear_wing', label: 'Rear wing', cost: 'rear_wing', system: 'aero', explode: [-0.9, 0.42, 0], delay: 0.02 },
  { id: 'electronics', label: 'Loom, ECU and sensors', cost: 'electronics', system: 'electronics', explode: [0.0, 0.3, 0], delay: 0.36 },
];

export const PART_INDEX: Record<string, number> = Object.fromEntries(PARTS.map((p, i) => [p.id, i]));

export const MAX_PARTS = 64;
if (PARTS.length > MAX_PARTS) throw new Error('blueprint: too many parts for the GPU tables');

/** Parts that light up together with `id`: its group, or itself. */
export function groupOf(id: string): string[] {
  const p = PARTS[PART_INDEX[id]];
  if (!p?.group) return [id];
  return PARTS.filter((q) => q.group === p.group).map((q) => q.id);
}

/** A price-book line in USD cents. */
export function priceCents(id: CostId | 'chassis_repair'): { low: number; mid: number; high: number } {
  const p = PRICES[id];
  const c = (g: number) => Math.round(g * USD_PER_GBP * 100);
  return { low: c(p.low), mid: c(p.mid), high: c(p.high) };
}

/** What the car is worth at price-book mid: every line times the units the car carries. */
export function carValueCents(): { low: number; mid: number; high: number } {
  let low = 0;
  let mid = 0;
  let high = 0;
  for (const id of Object.keys(UNITS) as CostId[]) {
    const p = priceCents(id);
    low += p.low * UNITS[id];
    mid += p.mid * UNITS[id];
    high += p.high * UNITS[id];
  }
  return { low, mid, high };
}
