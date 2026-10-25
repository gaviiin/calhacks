// One stroke weight, one grid (16px, 1.6 stroke, square caps): the desk's own icon set.

type P = { size?: number; className?: string; title?: string };

function Svg({ size = 16, className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="square"
      strokeLinejoin="miter"
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {children}
    </svg>
  );
}

export const IconApproved = (p: P) => (
  <Svg {...p}>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </Svg>
);

export const IconDenied = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

export const IconWaiting = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3.4l2.2 1.4" />
  </Svg>
);

export const IconQuestion = (p: P) => (
  <Svg {...p}>
    <path d="M5.6 5.8C5.8 4.6 6.8 3.8 8 3.8c1.4 0 2.4.9 2.4 2.1 0 1.8-2.4 1.9-2.4 3.7" />
    <path d="M8 12.2v.2" />
  </Svg>
);

export const IconPolicy = (p: P) => (
  <Svg {...p}>
    <path d="M4 2.5h6l2.5 2.5v8.5H4z" />
    <path d="M6.2 7.5h4M6.2 10h4" />
  </Svg>
);

export const IconEntry = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11M8 2.5v11" />
  </Svg>
);

export const IconAgent = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="9" height="9" />
    <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
  </Svg>
);

export const IconPerson = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="5.5" r="2.6" />
    <path d="M3 14c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3" />
  </Svg>
);

export const IconDoc = (p: P) => (
  <Svg {...p}>
    <path d="M4 1.8h5.4L12.5 5v9.2H4z" />
    <path d="M9.2 1.8V5h3.3" />
  </Svg>
);

export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4" />
  </Svg>
);

export const IconArrow = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 8h10.5M9.5 4.5L13 8l-3.5 3.5" />
  </Svg>
);

export const IconShield = (p: P) => (
  <Svg {...p}>
    <path d="M8 1.8l5 1.9v4.1c0 3.1-2.1 5.4-5 6.4-2.9-1-5-3.3-5-6.4V3.7z" />
  </Svg>
);

export const IconLive = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.2" fill="currentColor" stroke="none" />
    <path d="M4.2 4.2a5.4 5.4 0 000 7.6M11.8 4.2a5.4 5.4 0 010 7.6" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M5.5 3.5v9M10.5 3.5v9" />
  </Svg>
);

export const IconSkip = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 3.5l6 4.5-6 4.5zM12.5 3.5v9" />
  </Svg>
);

export const IconRestart = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.5H6" />
  </Svg>
);

export const IconBolt = (p: P) => (
  <Svg {...p}>
    <path d="M9 1.8L3.8 9h4l-1 5.2L12.2 7h-4z" />
  </Svg>
);

export const IconRadio = (p: P) => (
  <Svg {...p}>
    <path d="M8 9.5v4.5M5.6 7.6a3.4 3.4 0 0 1 4.8 0M3.4 5.4a6.5 6.5 0 0 1 9.2 0" />
    <path d="M8 9.6h0" />
  </Svg>
);

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 3v10l8-5z" />
  </Svg>
);

export const IconPlug = (p: P) => (
  <Svg {...p}>
    <path d="M5 2v4M11 2v4M3.5 6h9v2.5a4.5 4.5 0 0 1-9 0zM8 13v2" />
  </Svg>
);

export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M8 11V3M4.5 6.5L8 3l3.5 3.5M3 13h10" />
  </Svg>
);

export const IconChart = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11M4 10l3-3.5 2.5 2L12 4.5" />
  </Svg>
);

export const IconMail = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 4h11v8.5h-11zM2.5 4.5L8 9l5.5-4.5" />
  </Svg>
);

export const IconFlag = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 14V2.5M3.5 3h9l-2 3 2 3h-9" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg {...p}>
    <path d="M4 4h8v8H4z" />
  </Svg>
);
