import { useCallback, useEffect, useState } from 'react';

const API = import.meta.env.VITE_FINANCE_API ?? 'http://127.0.0.1:8000';
const RUN_KEY = 'pitwall.mondayRunId';
const SPA_ROUND = 14;

const ACTORS: Record<string, { id: string; name: string }> = {
  controller: { id: 'dana', name: 'Dana Okafor' },
  cfo: { id: 'priya', name: 'Priya Raman' },
};

type Parked = {
  je_id: string;
  kind: string;
  memo: string;
  total_cents: number;
  needs: string[];
  approved_roles: string[];
  reason: string | null;
  recorded_at: string;
};

type Question = {
  q_id: string;
  to_role: string;
  subject: string;
  text: string;
  asked_at: string;
};

type Held = {
  request_id: string;
  reason: string;
  sponsor_id: string;
  round: number;
  session: string;
  car: number;
  amount_orig: number;
  currency: string;
  note?: string;
};

type AlertItem = {
  key: string;
  text?: string;
  fia_url?: string;
  at: string;
};

type Queue = {
  parked: Parked[];
  questions: Question[];
  held_billing: Held[];
  alerts: AlertItem[];
};

type Sponsor = { name: string; receivable_usd_cents: number };
type RoundRow = {
  round: number;
  name: string;
  slug: string;
  final: boolean;
  cumulative: { base: number; bonus: number; prize: number };
};
type WeekendDoc = { title: string; url: string; kind: string };
type Weekend = { name: string; fia_documents: WeekendDoc[]; actions: unknown[] };
type Why = { text: string; lines: string[]; evidence: string[] };
type ScenarioResult = {
  text: string;
  revenue_delta_cents: number;
  entries: { je_id: string; status: string; memo: string; needs: string[] }[];
};

type Books = {
  queue: Queue;
  sponsors: Sponsor[];
  timeline: RoundRow[];
  weekend: Weekend | null;
  agents: { events: number; code: number; agent: number };
  ties: boolean;
};

