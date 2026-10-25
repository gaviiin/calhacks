import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Local files the agents write, served to the dashboard by the dev server only. Seat codes are the
// one-time invites `make bootstrap` mints for the human seats (agents/state/seat_codes.json): on a
// local demo the person at the screen takes a seat with one; anywhere real they arrive out of band.
const LOCAL_FILES: Record<string, string> = {
  '/local/seats': 'agents/state/seat_codes.json',
  '/local/scorecard': 'agents/out/scorecard.json',
  '/local/onboarding': 'agents/out/onboarding_report.md',
};

// Simulations the dashboard can start on this machine: each is a Makefile target. The dev server
// spawns `make <target>` and keeps the tail of its output; the dashboard polls /local/sim. Online
// (Claude) when ANTHROPIC_API_KEY is in .env, offline (deterministic) otherwise.
const SIM_TARGETS: Record<string, { label: string; desk: 'cost' | 'revenue' | 'evidence' | 'race'; note: string }> = {
  'race-demo': { label: 'Replay São Paulo 2024 live', desk: 'race', note: 'OpenF1 → telemetry → Jev → incidents → playbook → ERP → season → close, into pit-wall as it happens' },
  'race-reset': { label: 'Clean slate for the replay', desk: 'race', note: 'wipes pit-wall, reloads the FIA evidence, relearns 2024, seats this browser' },
  'cost-cap-run': { label: 'Run January end to end', desk: 'cost', note: 'fresh module → bootstrap → sync → learner → approve policies → analyst → standing → gateway → red team → score' },
  sync: { label: 'Sync the systems of record', desk: 'cost', note: 'world → golden rows → work items' },
  learner: { label: 'Policy Learner onboarding', desk: 'cost', note: 'drafts house policies from 2025' },
  'review-policies': { label: 'Head of Cost Cap approves policies', desk: 'cost', note: 'approve every proposed policy' },
  analyst: { label: 'Cap Analyst over the queue', desk: 'cost', note: 'proposes under policies, asks what no policy covers' },
  standing: { label: 'Standing approvals', desk: 'cost', note: 'approves what an approved rule decided' },
  gateway: { label: 'ERP gateway', desk: 'cost', note: 'posts APPROVED items' },
  redteam: { label: 'Red team', desk: 'cost', note: 'every forbidden action must be denied and logged' },
  score: { label: 'Score against the truth file', desk: 'cost', note: 'writes the scorecard' },
  advance: { label: 'Advance the sim clock a month', desk: 'cost', note: 'the world emits the next month of lines' },
  'evidence-replay': { label: 'Replay the FIA captures', desk: 'evidence', note: '200 real FIA documents into pit-wall' },
};

interface Job {
  target: string;
  startedAt: number;
  endedAt: number | null;
  code: number | null;
  lines: string[];
}

const jobs = new Map<string, Job>();

function startJob(target: string, env: NodeJS.ProcessEnv): Job {
  const job: Job = { target, startedAt: Date.now(), endedAt: null, code: null, lines: [] };
  jobs.set(target, job);
  const child = spawn('make', [target], { cwd: REPO, env, shell: false });
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      const t = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      if (t) job.lines.push(t);
    }
    if (job.lines.length > 400) job.lines.splice(0, job.lines.length - 400);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    job.endedAt = Date.now();
    job.code = code ?? -1;
  });
  child.on('error', (e) => {
    job.lines.push(`could not start make: ${e.message}`);
    job.endedAt = Date.now();
    job.code = -1;
  });
  return job;
}

