import { useRace, type RaceData } from '../../lib/race';
import { usdShort } from '../../lib/format';
import { ActButton, parse, roleLabel, type Headline } from './shared';

// Stage 5, ask: questions a person answers in one click; each answer is applied and learned at once.

interface Option {
  id: string;
  label: string;
  detail?: string;
}

export function askHeadline(race: RaceData): Headline {
  const open = race.questions.filter((q) => q.status === 'open');
  const asks = race.effects.filter((e) => e.status === 'needs_person').length;
  if (open.length) return { value: `${open.length} open`, note: `for the ${roleLabel(open[0]!.routeRole)}`, tone: 'hold' };
  if (asks) return { value: `${asks} lines`, note: 'Jev unsure: confirm or correct', tone: 'hold' };
  const answered = race.questions.filter((q) => q.status !== 'open').length;
  return { value: answered ? `${answered} answered` : 'none', note: answered ? 'each answer taught the desk' : 'nothing the desk could not settle', tone: answered ? 'ok' : 'muted' };
}

export function AskPanel() {
  const race = useRace();
  const qs = race.questions.slice().sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || a.createdAt.localeCompare(b.createdAt));
  return (
    <ul className="questions">
      {qs.map((q) => {
        const options = parse<Option[]>(q.optionsJson, []);
        const ans = parse<{ option?: string; defaulted?: boolean }>(q.answerJson, {});
        return (
          <li key={q.questionKey} className={`question question--${q.status}`}>
            <p className="question-prompt">
              <b>{q.prompt}</b>
            </p>
            <p className="muted">
              For the {roleLabel(q.routeRole)}
              {q.expectedLossCents > 0n ? ` · a wrong answer would cost about ${usdShort(q.expectedLossCents)}` : ''}
            </p>
            <div className="question-options">
              {options.map((o) =>
                q.status === 'open' ? (
                  <ActButton key={o.id} label={o.label} run={(by, at) => race.answer({ questionKey: q.questionKey, answerJson: JSON.stringify({ option: o.id }), by, at })} title={o.detail} />
                ) : (
                  <span key={o.id} className={`option ${ans.option === o.id ? 'option--chosen' : 'muted'}`}>
                    {o.label}
                  </span>
                )
              )}
            </div>
            {q.status !== 'open' && <p className="muted">{ans.defaulted ? 'No answer by the deadline: the desk took the safe default.' : `Answered by ${q.answeredBy}.`}</p>}
          </li>
        );
      })}
      {!qs.length && <li className="muted">No questions. Lines where Jev was unsure appear in the Money panel with Confirm and Correct.</li>}
    </ul>
  );
}
