import { useRef, type CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { SCENES } from '../../data/story';
import { sceneState } from '../state';

/**
 * Engineering callouts anchored to the car. Visibility follows `sceneState.section`
 * imperatively so a scene change never re-renders the canvas tree.
 */
export default function Callouts() {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useFrame(() => {
    const sec = sceneState.section;
    for (const el of refs.current) {
      if (!el) continue;
      const on = Number(el.dataset.scene) === sec && sceneState.fade < 0.5;
      if (on !== el.classList.contains('is-on')) el.classList.toggle('is-on', on);
    }
  });
  let k = 0;
  return (
    <>
      {SCENES.map((scene, i) =>
        scene.callouts.map((c, j) => {
          const idx = k++;
          const left = c.dx < 0;
          return (
            <Html key={`${scene.id}-${j}`} position={c.at} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <div
                ref={el => (refs.current[idx] = el)}
                data-scene={i}
                className={`callout${left ? ' callout--left' : ''}`}
                style={{ '--dx': `${c.dx}px`, '--dy': `${c.dy}px`, '--delay': `${0.3 + j * 0.2}s` } as CSSProperties}
              >
                <svg className="callout-line" width={Math.abs(c.dx) + 4} height={Math.abs(c.dy) + 4} style={{ left: left ? c.dx - 2 : -2, top: c.dy < 0 ? c.dy - 2 : -2 }}>
                  <line x1={left ? Math.abs(c.dx) + 2 : 2} y1={c.dy < 0 ? Math.abs(c.dy) + 2 : 2} x2={left ? 2 : Math.abs(c.dx) + 2} y2={c.dy < 0 ? 2 : Math.abs(c.dy) + 2} pathLength={1} />
                </svg>
                <i className="callout-dot" />
                <div className="callout-label">
                  <b>{c.label}</b>
                  <span>{c.value}</span>
                  {c.delta && <em className={c.tone ?? ''}>{c.delta}</em>}
                </div>
              </div>
            </Html>
          );
        })
      )}
    </>
  );
}
