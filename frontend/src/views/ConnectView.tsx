import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSpacetimeDB } from 'spacetimedb/react';
import { IconApproved, IconDoc, IconLive, IconMail, IconPlug, IconUpload } from '../components/icons';
import { useEvidence } from '../lib/evidence';
import { useRevenue } from '../lib/revenue';

// Connections: every system the desk reads from or speaks to, whether it is live, and the fields to
// connect it. Secrets go to .env on this machine through the dev server, masked on the way back.

interface Field {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
}

interface Connector {
  id: string;
  name: string;
  group: 'Data' | 'Approvals' | 'Accounting' | 'Models';
  what: string;
  fields: Field[];
  /** env keys that mean "configured" */
  needs: string[];
  docs?: string;
}

const CONNECTORS: Connector[] = [
  { id: 'fia', name: 'FIA documents (Apify)', group: 'Data', what: 'Stewards’ decisions and classifications from fia.com, captured by the monitor actor as they are published.', fields: [{ key: 'APIFY_TOKEN', label: 'Apify token', secret: true }, { key: 'APIFY_ACTOR_ID', label: 'Document monitor actor', placeholder: 'username/fia-document-monitor' }, { key: 'APIFY_DECISION_ACTOR_ID', label: 'Decision reader actor' }], needs: ['APIFY_TOKEN', 'APIFY_ACTOR_ID'] },
  { id: 'slack', name: 'Slack', group: 'Approvals', what: 'Parked entries land in a channel with Approve and Reject buttons; questions are answered in the thread.', fields: [{ key: 'SLACK_BOT_TOKEN', label: 'Bot token', secret: true }, { key: 'SLACK_SIGNING_SECRET', label: 'Signing secret', secret: true }, { key: 'SLACK_CHANNEL_FINANCE', label: 'Channel', placeholder: '#pit-wall' }, { key: 'SLACK_WEBHOOK_URL', label: 'Webhook URL (text only)' }], needs: ['SLACK_BOT_TOKEN'], docs: 'integrations/slack_manifest.yml' },
  { id: 'email', name: 'Email', group: 'Approvals', what: 'Approval links and the audit summary by email; SMTP, or Outlook through Microsoft Graph.', fields: [{ key: 'SMTP_HOST', label: 'SMTP host', placeholder: 'smtp.gmail.com' }, { key: 'SMTP_PORT', label: 'Port', placeholder: '587' }, { key: 'SMTP_USER', label: 'User' }, { key: 'SMTP_PASSWORD', label: 'Password', secret: true }, { key: 'SMTP_FROM', label: 'From' }, { key: 'EMAIL_TRANSPORT', label: 'Transport', placeholder: 'smtp or graph' }, { key: 'GRAPH_SENDER', label: 'Graph sender mailbox' }], needs: ['SMTP_HOST', 'SMTP_USER'] },
  { id: 'teams', name: 'Microsoft Teams', group: 'Approvals', what: 'Adaptive cards in a channel through a Workflows webhook.', fields: [{ key: 'TEAMS_WEBHOOK_URL', label: 'Workflows webhook URL' }], needs: ['TEAMS_WEBHOOK_URL'] },
  { id: 'sms', name: 'SMS (Twilio)', group: 'Approvals', what: 'Urgent items only: a CFO away from the desk gets a text with the link.', fields: [{ key: 'TWILIO_ACCOUNT_SID', label: 'Account SID', secret: true }, { key: 'TWILIO_AUTH_TOKEN', label: 'Auth token', secret: true }, { key: 'TWILIO_FROM', label: 'From number' }, { key: 'PHONE_PRIYA', label: 'CFO phone' }], needs: ['TWILIO_ACCOUNT_SID'] },
  { id: 'bc', name: 'Dynamics 365 Business Central', group: 'Accounting', what: 'Approved entries post to a general journal; account mapping in integrations/business_central_accounts.json.', fields: [{ key: 'MS_TENANT_ID', label: 'Entra tenant' }, { key: 'MS_CLIENT_ID', label: 'App (client) id' }, { key: 'MS_CLIENT_SECRET', label: 'Client secret', secret: true }, { key: 'BC_ENVIRONMENT', label: 'Environment', placeholder: 'Sandbox' }, { key: 'BC_COMPANY_ID', label: 'Company id' }, { key: 'BC_JOURNAL_ID', label: 'Journal id' }], needs: ['MS_TENANT_ID', 'MS_CLIENT_ID', 'BC_COMPANY_ID'] },
  { id: 'claude', name: 'Claude', group: 'Models', what: 'The Cap Analyst and Policy Learner draft with Claude; the revenue agent reads answers and writes explanations. Without a key both desks run their deterministic path.', fields: [{ key: 'ANTHROPIC_API_KEY', label: 'API key', secret: true }, { key: 'CCD_MODEL', label: 'Model', placeholder: 'claude-opus-5-5' }], needs: ['ANTHROPIC_API_KEY'] },
  { id: 'aoai', name: 'Azure OpenAI (auditor’s second opinion)', group: 'Models', what: 'The independent auditor asks a different model family for a second opinion.', fields: [{ key: 'AZURE_OPENAI_ENDPOINT', label: 'Endpoint' }, { key: 'AZURE_OPENAI_DEPLOYMENT', label: 'Deployment' }, { key: 'AZURE_OPENAI_API_KEY', label: 'API key', secret: true }], needs: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT'] },
];

interface Doc {
  name: string;
  kind: string;
  bytes: number;
  at: number;
}

function useLocal<T>(path: string, fallback: T, every = 0): [T, () => Promise<void>] {
  const [v, set] = useState<T>(fallback);
  const load = async () => {
    try {
      const r = await fetch(path, { cache: 'no-store' });
      if (r.ok) set((await r.json()) as T);
    } catch {
      /* dev server only */
    }
  };
  useEffect(() => {
    void load();
    if (!every) return;
    const t = window.setInterval(() => void load(), every);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  return [v, load];
}

function ConnectorCard({ c, set, onSaved }: { c: Connector; set: Record<string, string>; onSaved: () => Promise<void> }) {
  const configured = c.needs.every((k) => set[k]);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const updates = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
    const r = await fetch('/local/connections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) });
    setMsg(r.ok ? 'Saved to .env. Restart the API (make revenue-api) for it to pick the change up.' : 'Could not save: is the dashboard running from make dashboard?');
    setValues({});
    await onSaved();
  };
  return (
    <li className={`connector${configured ? ' connector--on' : ''}`}>
      <div className="connector-head">
        <span className={`connector-dot${configured ? ' connector-dot--on' : ''}`} aria-hidden />
        <span className="connector-name">{c.name}</span>
        <span className="connector-state">{configured ? 'connected' : 'not connected'}</span>
        <button className="btn btn--small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <IconPlug size={12} /> {configured ? 'Edit' : 'Connect'}
        </button>
      </div>
      <p className="connector-what muted">{c.what}</p>
      {open && (
        <form className="connector-form" onSubmit={save}>
          {c.fields.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                type={f.secret ? 'password' : 'text'}
                value={values[f.key] ?? ''}
                placeholder={set[f.key] ?? f.placeholder ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                autoComplete="off"
              />
            </label>
          ))}
          <div className="connector-actions">
            <button className="btn btn--primary" type="submit">
              Save
            </button>
            {c.docs && <span className="muted small">Setup: {c.docs}</span>}
          </div>
          {msg && <p className="small">{msg}</p>}
        </form>
      )}
    </li>
  );
}

export function ConnectView() {
  const costCap = useSpacetimeDB();
  const evidence = useEvidence();
  const revenue = useRevenue();
  const [env, reloadEnv] = useLocal<{ set: Record<string, string> }>('/local/connections', { set: {} });
  const [docs, reloadDocs] = useLocal<{ documents: Doc[] }>('/local/documents', { documents: [] });
  const [ms, setMs] = useState<Record<string, { configured: boolean }> | null>(null);
  const [test, setTest] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/microsoft/status', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then(setMs)
      .catch(() => setMs(null));
  }, []);
  const groups = useMemo(() => [...new Set(CONNECTORS.map((c) => c.group))], []);
  const live = [
    { label: 'cost-cap-desk (SpacetimeDB)', ok: costCap.isActive, note: 'work items, policies, audit log, agent steps' },
    { label: 'pit-wall (SpacetimeDB)', ok: evidence.connected, note: 'FIA documents, decisions, the revenue mirror' },
    { label: 'revenue API', ok: revenue.online, note: 'runs, queue, approvals, auditor' },
    { label: 'Business Central', ok: Boolean(ms?.business_central?.configured), note: 'general journal export' },
    { label: 'Azure OpenAI auditor', ok: Boolean(ms?.azure_openai_auditor?.configured), note: 'second opinion' },
  ];

  const upload = async (file: File) => {
    const dataUrl = await new Promise<string>((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.readAsDataURL(file);
    });
    await fetch('/local/documents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, dataUrl }) });
    await reloadDocs();
  };
  const sendTest = async (channel: string) => {
    setTest('sending');
    try {
      const r = await fetch('/api/notify/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel }) });
      const d = (await r.json().catch(() => ({}))) as { sent?: { status: string }[]; mode?: string; detail?: string };
      setTest(r.ok ? `${channel}: ${d.sent?.map((s) => s.status).join(', ') || 'rendered'} (mode ${d.mode ?? '?'})` : d.detail ?? `HTTP ${r.status}`);
    } catch {
      setTest('the revenue API is not reachable');
    }
  };

  return (
    <div className="connect">
      <section className="connect-live">
        <div className="sec-head">
          <h1>Connections</h1>
          <p className="muted">Where the desk's data comes from, where approvals go, and where entries post. Green is live now; connect the rest below.</p>
        </div>
        <ul className="live-list">
          {live.map((l) => (
            <li key={l.label} className={l.ok ? 'live live--ok' : 'live'}>
              <IconLive size={12} />
              <b>{l.label}</b>
              <span className="muted">{l.note}</span>
              <span className="live-state">{l.ok ? 'live' : 'not connected'}</span>
            </li>
          ))}
        </ul>
      </section>

      {groups.map((g) => (
        <section key={g} className="connect-group">
          <h2>{g}</h2>
          <ul className="connectors">
            {CONNECTORS.filter((c) => c.group === g).map((c) => (
              <ConnectorCard key={c.id} c={c} set={env.set} onSaved={reloadEnv} />
            ))}
          </ul>
          {g === 'Approvals' && (
            <div className="connect-test">
              <span className="muted">Send a test message:</span>
              {['slack', 'email', 'teams', 'sms'].map((ch) => (
                <button key={ch} className="btn btn--small" onClick={() => void sendTest(ch)}>
                  <IconMail size={12} /> {ch}
                </button>
              ))}
              {test && <span className="small">{test}</span>}
            </div>
          )}
        </section>
      ))}

      <section className="connect-docs">
        <div className="sec-head">
          <h2>Documents</h2>
          <p className="muted">Contracts and other documents the agents read: sponsor agreements, fair value schedules, policies. Drop a file here and it lands in the repo's uploads folder for the Contract Reader.</p>
        </div>
        <label className="dropzone">
          <IconUpload size={18} />
          <span>Choose a file or drop it here</span>
          <input type="file" multiple onChange={(e) => Array.from(e.target.files ?? []).forEach((f) => void upload(f))} />
        </label>
        <ul className="doc-list">
          {docs.documents.map((d) => (
            <li key={d.kind + d.name}>
              <IconDoc size={13} />
              <span>{d.name}</span>
              <span className="muted mono">{d.kind} · {(d.bytes / 1024).toFixed(0)} KB</span>
              {d.kind === 'contract' && (
                <span className="tone-ok small">
                  <IconApproved size={11} /> read by the Contract Reader
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
