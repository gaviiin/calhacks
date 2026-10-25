import * as THREE from 'three';
import type { Frame } from './scene';
import { TAGGED } from './scene';
import { clamp, clockAt, easeInOut, expoOut, fmtClock, smooth, span, speedAt, T, window01 } from './timeline';

// Everything over the canvas: the telemetry readout, the captions, the paperwork that buries the crash,
// and the garage's part tags, all keyed to the same scroll position as the scene.

interface Win {
  cls?: string;
  bar: string;
  html: string;
  x: number; // % of the stage
  y: number;
  w: number; // px
  r: number; // deg
  at: number; // 0..1 inside the paperwork window
  phone?: boolean; // shown on narrow screens
}

const trace = `<svg viewBox="0 0 200 56"><path d="M0 8 H8 M0 28 H200 M0 48 H200" stroke="#ebecf0"/><path d="M0 10 C40 8 70 12 98 9 L104 10 C108 30 112 44 118 48 L200 48" fill="none" stroke="#0052cc" stroke-width="2"/><line x1="112" x2="112" y1="0" y2="56" stroke="#de350b" stroke-dasharray="3 2"/></svg>`;

// Illustrative: the shape of the mess every team lives with. None of it is a Williams document.
const WINDOWS: Win[] = [
  { bar: 'Inbox (38)', x: 3, y: 15, w: 300, r: -2.5, at: 0.0, phone: true, html: `
    <div class="row unread"><b>FIA Technical Delegate</b><span>Car 23: chassis seal check before</span></div>
    <div class="row unread"><b>Grove Stores</b><span>RE: RE: RE: spare tub status??</span></div>
    <div class="row unread"><b>Freight desk</b><span>LAS cut-off moved to Tue 18:00</span></div>
    <div class="row"><b>Head of Cost Cap</b><span>how much of this lands in 2024?</span></div>
    <div class="row"><b>Press office</b><span>statement on Albon by 14:00</span></div>` },
  { bar: 'cost_cap_2024_v9_FINAL(3).xlsx', x: 66, y: 13, w: 300, r: 2, at: 0.06, phone: true, html: `
    <table><tr><th>part</th><th>cost</th><th>cap yr</th><th>booked</th></tr>
    <tr><td>tub</td><td class="bad">???</td><td>2024?</td><td>no</td></tr>
    <tr><td>floor</td><td>280k?</td><td></td><td>no</td></tr>
    <tr><td>gearbox</td><td class="bad">#REF!</td><td></td><td></td></tr>
    <tr><td>front wing</td><td>127k</td><td>2024</td><td>?</td></tr></table>` },
  { bar: '#garage-sp', x: 7, y: 56, w: 250, r: 1.5, at: 0.12, phone: true, html: `
    <span class="msg">is the tub salvageable</span><br><span class="msg">need a call before 14:00</span><br>
    <span class="msg me">who's telling finance?</span><br><span class="msg">stores say 0 floors, sheet says 1</span>` },
  { cls: 'alert', bar: 'Team Principal', x: 70, y: 54, w: 260, r: -1.5, at: 0.17, phone: true, html: `
    <div class="big">3 h 28 m</div><div>to the start. Repair, spare tub, or withdraw?</div>` },
  { bar: 'WO-24-3317 · Grove', x: 36, y: 9, w: 230, r: -1, at: 0.24, html: `
    <b>Build spare monocoque</b><div>est. 12–14 h · crew: ?</div><div>start: <span class="bad">not scheduled</span></div>` },
  { bar: 'Hand carry · SAO → LAS', x: 40, y: 72, w: 240, r: 2.5, at: 0.3, phone: true, html: `
    <div class="row"><b>3 boxes</b><span>wing, floor, corner</span></div><div class="row"><b>Cut-off</b><span>Tue 18:00</span></div><div class="row"><b>Quote</b><span class="bad">pending</span></div>` },
  { bar: 'INV-GRV-11873.pdf', x: 84, y: 34, w: 210, r: 3, at: 0.36, html: `
    <div>Carbon composites</div><div class="big">£412,880</div><div>due in 30 days</div><span class="stamp">NOT ACCRUED</span>` },
  { bar: 'telemetry · car 23', x: 1, y: 38, w: 230, r: -3, at: 0.4, html: trace + `<div>315 → 0 km/h · 11:57:19</div>` },
  { cls: 'note', bar: '', x: 52, y: 22, w: 190, r: 4, at: 0.45, phone: true, html: `PU 3 or 4?? we're at the allocation` },
  { bar: 'Notice to the Stewards (draft)', x: 22, y: 30, w: 250, r: 1, at: 0.5, html: `
    <div>Car 23 will not take the start.</div><div>Signed: <span class="bad">—</span></div>` },
  { bar: 'Parc fermé change request', x: 58, y: 76, w: 230, r: -2.5, at: 0.55, html: `
    <div class="row"><b>Car 23</b><span>11 items</span></div><div class="row"><b>Status</b><span>needs TD sign-off</span></div>` },
  { bar: 'Spares manifest', x: 80, y: 66, w: 220, r: 1.5, at: 0.6, html: `
    <table><tr><th>part</th><th>track</th><th>Grove</th></tr><tr><td>front wing</td><td>2</td><td>3</td></tr>
    <tr><td>floor</td><td class="bad">0</td><td>1</td></tr><tr><td>tub</td><td>1 bare</td><td>0</td></tr></table>` },
  { bar: 'ERP · journal', x: 14, y: 80, w: 220, r: 2, at: 0.66, html: `
    <div class="row"><b>Pending entries</b><span>0</span></div><div class="row"><b>Last sync</b><span>18 Oct</span></div>` },
  { bar: 'Calendar', x: 30, y: 52, w: 200, r: -3.5, at: 0.72, html: `
    <b>Las Vegas Grand Prix</b><div>23 Nov · 20 days</div>` },
  { bar: 'Cap tracker', x: 62, y: 38, w: 210, r: 2.5, at: 0.78, html: `
    <div>Headroom</div><div class="big">~$0.8m?</div><div>as of last month</div>` },
  { bar: 'racingnews365.com · weeks later', x: 46, y: 46, w: 270, r: -1.5, at: 0.86, phone: true, html: `
    <b>São Paulo crashes cost Williams "nearly $4m"</b>` },
];

