import { useLayoutEffect, useRef, useState } from 'react';

const WIPE_MS = 950;
const SLANT = 140; // diagonal lean of the paint edge, in viewBox units
const BAND = 46; // width of the bright sheen that leads the wipe

// Painted bodywork panels. Everything else on the car is carbon and never changes,
// so a livery swap repaints the exact same geometry instead of swapping cars.
const PANELS = [
  { d: 'M113 93H185L189 101H109Z' },
  { d: 'M368 209L453 190L498 134L587 133L632 162L713 220L680 240L418 235Z', opacity: 0.93 },
  { d: 'M333 228L430 208L642 199L735 228L796 255L720 297L390 303L339 275Z' },
  { d: 'M716 226L781 236L1096 285L1102 297L787 255Z' },
  { d: 'M1006 298L1161 294L1190 304L1176 313L1039 310Z' },
];

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Polygon covering everything left of a slanted edge at `x` (the car faces right, so rear → nose). */
const edgePoints = (x: number) => `-300,0 ${x},0 ${x - SLANT},415 -300,415`;
const bandPoints = (x: number) =>
  `${x - BAND},0 ${x},0 ${x - SLANT},415 ${x - SLANT - BAND},415`;

function Panels({ fill, clip, extra }: { fill: string; clip?: string; extra?: object }) {
  return (
    <g clipPath={clip ? `url(#${clip})` : undefined} {...extra}>
      {PANELS.map(p => (
        <path key={p.d} d={p.d} fill={fill} opacity={p.opacity} />
      ))}
    </g>
  );
}

export default function RaceCar({ color, reduceMotion }: { color: string; reduceMotion: boolean }) {
  const [from, setFrom] = useState(color);
  const [to, setTo] = useState(color);
  const edgeRef = useRef<SVGPolygonElement>(null);
  const bandRef = useRef<SVGPolygonElement>(null);

  // A new livery always starts from whatever is fully painted now; a wipe
  // interrupted by fast scrolling snaps to its target first.
  useLayoutEffect(() => {
    if (color === to) return;
    setFrom(to);
    setTo(color);
  }, [color, to]);

  // Layout effect so the first wipe frame is set before paint: no flash of the new colour.
  useLayoutEffect(() => {
    const edge = edgeRef.current;
    const band = bandRef.current;
    if (!edge || !band) return;
    if (from === to || reduceMotion) {
      edge.setAttribute('points', edgePoints(1600));
      band.setAttribute('points', bandPoints(-400));
      return;
    }
    let raf = 0;
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / WIPE_MS);
      const x = -100 + easeInOut(t) * (1300 + SLANT + BAND);
      edge.setAttribute('points', edgePoints(x));
      band.setAttribute('points', bandPoints(x));
      if (t < 1) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [from, to, reduceMotion]);

  return (
    <svg viewBox="0 0 1200 415" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="pw-floor" x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#6f7b82" />
          <stop offset=".25" stopColor="#2c363e" />
          <stop offset=".7" stopColor="#0e141b" />
          <stop offset="1" stopColor="#010307" />
        </linearGradient>
        <linearGradient id="pw-body" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#717d87" />
          <stop offset=".18" stopColor="#353f47" />
          <stop offset=".52" stopColor="#131920" />
          <stop offset="1" stopColor="#0a0f14" />
        </linearGradient>
        <linearGradient id="pw-glass" x1="0" x2=".8" y1="0" y2="1">
          <stop stopColor="#64727f" />
          <stop offset="1" stopColor="#0a0e14" />
        </linearGradient>
        <linearGradient id="pw-tyre" x1="0" x2="1" y1="0" y2="1">
          <stop stopColor="#343a3c" />
          <stop offset=".23" stopColor="#0d1113" />
          <stop offset=".8" stopColor="#020304" />
          <stop offset="1" stopColor="#2a3030" />
        </linearGradient>
        <linearGradient id="pw-satin" x1="0" x2="0" y1="0" y2="1">
          <stop stopColor="#fff" stopOpacity=".34" />
          <stop offset=".35" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".38" />
        </linearGradient>
        <clipPath id="pw-wipe">
          <polygon ref={edgeRef} points={edgePoints(1600)} />
        </clipPath>
        <clipPath id="pw-band">
          <polygon ref={bandRef} points={bandPoints(-400)} />
        </clipPath>
      </defs>

      <ellipse cx="616" cy="358" rx="530" ry="21" fill="#000" opacity=".72" />
      <path d="M98 303 L1115 303 1131 326 115 326Z" fill="#12171d" />

      {/* rear wing, beam and diffuser */}
      <path d="M107 103H194L203 125H103Z" fill="url(#pw-body)" stroke="#697780" strokeWidth="2" />
      <path d="M94 111H206V123H90Z" fill="#0e1219" />
      <path d="M164 125L189 125L222 266L200 285L177 170Z" fill="#10171e" stroke="#343d45" />
      <path d="M120 310L206 289L325 311L282 341L143 333Z" fill="#0f151b" />
      <path d="M124 317L193 298L285 314" fill="none" stroke="#5d6468" strokeWidth="3" />

      {/* chassis */}
      <path
        d="M184 282C230 249 290 230 347 213L453 190L493 135L630 136L689 175L779 235L914 246L1104 281L1134 301L1108 322H192L146 313Z"
        fill="url(#pw-body)"
        stroke="#43505a"
        strokeWidth="3"
      />
      <path d="M705 221L793 229L1100 278L1128 297L1045 303L796 263Z" fill="#151c23" />

      {/* floor and front wing (under the wing paint) */}
      <path d="M206 303L379 303L795 303L1050 300L1155 300L1172 318L1131 332L214 331Z" fill="url(#pw-floor)" />
      <path d="M950 307L1150 304L1184 318L1153 331L954 324Z" fill="#11171d" stroke="#5c666c" />

      {/* livery: old paint, new paint wiping rear → nose, sheen on the wipe edge, satin shading */}
      <Panels fill={from} />
      <Panels fill={to} clip="pw-wipe" />
      <Panels fill="#ffffff" clip="pw-band" extra={{ opacity: 0.55 }} />
      <Panels fill="url(#pw-satin)" />

      {/* engine cover detail, cockpit, halo */}
      <path d="M407 213L475 187L508 151L578 149L627 183L651 217Z" fill="#0f151b" opacity=".65" />
      <path d="M467 186L503 140L622 141L655 176L589 184Z" fill="url(#pw-glass)" />
      <path d="M476 173 Q502 100 576 103 Q630 103 654 171" stroke="#0c1116" strokeWidth="17" fill="none" strokeLinecap="round" />
      <path d="M476 173 Q502 100 576 103 Q630 103 654 171" stroke="#87929a" strokeOpacity=".55" strokeWidth="4" fill="none" />
      <path d="M560 108V176" stroke="#252d36" strokeWidth="12" />
      <path d="M560 110V171" stroke="#6e7b83" strokeWidth="2" />
      <path d="M519 146L568 121L606 140L620 158L553 167Z" fill="#14191d" />
      <path d="M530 148L574 129L592 138" fill="none" stroke="#9cabb0" strokeWidth="2" opacity=".5" />

      {/* sidepod inlet and undercut */}
      <path d="M364 234L452 217L656 216L742 241L693 266L386 274Z" fill="#12191d" opacity=".8" />
      <path d="M403 283L718 278L756 255L774 264L727 302L367 304Z" fill="#090e14" />
      <path d="M385 287L718 285" stroke="#a1b1b2" strokeWidth="2" opacity=".6" />

      {/* nose highlight and front suspension */}
      <path d="M813 247L1106 302" stroke="#fff" strokeWidth="3" opacity=".28" />
      <path d="M772 258L939 292M790 286L943 266" stroke="#505b61" strokeWidth="8" />
      <path d="M771 258L940 289M790 285L943 266" stroke="#11171c" strokeWidth="4" />

      <path d="M1015 310L1177 309" stroke="#aeb7bb" strokeWidth="2" opacity=".6" />

      {/* fast lines and decals */}
      <path d="M351 222L448 201L632 197" fill="none" stroke="#fff" strokeWidth="2" opacity=".42" />
      <path d="M418 300L655 300" stroke="#a9bcc0" opacity=".26" strokeWidth="2" />
      <text x="482" y="263" fontFamily="Barlow Condensed,Arial" fontSize="43" fontWeight="900" letterSpacing="-1" fill="#f1f4f2">
        PIT<tspan className="car-fill">/</tspan>WALL
      </text>
      <text x="480" y="281" fontFamily="IBM Plex Mono,monospace" fontSize="10" fill="#9eaaad" letterSpacing="2">
        RACE FINANCE INTELLIGENCE
      </text>
      <text x="663" y="186" fontFamily="IBM Plex Mono,monospace" fontSize="13" fontWeight="600" fill="#dde3e1">
        PW—01
      </text>

      <Wheel cx={286} cy={292} r={97} />
      <Wheel cx={954} cy={296} r={91} />
    </svg>
  );
}

