import { useEffect, useMemo, useState } from 'react';
import { inboxItems } from './components/inboxModel';
import { Shell, useSeatStatus, type View } from './components/Shell';
import { useCostCap } from './lib/costcap';
import { useRace } from './lib/race';
import { useRevenue } from './lib/revenue';
import { AuditView } from './views/AuditView';
import { ConnectView } from './views/ConnectView';
import { RiskView } from './views/RiskView';
import { RaceReplayView } from './views/RaceReplayView';
import { RaceView } from './views/RaceView';
import { CostCapView } from './views/CostCapView';
import { EvidenceView } from './views/EvidenceView';
import { InboxView } from './views/InboxView';
import { Overview } from './views/Overview';
import { RevenueView } from './views/RevenueView';
import { AuditTabsView } from './views/AuditTabsView';
import { BooksView } from './views/BooksView';
import { RaceDayView } from './views/RaceDayView';
import { HomeView } from './views/desk/HomeView';
import { PresentView } from './views/desk/PresentView';
import { LearnedView } from './views/desk/LearnedView';

// #/ the car, one crash at a time (home) · #/instruments every instrument on one page · #/day/<garage|strategy|accounting|cfo> the role views · #/inbox/<key> · #/books/<race|cost-cap|revenue> · #/audit[/evidence|/<from>-<to>]
// still routable, off the nav: #/race (the full live desk) · #/replay/<season>-<round> · #/risk · #/pitwall (old overview)
// · #/cost-cap · #/revenue · #/evidence · #/connect (the gear)

interface Route {
  view: View;
  arg: string | null;
}

function parse(hash: string): Route {
  const [, view = '', ...rest] = hash.replace(/^#/, '').split('/');
  if (view === 'day') return { view: 'overview', arg: rest.join('/') || null };
  const known: View[] = ['instruments', 'learned', 'race', 'replay', 'inbox', 'books', 'cost-cap', 'risk', 'revenue', 'evidence', 'audit', 'connect', 'pitwall'];
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
  const race = useRace();
  const inbox = useMemo(() => inboxItems(cc, rev.queue, race), [cc, rev.queue, race]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [route.view]);

  const auditWindow = useMemo<[number, number] | null>(() => {
    const m = route.view === 'audit' && route.arg?.match(/^(\d+)-(\d+)$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }, [route]);

  return (
    <div className="g-ground">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Shell view={route.view} arg={route.arg} />
      <main id="main" className="page">
        {route.view === 'overview' && !route.arg ? (
          <PresentView nav={nav} />
        ) : route.view === 'learned' ? (
          <LearnedView />
        ) : route.view === 'instruments' ? (
          <HomeView nav={nav} />
        ) : route.view === 'overview' ? (
          <RaceDayView role={route.arg} nav={nav} />
        ) : route.view === 'replay' ? (
          <RaceReplayView arg={route.arg} nav={nav} inbox={inbox} status={status} />
        ) : route.view === 'race' ? (
          <RaceView />
        ) : route.view === 'books' ? (
          <BooksView tab={route.arg} nav={nav} status={status} inbox={inbox} costCapReady={cc.ready} />
        ) : route.view === 'audit' && !auditWindow ? (
          <AuditTabsView tab={route.arg} nav={nav} window={auditWindow} costCapReady={cc.ready} />
        ) : !cc.ready && route.view !== 'revenue' && route.view !== 'evidence' && route.view !== 'connect' ? (
          <p className="muted loading">Connecting to the cost cap desk on SpacetimeDB…</p>
        ) : route.view === 'pitwall' ? (
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
          Not affiliated with Williams Racing. Real: OpenF1 timing and car telemetry, Jolpica results, FIA documents (Apify captures of fia.com), the FIA Financial Regulations. Money on race day is press
          estimates and stated assumptions; the cost cap and revenue desks behind Books run on Meridian Racing, a synthetic team with its own ledgers, sponsors and people.
        </p>
      </footer>
    </div>
  );
}
