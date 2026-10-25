import { useMemo } from 'react';
import { usdShort } from '../../lib/format';
import { useRace } from '../../lib/race';
import { carLabel, ledger, sortTime } from '../../lib/raceModel';
import { ClosePanel } from '../raceday/ClosePanel';
import { latestSim } from '../raceday/ReplanPanel';
import { ActButton, clock, parse, roleLabel } from '../raceday/shared';
import './cfo.css';

// The CFO's view of the weekend: what it cost and where that went in the books, what the season now looks like as
// probabilities, and every item that waits for a person, with the decision in reach. No advice: figures and chances.

interface Facet {
  facet: string;
  owner: string;
  outcomes: { label: string; p: number }[];
}

const pct = (x: number | undefined) => (x === undefined ? '—' : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`);

export function CFOView() {
  const race = useRace();
  const led = useMemo(() => ledger(race.effects), [race.effects]);
  const sim = useMemo(() => latestSim({ sims: race.sims.filter((s) => !s.trigger.startsWith('trueup:')) }), [race.sims]);
  const p = sim ? parse<Record<string, any>>(sim.payloadJson, {}) : {};
  const cap = (p.cap ?? {}) as Record<string, any>;
  const facets = (p.facets ?? []) as Facet[];

  const posted = race.postings.filter((x) => x.status === 'posted');
  const held = race.postings.filter((x) => x.status === 'held');
  const sum = (rows: readonly { amountCents: bigint }[]) => rows.reduce((s, r) => s + r.amountCents, 0n);
  const entryOf = useMemo(() => new Map(race.entries.map((e) => [e.entryKey, e])), [race.entries]);
  const unsure = race.effects.filter((e) => e.status === 'needs_person');
  const decisions = race.actions.filter((a) => a.status === 'awaiting_approval' && (a.kind === 'withdraw_car' || a.outward));
  const openQs = race.questions.filter((q) => q.status === 'open');
  const close = race.closes[0];

  return (
    <div className="cfo">
      <dl className="cfo-tiles">
        <div>
          <dt>Weekend cost</dt>
          <dd className="mono cfo-big">{usdShort(led.cost.mid)}</dd>
          <dd className="muted mono">{led.cost.n ? `${usdShort(led.cost.low)}–${usdShort(led.cost.high)} provisional` : 'nothing booked'}</dd>
        </div>
        <div>
          <dt>In the books</dt>
          <dd className="mono cfo-big">{usdShort(sum(posted))}</dd>
          <dd className="muted">
            posted to the ERP · <b className={held.length ? 'tone-hold' : ''}>{usdShort(sum(held))} held for review</b>
          </dd>
        </div>
        <div>
          <dt>Expected prize money</dt>
          <dd className="mono cfo-big">{p.prize ? usdShort(p.prize.expected_cents) : '—'}</dd>
          <dd className={`muted ${p.prize?.delta_cents < 0 ? 'tone-alert' : ''}`}>{p.prize ? `${p.prize.delta_cents < 0 ? 'down' : 'up'} ${usdShort(Math.abs(p.prize.delta_cents))} since the baseline` : ''}</dd>
        </div>
        <div>
          <dt>Chance of P{p.target_position ?? 8}</dt>
          <dd className="mono cfo-big">{pct(p.p_target)}</dd>
          <dd className="muted">{p.p_target_baseline !== undefined ? `was ${pct(p.p_target_baseline)} before the weekend` : ''}</dd>
        </div>
        <div>
          <dt>Cost cap {cap.year ?? ''}</dt>
          <dd className={`mono cfo-big ${(cap.p_overspend ?? 0) > 0.1 ? 'tone-alert' : ''}`}>{pct(cap.p_overspend)}</dd>
          <dd className="muted">chance of an overspend · material {pct(cap.p_material)}</dd>
        </div>
      </dl>

      <section className="panel cfo-review" aria-labelledby="cfo-review-h">
        <div className="sec-head">
          <h2 id="cfo-review-h">Waiting for a person</h2>
          <span className="muted">{held.length + unsure.length + decisions.length + openQs.length + (close?.status === 'draft' ? 1 : 0)} items</span>
        </div>
        <ul className="cfo-list">
          {held.map((h) => {
            const e = entryOf.get(h.entryKey);
            return (
              <li key={h.entryKey}>
                <span className="cfo-kind">held from the ERP</span>
                <span>
                  <b>{e?.memo ?? h.entryKey}</b>
                  <br />
                  <span className="muted">{h.reason} · for the {roleLabel(h.reviewRole)}</span>
                </span>
                <span className="mono">{usdShort(h.amountCents)}</span>
                <span className="cfo-act">
                  <ActButton label="Approve and post" primary run={(by, at) => race.decidePosting({ entryKey: h.entryKey, status: 'approved', by, at })} />
                  <ActButton label="Reject" run={(by, at) => race.decidePosting({ entryKey: h.entryKey, status: 'rejected', by, at })} />
                </span>
              </li>
            );
          })}
          {unsure.map((e) => (
            <li key={e.effectKey}>
              <span className="cfo-kind">Jev unsure</span>
              <span>
                <b>{e.memo}</b>
                <br />
                <span className="muted">{carLabel(e.driverNumber)} · account {e.bucket} · the chief mechanic's answer settles it</span>
              </span>
              <span className="mono">{usdShort(e.midCents)}</span>
              <span className="cfo-act">
                <ActButton label="Confirm" run={(by, at) => race.confirm({ effectKey: e.effectKey, reason: 'Confirmed by the CFO', by, at })} />
              </span>
            </li>
          ))}
          {decisions.map((a) => (
            <li key={a.actionKey}>
              <span className="cfo-kind">{roleLabel(a.ownerRole)} decides</span>
              <span>
                <b>{a.title}</b>
                <br />
                <span className="muted">{a.dueAt ? `by ${clock(a.dueAt)} UTC · ` : ''}see Strategy or Pit wall</span>
              </span>
              <span />
              <span />
            </li>
          ))}
          {openQs.map((q) => (
            <li key={q.questionKey}>
              <span className="cfo-kind">question</span>
              <span>
                <b>{q.prompt}</b>
                <br />
                <span className="muted">for the {roleLabel(q.routeRole)}</span>
              </span>
              <span className="mono">{q.expectedLossCents > 0n ? usdShort(q.expectedLossCents) : ''}</span>
              <span />
            </li>
          ))}
          {!held.length && !unsure.length && !decisions.length && !openQs.length && <li className="muted">Nothing waits for a person.</li>}
        </ul>
      </section>

      <section className="panel" aria-labelledby="cfo-facets-h">
        <div className="sec-head">
          <h2 id="cfo-facets-h">The season, as chances</h2>
          <span className="muted">{sim ? `10,000 seasons · ${clock(sim.at)} UTC · ${sim.runtimeMs} ms` : 'not simulated yet'}</span>
        </div>
        <div className="cfo-facets">
          {facets
            .filter((f) => /prize|cost cap|place/i.test(f.facet))
            .map((f) => (
              <div key={f.facet} className="cfo-facet">
                <h3>
                  {f.facet} <span className="muted">· {f.owner}</span>
                </h3>
                <ul>
                  {f.outcomes.map((o) => (
                    <li key={o.label}>
                      <span>{o.label}</span>
                      <span className="cfo-bar" aria-hidden>
                        <span style={{ width: `${Math.max(o.p * 100, o.p > 0 ? 1 : 0)}%` }} />
                      </span>
                      <span className="mono">{pct(o.p)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
        {p.attribution && (
          <p className="muted">
            The prize change splits into our own weekend ({usdShort(p.attribution.ours_cents)}) and rivals' results ({usdShort(p.attribution.rivals_cents)}).
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="cfo-posted-h">
        <div className="sec-head">
          <h2 id="cfo-posted-h">Posted to the ERP</h2>
          <span className="muted">{posted.length} entries</span>
        </div>
        <ul className="cfo-posted">
          {posted
            .slice()
            .sort((a, b) => sortTime(b.at) - sortTime(a.at))
            .slice(0, 8)
            .map((x) => (
              <li key={x.entryKey}>
                <span className="mono">{x.erpEntryId}</span> <span>{entryOf.get(x.entryKey)?.memo ?? x.entryKey}</span>{' '}
                <span className="mono">{usdShort(x.amountCents)}</span>
              </li>
            ))}
          {!posted.length && <li className="muted">Nothing posted yet.</li>}
        </ul>
      </section>

      {close && (
        <section className="panel" aria-labelledby="cfo-close-h">
          <div className="sec-head">
            <h2 id="cfo-close-h">The sealed weekend and the briefs</h2>
          </div>
          <ClosePanel />
        </section>
      )}
    </div>
  );
}
