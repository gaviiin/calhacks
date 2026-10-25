import { useEffect, useMemo, useState } from 'react';
import { inboxItems } from './components/inboxModel';
import { Shell, useSeatStatus, type View } from './components/Shell';
import { useCostCap } from './lib/costcap';
import { useRevenue } from './lib/revenue';
import { AuditView } from './views/AuditView';
import { ConnectView } from './views/ConnectView';
import { RiskView } from './views/RiskView';
import { CostCapView } from './views/CostCapView';
import { EvidenceView } from './views/EvidenceView';
import { InboxView } from './views/InboxView';
import { Overview } from './views/Overview';
import { RevenueView } from './views/RevenueView';

// #/ · #/inbox/<key> · #/cost-cap · #/revenue · #/evidence · #/audit/<from>-<to>

interface Route {
  view: View;
  arg: string | null;
}

function parse(hash: string): Route {
  const [, view = '', ...rest] = hash.replace(/^#/, '').split('/');
  const known: View[] = ['inbox', 'cost-cap', 'risk', 'revenue', 'evidence', 'audit', 'connect'];
  return { view: (known as string[]).includes(view) ? (view as View) : 'overview', arg: rest.join('/') || null };
}

function useRoute(): [Route, (hash: string) => void] {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (h: string) => (window.location.hash = h)];
}

export default function App() {
  const [route, nav] = useRoute();
  const cc = useCostCap();
  const rev = useRevenue();
  const status = useSeatStatus();
  const inbox = useMemo(() => inboxItems(cc, rev.queue), [cc, rev.queue]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.view]);

  const auditWindow = useMemo<[number, number] | null>(() => {
    const m = route.view === 'audit' && route.arg?.match(/^(\d+)-(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }, [route]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Shell view={route.view} go={(v) => nav(v === 'overview' ? '/' : `/${v}`)} inboxCount={inbox.length} status={status} />
      <main id="main" className="page">
        {!cc.ready && route.view !== 'revenue' && route.view !== 'evidence' && route.view !== 'connect' ? (
          <p className="muted loading">Connecting to the cost cap desk on SpacetimeDB…</p>
        ) : route.view === 'overview' ? (
          <Overview inbox={inbox} status={status} />
        ) : route.view === 'inbox' ? (
          <InboxView inbox={inbox} selected={route.arg} select={(k) => nav(`/inbox/${k}`)} status={status} />
        ) : route.view === 'cost-cap' ? (
          <CostCapView status={status} inbox={inbox} />
        ) : route.view === 'risk' ? (
          <RiskView />
        ) : route.view === 'connect' ? (
          <ConnectView />
        ) : route.view === 'revenue' ? (
          <RevenueView />
        ) : route.view === 'evidence' ? (
          <EvidenceView />
        ) : (
          <AuditView window={auditWindow} clearWindow={() => nav('/audit')} />
        )}
      </main>
      <footer className="colophon">
        <p>
          Real: 2024 F1 results (Jolpica), FIA documents (Apify captures of fia.com), the FIA Financial Regulations. Synthetic: Meridian Racing, its ledgers,
          sponsors, vendors and people.
        </p>
      </footer>
    </>
  );
}
