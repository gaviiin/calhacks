// "Every feature, and why it is built this way": one tab per piece of the desk.

interface Feature {
  name: string;
  files: string[];
  lede: string;
  how: string[];
  why: string[];
}

const FEATURES: Feature[] = [
  {
    name: 'Part life',
    files: ['race/life.py', 'race_part_life'],
    lede: 'Each of the 22 parts on the two cars has a life. Laps use it, stress events use more, crashes end it, and every change says when the replacement will be fitted.',
    how: [
      'Kilometres per part: a floor about 2,000, a gearbox 5,000, brake discs 1,600; a qualifying lap counts 1.15 times.',
      'Jev classifies each stress event none, light, moderate or heavy and names the parts it hit; a part loses 1, 5, 15 or 25% of its life times the chance it was hit.',
      'The tripwire marks the likely parts damaged at once; the garage\'s answer replaces them with spares, which start again at zero.',
      'From the weekend distance ahead, each part gets the race it runs out at, and a power unit or gearbox past its allocation is a grid penalty.',
    ],
    why: [
      'The cap excludes depreciation (Financial Regulations Issue 22, Art. 3.1(o)), so wear is never booked. It moves the forecast instead.',
      'A replacement counts against the cap when it is fitted. Life is what decides which year that is.',
      'A crash makes the next failure more likely; finance hears it as a date, not a feeling.',
    ],
  },
  {
    name: 'Telemetry tripwire',
    files: ['race/normalize.py', 'race/telemetry.py'],
    lede: 'The desk sees a crash in the car data, seconds before race control says anything, and often when it never does.',
    how: [
      'Code, not a model: more than 100 km/h to under 25 with the brake on, or telemetry frozen on OpenF1\'s sentinel values.',
      'A retirement is suspected when a car\'s laps stop for 2.5 median laps while the track is not red, and confirmed from the session result.',
      'Every event, replayed or live, is normalised to one RaceEvent shape, so the learner and the live desk read the same thing.',
    ],
    why: [
      'OpenF1 never announces a retirement: race control posts collisions, flags and penalties, not "car stopped".',
      'Incident messages lag and are free text; in Canada 2026 the desk calls Albon\'s stop two minutes before the stewards\' first message.',
      'At São Paulo the tripwire beat the red flag by 9 to 26 seconds on three crashes.',
    ],
  },
  {
    name: 'Jev, System One',
    files: ['race/jev.py'],
    lede: 'A fast typed classifier answers the per-event questions in 70 to 500 ms, every answer with a probability.',
    how: [
      'Per event: does it move money, how severe, who was at fault, which parts are likely hit, is a sponsor bonus at risk, would a person want a full plan.',
      'Every answer is logged on the effect row, so a reviewer sees what the fast path believed and how sure it was.',
      'Offline, a rule table produces the same shape, so the pipeline, the tests and the demo run without a network.',
    ],
    why: [
      'A session is thousands of events. A frontier model per event is too slow and too costly; a fast tier with probabilities is not.',
      'Probabilities are what let the desk decide when to ask: below a confidence floor of 0.5, a person is asked.',
      'Claude is kept for what needs reasoning: the repair and money plan after a crash, and the briefs.',
    ],
  },
  {
    name: 'Precedents and policies',
    files: ['race/precedents.py', 'race/policy_learner.py', 'race_policies'],
    lede: 'What the team did before decides first. A model is asked only for what the team\'s history does not cover.',
    how: [
      'Every past case is a small feature vector: kind, the stewards\' words, retired within two laps, pitted straight after, track status, damage likely, tyre.',
      'Seven nearest cases; at least three at 0.85 or above with 80% agreement make the protocol, which books on its own authority and names the cases.',
      'Groups with enough cases become Ripple-Down Rule policies. A policy is licensed when the 90% Wilson lower bound of its record clears 0.75 with five or more cases.',
    ],
    why: [
      'Teams repeat themselves: 52 routine pit stops, 33 safety-car stops, 16 procedural infringements decided the same way.',
      'Autonomy earned from the team\'s own record is something a Head of Cost Cap can audit; autonomy granted by configuration is not.',
      'Eras keep the learning honest: São Paulo learns only from races before it.',
    ],
  },
  {
    name: 'Response plans',
    files: ['race_plans', 'spacetimedb/src/index.ts'],
    lede: 'After a crash, every hardware operation and every entry that follows is one plan, each line with its closest case in the team\'s history.',
    how: [
      'Lines: spares reserved at the track or Grove, factory work orders, inventory moves, hand-carries and freight against the next cut-off, FIA notices, and the entries.',
      'The Chief of Staff approves the plan once. Every line with a precedent at 0.8 or above executes and posts on its own, whatever its amount.',
      'A precedent is the same part, booked the same way, at a price the team has paid before; an entry is split by part, so a booking above the team\'s history is caught part by part.',
      'A line with no precedent waits for the Head of Cost Cap, and their decision becomes the precedent.',
    ],
    why: [
      'In F1 the size of a bill says little about its risk. A $127k wing the team replaces every month is routine; a $1.08m tub it has never built mid-season is not.',
      'So there is no amount threshold: the team\'s history decides who looks at a line.',
      'One approval per crash, not one per line, is the difference between a desk people use and one they route around.',
    ],
  },
  {
    name: 'Books that keep themselves',
    files: ['race/ledger.py', 'race/erp.py', 'world/api.py'],
    lede: 'Balanced entries for every incident, each line saying when the cost cap counts it, posted through one gateway.',
    how: [
      '6050 crash damage against 1400 inventory when spares are fitted, or 2100 accrued for new parts; 5200 repair labour; 6300 freight; 6910 FIA fines outside the cap.',
      'Adjustments once the garage confirms; an adjustment never reaches the ERP ahead of the entry it adjusts.',
      'The ERP accepts a race entry only when pit-wall authorized it: 403 otherwise, 503 if pit-wall cannot be asked.',
    ],
    why: [
      'Cap timing per line is the question a Head of Cost Cap actually asks: does this land in 2024 or 2025?',
      'An agent holding the gateway key still cannot post around the rule, because the rule lives in the database.',
      'Fines are booked but excluded from the cap, and the exclusion is confirmed by a person.',
    ],
  },
  {
    name: 'Ask a person',
    files: ['race/questions.py', 'race_question_timers'],
    lede: 'A person is asked only when the call is theirs, or when a wrong guess would cost more than the question.',
    how: [
      'Asked when the expected loss of a wrong call tops the price of asking, or when Jev is below its confidence floor.',
      'The question shows two cases the team has lived through, so the Chief Mechanic answers in one click.',
      'The deadline is a scheduled reducer in the database: when it comes due the conservative default applies, even if no agent is running.',
    ],
    why: [
      'A garage on race day will not fill in forms. One click, two real cases, a clock.',
      'A person\'s assessment outranks every later machine read, and the answer settles the crash once: lines, books and the desk\'s memory.',
      'A default applies the safe option but signs nothing off.',
    ],
  },
  {
    name: 'Season and cap',
    files: ['race/season_sim.py', 'race/cap_forecast.py', 'capsim/'],
    lede: 'After every change, 10,000 seasons and 10,000 cap years, so the championship and the cap are never stale when someone decides.',
    how: [
      'Each team\'s finishing positions this season, resampled with recency weights (half-life six rounds), DNFs at the rate they happened.',
      'Common random numbers: every run of a weekend uses the same draws, so the change between two runs is the evidence, split into our weekend and the rivals\'.',
      'The cap year: booked costs, this weekend, the rest-of-year plan with its noise, Poisson crashes per race, less the sprint adjustments.',
    ],
    why: [
      'Prize money, the wind-tunnel allowance and sponsor bonuses all hang on the constructors\' place.',
      'A crash is a cap event and a championship event at once; the CFO needs both on the same night.',
      'Vectorised numpy: 10,000 seasons in about 80 ms.',
    ],
  },
  {
    name: 'Seal and true-up',
    files: ['race/close.py', 'race/trueup.py', 'race_closes'],
    lede: 'On Sunday night the weekend is sealed and briefed; weeks later it is compared with the actuals.',
    how: [
      'A snapshot of every entry, sealed under one RFC 6962 Merkle root, so any row can be proven part of the seal.',
      'Claude drafts a brief per role; a check rejects any figure that is not in the snapshot, and every figure cites its row.',
      'Nothing goes out until the CFO approves. The true-up compares the seal with the actuals and recalibrates the price book.',
    ],
    why: [
      'Race-day numbers are provisional. Saying so, and sealing them, is what makes them usable on Monday morning.',
      'São Paulo sealed at $3.92m; the press reported "nearly $4m" weeks later.',
      'The true-up is how the price book stops being an assumption.',
    ],
  },
];

