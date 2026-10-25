// A single stacked horizontal bar: how a whole splits into parts, with a 2px surface gap between
// segments, direct labels below, and a legend. Used for "who decided" and "where the cap stands".

export interface Part {
  key: string;
  label: string;
  value: number;
  color: string;
  /** outline instead of fill (something not yet real) */
  outline?: boolean;
}

export function Composition({ parts, format, ariaLabel }: { parts: Part[]; format: (v: number) => string; ariaLabel: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0) || 1;
  let acc = 0;
  return (
    <div className="composition" role="img" aria-label={ariaLabel}>
      <div className="composition-bar">
        {parts.map((p) => {
          const w = (Math.max(0, p.value) / total) * 100;
          const left = acc;
          acc += w;
          return p.value > 0 ? (
            <span
              key={p.key}
              className={`composition-seg${p.outline ? ' composition-seg--outline' : ''}`}
              style={{ left: `${left}%`, width: `calc(${w}% - 2px)`, background: p.outline ? 'transparent' : `var(${p.color})`, boxShadow: p.outline ? `inset 0 0 0 1px var(${p.color})` : undefined }}
              title={`${p.label}: ${format(p.value)}`}
            />
          ) : null;
        })}
      </div>
      <ul className="composition-legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="swatch" style={p.outline ? { boxShadow: `inset 0 0 0 1px var(${p.color})` } : { background: `var(${p.color})` }} />
            <b className="mono">{format(p.value)}</b>
            <span className="muted">{p.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
