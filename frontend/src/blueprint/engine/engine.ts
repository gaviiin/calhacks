import * as THREE from 'three';
import { MAX_PARTS, PARTS, PART_INDEX, groupOf } from '../catalog';
import type { BuiltCar } from '../model/build';
import type { PartMesh } from '../model/mesh';
import { PALETTE } from '../palette';
import { BG_FRAG, GROUND_FRAG, GROUND_VERT, LINE_FRAG, LINE_VERT, QUAD_VERT, SURF_FRAG, SURF_VERT } from './shaders';

// The blueprint's renderer. One WebGL canvas sits under the whole sheet and draws five views through
// scissored viewports: the angled hero (perspective, orbitable, parts pull out under the pointer) and
// four rigid drawings (side, front, rear, underside) with hidden-line removal. Nothing renders while
// nothing moves; the loop wakes on input, on a state change and for the hero's slow idle drift.

export type ViewId = 'hero' | 'side' | 'front' | 'rear' | 'bottom';
export type OrthoId = Exclude<ViewId, 'hero'>;
export const ORTHO_IDS: OrthoId[] = ['side', 'front', 'rear', 'bottom'];

export type V3 = [number, number, number];

export interface PartTone {
  /** hero line colour, display RGB 0..1 */
  color: V3;
  /** brightness multiplier, 1 = normal */
  level: number;
  /** ink for the rigid drawings; null keeps the sheet's own ink */
  ink: V3 | null;
  /** breathes, for parts that need attention */
  pulse: boolean;
}

export interface Projected {
  x: number;
  y: number;
  /** in front of the camera and inside the view */
  visible: boolean;
}

type Listener = {
  hover: (id: string | null, from: ViewId) => void;
  select: (id: string | null) => void;
  /** after every rendered frame: overlays that follow the car read projections here */
  frame: () => void;
  /** after the views were measured: overlays fixed to the drawings recompute here */
  layout: () => void;
};

const ORTHO_SPEC: Record<OrthoId, { eye: V3; up: V3; sil: 'x' | 'y' | 'z' }> = {
  side: { eye: [0, 0, 1], up: [0, 1, 0], sil: 'z' },
  front: { eye: [1, 0, 0], up: [0, 1, 0], sil: 'x' },
  rear: { eye: [-1, 0, 0], up: [0, 1, 0], sil: 'x' },
  bottom: { eye: [0, -1, 0], up: [0, 0, 1], sil: 'y' },
};

/** Room around each drawing, CSS px: caption on top, dimensions below and at one side. */
const ORTHO_PAD: Record<OrthoId, { l: number; r: number; t: number; b: number }> = {
  side: { l: 46, r: 22, t: 34, b: 60 },
  front: { l: 26, r: 46, t: 34, b: 60 },
  rear: { l: 26, r: 26, t: 44, b: 60 },
  bottom: { l: 46, r: 22, t: 30, b: 60 },
};
const ORTHO_PAD_COMPACT: Record<OrthoId, { l: number; r: number; t: number; b: number }> = {
  side: { l: 14, r: 14, t: 28, b: 30 },
  front: { l: 12, r: 12, t: 28, b: 30 },
  rear: { l: 12, r: 12, t: 28, b: 30 },
  bottom: { l: 14, r: 14, t: 28, b: 30 },
};

export { PALETTE };

const DEFAULT_VIEW = { az: 0.7, el: 0.48 };
/** Seconds untouched before the hero starts drifting, and before it settles and stops drawing. */
const IDLE_DRIFT = 4;
const IDLE_SLEEP = 30;
const KIND_ISO = 0;
const KIND_EDGE = 1;
const KIND_SIL = 2;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const smoothstep = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};

/** Critically damped approach of `x` toward `to`; returns the new value and velocity. */
function spring(x: number, v: number, to: number, k: number, dt: number): [number, number] {
  const c = 2 * Math.sqrt(k);
  const a = k * (to - x) - c * v;
  const nv = v + a * dt;
  return [x + nv * dt, nv];
}

function lineGeometry(parts: PartMesh[], take: (p: PartMesh) => [Float32Array, number][]): THREE.InstancedBufferGeometry {
  let n = 0;
  for (const p of parts) for (const [arr] of take(p)) n += arr.length / 6;
  const A = new Float32Array(n * 3);
  const B = new Float32Array(n * 3);
  const part = new Float32Array(n);
  const kind = new Float32Array(n);
  let k = 0;
  parts.forEach((p, pi) => {
    for (const [arr, kd] of take(p)) {
      for (let i = 0; i < arr.length; i += 6) {
        A[k * 3] = arr[i];
        A[k * 3 + 1] = arr[i + 1];
        A[k * 3 + 2] = arr[i + 2];
        B[k * 3] = arr[i + 3];
        B[k * 3 + 1] = arr[i + 4];
        B[k * 3 + 2] = arr[i + 5];
        part[k] = pi;
        kind[k] = kd;
        k++;
      }
    }
  });
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0], 3));
  g.setIndex([0, 2, 1, 2, 3, 1]);
  g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 3));
  g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 3));
  g.setAttribute('aPart', new THREE.InstancedBufferAttribute(part, 1));
  g.setAttribute('aKind', new THREE.InstancedBufferAttribute(kind, 1));
  g.instanceCount = n;
  return g;
}