export function initFeatures(root: HTMLElement) {
  const list = root.querySelector<HTMLElement>('.feat-list')!;
  const body = root.querySelector<HTMLElement>('.feat-body')!;
  const buttons = FEATURES.map((f, i) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.id = `feat-${i}`;
    b.innerHTML = `<span>${String(i + 1).padStart(2, '0')}</span><b>${f.name}</b>`;
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        select((i + 1) % FEATURES.length, true);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        select((i - 1 + FEATURES.length) % FEATURES.length, true);
      }
    });
    list.appendChild(b);
    return b;
  });
  function select(i: number, focus = false) {
    buttons.forEach((b, j) => {
      b.setAttribute('aria-selected', String(i === j));
      b.tabIndex = i === j ? 0 : -1;
    });
    if (focus) buttons[i].focus();
    const f = FEATURES[i];
    body.setAttribute('aria-labelledby', `feat-${i}`);
    body.innerHTML = `
      <h3>${f.name}</h3>
      <div class="feat-files">${f.files.map((x) => `<code>${x}</code>`).join('')}</div>
      <p class="feat-lede">${f.lede}</p>
      <div class="feat-cols">
        <div><h4>How it is engineered</h4><ul>${f.how.map((x) => `<li>${x}</li>`).join('')}</ul></div>
        <div class="feat-why"><h4>Why, for Formula 1</h4><ul>${f.why.map((x) => `<li>${x}</li>`).join('')}</ul></div>
      </div>`;
    body.style.animation = 'none';
    void body.offsetWidth;
    body.style.animation = '';
  }
  select(0);
}
