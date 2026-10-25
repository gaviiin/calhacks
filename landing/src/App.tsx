import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { PRODUCT_ID, SCENES, liveryAccent, liveryName } from './data/story';
import IncidentDemo from './components/landing/IncidentDemo';
import Preloader from './components/landing/Preloader';
import ProductReveal from './components/landing/ProductReveal';
import RaceCar from './components/landing/RaceCar';
import { ChapterRail, SiteNav, Telemetry } from './components/landing/SiteChrome';
import { StoryScenes, useStoryTimeline } from './components/landing/ScrollStory';

// three.js only loads once the page has painted; the SVG car stands in until then.
const Scene = lazy(() => import('./three/Scene'));

// The marketing shell links out to the real product; it never talks to its backend.
const APP_URL = import.meta.env.VITE_PITWALL_APP_URL ?? 'http://localhost:5173';

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function usePrefersReducedMotion() {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduce, setReduce] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setReduce(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

function FallbackCar({ color, reduceMotion }: { color: string; reduceMotion: boolean }) {
  return (
    <div className="car-wrap">
      <RaceCar color={color} reduceMotion={reduceMotion} />
    </div>
  );
}

export default function App() {
  const reduceMotion = usePrefersReducedMotion();
  const storyRef = useRef<HTMLDivElement>(null);
  const [webgl] = useState(hasWebGL);
  const [ready, setReady] = useState(!webgl);
  const [started, setStarted] = useState(false);
  const { active, parked } = useStoryTimeline(storyRef, reduceMotion, started);
  const scene = SCENES[Math.min(active, SCENES.length - 1)];
  const inProduct = active >= SCENES.length;
  const accent = inProduct ? '#c9ff4b' : liveryAccent(scene.livery);
  const onReady = useCallback(() => setReady(true), []);
  const onStarted = useCallback(() => setStarted(true), []);

  // Accent colour for the HTML layer (rail, overlines, callouts) follows the livery.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--car-color', accent);
    root.setProperty('--glow', `${accent}2e`);
  }, [accent]);

  useEffect(() => {
    document.documentElement.classList.toggle('is-started', started);
  }, [started]);

  return (
    <>
      <Preloader ready={ready} onDone={onStarted} />
      <div className="progress" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
      <a className="skip-link" href={`#${PRODUCT_ID}`}>
        Skip the story: go to the interactive incident
      </a>
      <SiteNav />

      <div className="stage" id="pw-stage" aria-hidden="true">
        {webgl ? (
          <Suspense fallback={null}>
            <Scene reduceMotion={reduceMotion} running={!parked} onReady={onReady} />
          </Suspense>
        ) : (
          <FallbackCar color={accent} reduceMotion={reduceMotion} />
        )}
        <div className="hud">
          <div className="hud-spec">
            <div>
              <b>PW—01</b>
              <small>CHASSIS</small>
            </div>
            <div>
              <b>{inProduct ? 'CARBON / LIME' : liveryName(scene.livery)}</b>
              <small>LIVERY</small>
            </div>
            <div>
              <b>
                {scene.number} / {scene.focus}
              </b>
              <small>FOCUS</small>
            </div>
          </div>
          <Telemetry />
          <div className={`stage-status${active === 4 ? ' stage-status--hold' : ''}`}>
            <span />
            {active === 4 ? 'HOLD / AWAITING CONTROLLER' : 'TRACKING THE MONEY BEHIND THE RACE'}
          </div>
        </div>
      </div>
      <ChapterRail active={active} />

      <main>
        <div className="story" ref={storyRef}>
          <StoryScenes
            active={active}
            hero={
              <>
                <div className="hero-cta copy-reveal">
                  <a className="solid-btn" href={`#${SCENES[1].id}`}>
                    START THE STORY <span aria-hidden="true">↓</span>
                  </a>
                  <a className="outline-btn" href={`#${PRODUCT_ID}`}>
                    TRY THE INCIDENT ↗
                  </a>
                </div>
                <div className="scroll-cue copy-reveal">
                  <i aria-hidden="true" />
                  SCROLL · THE CAR IS THE STORY
                </div>
              </>
            }
          />

          <section id={PRODUCT_ID} className={`product${inProduct ? ' is-active' : ''}`} aria-labelledby="product-title">
            <ProductReveal reduceMotion={reduceMotion}>
              <div className="dashboard-heading">
                <div>
                  <div className="overline">
                    <i aria-hidden="true" />
                    06 / THE PRODUCT / INTERACTIVE EXAMPLE
                  </div>
                  <h2 id="product-title">
                    <span className="headline-line">FROM CHAOS.</span>
                    <span className="headline-line lime">TO CONTROL.</span>
                  </h2>
                </div>
                <p>Result changes → contract effect → accounting consequence → recommended action → approval. Run the simulated incident and watch the car's four stations become a finance desk.</p>
              </div>
              <IncidentDemo />
            </ProductReveal>
            <p className="footnote">
              DEMONSTRATION ONLY. FIGURES, CONTRACT CLAUSES, STANDINGS AND APPROVALS IN THIS SIMULATION ARE EXAMPLES. IT DOES NOT CONNECT TO A FINANCE BACKEND OR LEDGER.
            </p>
            <div className="final-cta">
              <div>
                <div className="overline">
                  <i aria-hidden="true" />
                  THE FINISH LINE IS JUST THE START
                </div>
                <h2>
                  <span className="headline-line">EVERY DECISION.</span>
                  <span className="headline-line lime">DEFENSIBLE.</span>
                </h2>
              </div>
              <div className="final-actions">
                <a className="solid-btn" href={APP_URL}>
                  OPEN THE LIVE EVIDENCE FEED <span aria-hidden="true">↗</span>
                </a>
                <a className="outline-btn" href="#start">
                  BACK TO THE GRID ↑
                </a>
                <small>Real FIA documents via Apify → SpacetimeDB. Evidence only, no journal entries.</small>
              </div>
            </div>
          </section>
        </div>
      </main>
      <footer className="site-footer">
        <span>© 2026 PIT WALL / CONCEPT EXPERIENCE</span>
        <span>FICTIONAL CAR AND LIVERIES. NOT AFFILIATED WITH FORMULA 1, THE FIA OR ANY TEAM.</span>
      </footer>
    </>
  );
}
