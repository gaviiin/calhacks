import { useEffect, useState } from 'react';

/** Black curtain with the wordmark and a progress hairline; lifts once the car has rendered. */
export default function Preloader({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'lift' | 'gone'>('loading');
  const [minTime, setMinTime] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinTime(true), 1100);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (phase === 'loading' && ready && minTime) setPhase('lift');
  }, [ready, minTime, phase]);
  useEffect(() => {
    if (phase !== 'lift') return;
    const t = setTimeout(() => {
      setPhase('gone');
      onDone();
    }, 900);
    return () => clearTimeout(t);
  }, [phase, onDone]);
  if (phase === 'gone') return null;
  return (
    <div className={`preloader preloader--${phase}`} aria-hidden="true">
      <div className="preloader-mark">
        <span className="brandmark">PW</span>
        <span>
          PIT<i>/</i>WALL
        </span>
      </div>
      <div className="preloader-bar">
        <i />
      </div>
      <div className="preloader-meta">
        <span>CHASSIS PW-01</span>
        <span>{ready ? 'RENDER READY' : 'BUILDING CAR'}</span>
      </div>
    </div>
  );
}
