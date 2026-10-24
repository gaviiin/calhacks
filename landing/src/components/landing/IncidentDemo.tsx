import { useEffect, useReducer, useState } from 'react';
import { DEMO, usd } from '../../data/demo';
import { Provenance } from './Provenance';

// detected → investigated → recalculated → proposed/held → approved (by Controller).
// Nothing here talks to a backend: every transition is local page state.
type Step = 'idle' | 'ingest' | 'interpret' | 'calculate' | 'held' | 'approved';
const ORDER: Step[] = ['idle', 'ingest', 'interpret', 'calculate', 'held', 'approved'];
// The agent runs on its own up to the hold; only a human moves it past.
const AUTO_NEXT: Partial<Record<Step, Step>> = { ingest: 'interpret', interpret: 'calculate', calculate: 'held' };
const STEP_MS = 750;

type Action = { type: 'run' } | { type: 'advance'; to: Step } | { type: 'approve' } | { type: 'reset' };

function reducer(step: Step, action: Action): Step {
  switch (action.type) {
    case 'run':
      return step === 'idle' ? 'ingest' : step;
    case 'advance':
      // Ignore stale timers that fire after a reset.
      return step !== 'idle' && ORDER.indexOf(action.to) === ORDER.indexOf(step) + 1 ? action.to : step;
    case 'approve':
      return step === 'held' ? 'approved' : step;
    case 'reset':
      return 'idle';
  }
}

const reached = (step: Step, at: Step) => ORDER.indexOf(step) >= ORDER.indexOf(at);

const LOG: { at: Step; tag: string; text: string }[] = [
  { at: 'ingest', tag: '01 / INGEST', text: 'Amended classification captured in the evidence feed with its source and event time.' },
  { at: 'interpret', tag: '02 / INTERPRET', text: `Sponsor podium clause ${DEMO.clause} is no longer satisfied.` },
  { at: 'calculate', tag: '03 / CALCULATE', text: 'Prize estimate flagged for re-computation; no amount invented.' },
  {
    at: 'held',
    tag: '04 / CONTROL',
    text: `${usd(DEMO.bonus)} exceeds the simulated ${usd(DEMO.threshold)} approval threshold. Proposed reversal is parked.`,
  },
  { at: 'approved', tag: '05 / HUMAN', text: 'Controller approved the simulated adjustment. Audit event recorded in this page only.' },
];

const FLAG: Record<Step, string> = {
  idle: 'AWAITING AGENT',
  ingest: 'INVESTIGATING',
  interpret: 'INVESTIGATING',
  calculate: 'RECALCULATING',
  held: 'NEEDS APPROVAL',
  approved: 'SANDBOX COMPLETE',
};