function money(cents: number, currency = 'USD') {
  const amount = (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  return currency === 'USD' ? `$${amount}` : `${amount} ${currency}`;
}

function roleLabel(role: string) {
  const actor = ACTORS[role];
  return actor ? `${actor.name} (${role})` : role;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export default function MondayMorning() {
  const [runId, setRunId] = useState<string | null>(null);
  const [books, setBooks] = useState<Books | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [why, setWhy] = useState<Why | null>(null);
  const [whyFor, setWhyFor] = useState<string | null>(null);
  const [scenario, setScenario] = useState<ScenarioResult | null>(null);
  const [car, setCar] = useState('44');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async (id: string) => {
    const [queue, sponsors, timeline, costs, balance] = await Promise.all([
      api<Queue>(`/api/runs/${id}/queue`),
      api<Sponsor[]>(`/api/runs/${id}/sponsors`),
      api<RoundRow[]>(`/api/runs/${id}/timeline`),
      api<{ router: { events: number; code: number; agent: number } }>(`/api/runs/${id}/costs`),
      api<{ ties: boolean }>(`/api/runs/${id}/trial-balance`),
    ]);
    const last = [...timeline].reverse().find(round => round.final) ?? timeline[timeline.length - 1];
    const weekend = last ? await api<Weekend>(`/api/runs/${id}/weekend/${last.round}`) : null;
    setBooks({
      queue,
      sponsors,
      timeline,
      weekend,
      agents: costs.router,
      ties: balance.ties,
    });
    setOffline(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const runs = await api<{ run_id: string }[]>('/api/runs');
        if (cancelled) return;
        const saved = sessionStorage.getItem(RUN_KEY);
        const match = runs.find(run => run.run_id === saved) ?? runs[0];
        if (match) {
          setRunId(match.run_id);
          await load(match.run_id);
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Could not reach the books';
        if (message === 'Failed to fetch') setOffline(true);
        else setError(message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function openMonday() {
    setBusy('open');
    setError(null);
    setScenario(null);
    try {
      const created = await api<{ run_id: string }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ season: 2024, stop_before_round: SPA_ROUND, auto_people: false }),
      });
      await api(`/api/runs/${created.run_id}/advance`, {
        method: 'POST',
        body: JSON.stringify({ round: SPA_ROUND }),
      });
      sessionStorage.setItem(RUN_KEY, created.run_id);
      setRunId(created.run_id);
      await load(created.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the books');
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (!runId) return;
    setBusy('refresh');
    setError(null);
    try {
      await load(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh');
    } finally {
      setBusy(null);
    }
  }

  async function act(id: string, path: string, body: object) {
    if (!runId) return;
    setBusy(id);
    setError(null);
    try {
      const result = await api<{ status?: string; reason?: string }>(`/api/runs/${runId}${path}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (result.status === 'refused') setError(result.reason || 'The books refused that.');
      await load(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action failed');
    } finally {
      setBusy(null);
    }
  }

  async function showWhy(jeId: string) {
    if (!runId) return;
    setBusy(`why:${jeId}`);
    setError(null);
    try {
      const detail = await api<Why>(`/api/runs/${runId}/entries/${jeId}/why`);
      setWhy(detail);
      setWhyFor(jeId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the explanation');
    } finally {
      setBusy(null);
    }
  }

  async function simulate() {
    if (!runId || !books) return;
    const last = [...books.timeline].reverse().find(round => round.final);
    if (!last) return;
    const number = Number(car);
    if (!Number.isInteger(number) || number <= 0) {
      setError('Enter a car number.');
      return;
    }
    setBusy('simulate');
    setError(null);
    try {
      const result = await api<ScenarioResult>(`/api/runs/${runId}/scenario`, {
        method: 'POST',
        body: JSON.stringify({ round: last.round, car: number, action: 'dsq' }),
      });
      setScenario(result);
      await load(runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The scenario did not run');
    } finally {
      setBusy(null);
    }
  }

  const last = books
    ? [...books.timeline].reverse().find(round => round.final) ?? books.timeline[books.timeline.length - 1]
    : undefined;
  const owed = books?.sponsors.reduce((sum, sponsor) => sum + sponsor.receivable_usd_cents, 0) ?? 0;
  const posted = last ? last.cumulative.base + last.cumulative.bonus + last.cumulative.prize : 0;
  const waiting =
    (books?.queue.parked.length ?? 0) +
    (books?.queue.questions.length ?? 0) +
    (books?.queue.held_billing.length ?? 0);

  return (
    <section className="monday" aria-labelledby="monday-heading">
      <div className="monday-head">
        <div>
          <p className="eyebrow">Decisions before data</p>
          <h2 id="monday-heading" className="section-title">
            Monday morning
          </h2>
          <p className="muted monday-lead">
            {last
              ? `After the ${last.name}. Sponsorship, headroom, and the document list wait until you have cleared what is parked.`
              : 'Open the books the morning after a Grand Prix. What needs you comes first.'}
          </p>
        </div>
        {runId && (
          <button className="btn btn-ghost" type="button" onClick={refresh} disabled={busy !== null}>
            Refresh
          </button>
        )}
      </div>

      {offline && (
        <p className="notice">
          The finance books are not running. Start them with <code>uvicorn finance.api:app --port 8000</code>, then
          refresh this page.
        </p>
      )}
      {error && <p className="notice">{error}</p>}

      {!runId && !offline && (
        <div className="empty monday-empty">
          <p>Nothing is open yet. This replays the 2024 season through Spa and stops where a person has to decide.</p>
          <button className="btn btn-primary" type="button" onClick={openMonday} disabled={busy !== null}>
            {busy === 'open' ? 'Replaying the season through Spa…' : 'Open Monday after Spa'}
          </button>
        </div>
      )}

      {books && last && (
        <>
          <div className="decision-grid" aria-label="What needs a person">
            <div className="stat">
              <span className="stat-value stat-review">{books.queue.parked.length}</span>
              <span className="stat-label">Need approval</span>
            </div>
            <div className="stat">
              <span className="stat-value">{books.queue.questions.length}</span>
              <span className="stat-label">Open questions</span>
            </div>
            <div className="stat">
              <span className="stat-value">{books.queue.held_billing.length}</span>
              <span className="stat-label">Bills on hold</span>
            </div>
            <div className="stat">
              <span className="stat-value">{books.queue.alerts.length}</span>
              <span className="stat-label">Alerts</span>
            </div>
          </div>

          <div className="queue">
            {books.queue.parked.map(entry => {
              const remaining = entry.needs.filter(role => !entry.approved_roles.includes(role));
              return (
                <article className="queue-item" key={entry.je_id}>
                  <header>
                    <span className="badge badge-review">Approve</span>
                    <strong>{entry.memo}</strong>
                  </header>
                  <p className="queue-meta">
                    <span className="mono">{money(entry.total_cents)}</span>
                    <span>{entry.kind.replace(/_/g, ' ')}</span>
                    <span>Needs {remaining.map(roleLabel).join(' and ') || 'no further signature'}</span>
                  </p>
                  {entry.reason && <p className="muted">{entry.reason}</p>}
                  <div className="row-actions">
                    {remaining.map(role => {
                      const actor = ACTORS[role] ?? { id: role, name: role };
                      return (
                        <button
                          key={role}
                          className="btn btn-primary"
                          type="button"
                          disabled={busy !== null}
                          onClick={() =>
                            act(entry.je_id, '/approve', {
                              je_id: entry.je_id,
                              approver: actor.id,
                              role,
                              decision: 'approve',
                              reason: 'Approved from the Monday queue.',
                            })
                          }
                        >
                          Approve as {actor.name}
                        </button>
                      );
                    })}
                    <button className="btn btn-ghost" type="button" disabled={busy !== null} onClick={() => showWhy(entry.je_id)}>
                      {busy === `why:${entry.je_id}` ? 'Loading…' : 'Why'}
                    </button>
                  </div>
                  <div className="reject-row">
                    <input
                      aria-label={`Reason to reject ${entry.memo}`}
                      value={drafts[entry.je_id] ?? ''}
                      onChange={event => setDrafts(prev => ({ ...prev, [entry.je_id]: event.target.value }))}
                      placeholder="Reason, if you reject this"
                    />
                    <button
                      className="btn btn-danger"
                      type="button"
                      disabled={busy !== null || !(drafts[entry.je_id] ?? '').trim() || remaining.length === 0}
                      onClick={() =>
                        act(entry.je_id, '/approve', {
                          je_id: entry.je_id,
                          approver: (ACTORS[remaining[0]] ?? { id: remaining[0] }).id,
                          role: remaining[0],
                          decision: 'reject',
                          reason: drafts[entry.je_id],
                        })
                      }
                    >
                      Reject
                    </button>
                  </div>
                  {why && whyFor === entry.je_id && (
                    <div className="why">
                      <p>{why.text}</p>
                      {why.evidence.length > 0 && <p className="muted">{why.evidence.join(' · ')}</p>}
                    </div>
                  )}
                </article>
              );
            })}

            {books.queue.questions.map(question => (
              <article className="queue-item" key={question.q_id}>
                <header>
                  <span className="badge badge-replay">Question</span>
                  <strong>{question.text}</strong>
                </header>
                <p className="queue-meta">
                  <span>For the {question.to_role}</span>
                  <span className="mono">{question.subject}</span>
                </p>
                <div className="reject-row">
                  <input
                    aria-label="Answer"
                    value={drafts[question.q_id] ?? ''}
                    onChange={event => setDrafts(prev => ({ ...prev, [question.q_id]: event.target.value }))}
                    placeholder="Your answer"
                  />
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={busy !== null || !(drafts[question.q_id] ?? '').trim()}
                    onClick={() =>
                      act(question.q_id, '/answer', { q_id: question.q_id, answer: drafts[question.q_id] })
                    }
                  >
                    Answer
                  </button>
                </div>
              </article>
            ))}

            {books.queue.alerts.map(alert => (
              <article className="queue-item" key={alert.key}>
                <header>
                  <span className="badge badge-review">Alert</span>
                  <strong>{alert.text || 'FIA document put money at risk'}</strong>
                </header>
                {alert.fia_url && (
                  <a href={alert.fia_url} target="_blank" rel="noreferrer">
                    Open the FIA document
                  </a>
                )}
              </article>
            ))}

            {books.queue.held_billing.map(bill => (
              <article className="queue-item" key={bill.request_id}>
                <header>
                  <span className="badge badge-fixture">On hold</span>
                  <strong>
                    {bill.sponsor_id} · car {bill.car} · R{bill.round} {bill.session}
                  </strong>
                </header>
                <p className="queue-meta">
                  <span className="mono">{money(bill.amount_orig, bill.currency)}</span>
                  <span>{bill.reason.replace(/_/g, ' ')}</span>
                </p>
                {bill.note && <p className="muted">{bill.note}</p>}
              </article>
            ))}

            {waiting === 0 && books.queue.alerts.length === 0 && (
              <p className="empty">Nothing is waiting on you.</p>
            )}
          </div>

          <div className="stand">
            <div>
              <p className="stat-label">Where we stand</p>
              <p>
                Sponsors still owe <strong>{money(owed)}</strong>. Posted revenue through {last.name} is{' '}
                <strong>{money(posted)}</strong>. The books {books.ties ? 'balance' : 'do not balance'}.
              </p>
            </div>
            <div>
              <p className="stat-label">What the agents did</p>
              <p>
                {books.agents.code} events settled in code. {books.agents.agent} went to the revenue agent. {books.agents.events}{' '}
                events in total.
              </p>
            </div>
            <div>
              <p className="stat-label">Since {last.name}</p>
              <p>
                {books.weekend?.fia_documents.length ?? 0} FIA documents on the weekend tape,{' '}
                {books.weekend?.actions.length ?? 0} actions recorded.
              </p>
              {books.weekend && books.weekend.fia_documents.slice(0, 3).map(doc => (
                <a key={doc.url} className="doc-link" href={doc.url} target="_blank" rel="noreferrer">
                  {doc.title}
                </a>
              ))}
            </div>
          </div>

          <form
            className="simulate"
            onSubmit={event => {
              event.preventDefault();
              void simulate();
            }}
          >
            <div>
              <p className="stat-label">If we simulate a new stewards' decision</p>
              <p className="muted">Disqualify a car from the {last.name} race. Any reversal that needs a person comes back into the queue.</p>
            </div>
            <label>
              Car
              <input
                className="car-input"
                inputMode="numeric"
                value={car}
                onChange={event => setCar(event.target.value)}
                aria-label="Car number"
              />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy !== null}>
              {busy === 'simulate' ? 'Running…' : `Disqualify from R${last.round}`}
            </button>
          </form>
          {scenario && (
            <div className="why">
              <p>{scenario.text}</p>
              <p>
                Revenue moves by <strong>{money(scenario.revenue_delta_cents)}</strong>.{' '}
                {scenario.entries.filter(entry => entry.status === 'parked').length} new item
                {scenario.entries.filter(entry => entry.status === 'parked').length === 1 ? '' : 's'} waiting above.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
