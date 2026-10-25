import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { LIVERY_SEQUENCE, PRODUCT_ID, PRODUCT_STATION, SCENES } from '../../data/story';
import { LIVERIES, sceneState, setLiverySequence, stationValues, type LiveryKey } from '../../three/state';

gsap.registerPlugin(ScrollTrigger);

const ACTIVE_LINE = '55%';

/**
 * Scroll → scene state. One scrubbed timeline moves the camera, livery and
 * exploded parts between stations, holding still through the middle of each
 * scene so the copy can be read; section triggers give React the active index.
 */
export function useStoryTimeline(container: RefObject<HTMLElement>, reduceMotion: boolean, started: boolean) {
  const [active, setActive] = useState(0);
  const [parked, setParked] = useState(false);
  const [layout, setLayout] = useState(0);

  // Section positions are measured once; rebuild the timeline when the viewport changes.
  useLayoutEffect(() => {
    let t = 0;
    let w = window.innerWidth;
    const onResize = () => {
      if (Math.abs(window.innerWidth - w) < 2) return; // mobile URL bar show/hide only changes height
      w = window.innerWidth;
      clearTimeout(t);
      t = window.setTimeout(() => setLayout(n => n + 1), 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const stations = [...SCENES.map(s => stationValues(s.station, mobile)), stationValues(PRODUCT_STATION, mobile)];
    const ids = [...SCENES.map(s => s.id), PRODUCT_ID];
    const lock = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('livery') : null;
    setLiverySequence(lock && lock in LIVERIES ? LIVERY_SEQUENCE.map(() => lock as LiveryKey) : LIVERY_SEQUENCE);
    Object.assign(sceneState, stations[0], { liveryT: 0 });

    const ctx = gsap.context(() => {
      const sections = ids.map(id => document.getElementById(id)!);
      const stage = document.getElementById('pw-stage');
      const progress = document.querySelector<HTMLElement>('.progress');

      sections.forEach((sec, i) =>
        ScrollTrigger.create({
          trigger: sec,
          start: i === 0 ? 'top bottom' : `top ${ACTIVE_LINE}`,
          end: `bottom ${ACTIVE_LINE}`,
          onToggle: self => {
            if (!self.isActive) return;
            sceneState.section = i;
            setActive(i);
            if (reduceMotion) gsap.set(sceneState, { ...stations[i], liveryT: i });
          },
        })
      );
      ScrollTrigger.create({ trigger: sections[sections.length - 1], start: 'top 5%', onToggle: self => setParked(self.isActive) });
      ScrollTrigger.create({
        trigger: sections[sections.length - 1],
        start: 'top 95%',
        end: 'top 20%',
        scrub: true,
        onUpdate: self => {
          if (stage) stage.style.setProperty('--stage-fade', String(self.progress));
        },
      });
      ScrollTrigger.create({ start: 0, end: 'max', onUpdate: self => progress?.style.setProperty('transform', `scaleX(${self.progress})`) });

      if (reduceMotion) return;

      const vh = window.innerHeight;
      const total = el.offsetHeight - vh;
      const top0 = el.getBoundingClientRect().top + window.scrollY;
      const tl = gsap.timeline({
        defaults: { ease: 'power2.inOut' },
        scrollTrigger: { trigger: el, start: 'top top', end: 'bottom bottom', scrub: 0.8 },
      });
      let prevEnd = 0;
      sections.forEach((sec, i) => {
        if (i === 0) return;
        const top = sec.getBoundingClientRect().top + window.scrollY - top0;
        const centre = top + Math.min(sec.offsetHeight, vh) * 0.5 - vh * 0.5;
        const p = gsap.utils.clamp(0, 1, centre / total);
        const hold = (Math.min(sec.offsetHeight, vh * 1.5) / total) * 0.16;
        const start = Math.max(prevEnd + 0.002, p - hold);
        const duration = start - prevEnd;
        tl.to(sceneState, { ...stations[i], duration }, prevEnd);
        // Livery wipe runs over the middle 70% of the camera move.
        tl.to(sceneState, { liveryT: i, duration: duration * 0.7, ease: 'power1.inOut' }, prevEnd + duration * 0.15);
        prevEnd = Math.min(0.999, p + hold);
      });
      tl.to({}, { duration: 0.001 }, 1); // pad so timeline progress == scroll progress
    }, el);

    return () => ctx.revert();
  }, [container, reduceMotion, layout]);

  // Hero light sweep once the preloader has lifted.
  useLayoutEffect(() => {
    if (!started) return;
    const tween = gsap.to(sceneState, { sweep: 1, duration: reduceMotion ? 0.01 : 2.8, delay: 0.2, ease: 'power2.inOut' });
    return () => {
      tween.kill();
    };
  }, [started, reduceMotion]);

  return { active, parked };
}

/** Renders "[WORD]" segments in the accent colour. */
function Headline({ id, lines, hero }: { id: string; lines: string[]; hero: boolean }) {
  const content = lines.map((line, i) => (
    <span key={i} className="headline-line">
      {line.split(/(\[[^\]]+\])/).map((part, j) =>
        part.startsWith('[') ? (
          <span key={j} className="accent">
            {part.slice(1, -1)}
          </span>
        ) : (
          part
        )
      )}
    </span>
  ));
  return hero ? (
    <h1 id={id} className="copy-reveal">
      {content}
    </h1>
  ) : (
    <h2 id={id} className="copy-reveal">
      {content}
    </h2>
  );
}

export function StoryScenes({ active, hero }: { active: number; hero?: ReactNode }) {
  return (
    <>
      {SCENES.map((s, i) => (
        <section key={s.id} id={s.id} className={`scene${i === 0 ? ' scene--hero' : ''}${i === active ? ' is-active' : ''}`} aria-labelledby={`${s.id}-h`}>
          <div className="scene-copy">
            <div className="overline copy-reveal">
              <i aria-hidden="true" />
              {s.overline}
            </div>
            <Headline id={`${s.id}-h`} lines={s.headline} hero={i === 0} />
            <p className="desc copy-reveal">{s.body}</p>
            {s.facts && (
              <dl className="facts copy-reveal">
                {s.facts.map(f => (
                  <div key={f.k}>
                    <dt>{f.k}</dt>
                    <dd>{f.v}</dd>
                  </div>
                ))}
              </dl>
            )}
            {i === 0 && hero}
          </div>
        </section>
      ))}
    </>
  );
}