export default function IncidentDemo() {
  const [step, dispatch] = useReducer(reducer, 'idle');
  const [why, setWhy] = useState(false);

  useEffect(() => {
    if (step === 'idle') setWhy(false);
    const next = AUTO_NEXT[step];
    if (!next) return;
    const timer = setTimeout(() => dispatch({ type: 'advance', to: next }), STEP_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const bonus = reached(step, 'interpret') ? { text: 'REVERSAL IDENTIFIED', tone: 'pending' } : null;
  const prize = reached(step, 'calculate') ? { text: 'RE-ESTIMATE REQUIRED', tone: 'pending' } : null;
  const journal =
    step === 'approved'
      ? { text: 'SIMULATED APPROVAL', tone: 'positive' }
      : reached(step, 'held')
        ? { text: 'HELD FOR CONTROLLER', tone: 'pending' }
        : reached(step, 'calculate')
          ? { text: 'PROPOSED', tone: 'pending' }
          : null;
  const running = step in AUTO_NEXT;

  return (
    <div className="console" role="region" aria-label="Pit Wall simulated finance incident">
      <div className="console-top">
        <div className="console-brand">
          PIT<span>/</span>WALL · OPERATIONS
        </div>
        <div className="console-status">● SIMULATED INCIDENT / SANDBOX / NO LEDGER CONNECTED</div>
      </div>
      <div className="console-body">
        <nav className="console-side" aria-label="Console sections (illustrative)">
          <small>WORKSPACE</small>
          <div>▦ OVERVIEW</div>
          <small>STATIONS</small>
          <div className="selected" data-station="capture" aria-current="page">
            <span>01</span> CAPTURE · INCIDENT QUEUE
          </div>
          <div data-station="ingest">
            <span>02</span> INGEST · EVIDENCE FEED
          </div>
          <div data-station="reason">
            <span>03</span> REASON · AGENT PROPOSALS
          </div>
          <div data-station="control">
            <span>04</span> CONTROL · CONTROLLER AUDIT
          </div>
          <small>LEDGER</small>
          <div>≡ JOURNAL ENTRIES</div>
          <div className="boot" aria-hidden="true">
            <p className="boot-line">SYS · PW-01 ONLINE</p>
            <p className="boot-line">EVIDENCE FEED · SUBSCRIBED</p>
            <p className="boot-line">RULES ENGINE · v1 LOADED</p>
            <p className="boot-line">CONTROLLER GATE · {usd(DEMO.threshold)}</p>
          </div>
        </nav>
        <div className="console-main">
          <h3>CLASSIFICATION CHANGE / CASE #{DEMO.caseId}</h3>
          <div className="console-sub">EXAMPLE RACE EVENT · TRIGGERED BY AN AMENDED CLASSIFICATION</div>
          <div className="incident">
            <div>
              <strong>DRIVER CLASSIFICATION AMENDED: P3 → DSQ</strong>
              <span>Source ingested → sponsor contract affected → journal review required</span>
            </div>
            <div className={`flag flag--${step}`} aria-live="polite">
              {FLAG[step]}
            </div>
          </div>

          <div className="ledger-wrap">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">FINANCIAL ITEM</th>
                  <th scope="col">DELTA</th>
                  <th scope="col">STATUS</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    Podium bonus
                    <br />
                    <small>Clause {DEMO.clause}</small>
                  </td>
                  <td>−{usd(DEMO.bonus)}</td>
                  <td className={bonus?.tone}>{bonus?.text ?? 'NOT RUN'}</td>
                </tr>
                <tr>
                  <td>
                    Prize estimate
                    <br />
                    <small>Classification-linked</small>
                  </td>
                  <td>Recalculate</td>
                  <td className={prize?.tone}>{prize?.text ?? 'NOT RUN'}</td>
                </tr>
                <tr>
                  <td>
                    Journal adjustment
                    <br />
                    <small>Controller threshold {usd(DEMO.threshold)}</small>
                  </td>
                  <td>−{usd(DEMO.bonus)}</td>
                  <td className={journal?.tone}>
                    {journal?.text ?? 'NOT RUN'}
                    {journal && (
                      <button
                        type="button"
                        className="why-btn why-btn--inline"
                        aria-expanded={why}
                        aria-controls="console-why"
                        onClick={() => setWhy(w => !w)}
                      >
                        {why ? 'HIDE' : 'WHY?'}
                      </button>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {why && journal && (
            <Provenance
              id="console-why"
              approver={step === 'approved' ? 'Human Controller: approved (simulation)' : undefined}
            />
          )}

          <div className="console-actions">
            <button type="button" className="run-btn" disabled={step !== 'idle'} onClick={() => dispatch({ type: 'run' })}>
              {running ? '… RUNNING' : '▶ RUN DISQUALIFICATION'}
            </button>
            <button
              type="button"
              className="approve-btn"
              disabled={step !== 'held'}
              onClick={() => dispatch({ type: 'approve' })}
            >
              ✓ APPROVE IN SIMULATION
            </button>
            <button type="button" className="reset-btn" onClick={() => dispatch({ type: 'reset' })}>
              ↺ RESET
            </button>
          </div>
          <div className="demo-log" aria-live="polite">
            {step === 'idle' ? (
              <p>
                <b>[ READY ]</b> Run the simulated incident to watch the evidence → contract → control sequence. No
                production data or ledger is affected.
              </p>
            ) : (
              LOG.filter(l => reached(step, l.at)).map(l => (
                <p key={l.tag}>
                  <b>[ {l.tag} ]</b> {l.text}
                </p>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