interface TagDef {
  id: (typeof TAGGED)[number];
  name: string;
  value: string;
  status: string;
  dead: boolean;
  note: string;
  dx: number;
  dy: number;
}

const TAGS: TagDef[] = [
  { id: 'front_wing', name: 'Front wing', value: '$127k', status: 'Destroyed', dead: true, note: 'Fitted from spares; counts in the 2024 cap when fitted.', dx: 70, dy: -120 },
  { id: 'chassis', name: 'Survival cell', value: '$1.08m', status: 'Destroyed', dead: true, note: 'Spare tub: about 13 h of work, 3 h 30 m to the start.', dx: -30, dy: -175 },
  { id: 'power_unit', name: 'Power unit', value: '92%', status: 'Grid penalty risk', dead: false, note: 'Not hit. Now runs out before Abu Dhabi, past its allocation.', dx: -150, dy: -120 },
  { id: 'floor', name: 'Floor', value: '$279k', status: 'Destroyed', dead: true, note: 'One left at Grove, none at the track.', dx: 40, dy: 130 },
  { id: 'gearbox', name: 'Gearbox', value: '$495k', status: 'Destroyed', dead: true, note: 'Work order raised at Grove.', dx: -60, dy: 165 },
  { id: 'rear_wing', name: 'Rear wing', value: '$83k', status: 'Destroyed', dead: true, note: 'Precedent 0.93: posts on its own.', dx: -220, dy: 30 },
  { id: 'fsusp_r', name: 'Front-right corner', value: '$83k', status: 'Destroyed', dead: true, note: 'Wishbones, pushrod, upright.', dx: 120, dy: 40 },
];

export class HeroOverlay {
  private caps: Record<string, HTMLElement> = {};
  private hud: Record<string, HTMLElement> = {};
  private wins: { el: HTMLElement; def: Win }[] = [];
  private tags: { el: HTMLElement; def: TagDef }[] = [];
  private svg: SVGSVGElement;
  private lines: { line: SVGLineElement; dot: SVGCircleElement }[] = [];
  private rail: HTMLElement[];
  private flash: HTMLElement;
  private veil: HTMLElement;
  private hudBox: HTMLElement;
  private v = new THREE.Vector3();

