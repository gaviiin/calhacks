import { useEffect, useState } from 'react';
import { usdShort } from '../lib/format';
import { duration, type Replay } from '../lib/racedesk';
import { IconArrow, IconBolt } from './icons';

// The race desk on the overview: the headline races, what each one did to the money, and how fast
// the desk acted. Each card opens that race in the replay.

const CARDS = [
  { season: 2024, round: 14, label: 'Spa 2024' },
  { season: 2026, round: 10, label: 'Spa 2026' },
  { season: 2023, round: 15, label: 'Singapore 2023' },
];

type Summary = Pick<Replay, 'season' | 'round' | 'race' | 'totals' | 'crashes' | 'speed' | 'road' | 'final'>;

export function RaceStrip() {
  const [rows, setRows] = useState<(Summary | null)[]>(CARDS.map(() => null));
  const [down, setDown] = useState(false);
  useEffect(() => {
    let live = true;
    // one at a time: the API serves one request at a time and the 2026 crash runs the cap forecast
    void (async () => {
      for (let i = 0; i < CARDS.length; i++) {
        const c = CARDS[i];
        try {
          const r = await fetch(`/api/racedesk/replay/${c.season}/${c.round}?detail=false`);
          if (!r.ok) throw new Error(String(r.status));
          const d = (await r.json()) as Summary;
          if (live) setRows((p) => p.map((x, k) => (k === i ? d : x)));
        } catch {
          if (live) setDown(true);
          return;
        }
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="racestrip" aria-labelledby="rs-h">
      <div className="sec-head">
        <h2 id="rs-h">
          <IconBolt size={16} /> Race desk
        </h2>
        <p className="muted">Real races, priced lap by lap. Crashes and FIA decisions reach the books in seconds; a month-end close takes about ten days.</p>
      </div>
      {down ? (
        <p className="muted">
          The race desk API is not running. Start it with <code>uvicorn finance.api:app --port 8000</code>.
        </p>
      ) : (
        <div className="racestrip-grid">
          {CARDS.map((c, i) => {
            const d = rows[i];
            const crash = d?.crashes[0];
            const fast = d?.totals.fastest_reaction_seconds;
            return (
              <a key={c.label} className="racestrip-card" href={`#/replay/${c.season}-${c.round}`}>
                <span className="racestrip-label">{c.label}</span>
                {!d ? (
                  <span className="muted small">Pricing every lap…</span>
                ) : (
                  <>
                    <span className="racestrip-race muted small">{d.race}</span>
                    <span className="racestrip-figure mono">
                      {d.totals.money_protected > 0 ? usdShort(d.totals.money_protected) : crash?.damage_estimate ? usdShort(crash.damage_estimate) : usdShort(d.final.bonus_usd)}
                    </span>
                    <span className="small">
                      {d.totals.money_protected > 0
                        ? 'kept off invoices after a disqualification'
                        : crash
                          ? `${crash.driver} crash booked to the cost cap`
                          : 'sponsor bonuses booked'}
                    </span>
                    <span className="racestrip-speed small">
                      {fast != null ? (
                        <>
                          acted in <b className="mono tone-ok">{duration(fast)}</b> · close: ~10 days
                        </>
                      ) : (
                        'replay the race'
                      )}
                    </span>
                  </>
                )}
                <span className="link small">
                  Replay <IconArrow size={12} />
                </span>
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}