async function readEnv(): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  try {
    for (const line of (await readFile(resolve(REPO, '.env'), 'utf8')).split('\n')) {
      const mm = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (mm) m.set(mm[1], mm[2].replace(/^["']|["']$/g, ''));
    }
  } catch {
    /* no .env yet */
  }
  return m;
}

async function writeEnv(updates: Record<string, string>) {
  const path = resolve(REPO, '.env');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    /* new file */
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z0-9_]+$/.test(k)) continue;
    const re = new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=.*$`, 'm');
    const line = `${k}=${v}`;
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  }
  await writeFile(path, text, 'utf8');
}

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
};

const body = (req: import('node:http').IncomingMessage) =>
  new Promise<string>((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => ok(s));
  });

function localFiles(): Plugin {
  return {
    name: 'pit-wall-local',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const file = LOCAL_FILES[url];
        if (file) {
          try {
            const text = await readFile(resolve(REPO, file), 'utf8');
            res.setHeader('content-type', file.endsWith('.md') ? 'text/markdown' : 'application/json');
            res.setHeader('cache-control', 'no-store');
            return res.end(text);
          } catch {
            return json(res, 404, { error: `${file} not found` });
          }
        }
        // ---------------------------------------------------------------- simulations
        if (url === '/local/sim' && req.method === 'GET') {
          const env = await readEnv();
          return json(res, 200, {
            targets: SIM_TARGETS,
            online: Boolean(env.get('ANTHROPIC_API_KEY')),
            jobs: [...jobs.values()].map((j) => ({ ...j, lines: j.lines.slice(-40) })),
          });
        }
        const m = url.match(/^\/local\/sim\/([a-z-]+)$/);
        if (m && req.method === 'POST') {
          const target = m[1];
          if (!SIM_TARGETS[target]) return json(res, 400, { error: 'unknown simulation' });
          const running = jobs.get(target);
          if (running && running.endedAt === null) return json(res, 409, { error: 'already running' });
          const env = await readEnv();
          const procEnv: NodeJS.ProcessEnv = { ...process.env };
          for (const [k, v] of env) procEnv[k] = v;
          // The race reset seats the browser that asked: its pit-wall identity, 64 hex characters, nothing else.
          const asked = await body(req).catch(() => '');
          const id = (() => {
            try {
              return String((JSON.parse(asked || '{}') as { browserId?: string }).browserId ?? '');
            } catch {
              return '';
            }
          })();
          if (/^[0-9a-f]{64}$/.test(id)) procEnv.BROWSER_ID = id;
          if (!env.get('ANTHROPIC_API_KEY')) procEnv.OFFLINE = '1';
          else delete procEnv.OFFLINE;
          return json(res, 202, { started: startJob(target, procEnv).target });
        }
        // ---------------------------------------------------------------- connections
        if (url === '/local/connections' && req.method === 'GET') {
          const env = await readEnv();
          const set: Record<string, string> = {};
          for (const [k, v] of env) if (v) set[k] = /TOKEN|SECRET|PASSWORD|KEY|SID/.test(k) ? `•••• ${v.slice(-4)}` : v;
          return json(res, 200, { set });
        }
        if (url === '/local/connections' && req.method === 'POST') {
          try {
            const updates = JSON.parse(await body(req)) as Record<string, string>;
            await writeEnv(updates);
            return json(res, 200, { saved: Object.keys(updates) });
          } catch (e) {
            return json(res, 400, { error: String(e) });
          }
        }
        // ---------------------------------------------------------------- documents
        const docsDir = resolve(REPO, 'world/contracts');
        const uploads = resolve(REPO, 'uploads');
        if (url === '/local/documents' && req.method === 'GET') {
          const list = async (dir: string, kind: string) => {
            if (!existsSync(dir)) return [];
            const names = (await readdir(dir)).filter((n) => !n.startsWith('.'));
            return Promise.all(names.map(async (n) => ({ name: n, kind, bytes: (await stat(resolve(dir, n))).size, at: (await stat(resolve(dir, n))).mtimeMs })));
          };
          return json(res, 200, { documents: [...(await list(docsDir, 'contract')), ...(await list(uploads, 'upload'))].sort((a, b) => b.at - a.at) });
        }
        if (url === '/local/documents' && req.method === 'POST') {
          try {
            const { name, dataUrl } = JSON.parse(await body(req)) as { name: string; dataUrl: string };
            const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
            const b64 = dataUrl.split(',')[1] ?? '';
            await mkdir(uploads, { recursive: true });
            await writeFile(resolve(uploads, safe), Buffer.from(b64, 'base64'));
            return json(res, 200, { saved: safe });
          } catch (e) {
            return json(res, 400, { error: String(e) });
          }
        }
        return next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localFiles()],
  server: {
    port: 5173,
    proxy: {
      // the revenue desk API (finance/api.py)
      '/api': { target: process.env.PITWALL_API ?? 'http://localhost:8000', changeOrigin: true },
    },
  },
});