  constructor(private pin: HTMLElement) {
    pin.querySelectorAll<HTMLElement>('[data-cap]').forEach((el) => (this.caps[el.dataset.cap!] = el));
    pin.querySelectorAll<HTMLElement>('[data-hud]').forEach((el) => (this.hud[el.dataset.hud!] = el));
    this.flash = pin.querySelector('.flash')!;
    this.veil = pin.querySelector('.veil')!;
    this.hudBox = pin.querySelector('.hud')!;
    this.rail = [...pin.querySelectorAll<HTMLElement>('.rail li')];
    const chaos = pin.querySelector('.chaos')!;
    for (const def of WINDOWS) {
      const el = document.createElement('div');
      el.className = `win ${def.cls ?? ''}`;
      el.innerHTML = (def.bar ? `<div class="win-bar"><i></i><i></i><i></i><span>${def.bar}</span></div>` : '') + `<div class="win-body">${def.html}</div>`;
      if (def.cls === 'note') el.innerHTML = def.html;
      chaos.appendChild(el);
      this.wins.push({ el, def });
    }
    const tagsBox = pin.querySelector('.tags')!;
    this.svg = pin.querySelector('.tag-lines') as SVGSVGElement;
    for (const def of TAGS) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = `<h4>${def.name}<b>${def.value}</b></h4><span class="st-chip ${def.dead ? 'dead' : 'warn'}">${def.status}</span><p>${def.note}</p>`;
      tagsBox.appendChild(el);
      this.tags.push({ el, def });
      const ns = 'http://www.w3.org/2000/svg';
      const line = document.createElementNS(ns, 'line');
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('r', '4');
      if (def.dead) {
        line.classList.add('hurt');
        dot.classList.add('hurt');
      }
      this.svg.append(line, dot);
      this.lines.push({ line, dot });
    }
  }

  update(p: number, frame: Frame | null, narrow: boolean) {
    // captions
    const show = (key: string, o: number, lift = 18) => {
      const el = this.caps[key];
      if (!el) return;
      el.style.opacity = String(o);
      const base = key === 'chaos' || key === 'one' ? 'translate(-50%, -50%) ' : key === 'garage' && !narrow ? 'translateY(-50%) ' : '';
      el.style.transform = `${base}translateY(${(1 - o) * lift}px)`;
      el.classList.toggle('on', o > 0.5);
    };
    show('title', 1 - span(p, T.titleOut - 0.02, T.titleOut + 0.01), -30);
    show('lap', window01(p, 0.064, T.snap + 0.035, 0.012));
    show('hit', window01(p, T.impact + 0.006, T.redFlag - 0.03, 0.01));
    show('flag', window01(p, T.redFlag, T.chaosIn + 0.01, 0.012));
    show('chaos', window01(p, T.chaosIn + 0.05, T.collapse - 0.01, 0.015));
    show('one', window01(p, T.collapse + 0.012, T.garageIn - 0.004, 0.01), 30);
    show('garage', span(p, T.tags - 0.03, T.tags + 0.01));

    // the readout
    const sp = speedAt(p);
    this.hud.speed.textContent = String(Math.round(sp));
    this.hud.speed2.textContent = String(Math.round(Math.max(sp, 0)));
    const thr = p < T.snap ? 1 : 0;
    const brk = p >= T.snap && p < T.impact + 0.02 ? 1 : 0;
    this.hud.thr.style.transform = `scaleX(${thr})`;
    this.hud.brk.style.transform = `scaleX(${brk})`;
    this.hud.gear.textContent = p < T.snap ? '8' : p < T.impact ? String(Math.max(5, 8 - Math.floor(span(p, T.snap, T.impact) * 4))) : 'N';
    this.hud.clock.textContent = fmtClock(clockAt(p));
    const flag = this.hud.flag;
    if (p >= T.redFlag) {
      flag.textContent = 'RED FLAG';
      flag.className = 'hud-flag red';
    } else if (p >= T.impact) {
      flag.textContent = 'CAR 23 STOPPED';
      flag.className = 'hud-flag stop';
    } else {
      flag.textContent = 'TRACK CLEAR';
      flag.className = 'hud-flag';
    }
    const hudOn = 1 - span(p, T.chaosIn + 0.02, T.chaosIn + 0.06);
    this.hudBox.style.opacity = String(hudOn);
    this.hudBox.style.visibility = hudOn <= 0.01 ? 'hidden' : 'visible';

    // the hit, then the flag
    const white = p > T.impact ? 1 - span(p, T.impact, T.impact + 0.014) : 0;
    const red = window01(p, T.redFlag, T.chaosIn + 0.02, 0.008);
    if (white > 0.02) {
      this.pin.classList.remove('red');
      this.flash.style.opacity = String(white * 0.92);
    } else {
      this.pin.classList.toggle('red', red > 0);
      this.flash.style.opacity = String(red);
    }
    this.veil.style.opacity = String(window01(p, T.chaosIn + 0.01, T.collapse + 0.025, 0.03) * 0.9);

    // the paperwork piles up, then collapses into one ledger
    const pile = span(p, T.chaosIn, T.chaosFull);
    const gone = easeInOut(span(p, T.collapse, T.oneLedger));
    for (const { el, def } of this.wins) {
      if (narrow && !def.phone) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      const appear = expoOut(clamp((pile - def.at * 0.9) / 0.12));
      const o = appear * (1 - gone);
      if (o <= 0.001) {
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
        continue;
      }
      el.style.visibility = 'visible';
      const w = narrow ? Math.min(def.w, 220) : def.w;
      el.style.width = `${w}px`;
      const x = narrow ? Math.min(def.x, 100 - (w / window.innerWidth) * 100 - 2) : def.x;
      el.style.left = `${x}%`;
      el.style.top = `${def.y}%`;
      // collapse toward the centre of the stage
      const cx = (50 - x) * gone;
      const cy = (50 - def.y) * gone;
      const s = (0.92 + 0.08 * appear) * (1 - 0.8 * gone);
      el.style.transform = `translate(${cx}vw, ${cy}vh) translateY(${(1 - appear) * 30}px) rotate(${def.r * (1 - gone)}deg) scale(${s})`;
      el.style.opacity = String(o);
      el.style.filter = gone > 0.01 ? `blur(${gone * 6}px)` : '';
    }

    // the garage's readout: one tag per priced part, a leader line to where it sits
    const tagK = span(p, T.tags, T.tags + 0.06);
    const phoneTags = ['power_unit', 'front_wing', 'floor'];
    this.tags.forEach(({ el, def }, i) => {
      const line = this.lines[i];
      const k = !narrow || phoneTags.includes(def.id) ? smooth(clamp((tagK - i * 0.08) / 0.4)) : 0;
      if (!frame || k <= 0.001) {
        el.style.opacity = '0';
        line.line.style.opacity = '0';
        line.dot.style.opacity = '0';
        return;
      }
      const a = frame.anchors[def.id];
      if (!a) return;
      this.v.copy(a).project(frame.camera);
      const sx = (this.v.x * 0.5 + 0.5) * frame.width;
      const sy = (-this.v.y * 0.5 + 0.5) * frame.height;
      const scale = narrow ? 0.55 : 1;
      const tw = narrow ? 150 : 200;
      let lx = sx + def.dx * scale - (def.dx < 0 ? tw : 0);
      let ly = sy + def.dy * scale - 20;
      lx = clamp(lx, narrow ? 8 : Math.max(8, frame.width * 0.4), frame.width - tw - 8);
      ly = clamp(ly, 70, frame.height - 80);
      el.style.opacity = String(k);
      el.style.transform = `translate(${lx}px, ${ly + (1 - k) * 10}px)`;
      const ex = def.dx < 0 ? lx + tw : lx;
      const ey = ly + 20;
      line.line.setAttribute('x1', String(sx));
      line.line.setAttribute('y1', String(sy));
      line.line.setAttribute('x2', String(ex));
      line.line.setAttribute('y2', String(ey));
      line.dot.setAttribute('cx', String(sx));
      line.dot.setAttribute('cy', String(sy));
      line.line.style.opacity = String(k * 0.9);
      line.dot.style.opacity = String(k);
    });

    // sectors
    const marks: [number, number][] = [
      [0, T.snap],
      [T.snap, T.debrisEnd],
      [T.debrisEnd, T.garageIn],
      [T.garageIn, 0.96],
    ];
    this.rail.forEach((li, i) => {
      const f = span(p, marks[i][0], marks[i][1]);
      li.style.setProperty('--fill', String(f));
      li.classList.toggle('on', f > 0 && f < 1);
    });
  }
}