function surfaceGeometry(parts: PartMesh[]): THREE.BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const p of parts) {
    nv += p.pos.length / 3;
    ni += p.idx.length;
  }
  const pos = new Float32Array(nv * 3);
  const nrm = new Float32Array(nv * 3);
  const part = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let vo = 0;
  let io = 0;
  parts.forEach((p, pi) => {
    pos.set(p.pos, vo * 3);
    nrm.set(p.nrm, vo * 3);
    part.fill(pi, vo, vo + p.pos.length / 3);
    for (let i = 0; i < p.idx.length; i++) idx[io + i] = p.idx[i] + vo;
    vo += p.pos.length / 3;
    io += p.idx.length;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

interface PartState {
  pull: number;
  pullV: number;
  hi: number;
  hiV: number;
  dim: number;
  dimV: number;
  col: V3;
  ink: V3;
  level: number;
  /** current offset */
  off: V3;
}

interface View {
  id: ViewId;
  el: HTMLElement;
  rect: { x: number; y: number; w: number; h: number };
  scene: THREE.Scene;
  camera: THREE.Camera;
  bg: THREE.ShaderMaterial;
  lineMats: THREE.RawShaderMaterial[];
}

export interface EngineOptions {
  host: HTMLElement;
  views: Record<ViewId, HTMLElement>;
  reducedMotion: boolean;
  /** small drawings: one row of dimensions, tighter margins */
  compact?: boolean;
}

export class BlueprintEngine {
  private renderer: THREE.WebGLRenderer;
  private host: HTMLElement;
  private views: View[] = [];
  private hero!: View;
  private heroCam: THREE.PerspectiveCamera;
  private parts: PartMesh[];
  private state: PartState[];
  private tones: PartTone[];
  private offsets = new Float32Array(MAX_PARTS * 4);
  private colors = new Float32Array(MAX_PARTS * 4);
  private orthoOffsets = new Float32Array(MAX_PARTS * 4);
  private orthoColors = new Float32Array(MAX_PARTS * 4);
  private uOffset = { value: this.offsets };
  private uColor = { value: this.colors };
  private uOffsetO = { value: this.orthoOffsets };
  private uColorO = { value: this.orthoColors };
  private dpr = 1;
  /** the canvas' size in CSS px (the host's padding box) */
  private cssH = 1;
  private disposed = false;
  private raf = 0;
  private last = 0;
  private time = 0;
  private visible = true;
  private reducedMotion: boolean;
  private compact: boolean;
  private listeners: { [K in keyof Listener]: Set<Listener[K]> } = { hover: new Set(), select: new Set(), frame: new Set(), layout: new Set() };
  private cleanups: (() => void)[] = [];
  private glDisposables: { dispose: () => void }[] = [];
  // orbit
  private az = DEFAULT_VIEW.az;
  private el = DEFAULT_VIEW.el;
  private azV = 0;
  private azBase = DEFAULT_VIEW.az;
  private idleSince = 0;
  private drift = 0;
  private driftAz = 0;
  /** 1 while the hero is awake (drift and pulse run), easing to 0 when it goes to sleep */
  private life = 1;
  private dist = 10;
  private distV = 0;
  private fitDist = 10;
  private zoom = 1;
  private target = new THREE.Vector3(0.05, 0.36, 0);
  private restCentre = new THREE.Vector3(0.05, 0.36, 0);
  private dragging = false;
  private pointerDown: { x: number; y: number; id: number; moved: boolean; view: ViewId } | null = null;
  // explode
  private explode = 0;
  private explodeTo = 0;
  // highlight: the part under the pointer, parts lit from outside (a row of the parts list), the pinned parts
  private hoverId: string | null = null;
  private hoverFrom: ViewId | null = null;
  private outside: string[] = [];
  private outsidePull = true;
  private pinned: string[] = [];
  private pendingPick: { x: number; y: number; view: ViewId } | null = null;
  // picking
  private raycaster = new THREE.Raycaster();
  private pickMeshes: THREE.Mesh[] = [];
  private restMeshes: THREE.Mesh[] = [];
  private restBox = new THREE.Box3();
  /** a sparse cloud of surface points (x, y, z, part) for framing the hero */
  private cloud: Float32Array = new Float32Array(0);
  private orthoFit: Partial<Record<OrthoId, { cam: THREE.OrthographicCamera; mPerPx: number }>> = {};
  /** frame counters for the dev perf probe (window.__bp.stats) */
  stats = { frames: 0, jsMs: 0, worstMs: 0 };

  constructor(car: BuiltCar, opts: EngineOptions) {
    this.host = opts.host;
    this.parts = car.parts;
    this.reducedMotion = opts.reducedMotion;
    this.compact = !!opts.compact;
    const canvas = document.createElement('canvas');
    canvas.className = 'bp-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.host.prepend(canvas);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: this.dpr < 2, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.sortObjects = false;
    this.renderer.autoClear = true;
    this.renderer.setClearColor(new THREE.Color(...PALETTE.sheetBg1), 1);
    this.renderer.setScissorTest(true);

    this.state = PARTS.map(() => ({
      pull: 0,
      pullV: 0,
      hi: 0,
      hiV: 0,
      dim: 0,
      dimV: 0,
      col: [...PALETTE.line] as V3,
      ink: [...PALETTE.ink] as V3,
      level: 1,
      off: [0, 0, 0] as V3,
    }));
    this.tones = PARTS.map(() => ({ color: PALETTE.line, level: 1, ink: null, pulse: false }));

    const cloud: number[] = [];
    this.parts.forEach((p, i) => {
      this.restBox.expandByPoint(new THREE.Vector3(p.bounds[0], p.bounds[1], p.bounds[2]));
      this.restBox.expandByPoint(new THREE.Vector3(p.bounds[3], p.bounds[4], p.bounds[5]));
      const step = Math.max(1, Math.floor(p.pickPos.length / 3 / 260)) * 3;
      for (let k = 0; k < p.pickPos.length; k += step) cloud.push(p.pickPos[k], p.pickPos[k + 1], p.pickPos[k + 2], i);
    });
    this.cloud = new Float32Array(cloud);
    // orbit the middle of the car, a little below half height so the wings and the airbox balance
    this.restCentre.set((this.restBox.min.x + this.restBox.max.x) / 2, (this.restBox.min.y + this.restBox.max.y) * 0.44, 0);
    this.target.copy(this.restCentre);
    this.heroCam = new THREE.PerspectiveCamera(24, 1.8, 0.5, 80);
    this.build(opts.views);
    this.bindInput();
    this.observe();
    this.layout();
    this.dist = this.fitDist;
    this.wake();
  }

  // ---------------------------------------------------------------------------------------- scene

  private build(els: Record<ViewId, HTMLElement>) {
    const surf = surfaceGeometry(this.parts);
    const heroLines = lineGeometry(this.parts, (p) => [
      [p.iso, KIND_ISO],
      [p.edges, KIND_EDGE],
    ]);
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    quad.setIndex([0, 1, 2, 2, 1, 3]);
    this.glDisposables.push(surf, heroLines, quad);

    const additive = {
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      transparent: true,
      depthWrite: false,
    };
    const lineMat = (u: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters>) => {
      const m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: LINE_VERT,
        fragmentShader: LINE_FRAG,
        uniforms: {
          uViewport: { value: new THREE.Vector2(1, 1) },
          uWidth: { value: new THREE.Vector4(1, 1.5, 1.5, 1) },
          uKindAlpha: { value: new THREE.Vector4(0.4, 0.95, 0.95, 1) },
          uGlow: { value: 0 },
          uGlowAmt: { value: 0 },
          uDash: { value: 0 },
          uUseOffset: { value: 1 },
          uFade: { value: new THREE.Vector2(1e3, 2e3) },
          uFadeTo: { value: 1 },
          uHiBoost: { value: 1 },
          ...u,
        },
        ...additive,
        ...extra,
      });
      this.glDisposables.push(m);
      return m;
    };
    const surfMat = (u: Record<string, THREE.IUniform>, extra: Partial<THREE.ShaderMaterialParameters>) => {
      const m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: SURF_VERT,
        fragmentShader: SURF_FRAG,
        uniforms: {
          uOrtho: { value: 0 },
          uSurf: { value: 1 },
          uMode: { value: 0 },
          uUseOffset: { value: 1 },
          uFill: { value: new THREE.Color(...PALETTE.sheetBg0) },
          uHiFill: { value: new THREE.Color(...PALETTE.inkHi) },
          ...u,
        },
        side: THREE.DoubleSide,
        ...extra,
      });
      this.glDisposables.push(m);
      return m;
    };
    const bgMat = (world: boolean, c0: V3, c1: V3) => {
      const m = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: QUAD_VERT,
        fragmentShader: BG_FRAG,
        uniforms: {
          uViewport: { value: new THREE.Vector2(1, 1) },
          uOrigin: { value: new THREE.Vector2(0, 0) },
          uBg0: { value: new THREE.Color(...c0) },
          uBg1: { value: new THREE.Color(...c1) },
          uGrid: { value: new THREE.Color(...PALETTE.grid) },
          uWorld: { value: new THREE.Vector4(0, 0, 0.01, world ? 1 : 0) },
          uGridSpec: { value: world ? new THREE.Vector4(0.1, 0.5, 0.035, 0.07) : new THREE.Vector4(24, 120, 0.028, 0.045) },
        },
        depthTest: false,
        depthWrite: false,
      });
      this.glDisposables.push(m);
      return m;
    };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, order: number) => {
      const o = new THREE.Mesh(g, m);
      o.frustumCulled = false;
      o.renderOrder = order;
      o.matrixAutoUpdate = false;
      return o;
    };

    // -------------------------------------------------------------- hero
    {
      const scene = new THREE.Scene();
      const bg = bgMat(false, PALETTE.heroBg0, PALETTE.heroBg1);
      scene.add(mesh(quad, bg, 0));
      const depth = surfMat(
        { uOffset: this.uOffset, uColor: this.uColor },
        { colorWrite: false, depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
      );
      scene.add(mesh(surf, depth, 1));
      const groundGeo = new THREE.PlaneGeometry(14, 10);
      groundGeo.rotateX(-Math.PI / 2);
      groundGeo.translate(0, -0.001, 0);
      this.glDisposables.push(groundGeo);
      const ground = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: GROUND_VERT,
        fragmentShader: GROUND_FRAG,
        uniforms: { uGrid: { value: new THREE.Color(...PALETTE.grid) }, uAlpha: { value: 0.16 }, uCentre: { value: new THREE.Vector2(0.1, 0) }, uRadius: { value: 4.4 } },
        ...additive,
        depthTest: true,
      });
      this.glDisposables.push(ground);
      scene.add(mesh(groundGeo, ground, 2));
      const glass = surfMat({ uOffset: this.uOffset, uColor: this.uColor, uSurf: { value: 0.9 } }, { ...additive, depthTest: true, depthFunc: THREE.LessEqualDepth });
      scene.add(mesh(surf, glass, 3));
      const vis = lineMat(
        { uOffset: this.uOffset, uColor: this.uColor, uGlowAmt: { value: 0.12 }, uFadeTo: { value: 0.55 } },
        { depthTest: true, depthFunc: THREE.LessEqualDepth },
      );
      scene.add(mesh(heroLines, vis, 4));
      const hid = lineMat(
        { uOffset: this.uOffset, uColor: this.uColor, uKindAlpha: { value: new THREE.Vector4(0.055, 0.15, 0.15, 1) }, uFadeTo: { value: 0.6 }, uHiBoost: { value: 4.2 } },
        { depthTest: true, depthFunc: THREE.GreaterDepth },
      );
      scene.add(mesh(heroLines, hid, 5));
      this.hero = { id: 'hero', el: els.hero, rect: { x: 0, y: 0, w: 1, h: 1 }, scene, camera: this.heroCam, bg, lineMats: [vis, hid] };
      this.views.push(this.hero);
    }

    // -------------------------------------------------------------- the rigid drawings
    for (const id of ORTHO_IDS) {
      const spec = ORTHO_SPEC[id];
      const lines = lineGeometry(this.parts, (p) => [
        [p.edges, KIND_EDGE],
        [p.sil[spec.sil], KIND_SIL],
      ]);
      this.glDisposables.push(lines);
      const scene = new THREE.Scene();
      const bg = bgMat(true, PALETTE.sheetBg0, PALETTE.sheetBg1);
      scene.add(mesh(quad, bg, 0));
      const fill = surfMat(
        { uOffset: this.uOffsetO, uColor: this.uColorO, uMode: { value: 1 }, uUseOffset: { value: 0 }, uOrtho: { value: 1 } },
        { depthWrite: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 },
      );
      scene.add(mesh(surf, fill, 1));
      const vis = lineMat(
        { uOffset: this.uOffsetO, uColor: this.uColorO, uUseOffset: { value: 0 }, uKindAlpha: { value: new THREE.Vector4(0.3, 0.92, 0.92, 1) } },
        { depthTest: true, depthFunc: THREE.LessEqualDepth },
      );
      scene.add(mesh(lines, vis, 2));
      const hid = lineMat(
        {
          uOffset: this.uOffsetO,
          uColor: this.uColorO,
          uUseOffset: { value: 0 },
          uKindAlpha: { value: new THREE.Vector4(0.0, 0.075, 0.075, 1) },
          uDash: { value: 6 },
          uHiBoost: { value: 9 },
        },
        { depthTest: true, depthFunc: THREE.GreaterDepth },
      );
      scene.add(mesh(lines, hid, 3));
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 40);
      const [ex, ey, ez] = spec.eye;
      cam.position.set(ex * 12, ey * 12, ez * 12);
      cam.up.set(...spec.up);
      cam.lookAt(0, 0, 0);
      this.views.push({ id, el: els[id], rect: { x: 0, y: 0, w: 1, h: 1 }, scene, camera: cam, bg, lineMats: [vis, hid] });
    }

    // -------------------------------------------------------------- picking
    const pickMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    this.glDisposables.push(pickMat);
    this.parts.forEach((p, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.pickPos, 3));
      g.setIndex(new THREE.BufferAttribute(p.pickIdx, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      this.glDisposables.push(g);
      const live = new THREE.Mesh(g, pickMat);
      live.userData.part = i;
      const rest = new THREE.Mesh(g, pickMat);
      rest.userData.part = i;
      rest.updateMatrixWorld(true);
      this.pickMeshes.push(live);
      this.restMeshes.push(rest);
    });
  }

  // ---------------------------------------------------------------------------------------- layout

  private observe() {
    const ro = new ResizeObserver(() => {
      this.layout();
      this.wake();
    });
    ro.observe(this.host);
    for (const v of this.views) ro.observe(v.el);
    const io = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting);
      if (this.visible) this.wake();
    });
    io.observe(this.host);
    const onVis = () => {
      if (document.visibilityState === 'visible') this.wake();
    };
    document.addEventListener('visibilitychange', onVis);
    const onLost = (e: Event) => e.preventDefault();
    this.renderer.domElement.addEventListener('webglcontextlost', onLost);
    this.cleanups.push(() => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      this.renderer.domElement.removeEventListener('webglcontextlost', onLost);
    });
  }

  private layout() {
    if (this.disposed) return;
    // the canvas fills the host's padding box: measure every view against that, not the border box
    const box = this.host.getBoundingClientRect();
    const ox = box.left + this.host.clientLeft;
    const oy = box.top + this.host.clientTop;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.cssH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr !== this.dpr) {
      this.dpr = dpr;
      this.renderer.setPixelRatio(dpr);
    }
    this.renderer.setSize(w, h, false);
    const canvas = this.renderer.domElement;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    for (const v of this.views) {
      const r = v.el.getBoundingClientRect();
      v.rect = { x: r.left - ox, y: r.top - oy, w: Math.max(1, r.width), h: Math.max(1, r.height) };
      for (const m of v.lineMats) {
        (m.uniforms.uViewport.value as THREE.Vector2).set(v.rect.w * dpr, v.rect.h * dpr);
      }
      const bgU = v.bg.uniforms;
      (bgU.uViewport.value as THREE.Vector2).set(v.rect.w * dpr, v.rect.h * dpr);
      (bgU.uOrigin.value as THREE.Vector2).set(v.rect.x * dpr, (h - v.rect.y - v.rect.h) * dpr);
      if (v.id === 'hero') {
        this.heroCam.aspect = v.rect.w / v.rect.h;
        this.heroCam.updateProjectionMatrix();
      } else {
        this.fitOrtho(v);
      }
    }
    this.setLineWidths();
    this.refit();
    for (const f of this.listeners.layout) f();
  }

  private setLineWidths() {
    const d = this.dpr;
    const [vis, hid] = this.hero.lineMats;
    (vis.uniforms.uWidth.value as THREE.Vector4).set(0.85 * d, 1.35 * d, 1.35 * d, 1);
    vis.uniforms.uGlow.value = 3 * d;
    (hid.uniforms.uWidth.value as THREE.Vector4).set(0.8 * d, 0.95 * d, 0.95 * d, 1);
    for (const v of this.views) {
      if (v.id === 'hero') continue;
      const [ov, oh] = v.lineMats;
      (ov.uniforms.uWidth.value as THREE.Vector4).set(0.8 * d, 0.95 * d, 1.45 * d, 1);
      (oh.uniforms.uWidth.value as THREE.Vector4).set(0.8 * d, 0.85 * d, 0.85 * d, 1);
      oh.uniforms.uDash.value = 5 * d;
    }
  }

  /** Frames a rigid view on the car at rest, centred, with room around it for the dimension lines. */
  private fitOrtho(v: View) {
    const id = v.id as OrthoId;
    const cam = v.camera as THREE.OrthographicCamera;
    cam.updateMatrixWorld(true);
    const inv = cam.matrixWorldInverse;
    const b = this.restBox;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(inv);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    // margins in CSS px: the caption above, two rows of dimensions below, a vertical dimension at a side
    const pad = (this.compact ? ORTHO_PAD_COMPACT : ORTHO_PAD)[id];
    const cw = x1 - x0;
    const ch = y1 - y0;
    const W = v.rect.w;
    const H = v.rect.h;
    const s = Math.max(1e-3, Math.min((W - pad.l - pad.r) / cw, (H - pad.t - pad.b) / ch));
    const spareX = (W - pad.l - pad.r - cw * s) / 2;
    const spareY = (H - pad.t - pad.b - ch * s) / 2;
    cam.left = x0 - (pad.l + spareX) / s;
    cam.right = cam.left + W / s;
    cam.top = y1 + (pad.t + spareY) / s;
    cam.bottom = cam.top - H / s;
    cam.updateProjectionMatrix();
    const mPerPx = 1 / s;
    this.orthoFit[id] = { cam, mPerPx };
    // the grid follows car metres in the drawing's own plane
    const u = v.bg.uniforms.uWorld.value as THREE.Vector4;
    u.set(cam.left, cam.bottom, mPerPx / this.dpr, 1);
  }

  /**
   * Hero distance that keeps the whole car in frame (exploded, when it is) for azimuths near the current
   * one, so the idle drift and small turns never clip it and the frame does not breathe while dragging.
   */
  private refit() {
    const cam = this.heroCam;
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const tanH = tanV * cam.aspect;
    const e = this.explodeTo;
    const ty = this.restCentre.y + 0.3 * e * 0.6;
    const c = this.cloud;
    const pts: number[] = [];
    for (let k = 0; k < c.length; k += 4) {
      const [dx, dy, dz] = PARTS[c[k + 3]].explode;
      pts.push(c[k] + dx * e - this.target.x, c[k + 1] + (dy + 0.3) * e - ty, c[k + 2] + dz * e - this.target.z);
    }
    let need = 0;
    const el = this.el;
    for (let k = -4; k <= 4; k++) {
      const az = this.az + (k / 4) * 0.45;
      const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
      const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      const up = dir.clone().cross(right).normalize();
      for (let k = 0; k < pts.length; k += 3) {
        const x = pts[k];
        const y = pts[k + 1];
        const z = pts[k + 2];
        const along = x * dir.x + y * dir.y + z * dir.z;
        const r = Math.abs(x * right.x + y * right.y + z * right.z);
        const u = Math.abs(x * up.x + y * up.y + z * up.z);
        need = Math.max(need, along + r / (tanH * 0.93), along + u / (tanV * 0.9));
      }
    }
    this.fitDist = need;
  }

  // ---------------------------------------------------------------------------------------- input

  private bindInput() {
    for (const v of this.views) {
      const el = v.el;
      const id = v.id;
      const local = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      /** buttons laid over a view (sponsor zones, the lens switch) belong to the page, not to the drawing */
      const onControl = (e: PointerEvent) => e.target instanceof Element && e.target !== el && !!e.target.closest('button, a, input, select');
      const down = (e: PointerEvent) => {
        if (e.button !== 0 || onControl(e)) return;
        const p = local(e);
        this.pointerDown = { ...p, id: e.pointerId, moved: false, view: id };
        if (id === 'hero') el.setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!this.pointerDown && onControl(e)) {
          this.releaseHover();
          return;
        }
        const p = local(e);
        const pd = this.pointerDown;
        if (pd && pd.id === e.pointerId && id === 'hero') {
          const dx = p.x - pd.x;
          const dy = p.y - pd.y;
          if (!pd.moved && Math.hypot(dx, dy) > 4) {
            pd.moved = true;
            this.dragging = true;
            el.classList.add('is-dragging');
          }
          if (pd.moved) {
            this.interact();
            this.azBase -= dx * 0.0062;
            this.el = clamp(this.el + dy * 0.0045, 0.06, 1.25);
            this.azV = -dx * 0.0062 * 60;
            pd.x = p.x;
            pd.y = p.y;
            this.wake();
            return;
          }
        }
        if (id === 'hero') this.interact();
        if (!this.dragging) {
          this.pendingPick = { x: p.x, y: p.y, view: id };
          this.wake();
        }
      };
      const up = (e: PointerEvent) => {
        const pd = this.pointerDown;
        if (!pd || pd.id !== e.pointerId) return;
        this.pointerDown = null;
        if (id === 'hero' && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
        if (pd.moved) {
          this.dragging = false;
          el.classList.remove('is-dragging');
          this.refit();
          this.wake();
          return;
        }
        const p = local(e);
        const hit = this.pick(id, p.x, p.y);
        for (const f of this.listeners.select) f(hit);
      };
      const cancel = (e: PointerEvent) => {
        const pd = this.pointerDown;
        if (!pd || pd.id !== e.pointerId) return;
        this.pointerDown = null;
        if (pd.moved) {
          this.dragging = false;
          el.classList.remove('is-dragging');
          this.refit();
          this.wake();
        }
      };
      const leave = () => {
        if (this.dragging) return;
        this.pendingPick = null;
        if (this.hoverFrom === id) this.applyHover(null, id);
      };
      const dbl = () => {
        if (id === 'hero') this.resetView();
      };
      const wheel = (e: WheelEvent) => {
        if (id !== 'hero' || !(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        this.zoom = clamp(this.zoom * Math.exp(e.deltaY * 0.0022), 0.55, 1.35);
        this.interact();
        this.wake();
      };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', cancel);
      el.addEventListener('pointerleave', leave);
      el.addEventListener('dblclick', dbl);
      el.addEventListener('wheel', wheel, { passive: false });
      this.cleanups.push(() => {
        el.removeEventListener('pointerdown', down);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', cancel);
        el.removeEventListener('pointerleave', leave);
        el.removeEventListener('dblclick', dbl);
        el.removeEventListener('wheel', wheel);
      });
    }
  }

  /** The part under a point in a view, or null. Hero hits use the parts where they are now. */
  private pick(view: ViewId, x: number, y: number): string | null {
    const v = this.views.find((w) => w.id === view);
    if (!v) return null;
    const ndc = new THREE.Vector2((x / v.rect.w) * 2 - 1, -(y / v.rect.h) * 2 + 1);
    this.raycaster.setFromCamera(ndc, v.camera);
    if (view !== 'hero') {
      const hit = this.raycaster.intersectObjects(this.restMeshes, false)[0];
      return hit ? PARTS[hit.object.userData.part as number].id : null;
    }
    for (let i = 0; i < this.pickMeshes.length; i++) {
      const m = this.pickMeshes[i];
      const o = this.state[i].off;
      m.position.set(o[0], o[1], o[2]);
      m.updateMatrixWorld(true);
    }
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    // stay on the part already under the pointer while it slides out, so it does not flicker back
    if (this.hoverId && this.hoverFrom === 'hero') {
      const cur = PART_INDEX[this.hoverId];
      if (hits.some((h) => h.object.userData.part === cur)) return this.hoverId;
      if (this.raycaster.intersectObject(this.restMeshes[cur], false).length) return this.hoverId;
    }
    return hits[0] ? PARTS[hits[0].object.userData.part as number].id : null;
  }

  /** The person touched the hero: fold the idle drift into the resting angle and restart the idle clock. */
  private interact() {
    this.azBase += this.driftAz;
    this.driftAz = 0;
    this.drift = 0;
    this.idleSince = this.time;
    this.life = 1;
  }

  private applyHover(id: string | null, from: ViewId) {
    if (id === this.hoverId && (id === null || from === this.hoverFrom)) return;
    this.hoverId = id;
    this.hoverFrom = id ? from : null;
    for (const f of this.listeners.hover) f(id, from);
    this.wake();
  }

  // ---------------------------------------------------------------------------------------- public api

  on<K extends keyof Listener>(k: K, f: Listener[K]): () => void {
    (this.listeners[k] as Set<Listener[K]>).add(f);
    return () => (this.listeners[k] as Set<Listener[K]>).delete(f);
  }

  /**
   * Lights parts from outside the canvas (a row of the parts list): they glow and pull out like a hover.
   * `pull: false` only lights them, for buttons that sit on the part and must not slide out from under the pointer.
   */
  setHighlight(ids: string[], pull = true) {
    if (pull === this.outsidePull && ids.length === this.outside.length && ids.every((x, i) => x === this.outside[i])) return;
    this.outside = ids;
    this.outsidePull = pull;
    this.wake();
  }

  /** Drops the pointer's hover, for when the pointer moves onto something laid over the hero (a sponsor button). */
  releaseHover() {
    this.pendingPick = null;
    if (this.hoverFrom === 'hero') this.applyHover(null, 'hero');
  }

  /** Pins parts: they stay lit and pulled out until unpinned. */
  setSelected(ids: string[]) {
    if (ids.length === this.pinned.length && ids.every((x, i) => x === this.pinned[i])) return;
    this.pinned = ids;
    this.wake();
  }

  setExploded(on: boolean) {
    this.explodeTo = on ? 1 : 0;
    this.refit();
    this.wake();
  }

  setTones(tones: PartTone[]) {
    this.tones = tones;
    this.wake();
  }

  /** Turns the hero from the keyboard: radians of azimuth and elevation. */
  nudge(dAz: number, dEl: number) {
    this.interact();
    this.azBase += dAz;
    this.el = clamp(this.el + dEl, 0.06, 1.25);
    this.refit();
    this.wake();
  }

  /** Back to the drawing's default angle, turning the short way round. */
  resetView() {
    this.interact();
    this.azV = 0;
    this.azBase = DEFAULT_VIEW.az + Math.round((this.az - DEFAULT_VIEW.az) / (Math.PI * 2)) * Math.PI * 2;
    this.el = DEFAULT_VIEW.el;
    this.zoom = 1;
    this.refit();
    this.wake();
  }

  /** Where a part is now (its bounds' centre plus its offset), car metres. */
  anchor(id: string, rest = false): V3 {
    const i = PART_INDEX[id];
    const b = this.parts[i].bounds;
    const o = rest ? [0, 0, 0] : this.state[i].off;
    return [(b[0] + b[3]) / 2 + o[0], (b[1] + b[4]) / 2 + o[1], (b[2] + b[5]) / 2 + o[2]];
  }

  /** How far a part has moved from its mount right now (pulled out or exploded), car metres. */
  offsetOf(id: string): V3 {
    return this.state[PART_INDEX[id]]?.off ?? [0, 0, 0];
  }

  /** Projects a car-space point into a view, CSS px from the view's top-left. */
  project(view: ViewId, p: V3): Projected {
    const v = this.views.find((w) => w.id === view);
    if (!v) return { x: 0, y: 0, visible: false };
    const q = new THREE.Vector3(...p).project(v.camera);
    return { x: (q.x * 0.5 + 0.5) * v.rect.w, y: (-q.y * 0.5 + 0.5) * v.rect.h, visible: q.z < 1 && Math.abs(q.x) <= 1.05 && Math.abs(q.y) <= 1.05 };
  }

  /** Metres per CSS px in a rigid view. */
  scaleOf(view: OrthoId): number {
    return this.orthoFit[view]?.mPerPx ?? 0;
  }

  // ---------------------------------------------------------------------------------------- loop

  private wake() {
    if (this.life < 1 && !this.reducedMotion) this.interact();
    if (this.disposed || this.raf || !this.visible || document.visibilityState === 'hidden') return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const t0 = performance.now();
    const dt = clamp((now - this.last) / 1000, 1 / 240, 1 / 24);
    this.last = now;
    this.time += dt;
    if (this.pendingPick) {
      const { x, y, view } = this.pendingPick;
      this.pendingPick = null;
      const hit = this.pick(view, x, y);
      if (hit !== this.hoverId || (hit && this.hoverFrom !== view)) this.applyHover(hit, view);
    }
    const moving = this.update(dt);
    this.render();
    for (const f of this.listeners.frame) f();
    const spent = performance.now() - t0;
    this.stats.frames++;
    this.stats.jsMs += spent;
    this.stats.worstMs = Math.max(this.stats.worstMs, spent);
    if (!this.visible || document.visibilityState === 'hidden') return;
    const alive = this.life > 0 && !this.reducedMotion && !this.dragging;
    // a listener above may already have woken the loop (a hover re-renders React, React calls back in)
    if (!this.raf && (moving || alive)) this.raf = requestAnimationFrame(this.frame);
  };

  /** Advances every spring; true while anything is still settling. */
  private update(dt: number): boolean {
    let moving = false;
    // ------------------------------------------------ explode tween (staggered per part)
    if (this.explode !== this.explodeTo) {
      const step = dt / (this.reducedMotion ? 0.25 : 1.15);
      this.explode = this.explodeTo > this.explode ? Math.min(this.explodeTo, this.explode + step) : Math.max(this.explodeTo, this.explode - step);
      moving = true;
    }
    const E = this.explode;
    const lift = 0.3 * smoothstep(E);
    // ------------------------------------------------ highlight sets
    const lit = new Set<string>();
    if (this.hoverId) for (const g of groupOf(this.hoverId)) lit.add(g);
    for (const id of this.pinned) lit.add(id);
    const pulled = new Set<string>(lit);
    for (const id of this.outside) {
      lit.add(id);
      if (this.outsidePull) pulled.add(id);
    }
    const anyLit = lit.size > 0;
    const idleNow = this.time - this.idleSince;
    const awake = !this.reducedMotion && idleNow < IDLE_SLEEP;
    const lifeBefore = this.life;
    this.life = awake ? Math.min(1, this.life + dt * 2) : Math.max(0, this.life - dt / 2.5);
    if (this.life !== lifeBefore) moving = true;
    // the pulse breathes around full brightness and fades to it as the hero goes to sleep
    const pulse = 1 - this.life * (0.5 - 0.5 * Math.sin(this.time * 3.4));
    for (let i = 0; i < PARTS.length; i++) {
      const def = PARTS[i];
      const s = this.state[i];
      const on = lit.has(def.id) ? 1 : 0;
      [s.hi, s.hiV] = spring(s.hi, s.hiV, on, 260, dt);
      [s.dim, s.dimV] = spring(s.dim, s.dimV, anyLit && !on ? 1 : 0, 160, dt);
      [s.pull, s.pullV] = spring(s.pull, s.pullV, pulled.has(def.id) ? 1 : 0, this.reducedMotion ? 400 : 90, dt);
      if (Math.abs(s.hiV) > 1e-3 || Math.abs(s.dimV) > 1e-3 || Math.abs(s.pullV) > 1e-3 || Math.abs(s.hi - on) > 1e-3 || Math.abs(s.pull - (pulled.has(def.id) ? 1 : 0)) > 1e-3)
        moving = true;
      const t = this.tones[i];
      // colours ease toward the lens' tones
      const k = 1 - Math.exp(-dt * 10);
      for (let c = 0; c < 3; c++) {
        const before = s.col[c];
        s.col[c] += (t.color[c] - s.col[c]) * k;
        const ink = t.ink ?? PALETTE.ink;
        s.ink[c] += (ink[c] - s.ink[c]) * k;
        if (Math.abs(s.col[c] - before) > 1e-4) moving = true;
      }
      const lvBefore = s.level;
      s.level += (t.level - s.level) * k;
      if (Math.abs(s.level - lvBefore) > 1e-4) moving = true;
      // offset: staggered teardown plus the pull-out under the pointer
      const delay = def.delay * 0.55;
      const pe = smoothstep((E - delay) / 0.45);
      const amount = pe + s.pull * (0.4 * (1 - E) + 0.12 * E);
      const [dx, dy, dz] = def.explode;
      s.off = [dx * amount, dy * amount + lift, dz * amount];
      // ------------------------------------------------ hero colour
      const hi = s.hi;
      const pl = t.pulse ? 0.78 + 0.22 * pulse : 1;
      const level = s.level * pl * (1 - 0.74 * s.dim * (1 - hi)) * (1 + 0.55 * hi);
      const o = i * 4;
      this.colors[o] = s.col[0] + (PALETTE.hi[0] - s.col[0]) * 0.6 * hi;
      this.colors[o + 1] = s.col[1] + (PALETTE.hi[1] - s.col[1]) * 0.6 * hi;
      this.colors[o + 2] = s.col[2] + (PALETTE.hi[2] - s.col[2]) * 0.6 * hi;
      this.colors[o + 3] = level;
      this.offsets[o] = s.off[0];
      this.offsets[o + 1] = s.off[1];
      this.offsets[o + 2] = s.off[2];
      this.offsets[o + 3] = hi;
      // ------------------------------------------------ drawing ink
      const ink = s.ink;
      this.orthoColors[o] = ink[0] + (PALETTE.inkHi[0] - ink[0]) * hi;
      this.orthoColors[o + 1] = ink[1] + (PALETTE.inkHi[1] - ink[1]) * hi;
      this.orthoColors[o + 2] = ink[2] + (PALETTE.inkHi[2] - ink[2]) * hi;
      this.orthoColors[o + 3] = (1 - 0.5 * s.dim * (1 - hi)) * (t.pulse ? 0.86 + 0.14 * pulse : 1);
      this.orthoOffsets[o + 3] = hi;
    }
    // ------------------------------------------------ camera
    const idle = idleNow;
    if (!this.dragging) {
      // inertia after a flick, then the slow drift
      if (Math.abs(this.azV) > 1e-4) {
        this.azBase += this.azV * dt;
        this.azV *= Math.exp(-dt * 5.5);
        moving = true;
      }
      if (!this.reducedMotion && idle > IDLE_DRIFT) this.drift = Math.min(this.life, this.drift + dt / 3);
    }
    this.drift = Math.min(this.drift, this.life);
    this.driftAz = this.drift * 0.13 * Math.sin((idle - IDLE_DRIFT) * 0.21);
    const targetAz = this.azBase + this.driftAz;
    const da = targetAz - this.az;
    this.az += da * (1 - Math.exp(-dt * 16));
    if (Math.abs(da) > 1e-4) moving = true;
    const wantDist = this.fitDist * this.zoom;
    [this.dist, this.distV] = spring(this.dist, this.distV, wantDist, 30, dt);
    if (Math.abs(this.dist - wantDist) > 1e-3) moving = true;
    const ty = this.restCentre.y + lift * 0.6;
    this.target.y += (ty - this.target.y) * (1 - Math.exp(-dt * 6));
    const cam = this.heroCam;
    cam.position.set(
      this.target.x + this.dist * Math.cos(this.el) * Math.cos(this.az),
      this.target.y + this.dist * Math.sin(this.el),
      this.target.z + this.dist * Math.cos(this.el) * Math.sin(this.az),
    );
    cam.lookAt(this.target);
    cam.updateMatrixWorld(true);
    const [vis, hid] = this.hero.lineMats;
    (vis.uniforms.uFade.value as THREE.Vector2).set(this.dist - 2.4, this.dist + 2.8);
    (hid.uniforms.uFade.value as THREE.Vector2).set(this.dist - 2.4, this.dist + 2.8);
    return moving;
  }

  private render() {
    const r = this.renderer;
    const H = this.cssH;
    for (const v of this.views) {
      const x = v.rect.x;
      const y = H - v.rect.y - v.rect.h;
      r.setViewport(x, y, v.rect.w, v.rect.h);
      r.setScissor(x, y, v.rect.w, v.rect.h);
      r.render(v.scene, v.camera);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    for (const c of this.cleanups) c();
    for (const d of this.glDisposables) d.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
