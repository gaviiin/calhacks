// "How it fits together": wires between the columns, and one event travelling left to right.

const STAGES: [string, string][][] = [
  [['openf1', 'normalize'], ['jolpica', 'normalize'], ['fia', 'normalize']],
  [['normalize', 'policy'], ['normalize', 'precedent'], ['normalize', 'jev'], ['normalize', 'claude'], ['history', 'precedent'], ['history', 'policy']],
  [['policy', 'life'], ['precedent', 'life'], ['jev', 'life'], ['precedent', 'plan'], ['claude', 'plan'], ['jev', 'ledger'], ['policy', 'ledger'], ['jev', 'sim']],
  [['life', 'stdb'], ['plan', 'stdb'], ['ledger', 'stdb'], ['sim', 'stdb']],
  [['stdb', 'erp'], ['stdb', 'dash'], ['stdb', 'notify'], ['stdb', 'seal']],
];
const STAGE_MS = 1100;

export function initFlow(root: HTMLElement, reduced: boolean) {
  const svg = root.querySelector<SVGSVGElement>('.flow-wires')!;
  const nodes = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>('[data-node]').forEach((n) => nodes.set(n.dataset.node!, n));
  const paths = new Map<string, SVGPathElement>();
  const ns = 'http://www.w3.org/2000/svg';
  const dots: SVGCircleElement[] = [];

  const layout = () => {
    if (getComputedStyle(svg).display === 'none') return;
    const box = root.getBoundingClientRect();
    svg.innerHTML = '';
    paths.clear();
    for (const stage of STAGES) {
      for (const [a, b] of stage) {
        const ra = nodes.get(a)!.getBoundingClientRect();
        const rb = nodes.get(b)!.getBoundingClientRect();
        const x1 = ra.right - box.left;
        const y1 = ra.top + ra.height / 2 - box.top;
        const x2 = rb.left - box.left;
        const y2 = rb.top + rb.height / 2 - box.top;
        const mx = (x1 + x2) / 2;
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
        svg.appendChild(p);
        paths.set(`${a}>${b}`, p);
      }
    }
    dots.length = 0;
    for (let i = 0; i < 8; i++) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('r', '3.5');
      c.style.opacity = '0';
      svg.appendChild(c);
      dots.push(c);
    }
  };
  layout();
  new ResizeObserver(layout).observe(root);

  let visible = false;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.2 }).observe(root);
  if (reduced) return;

  let start = performance.now();
  const tick = (now: number) => {
    requestAnimationFrame(tick);
    if (!visible || !paths.size) {
      start = now;
      return;
    }
    const t = (now - start) / STAGE_MS;
    const si = Math.floor(t) % STAGES.length;
    const u = t - Math.floor(t);
    const stage = STAGES[si];
    paths.forEach((p) => p.classList.remove('hot'));
    nodes.forEach((n) => n.classList.remove('hot'));
    stage.forEach(([a, b], i) => {
      const p = paths.get(`${a}>${b}`);
      if (!p) return;
      p.classList.add('hot');
      nodes.get(a)!.classList.add('hot');
      if (u > 0.85) nodes.get(b)!.classList.add('hot');
      const d = dots[i];
      if (!d) return;
      const len = p.getTotalLength();
      const e = 1 - Math.pow(1 - Math.min(1, u / 0.9), 3);
      const pt = p.getPointAtLength(len * e);
      d.setAttribute('cx', String(pt.x));
      d.setAttribute('cy', String(pt.y));
      d.style.opacity = u < 0.92 ? '1' : '0';
    });
    for (let i = stage.length; i < dots.length; i++) dots[i].style.opacity = '0';
  };
  requestAnimationFrame(tick);
}
