// The cap risk model: what an overspend buys on track against what the FIA can take back.
//
// Regulation facts come from the 2026 Financial Regulations on disk (research/fia/secD_iss07.txt):
// D10.3.1 a Minor Overspend Breach is Relevant Costs over the Cost Cap by less than 2%; D10.3.3 a
// Material Overspend Breach is 2% or more; D10.3.2 a minor breach carries a Financial Penalty and
// any other appropriate Minor Sporting Penalty; D10.3.4 a material breach carries a Constructors'
// Championship points deduction, a Financial Penalty and any other appropriate Material Sporting
// Penalty (D12.1.1). Everything else below is an assumption the team can edit, labelled as such.

export const REG = {
  minorBelow: 0.02,
  articles: {
    minor: 'D10.3.1',
    minorSanction: 'D10.3.2',
    material: 'D10.3.3',
    materialSanction: 'D10.3.4',
    sanctions: 'D12.1.1',
  },
};

export interface Assumptions {
  /** USD over the cap the team plans to spend */
  overspend: number;
  /** seconds per lap gained per $1m of extra development, at the first dollar */
  gainPerMillion: number;
  /** $m after which each extra million buys half as much lap time */
  halfLife: number;
  /** seconds per lap between neighbouring constructors' places */
  secondsPerPlace: number;
  /** USD of prize money per constructors' place */
  prizePerPlace: number;
  /** USD of sponsor bonuses per constructors' place over a season */
  bonusPerPlace: number;
  /** probability the FIA's review finds the overspend as reported */
  pFound: number;
  /** fine as a multiple of the overspend */
  fineMultiple: number;
  /** aerodynamic testing cut (fraction of ATR) for a minor breach */
  atrCut: number;
  /** seconds per lap lost next season for a 10% ATR cut */
  atrSecondsPer10: number;
  /** constructors' points deducted for a material breach */
  pointsDeduction: number;
  /** points between neighbouring constructors' places */
  pointsPerPlace: number;
  /** next season's cap reduction for a material breach, USD */
  capCutNextYear: number;
  /** next season's money counts this much (uncertainty + time) */
  nextYearWeight: number;
}

export const DEFAULTS: Assumptions = {
  overspend: 3_000_000,
  gainPerMillion: 0.012,
  halfLife: 12,
  secondsPerPlace: 0.15,
  prizePerPlace: 9_000_000, // world/prize_table.json: $9m between neighbouring places
  bonusPerPlace: 1_500_000, // world/sponsors.json: wins, podiums and points finishes per car
  pFound: 0.9,
  fineMultiple: 3, // the 2021 precedent: a $7m fine on a $2.2m overspend
  atrCut: 0.1, // the 2021 precedent: 10% less aerodynamic testing for 12 months
  atrSecondsPer10: 0.06,
  pointsDeduction: 30,
  pointsPerPlace: 35,
  capCutNextYear: 0,
  nextYearWeight: 0.8,
};

export type Band = 'inside' | 'minor' | 'material';

export function band(overspend: number, cap: number): Band {
  if (overspend <= 0) return 'inside';
  return overspend / cap < REG.minorBelow ? 'minor' : 'material';
}

/** Lap time bought by `usd` of extra spend, with diminishing returns. */
export function lapTimeGain(usd: number, a: Assumptions): number {
  const m = Math.max(0, usd) / 1e6;
  const k = Math.LN2 / Math.max(0.1, a.halfLife);
  // integral of gainPerMillion * exp(-k x) from 0 to m
  return (a.gainPerMillion / k) * (1 - Math.exp(-k * m));
}

export interface Outcome {
  band: Band;
  overspendPct: number;
  gainSeconds: number;
  placesGained: number;
  upside: number;
  /** if found */
  fine: number;
  atrLoss: number;
  pointsLoss: number;
  capCutLoss: number;
  penaltyIfFound: number;
  expectedPenalty: number;
  /** upside minus the expected penalty */
  expected: number;
  /** upside minus the full penalty */
  worst: number;
  /** upside, never found */
  best: number;
}

export function evaluate(a: Assumptions, cap: number): Outcome {
  const o = Math.max(0, a.overspend);
  const b = band(o, cap);
  const gainSeconds = lapTimeGain(o, a);
  const placesGained = gainSeconds / a.secondsPerPlace;
  const perPlace = a.prizePerPlace + a.bonusPerPlace;
  const upside = placesGained * perPlace;
  const fine = b === 'inside' ? 0 : o * a.fineMultiple;
  const atrSeconds = (a.atrCut / 0.1) * a.atrSecondsPer10;
  const atrLoss = b === 'inside' ? 0 : (atrSeconds / a.secondsPerPlace) * perPlace * a.nextYearWeight;
  const pointsLoss = b === 'material' ? (a.pointsDeduction / a.pointsPerPlace) * perPlace : 0;
  // a smaller cap next year is lap time you cannot buy back
  const capCutLoss = b === 'material' ? (lapTimeGain(a.capCutNextYear, a) / a.secondsPerPlace) * perPlace * a.nextYearWeight : 0;
  const penaltyIfFound = fine + atrLoss + pointsLoss + capCutLoss;
  const expectedPenalty = penaltyIfFound * a.pFound;
  return {
    band: b,
    overspendPct: o / cap,
    gainSeconds,
    placesGained,
    upside,
    fine,
    atrLoss,
    pointsLoss,
    capCutLoss,
    penaltyIfFound,
    expectedPenalty,
    expected: upside - expectedPenalty,
    worst: upside - penaltyIfFound,
    best: upside,
  };
}

/** The curve the chart draws: outcomes from inside the cap to `maxPct` over it. */
export function curve(a: Assumptions, cap: number, maxPct = 0.06, steps = 60) {
  const xs: number[] = [];
  const rows: Outcome[] = [];
  for (let i = 0; i <= steps; i++) {
    const overspend = (maxPct * i) / steps * cap;
    xs.push(overspend);
    rows.push(evaluate({ ...a, overspend }, cap));
  }
  return { xs, rows };
}

/** The first overspend at which the expected value turns negative, or null if it never does on the curve. */
export function breakEven(a: Assumptions, cap: number): number | null {
  const { xs, rows } = curve(a, cap, 0.08, 160);
  for (let i = 1; i < rows.length; i++) if (rows[i].expected < 0 && rows[i - 1].expected >= 0) return xs[i];
  return null;
}
