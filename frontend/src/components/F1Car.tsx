import { useId } from 'react';

// Meridian's car, side on, nose to the right: an original drawing in the desk's own livery (graphite,
// a lime flash, Meridian's sponsors where their money is painted). The full car carries hotspots,
// one per sponsor, and shows what the race did to it: crash damage at the front in coral, a
// disqualification greyed out. `mini` is the same car as a small silhouette for the running order.

export type CarState = 'running' | 'crashed' | 'dsq' | 'out';

export interface Hotspot {
  id: string;
  label: string;
  /** clauses earned at the current position */
  earning: boolean;
}

/** where each sponsor's name is painted, in the drawing's coordinates */
export const ZONES: Record<string, { x: number; y: number; part: string }> = {
  halcyon: { x: 612, y: 196, part: 'sidepod' },
  arcadia: { x: 150, y: 30, part: 'rear wing' },
  volta: { x: 990, y: 190, part: 'nose' },
  northwind: { x: 462, y: 124, part: 'engine cover' },
  ridgeline: { x: 1080, y: 306, part: 'front wing' },
};

interface Props {
  number?: string;
  state?: CarState;
  spinning?: boolean;
  hotspots?: Hotspot[];
  selected?: string | null;
  onSelect?: (id: string) => void;
  damage?: string | null;
  mini?: boolean;
  tone?: 'team' | 'field';
  className?: string;
  title?: string;
}

function Wheel({ cx, cy, r, spinning, id }: { cx: number; cy: number; r: number; spinning: boolean; id: string }) {
  return (
    <g className="f1-wheel">
      <circle cx={cx} cy={cy} r={r} fill="#0b0d10" />
      <circle cx={cx} cy={cy} r={r - 3} fill="none" stroke="#23282f" strokeWidth={2} />
      {/* tyre sidewall band: the compound colour */}
      <circle cx={cx} cy={cy} r={r * 0.74} fill="none" stroke={`url(#${id}-band)`} strokeWidth={r * 0.07} />
      <circle cx={cx} cy={cy} r={r * 0.62} fill={`url(#${id}-rim)`} />
      <g className={spinning ? 'f1-spokes f1-spokes--spin' : 'f1-spokes'} style={{ transformOrigin: `${cx}px ${cy}px` }}>
        {Array.from({ length: 10 }, (_, k) => {
          const a = (k / 10) * Math.PI * 2;
          return (
            <line
              key={k}
              x1={cx + Math.cos(a) * r * 0.16}
              y1={cy + Math.sin(a) * r * 0.16}
              x2={cx + Math.cos(a) * r * 0.58}
              y2={cy + Math.sin(a) * r * 0.58}
              stroke="#4a535d"
              strokeWidth={r * 0.05}
              strokeLinecap="round"
            />
          );
        })}
        <circle cx={cx + r * 0.52} cy={cy} r={r * 0.04} fill="#c9ff4b" />
      </g>
      <circle cx={cx} cy={cy} r={r * 0.16} fill="#15181d" stroke="#5c6670" strokeWidth={2} />
      <circle cx={cx} cy={cy} r={r * 0.06} fill="#c9ff4b" />
    </g>
  );
}

