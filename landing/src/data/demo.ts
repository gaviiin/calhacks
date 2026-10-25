// Demo figures for the simulated incident. Labelled SIMULATED / EXAMPLE wherever rendered.

export const DEMO = {
  bonus: 450_000,
  threshold: 250_000,
  clause: '4.2',
  caseId: 'PW-014',
} as const;

export const usd = (n: number) => `$${n.toLocaleString('en-US')}`;

/** Evidence trail behind the proposed reversal. Placeholders, clearly not real documents. */
export const PROVENANCE = [
  { label: 'SOURCE', value: "Stewards' decision, amended classification (example document)" },
  { label: 'EVENT TIME', value: 'Race + 21 days (simulated)' },
  { label: 'CONTRACT', value: `Sponsor agreement, clause ${DEMO.clause}: podium bonus (example)` },
  { label: 'COMPUTATION', value: `rules/podium-bonus v1 → −${usd(DEMO.bonus)}` },
  { label: 'CONTROL', value: `Exceeds ${usd(DEMO.threshold)} auto-post limit → HELD` },
];