function Wheel({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const s = r / 97;
  const spoke = 54 * s;
  const diag = 38 * s;
  const spokes = `M${cx} ${cy - spoke}V${cy + spoke}M${cx - spoke} ${cy}H${cx + spoke}M${cx - diag} ${cy - diag}L${cx + diag} ${cy + diag}M${cx - diag} ${cy + diag}L${cx + diag} ${cy - diag}`;
  const arcR = r - 3;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#010203" stroke="#242a2d" strokeWidth="6" />
      <circle cx={cx} cy={cy} r={r - 9} fill="url(#pw-tyre)" stroke="#393f42" strokeWidth="9" />
      <circle cx={cx} cy={cy} r={r - 27} fill="none" stroke="#535c5d" strokeWidth="1.5" strokeDasharray="10 7" opacity=".6" />
      <circle cx={cx} cy={cy} r={r - 38} fill="#090c0d" stroke="#747b7c" strokeWidth="3" />
      <g className="wheel-spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <path d={spokes} stroke="#78828a" strokeWidth={9 * s} />
        <path d={spokes} stroke="#192128" strokeWidth="4" />
      </g>
      <circle cx={cx} cy={cy} r={29 * s} fill="#1d262b" stroke="#adbdc3" strokeWidth="3" />
      <circle cx={cx} cy={cy} r={12 * s} className="car-fill" />
      <path
        d={`M${cx - arcR * 0.78} ${cy - arcR * 0.53}A${arcR} ${arcR} 0 0 1 ${cx + arcR * 0.78} ${cy - arcR * 0.5}`}
        fill="none"
        className="car-stroke"
        strokeWidth="4"
        opacity=".9"
      />
    </g>
  );
}