export function F1Car({ number = '63', state = 'running', spinning = false, hotspots = [], selected, onSelect, damage, mini, tone = 'team', className, title }: Props) {
  const id = useId().replace(/:/g, '');
  const crashed = state === 'crashed';
  const grey = state === 'dsq' || state === 'out' || tone === 'field';
  const accent = tone === 'field' ? '#7d8790' : '#c9ff4b';

  return (
    <svg
      viewBox="0 0 1200 330"
      className={`f1car${mini ? ' f1car--mini' : ''}${grey ? ' f1car--grey' : ''}${state !== 'running' ? ` f1car--${state}` : ''}${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={title ?? `Meridian car ${number}`}
    >
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5d6873" />
          <stop offset="0.22" stopColor="#353d47" />
          <stop offset="0.7" stopColor="#1b2027" />
          <stop offset="1" stopColor="#0f1216" />
        </linearGradient>
        <linearGradient id={`${id}-pod`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#47515c" />
          <stop offset="0.5" stopColor="#262c34" />
          <stop offset="1" stopColor="#12161a" />
        </linearGradient>
        <linearGradient id={`${id}-wing`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#14181d" />
          <stop offset="1" stopColor="#2d343d" />
        </linearGradient>
        <radialGradient id={`${id}-rim`}>
          <stop offset="0" stopColor="#2a3038" />
          <stop offset="1" stopColor="#14171c" />
        </radialGradient>
        <linearGradient id={`${id}-band`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f3f3f0" />
          <stop offset="1" stopColor="#aab5bc" />
        </linearGradient>
        <linearGradient id={`${id}-flash`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={accent} stopOpacity="0" />
          <stop offset="0.35" stopColor={accent} />
          <stop offset="1" stopColor={accent} />
        </linearGradient>
        <radialGradient id={`${id}-shadow`}>
          <stop offset="0" stopColor="#000" stopOpacity="0.7" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>

      {/* ground shadow */}
      <ellipse cx="600" cy="306" rx="560" ry="16" fill={`url(#${id}-shadow)`} />

      {spinning && !mini && (
        <g className="f1-speedlines" stroke="#aab5bc" strokeLinecap="round">
          <line x1="-40" y1="120" x2="70" y2="120" />
          <line x1="-80" y1="180" x2="40" y2="180" />
          <line x1="-20" y1="236" x2="90" y2="236" />
        </g>
      )}

      <g className="f1-body">
        {/* floor and plank */}
        <path d="M190 262 L960 262 L1000 270 L960 278 L190 278 Z" fill="#0d1014" />
        <path d="M300 278 L880 278 L880 283 L300 283 Z" fill="#3a2a1c" opacity="0.8" />
        {/* diffuser */}
        <path d="M150 248 L230 248 L240 272 L170 272 Z" fill="#101317" />

        {/* rear wing: endplate, mainplane, flap, beam wing */}
        <path d="M96 60 L176 54 L196 70 L196 214 L112 222 L96 206 Z" fill={`url(#${id}-wing)`} stroke="#3c444d" strokeWidth="2" />
        <path d="M86 58 Q150 40 214 56 L214 70 Q150 58 90 72 Z" fill="#2c333c" stroke="#4b545e" strokeWidth="1.5" />
        <path d="M92 80 Q150 66 210 78 L208 90 Q150 80 96 92 Z" fill="#1d2228" />
        <path d="M118 182 Q170 176 230 186 L228 196 Q170 188 120 194 Z" fill="#20262d" />
        <rect x="96" y="60" width="6" height="146" fill={accent} opacity="0.9" />

        {/* gearbox and rear crash structure */}
        <path d="M150 206 L238 194 L250 248 L156 250 Z" fill="#161a20" />

        {/* engine cover, airbox, chassis and nose in one sweep */}
        <path
          d={`M168 214
              C 190 180, 260 162, 330 148
              C 400 132, 450 112, 488 96
              L 530 92
              C 540 92, 544 100, 544 112
              L 546 142
              L 690 146
              C 760 150, 850 168, 940 192
              C 1000 206, 1060 214, 1104 222
              L 1110 232
              C 1050 236, 990 236, 930 234
              L 720 236
              L 260 248
              L 176 250 Z`}
          fill={`url(#${id}-body)`}
          stroke="#56606b"
          strokeWidth="1.5"
        />
        {/* airbox inlet and roll hoop */}
        <path d="M498 100 L530 96 L534 126 L506 128 Z" fill="#07090c" />
        <path d="M488 96 L530 92" stroke="#7b8691" strokeWidth="2" />

        {/* sidepod with its inlet and undercut */}
        <path
          d="M300 236 C 320 200, 360 178, 420 172 L 640 166 C 660 166, 668 174, 668 184 L 668 226 C 600 236, 420 240, 300 236 Z"
          fill={`url(#${id}-pod)`}
          stroke="#4a545e"
          strokeWidth="1.5"
        />
        <path d="M640 170 L664 172 L664 220 L646 222 Z" fill="#06080a" />
        <path d="M320 236 C 400 228, 560 226, 666 222" stroke="#0a0c0f" strokeWidth="6" fill="none" opacity="0.8" />

        {/* the lime flash along the car */}
        <path d={`M300 214 C 420 206, 560 202, 690 198 C 820 196, 960 214, 1090 226 L 1090 232 C 960 222, 820 206, 690 206 C 560 210, 420 214, 300 222 Z`} fill={`url(#${id}-flash)`} opacity="0.95" />

        {/* cockpit, mirror, halo, driver */}
        <path d="M546 142 C 580 138, 640 138, 690 146 L 690 152 L 546 150 Z" fill="#050608" />
        <circle cx="596" cy="126" r="21" fill={tone === 'field' ? '#9aa4ad' : '#f3f3f0'} />
        <path d="M580 118 Q600 110 616 120 L614 130 Q600 124 582 128 Z" fill="#0b0d10" />
        <path d="M584 120 Q600 114 612 122" stroke={accent} strokeWidth="3" fill="none" />
        <path d="M548 146 C 560 112, 610 100, 664 118 C 680 124, 690 136, 694 150" fill="none" stroke="#11151a" strokeWidth="11" strokeLinecap="round" />
        <path d="M548 146 C 560 112, 610 100, 664 118 C 680 124, 690 136, 694 150" fill="none" stroke="#5d6772" strokeWidth="3" strokeLinecap="round" />
        <path d="M690 150 L700 128" stroke="#11151a" strokeWidth="6" strokeLinecap="round" />
        <path d="M720 150 L742 140 L760 142 L752 150 Z" fill="#2a3139" stroke="#5c6670" strokeWidth="1" />

        {/* number on the nose */}
        <text x="790" y="194" className="f1-number" fill={tone === 'field' ? '#c3cbd2' : '#f3f3f0'} transform="skewX(-12)">
          {number}
        </text>

        {/* suspension */}
        <g stroke="#6b7680" strokeWidth="4" strokeLinecap="round">
          <line x1="906" y1="236" x2="800" y2="204" />
          <line x1="906" y1="240" x2="800" y2="230" />
          <line x1="256" y1="236" x2="350" y2="214" />
          <line x1="256" y1="240" x2="340" y2="240" />
        </g>
      </g>

      {/* front wing: drawn apart so it can break off */}
      <g className="f1-frontwing">
        <path d="M960 272 Q1040 258, 1132 262 L1136 276 Q1040 276, 962 284 Z" fill="#20262d" stroke="#4b545e" strokeWidth="1.5" />
        <path d="M980 262 Q1050 248, 1126 250 L1128 258 Q1050 258, 982 270 Z" fill="#2d343d" />
        <path d="M1020 236 L1124 230 L1140 244 L1140 282 L1026 286 Z" fill={`url(#${id}-wing)`} stroke="#3c444d" strokeWidth="2" />
        <rect x="1134" y="232" width="5" height="50" fill={accent} opacity="0.9" />
      </g>

      <Wheel cx={256} cy={238} r={66} spinning={spinning} id={id} />
      <Wheel cx={906} cy={240} r={63} spinning={spinning} id={id} />

      {!mini && (
        <g className="f1-sponsors">
          <text x="470" y="208" textAnchor="middle" className="f1-sponsor f1-sponsor--big">
            HALCYON
          </text>
          <text x="340" y="164" textAnchor="middle" className="f1-sponsor" transform="rotate(-12 340 164)">
            NORTHWIND
          </text>
          <text x="146" y="140" textAnchor="middle" className="f1-sponsor f1-sponsor--small" transform="rotate(-90 146 140)">
            ARCADIA
          </text>
          <text x="925" y="214" textAnchor="middle" className="f1-sponsor f1-sponsor--small" transform="rotate(9 925 214)">
            VOLTA
          </text>
          <text x="1080" y="266" textAnchor="middle" className="f1-sponsor f1-sponsor--tiny">
            RIDGELINE
          </text>
        </g>
      )}

      {crashed && (
        <g className="f1-damage">
          <ellipse cx="1010" cy="250" rx="150" ry="70" fill="#ff725f" opacity="0.28" filter={`url(#${id}-glow)`} />
          <path d="M860 196 L1150 196 L1150 300 L860 300 Z" fill="none" stroke="#ff725f" strokeWidth="2" strokeDasharray="8 6" />
          <g fill="#ff725f">
            <path d="M1150 300 l14 -8 l4 10 z" />
            <path d="M1172 286 l10 -4 l2 8 z" />
            <path d="M1140 312 l12 0 l-4 7 z" />
          </g>
          {!mini && damage && (
            <g transform="translate(830 132)">
              <rect width="200" height="26" rx="2" fill="#ff725f" />
              <text x="10" y="18" className="f1-damage-label">
                {damage}
              </text>
            </g>
          )}
        </g>
      )}

      {state === 'dsq' && !mini && (
        <g transform="rotate(-8 600 150)">
          <rect x="470" y="110" width="260" height="70" rx="3" fill="none" stroke="#ff725f" strokeWidth="5" />
          <text x="600" y="162" textAnchor="middle" className="f1-stamp">
            DSQ
          </text>
        </g>
      )}

      {!mini &&
        hotspots.map((h) => {
          const z = ZONES[h.id];
          if (!z) return null;
          const on = selected === h.id;
          return (
            <g
              key={h.id}
              className={`f1-hot${on ? ' f1-hot--on' : ''}${h.earning ? ' f1-hot--earning' : ''}`}
              transform={`translate(${z.x} ${z.y})`}
              onClick={() => onSelect?.(h.id)}
              role="button"
              tabIndex={0}
              aria-label={`${h.label}, ${z.part}${h.earning ? ', earning now' : ''}`}
              aria-pressed={on}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.(h.id)}
            >
              <circle r="30" className="f1-hot-ring" />
              <circle r="19" className="f1-hot-dot" />
              <path d="M-7 0 H7 M0 -7 V7" className="f1-hot-plus" />
            </g>
          );
        })}
    </svg>
  );
}
