// "Every API and service we used": a marquee, then a searchable list.

interface Item {
  name: string;
  cat: string;
  what: string;
  where: string;
}

const STACK: Item[] = [
  { name: 'OpenF1 REST API', cat: 'Race data', what: 'Laps, car telemetry, race control, positions, pit stops, session results', where: 'race/openf1.py' },
  { name: 'OpenF1 live (MQTT)', cat: 'Race data', what: 'The live feed on the paid tier; the client is ready', where: 'race/live.py' },
  { name: 'Jolpica-F1', cat: 'Race data', what: 'Results and standings, 2023 to 2026, for the season simulation', where: 'world/results' },
  { name: 'FIA documents, via an Apify actor', cat: 'Race data', what: '200 stewards\' decisions and classifications, with publication times', where: 'ingestion/' },
  { name: 'FIA Financial Regulations', cat: 'Race data', what: 'Issue 22 (2021-25) and the 2026 Section D, as versioned data', where: 'rulebook/' },
  { name: 'Press figures, sourced', cat: 'Race data', what: 'Part prices, crash costs and spares, each with its source', where: 'race/prices.py, race/data' },
  { name: 'Jev, by TypeSafe AI', cat: 'AI', what: 'System One: typed per-event answers with probabilities in 70-500 ms', where: 'race/jev.py' },
  { name: 'Vercel AI Gateway', cat: 'AI', what: 'Routes Jev for gateway keys', where: 'race/jev.py' },
  { name: 'Claude Opus 5.5', cat: 'AI', what: 'System Two: the repair and money plan after a crash, the per-role briefs', where: 'race/forecast_agent.py, race/close.py' },
  { name: 'Claude Sonnet 5.5 and Haiku 5.5', cat: 'AI', what: 'The cost cap analyst\'s drafts and the policy reviews', where: 'agents/' },
  { name: 'Anthropic SDK', cat: 'AI', what: 'Structured outputs for every model call, offline fallbacks for each', where: 'agents/llm.py' },
  { name: 'SpacetimeDB 2.13, pit-wall', cat: 'Database', what: '34 tables and 40 reducers: the gate, the audit row, seats, postings, plans', where: 'spacetimedb/' },
  { name: 'SpacetimeDB, cost-cap-desk', cat: 'Database', what: 'Work items, Ripple-Down Rule policies, allocations, the audit log', where: 'system_of_work/' },
  { name: 'Scheduled reducers', cat: 'Database', what: 'Question deadlines kept by the database, defaults applied with no agent running', where: 'race_question_timers' },
  { name: 'SpacetimeDB TypeScript SDK', cat: 'Database', what: 'Live subscriptions behind every view', where: 'frontend/' },
  { name: 'SQLite', cat: 'Database', what: 'The revenue desk\'s ledger, re-checked by its kernel', where: 'finance/' },
  { name: 'Python 3.13 and uv', cat: 'Compute', what: 'The race desk, the agents, the worlds', where: 'race/, agents/' },
  { name: 'NumPy', cat: 'Compute', what: '10,000 seasons in about 80 ms, common random numbers', where: 'race/season_sim.py' },
  { name: 'FastAPI', cat: 'Compute', what: 'The ERP and systems of record, the revenue desk API', where: 'world/api.py, finance/api.py' },
  { name: 'capsim', cat: 'Compute', what: 'A teammate\'s cost cap Monte Carlo: crash and spend models', where: 'capsim/' },
  { name: 'ERP gateway', cat: 'Integrations', what: 'Accepts a race entry only when pit-wall authorized it', where: 'world/api.py' },
  { name: 'Microsoft Business Central', cat: 'Integrations', what: 'Journal postings from the revenue desk', where: 'finance/erp' },
  { name: 'Slack, email, Teams, SMS', cat: 'Integrations', what: 'Approvals and notices; dry run until switched live', where: 'finance/notify' },
  { name: 'Fetch.ai agents', cat: 'Integrations', what: 'A sponsor agent and a dispute demo', where: 'agents/fetchai' },
  { name: 'Azure, Bicep', cat: 'Integrations', what: 'Deployment templates', where: 'deploy/azure' },
  { name: 'React 18, Vite 7, TypeScript', cat: 'Frontend', what: 'The dashboard: a view per role', where: 'frontend/' },
  { name: 'WebGL2 blueprint engine', cat: 'Frontend', what: 'Instanced anti-aliased lines, 34 parts built in a Web Worker', where: 'frontend/src/blueprint' },
  { name: 'three.js', cat: 'Frontend', what: 'This page\'s crash, on the same car model', where: 'pitch/' },
  { name: 'pytest', cat: 'Testing', what: '516 tests across the desks, the evidence pipeline, the rulebook', where: 'race/tests, agents/tests' },
  { name: 'vitest', cat: 'Testing', what: '132 module tests, the gate and the plans included', where: 'spacetimedb/test' },
  { name: 'Red team', cat: 'Testing', what: '15 of 15 forbidden actions denied and logged', where: 'agents/redteam.py' },
  { name: 'Planted-error answer keys', cat: 'Testing', what: 'Truth files the agents never see', where: 'world/out' },
  { name: 'Telemetry tripwire', cat: 'Built by us', what: 'Sees a crash before race control', where: 'race/telemetry.py' },
  { name: 'Part life model', cat: 'Built by us', what: 'Laps, stress events and crashes into each part\'s life and cap year', where: 'race/life.py' },
  { name: 'Precedent store and Policy Learner', cat: 'Built by us', what: 'Nearest cases, Ripple-Down Rules, the Wilson licence', where: 'race/precedents.py, race/policy_learner.py' },
  { name: 'Response plans', cat: 'Built by us', what: 'A precedent per line, one approval per crash', where: 'race_plans' },
  { name: 'The seal and the true-up', cat: 'Built by us', what: 'RFC 6962 Merkle root, briefs that cite every row, recalibration', where: 'race/close.py, race/trueup.py' },
];

export function initStack(root: HTMLElement) {
  const marquee = root.querySelector<HTMLElement>('[data-marquee]')!;
  const names = STACK.map((s) => `<span>${s.name}</span>`).join('');
  marquee.innerHTML = names + names;

  const list = root.querySelector<HTMLElement>('[data-stack]')!;
  const q = root.querySelector<HTMLInputElement>('[data-stack-q]')!;
  const catsBox = root.querySelector<HTMLElement>('[data-stack-cats]')!;
  const count = root.querySelector<HTMLElement>('[data-stack-count]')!;
  const cats = ['All', ...new Set(STACK.map((s) => s.cat))];
  let cat = 'All';
  const buttons = cats.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = c;
    b.addEventListener('click', () => {
      cat = c;
      render();
    });
    catsBox.appendChild(b);
    return b;
  });
  const render = () => {
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b.textContent === cat)));
    const term = q.value.trim().toLowerCase();
    const shown = STACK.filter((s) => (cat === 'All' || s.cat === cat) && (!term || `${s.name} ${s.what} ${s.where} ${s.cat}`.toLowerCase().includes(term)));
    list.innerHTML = shown.length
      ? shown.map((s) => `<li><b>${s.name}</b><em>${s.cat}</em><span>${s.what}</span><code>${s.where}</code></li>`).join('')
      : `<li class="stack-empty">Nothing matches "${q.value.replace(/[<>&"]/g, '')}".</li>`;
    count.textContent = `${shown.length} of ${STACK.length}`;
  };
  q.addEventListener('input', render);
  render();
}
