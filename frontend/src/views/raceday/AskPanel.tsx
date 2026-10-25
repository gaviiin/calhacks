import { useRace, type RaceData } from '../../lib/race';
import { usdShort } from '../../lib/format';
import { carLabel } from '../../lib/raceModel';
import type { RaceQuestions } from '../../module_bindings/types';
import { ActButton, clock, parse, roleLabel, type Headline } from './shared';

// Stage 5, ask: a person is asked only when a wrong answer would cost more than the question, and the question is a
// choice between two cases the team has lived through. One click applies the answer and teaches the desk.

interface Option {
  id: string;
  label: string;
  severity: string;
  band: [number, number, number];
  detail?: string;
  case_id?: string;
}

export function askHeadline(race: RaceData): Headline {
  const open = race.questions.filter((q) => q.status === 'open');
  const asks = race.effects.filter((e) => e.status === 'needs_person').length;
  if (open.length) return { value: `${open.length} open`, note: `for the ${roleLabel(open[0]!.routeRole)}${asks ? ` · ${asks} lines wait` : ''}`, tone: 'hold' };
  if (asks) return { value: `${asks} lines`, note: 'Jev unsure: confirm or correct', tone: 'hold' };
  const answered = race.questions.filter((q) => q.status === 'answered').length;
  const defaulted = race.questions.filter((q) => q.status === 'defaulted').length;
  if (answered || defaulted) return { value: `${answered} answered`, note: defaulted ? `${defaulted} took the safe default at the deadline` : 'each answer taught the desk', tone: 'ok' };
  return { value: 'none', note: 'nothing the desk could not settle', tone: 'muted' };
}

const usd = (cents: number) => usdShort(cents);

export function QuestionCard({ q }: { q: RaceQuestions }) {
  const race = useRace();
  const options = parse<Option[]>(q.optionsJson, []);
  const ans = parse<{ option?: string; defaulted?: boolean; why_asked?: string }>(q.answerJson, {});
  const asked = parse<{ why_asked?: string }>(q.answerJson, {}).why_asked;
  const inc = race.incidents.find((i) => i.incidentKey === q.incidentKey);
  return (
    <li className={`question question--${q.status}`}>
      <p className="question-prompt">
        <b>{q.prompt}</b>
      </p>
      <p className="muted small">
        {inc ? `${carLabel(inc.driverNumber)} · ` : ''}for the {roleLabel(q.routeRole)}
        {asked ? ` · asked because ${asked}` : ''}
        {q.expectedLossCents > 0n ? ` · a wrong call would cost about ${usdShort(q.expectedLossCents)} in expectation` : ''}
      </p>
      <div className="question-options">
        {options.map((o) =>
          q.status === 'open' ? (
            <span key={o.id} className="option-btn">
              <ActButton label={o.label} primary={o.id === q.defaultOption} run={(by, at) => race.answer({ questionKey: q.questionKey, answerJson: JSON.stringify({ option: o.id }), by, at })} title={o.detail} />
              <small className="mono muted">
                {usd(o.band[1])} ({usd(o.band[0])}–{usd(o.band[2])})
              </small>
            </span>
          ) : (
            <span key={o.id} className={`option ${ans.option === o.id ? 'option--chosen' : 'muted'}`}>
              {ans.option === o.id ? '✓ ' : ''}
              {o.label} <small className="mono">{usd(o.band[1])}</small>
            </span>
          )
        )}
      </div>
      {q.status === 'open' ? (
        <p className="muted small">
          {q.deadlineAt ? `If nobody answers by ${clock(q.deadlineAt)} race time, the desk takes ${options.find((o) => o.id === q.defaultOption)?.label ?? 'the default'} and says so.` : ''} Neither? Correct
          the band on the line itself.
        </p>
      ) : (
        <p className="muted small">{ans.defaulted ? 'Nobody answered by the deadline: the desk took the stated default.' : `Answered by ${q.answeredBy}; the case joined the precedents.`}</p>
      )}
    </li>
  );
}

export function AskPanel() {
  const race = useRace();
  const qs = race.questions.slice().sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || a.createdAt.localeCompare(b.createdAt));
  const waiting = race.effects.filter((e) => e.status === 'needs_person');
  return (
    <div>
      <ul className="questions">
        {qs.map((q) => (
          <QuestionCard key={q.questionKey} q={q} />
        ))}
        {!qs.length && <li className="muted">No questions. The desk asks only when a wrong answer would cost more than asking.</li>}
      </ul>
      {waiting.length > 0 && (
        <p className="muted small">
          {waiting.length} crash {waiting.length === 1 ? 'line waits' : 'lines wait'} for a person because Jev was unsure (below the {`RACE_ASK_FLOOR`} a person sets). Answering the question settles them; they also show in
          the Inbox with Confirm.
        </p>
      )}
    </div>
  );
}
