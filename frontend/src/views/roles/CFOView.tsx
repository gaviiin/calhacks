import { useMemo } from 'react';
import { usdShort } from '../../lib/format';
import { useRace, type RaceData } from '../../lib/race';
import { carLabel, ledger, sortTime } from '../../lib/raceModel';
import { ClosePanel } from '../raceday/ClosePanel';
import { latestSim } from '../raceday/ReplanPanel';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import { Figure, Meter, Odds, Panel, Pill, Stack } from './kit';
import './cfo.css';

// The CFO's view of the weekend: what it cost and where that went in the books, what the season now looks like as
// probabilities, and every item that waits for a person, with the decision in reach. No advice: figures and chances.

type Sim = RaceData['sims'][number];

interface Facet {
  facet: string;
  owner: string;
  basis?: string;
  outcomes: { label: string; p: number }[];
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`);
const signed = (c: number) => (c > 0 ? `+${usdShort(c)}` : c < 0 ? usdShort(c) : '$0');
const n = (c: bigint | number | undefined) => Number(c ?? 0);
const isSeasonRun = (s: Sim) => !s.trigger.startsWith('trueup:');

/** The memo's first clause: the rest (rules, basis) lives in the row's tooltip. */
const shortMemo = (memo: string) => memo.split(/ - counts| - retirement|\. /)[0]!.trim();

/** A held entry's reason in two or three words; the full reason is the tooltip. */
function reasonTags(reason: string): string[] {
  const out: string[] = [];
  if (/unsure/i.test(reason)) out.push('Jev unsure');
  if (/materiality/i.test(reason)) out.push('over materiality');
  if (/threshold/i.test(reason)) out.push('over CFO threshold');
  return out.length ? out : [reason.split(/[:;(]/)[0]!.trim()];
}

/** Weekend cost: the mid as a figure, its band drawn on a line from zero. */
function Band({ low, mid, high }: { low: number; mid: number; high: number }) {
  const max = Math.max(high, 1) * 1.04;
  const at = (x: number) => `${Math.max(0, Math.min(100, (x / max) * 100))}%`;
  return (
    <div className="cfo-band" role="img" aria-label={`band ${usdShort(low)} to ${usdShort(high)}, mid ${usdShort(mid)}`}>
      <div className="cfo-band-track">
        <span className="cfo-band-range" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
        <span className="cfo-band-mid" style={{ left: at(mid) }} />
      </div>
      <div className="cfo-band-scale mono">
        <span style={{ left: at(low) }}>{usdShort(low)}</span>
        <span style={{ left: at(high) }}>{usdShort(high)}</span>
      </div>
    </div>
  );
}

/** P(target) across the weekend, one point per season re-run; the dashed line is the baseline. */
function Spark({ values }: { values: number[] }) {
  const W = 160;
  const H = 40;
  if (values.length < 2) return <span className="muted small">Line starts with the second run.</span>;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => 3 + (1 - v) * (H - 6);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = values[values.length - 1]!;
  return (
    <svg className="cfo-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`from ${pct(values[0])} to ${pct(last)} over ${values.length} runs`}>
      <line x1={0} x2={W} y1={y(values[0]!)} y2={y(values[0]!)} className="cfo-spark-base" />
      <polyline points={pts} className="cfo-spark-line" vectorEffect="non-scaling-stroke" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.5} className="cfo-spark-dot" />
    </svg>
  );
}

/** Why the prize moved: our weekend and the rivals', as two bars on one scale. */
function Attribution({ ours, rivals }: { ours: number; rivals: number }) {
  const max = Math.max(Math.abs(ours), Math.abs(rivals), 1);
  const row = (label: string, v: number, tone: string) => (
    <div className="cfo-attr-row" key={label}>
      <span className="cfo-attr-label">{label}</span>
      <span className="cfo-attr-track" aria-hidden>
        <span className={`cfo-attr-fill k-seg--${tone}`} style={{ width: `${Math.max((Math.abs(v) / max) * 100, v ? 1.5 : 0)}%` }} />
      </span>
      <span className={`cfo-attr-v mono ${v < 0 ? 'tone-alert' : ''}`}>{signed(v)}</span>
    </div>
  );
  return (
    <div className="cfo-attr" aria-label="Prize change by cause">
      {row('Our weekend', ours, 'navy')}
      {row('Rivals', rivals, 'sky')}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="cfo-skel" aria-busy="true" aria-label="Loading">
      <span />
      <span />
      <span />
    </div>
  );
}

export function CFOView() {
  const race = useRace();
  const led = useMemo(() => ledger(race.effects), [race.effects]);
  const sim = useMemo(() => latestSim({ sims: race.sims.filter(isSeasonRun) }), [race.sims]);
  const p = sim ? parse<Record<string, any>>(sim.payloadJson, {}) : {};
  const cap = (p.cap ?? {}) as Record<string, any>;
  const facets = (p.facets ?? []) as Facet[];
  const target = (p.target_position as number | undefined) ?? 8;

  const history = useMemo(
    () =>
      sim
        ? race.sims
            .filter((s) => s.meetingKey === sim.meetingKey && isSeasonRun(s))
            .map((s) => ({ s, v: parse<Record<string, any>>(s.payloadJson, {}).p_target }))
            .filter((r): r is { s: Sim; v: number } => typeof r.v === 'number')
            .sort((a, b) => sortTime(a.s.at) - sortTime(b.s.at) || a.s.simKey.localeCompare(b.s.simKey))
            .map((r) => r.v)
        : [],
    [race.sims, sim],
  );

  const postingOf = useMemo(() => new Map(race.postings.map((x) => [x.entryKey, x])), [race.postings]);
  const entryOf = useMemo(() => new Map(race.entries.map((e) => [e.entryKey, e])), [race.entries]);
  const posted = race.postings.filter((x) => x.status === 'posted');
  const held = race.postings.filter((x) => x.status === 'held').sort((a, b) => n(b.amountCents) - n(a.amountCents));
  const unsure = race.effects.filter((e) => e.status === 'needs_person');
  const decisions = race.actions.filter((a) => a.status === 'awaiting_approval' && (a.kind === 'withdraw_car' || a.outward));
  const openQs = race.questions.filter((q) => q.status === 'open');
  const close = race.closes.reduce<RaceData['closes'][number] | null>((b, c) => (!b || c.closedAt > b.closedAt ? c : b), null);
  const closeTotals = close ? parse<Record<string, any>>(close.totalsJson, {}) : {};

  // the books: every entry the desk drafted, by where it sits now
  const books = useMemo(() => {
    const b = { posted: { c: 0, k: 0 }, held: { c: 0, k: 0 }, unrouted: { c: 0, k: 0 }, rejected: { c: 0, k: 0 } };
    for (const e of race.entries) {
      const s = postingOf.get(e.entryKey)?.status;
      const slot = s === 'posted' || s === 'approved' ? b.posted : s === 'held' ? b.held : s === 'rejected' ? b.rejected : b.unrouted;
      slot.c += Math.abs(n(e.amountCents));
      slot.k += 1;
    }
    return b;
  }, [race.entries, postingOf]);
  const bookParts = [
    { key: 'posted', label: 'Posted', tone: 'navy' as const, ...books.posted },
    { key: 'held', label: 'Held', tone: 'wait' as const, ...books.held },
    { key: 'unrouted', label: 'Not routed', tone: 'gray' as const, ...books.unrouted },
    ...(books.rejected.k ? [{ key: 'rejected', label: 'Rejected', tone: 'neutral' as const, ...books.rejected }] : []),
  ];

  const ye = cap.year_end as { p10_cents: number; p50_cents: number; p90_cents: number } | undefined;
  const capCents = n(cap.cap_cents);
  // the meter shows the window around the cap, so P10, P50, P90 and the cap read apart (labels carry true values)
  const capLo = Math.min(capCents, ye?.p10_cents ?? capCents);
  const capHi = Math.max(capCents, ye?.p90_cents ?? capCents);
  const capBase = Math.max(capLo - Math.max(capHi - capLo, capCents * 0.01) * 0.6, 0);
  const capMax = capHi + Math.max(capHi - capLo, capCents * 0.01) * 0.25 - capBase || 1;
  const z = (c: number) => c - capBase;
  const pOver = (cap.p_overspend as number | undefined) ?? 0;
  const pMat = (cap.p_material as number | undefined) ?? 0;
  const capFacet = facets.find((f) => /cost cap/i.test(f.facet));
  const overRows = (capFacet?.outcomes ?? []).filter((o) => /over by more than/i.test(o.label)).map((o) => ({ label: o.label.replace(/^over by more than /i, '> '), p: o.p }));

  const mine = held.length + unsure.length + (close?.status === 'draft' ? 1 : 0);
  const others = decisions.length + openQs.length;
  const bases = [p.prize?.basis, cap.cap_basis, cap.relevant_before_basis, cap.context, ...facets.map((f) => f.basis && `${f.facet}: ${f.basis}`)].filter(Boolean) as string[];

  if (!race.connected && !race.entries.length && !race.sims.length) {
    return (
      <div className="cfo">
        <div className="cfo-grid">
          {['Weekend cost', 'In the books', 'Prize money', 'Cost cap'].map((t) => (
            <Panel key={t} title={t}>
              <Skeleton />
            </Panel>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cfo">
      <div className="cfo-grid">
        <Panel title="Weekend cost" aside={led.cost.n ? `${led.cost.n} effects` : undefined}>
          {led.cost.n ? (
            <>
              <Figure label="Mid, provisional" value={usdShort(led.cost.mid)} size="lg" />
              <Band low={n(led.cost.low)} mid={n(led.cost.mid)} high={n(led.cost.high)} />
            </>
          ) : (
            <p className="muted small">The first costed incident appears here.</p>
          )}
        </Panel>

        <Panel title="In the books" aside={`${race.entries.length} entries`}>
          {race.entries.length ? (
            <>
              <Figure label="Posted to the ERP" value={usdShort(books.posted.c)} size="lg" />
              <Stack parts={bookParts.map((b) => ({ label: b.label, value: b.c, tone: b.tone }))} height={12} legend={false} />
              <ul className="cfo-legend">
                {bookParts.map((b) => (
                  <li key={b.key}>
                    <i className={`k-dot k-seg--${b.tone}`} aria-hidden />
                    <span>{b.label}</span>
                    <b className="mono">{usdShort(b.c)}</b>
                    <span className="muted mono">{b.k}</span>
                  </li>
                ))}
              </ul>
              {posted.length > 0 && (
                <details className="cfo-more">
                  <summary>ERP entries</summary>
                  <ul className="cfo-posted">
                    {posted
                      .slice()
                      .sort((a, b) => sortTime(b.at) - sortTime(a.at))
                      .slice(0, 8)
                      .map((x) => {
                        const memo = entryOf.get(x.entryKey)?.memo ?? x.entryKey;
                        return (
                          <li key={x.entryKey} title={memo}>
                            <span className="mono muted">{x.erpEntryId}</span>
                            <span className="cfo-ellipsis">{shortMemo(memo)}</span>
                            <span className="mono">{usdShort(x.amountCents)}</span>
                          </li>
                        );
                      })}
                  </ul>
                </details>
              )}
            </>
          ) : (
            <p className="muted small">Entries appear as each incident is costed.</p>
          )}
        </Panel>

        <Panel title="Prize money" aside={sim ? <span title={`10,000 seasons · ${sim.runtimeMs} ms`}>{clock(sim.at).slice(0, 5)} UTC</span> : undefined}>
          {p.prize ? (
            <>
              <Figure
                label="Expected"
                value={usdShort(p.prize.expected_cents)}
                size="lg"
                delta={signed(p.prize.delta_cents)}
                deltaTone={p.prize.delta_cents < 0 ? 'bad' : p.prize.delta_cents > 0 ? 'ok' : 'neutral'}
                sub="vs baseline"
              />
              <div className="cfo-odds-line">
                <Figure label={`P(P${target} or better)`} value={pct(p.p_target)} size="sm" sub={p.p_target_baseline !== undefined ? `from ${pct(p.p_target_baseline)}` : undefined} />
                <Spark values={history} />
              </div>
              {p.attribution && <Attribution ours={p.attribution.ours_cents} rivals={p.attribution.rivals_cents} />}
            </>
          ) : (
            <p className="muted small">The season runs as soon as the weekend starts.</p>
          )}
        </Panel>

        <Panel title={`Cost cap ${cap.year ?? ''}`.trim()} aside={ye ? <span title={cap.cap_basis}>cap {usdShort(capCents)}</span> : undefined}>
          {ye ? (
            <>
              <Figure label="Chance of an overspend" value={pct(pOver)} size="lg" sub={`material ${pct(pMat)}`} />
              <Meter
                value={z(ye.p50_cents)}
                limit={z(capCents)}
                max={capMax}
                tone={ye.p50_cents > capCents ? 'bad' : 'info'}
                ticks={[
                  { at: z(ye.p10_cents), label: `P10 ${usdShort(ye.p10_cents)}` },
                  { at: z(ye.p90_cents), label: `P90 ${usdShort(ye.p90_cents)}` },
                ]}
                label={
                  <span title={`Year-end cap spend: P10 ${usdShort(ye.p10_cents)}, P50 ${usdShort(ye.p50_cents)}, P90 ${usdShort(ye.p90_cents)}; the dark line is the cap. The bar starts at ${usdShort(capBase)}, not zero.`}>
                    year-end P50 {usdShort(ye.p50_cents)} · P10–P90 {usdShort(ye.p10_cents)}–{usdShort(ye.p90_cents)}
                  </span>
                }
              />
              <Stack
                parts={[
                  { label: 'Under', value: Math.max(1 - pOver, 0), tone: 'navy' },
                  { label: 'Minor', value: Math.max(pOver - pMat, 0), tone: 'wait' },
                  { label: 'Material', value: pMat, tone: 'bad' },
                ]}
              />
              {overRows.length > 0 && <Odds rows={overRows} />}
            </>
          ) : (
            <p className="muted small">The cap forecast runs with the season.</p>
          )}
        </Panel>
      </div>

      <Panel title="Waiting for you" aside={mine ? <Pill tone="wait">{mine} to decide</Pill> : <Pill tone="ok">Clear</Pill>} className="cfo-queue">
        <ul className="cfo-rows">
          {close?.status === 'draft' && (
            <li>
              <Pill tone="wait">Draft</Pill>
              <span className="cfo-what">
                <b>Weekend close and briefs</b>
                <span className="cfo-meta">{close.leaves} rows sealed · {close.closeKey}</span>
              </span>
              <span className="cfo-who">CFO</span>
              <span className="cfo-amt mono">{closeTotals.race_cost ? usdShort(closeTotals.race_cost.mid_cents) : ''}</span>
              <span className="cfo-act">
                <ActButton label="Approve and send" busyLabel="Approving…" primary run={(by, at) => race.approveClose({ closeKey: close.closeKey, by, at })} />
              </span>
            </li>
          )}
          {held.map((h) => {
            const memo = entryOf.get(h.entryKey)?.memo ?? h.entryKey;
            return (
              <li key={h.entryKey}>
                <Pill tone="wait">Held</Pill>
                <span className="cfo-what" title={`${memo}\n\n${h.reason}`}>
                  <b>{shortMemo(memo)}</b>
                  <span className="cfo-meta">{reasonTags(h.reason).join(' · ')}</span>
                </span>
                <span className="cfo-who">{roleLabel(h.reviewRole)}</span>
                <span className="cfo-amt mono">{usdShort(h.amountCents)}</span>
                <span className="cfo-act">
                  <ActButton label="Approve" busyLabel="Approving…" primary title={`Approve as ${roleLabel(h.reviewRole)}: the desk posts it to the ERP`} run={(by, at) => race.decidePosting({ entryKey: h.entryKey, status: 'approved', by, at })} />
                  <ActButton label="Reject" busyLabel="Rejecting…" title="Keep it out of the ERP" run={(by, at) => race.decidePosting({ entryKey: h.entryKey, status: 'rejected', by, at })} />
                </span>
              </li>
            );
          })}
          {unsure.map((e) => (
            <li key={e.effectKey}>
              <Pill tone="wait">Unsure</Pill>
              <span className="cfo-what" title={`${e.memo}\n\nJev was unsure; the chief mechanic's answer settles it.`}>
                <b>{shortMemo(e.memo)}</b>
                <span className="cfo-meta">
                  {carLabel(e.driverNumber)} · account {e.bucket}
                </span>
              </span>
              <span className="cfo-who">Chief Mechanic</span>
              <span className="cfo-amt mono">{usdShort(e.midCents)}</span>
              <span className="cfo-act">
                <ActButton label="Confirm" busyLabel="Confirming…" title="The band stands as booked" run={(by, at) => race.confirm({ effectKey: e.effectKey, reason: 'Confirmed by the CFO', by, at })} />
              </span>
            </li>
          ))}
          {!mine && <li className="cfo-empty muted">Nothing waits for you.</li>}
        </ul>

        {others > 0 && (
          <details className="cfo-more">
            <summary>
              Waiting on others <span className="mono">{others}</span>
            </summary>
            <ul className="cfo-rows cfo-rows--others">
              {decisions.map((a) => (
                <li key={a.actionKey}>
                  <Pill tone="neutral">Decision</Pill>
                  <span className="cfo-what" title={a.title}>
                    <b>{a.title}</b>
                  </span>
                  <span className="cfo-who">{roleLabel(a.ownerRole)}</span>
                  <span className="cfo-amt mono muted">{a.dueAt ? `${clock(a.dueAt).slice(0, 5)} UTC` : ''}</span>
                  <span className="cfo-act" />
                </li>
              ))}
              {openQs.map((q) => (
                <li key={q.questionKey}>
                  <Pill tone="info">Question</Pill>
                  <span className="cfo-what" title={q.prompt}>
                    <b>{q.prompt}</b>
                  </span>
                  <span className="cfo-who">{roleLabel(q.routeRole)}</span>
                  <span className="cfo-amt mono" title="expected loss if unanswered">
                    {q.expectedLossCents > 0n ? usdShort(q.expectedLossCents) : ''}
                  </span>
                  <span className="cfo-act" />
                </li>
              ))}
            </ul>
          </details>
        )}
      </Panel>

      {close && (
        <Panel
          title="Close and briefs"
          className="cfo-close"
          aside={
            <Pill tone={close.status === 'draft' ? 'wait' : 'ok'} title={close.approvedBy ? `Approved by ${close.approvedBy}` : 'The CFO approves before the briefs go out'}>
              {close.status === 'draft' ? 'Draft' : close.status === 'sent' ? 'Sent' : 'Approved'}
            </Pill>
          }
        >
          <details className="cfo-briefs">
            <summary>
              <span>Four briefs, one per role</span>
              <span className="mono muted">{close.leaves} rows · root {close.rootHash.slice(0, 8)}</span>
            </summary>
            <div className="cfo-close-body">
              <ClosePanel />
            </div>
          </details>
        </Panel>
      )}

      {bases.length > 0 && (
        <details className="cfo-basis">
          <summary>Basis</summary>
          <ul>
            {sim && (
              <li>
                10,000 seasons · {clock(sim.at)} UTC · {sim.runtimeMs} ms
              </li>
            )}
            {bases.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
