import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { PARTS } from '../model/catalog';
import type { WirePart } from '../model/worker';
import { FLYING, poseAt, simulate, SIM_SECONDS, type SimResult } from './debris';
import { clamp, easeInOut, easeOut, expoOut, rng, smooth, span, T } from './timeline';

// The opening, drawn as the dashboard draws the car: white paper, blue construction lines, grey track.
// Interlagos, qualifying, car 23 at 315 km/h; the rear steps out, the right front finds the barrier,
// the parts go everywhere; then every part flies into the garage as an exploded drawing, priced.

const C = {
  paper: new THREE.Color('#ffffff'),
  shade: new THREE.Color('#c3d3ea'),
  ink: new THREE.Color('#0747a6'),
  blue: new THREE.Color('#0052cc'),
  iso: new THREE.Color('#4c9aff'),
  grey: new THREE.Color('#8993a4'),
  hurtPaper: new THREE.Color('#fff6f4'),
  hurtShade: new THREE.Color('#f3d0c8'),
  hurtInk: new THREE.Color('#bf2600'),
};

export const WALL_Z = 8.6;
const TRACK_HW = 6.2;
const KERB_W = 0.95;
const CRUISE = 26; // m/s on screen; the readout says 315 km/h, the eye wants something it can follow
const IMPACT = new THREE.Vector3(27, 0, WALL_Z - 1.12);
const WALL_BLOCK = 1.25;
const UP = new THREE.Vector3(0, 1, 0);

/** Parts Anneal reads out in the garage, with the line each one carries. */
export const TAGGED = ['front_wing', 'chassis', 'floor', 'gearbox', 'power_unit', 'rear_wing', 'fsusp_r'] as const;
/** What the São Paulo replay marks destroyed on Albon's car: tinted red in the garage. */
const DESTROYED = new Set(['front_wing', 'nose', 'chassis', 'floor', 'gearbox', 'rear_wing', 'fsusp_r', 'fbrake_r', 'rsusp_r', 'sidepod_r', 'engine_cover']);

const paperVert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  varying vec3 vWN;
  void main() {
    vec4 lp = vec4(position, 1.0);
    vec3 ln = normal;
    #ifdef USE_INSTANCING
      lp = instanceMatrix * lp;
      ln = mat3(instanceMatrix) * ln;
    #endif
    vec4 wp = modelMatrix * lp;
    vW = wp.xyz;
    vWN = normalize(mat3(modelMatrix) * ln);
    vec4 mv = viewMatrix * wp;
    vV = -mv.xyz;
    vN = normalize(normalMatrix * ln);
    gl_Position = projectionMatrix * mv;
  }
`;

const paperFrag = /* glsl */ `
  uniform vec3 uPaper;
  uniform vec3 uShade;
  uniform vec3 uCam;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vW;
  varying vec3 vWN;
  void main() {
    vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 wn = normalize(vWN) * (gl_FrontFacing ? 1.0 : -1.0);
    float fres = 1.0 - abs(dot(n, normalize(vV)));
    float sky = 0.5 + 0.5 * wn.y;
    float k = clamp(pow(fres, 2.4) * 0.9 + (1.0 - sky) * 0.32, 0.0, 1.0);
    vec3 col = mix(uPaper, uShade, k);
    float fog = smoothstep(uFogNear, uFogFar, length(vW - uCam));
    gl_FragColor = vec4(mix(col, vec3(1.0), fog), 1.0);
  }
`;

const groundFrag = /* glsl */ `
  uniform float uOffset;
  uniform float uGarage;
  uniform float uTrack;
  uniform vec3 uCam;
  uniform vec3 uBay;
  uniform float uBayYaw;
  uniform float uFogNear;
  uniform float uFogFar;
  varying vec3 vW;

  float line(float d, float w) {
    float f = fwidth(d) * 1.2;
    return 1.0 - smoothstep(w, w + f, abs(d));
  }
  float grid(float x, float s, float w) {
    float d = (fract(x / s + 0.5) - 0.5) * s;
    return line(d, w);
  }
  void main() {
    vec3 white = vec3(1.0);
    vec3 asphalt = vec3(0.957, 0.961, 0.969);
    vec3 minor = vec3(0.914, 0.925, 0.941);
    vec3 major = vec3(0.835, 0.851, 0.878);
    vec3 blue = vec3(0.0, 0.322, 0.8);
    vec3 col = white;

    // the track: grey asphalt with a measuring grid that streams past, kerbs, run-off hatching
    float x = vW.x + uOffset;
    float z = vW.z;
    float az = abs(z);
    float onTrack = 1.0 - smoothstep(${TRACK_HW.toFixed(2)} - 0.02, ${TRACK_HW.toFixed(2)} + 0.02, az);
    vec3 t = mix(white, asphalt, onTrack);
    float g = max(grid(x, 2.0, 0.012) * 0.6, grid(z, 2.0, 0.012) * 0.6 * onTrack);
    t = mix(t, minor, g * onTrack);
    t = mix(t, major, max(grid(x, 10.0, 0.03), grid(z, 10.0, 0.03)) * onTrack);
    // white lines at the track edge
    t = mix(t, vec3(0.75, 0.78, 0.82), line(az - ${TRACK_HW.toFixed(2)}, 0.05));
    // kerbs: blue and white, one metre a block
    float kerb = step(${TRACK_HW.toFixed(2)}, az) * (1.0 - step(${(TRACK_HW + KERB_W).toFixed(2)}, az));
    float stripe = step(0.5, fract(x / 2.0));
    t = mix(t, mix(white, blue, stripe), kerb);
    t = mix(t, blue, line(az - ${(TRACK_HW + KERB_W).toFixed(2)}, 0.025));
    // run-off between the kerb and the barrier: painted hatching
    float runoff = step(${(TRACK_HW + KERB_W).toFixed(2)}, az) * (1.0 - step(${WALL_Z.toFixed(2)}, az));
    float hatch = grid(x + z, 0.9, 0.05);
    t = mix(t, mix(white, minor, hatch), runoff);
    col = mix(col, t, uTrack);

    // the garage: epoxy floor, half-metre tiles, the bay painted in blue around the car
    vec3 floorCol = vec3(0.973, 0.976, 0.98);
    vec3 gcol = floorCol;
    gcol = mix(gcol, minor, max(grid(vW.x, 1.0, 0.01), grid(vW.z, 1.0, 0.01)));
    vec2 rel = vW.xz - uBay.xz;
    float c = cos(uBayYaw), s = sin(uBayYaw);
    vec2 b = vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
    float inBay = step(abs(b.x), 4.6) * step(abs(b.y), 2.9);
    float bayEdge = max(line(abs(b.x) - 4.6, 0.05) * step(abs(b.y), 2.95), line(abs(b.y) - 2.9, 0.05) * step(abs(b.x), 4.65));
    gcol = mix(gcol, vec3(0.94, 0.955, 0.985), inBay * 0.8);
    float hz = step(abs(b.y), 2.9) * step(4.75, b.x) * (1.0 - step(5.35, b.x));
    gcol = mix(gcol, mix(white, blue, step(0.5, fract((b.x + b.y) / 0.7))), hz);
    gcol = mix(gcol, blue, bayEdge);
    // the centre line the car is set out on
    gcol = mix(gcol, vec3(0.7, 0.78, 0.9), line(b.y, 0.01) * step(abs(b.x), 4.4) * step(0.5, fract(b.x / 0.5)));
    col = mix(col, gcol, uGarage);

    float fog = smoothstep(uFogNear, uFogFar, length(vW - uCam));
    gl_FragColor = vec4(mix(col, white, fog), 1.0);
  }
`;

interface Part {
  id: string;
  index: number;
  mesh: THREE.Mesh;
  edges: LineSegments2;
  iso: THREE.LineSegments;
  centre: THREE.Vector3;
  half: THREE.Vector3;
  explode: THREE.Vector3;
  delay: number;
  wheel: boolean;
  paper: THREE.ShaderMaterial;
  edgeMat: LineMaterial;
  objects: THREE.Object3D[];
}

export interface Frame {
  anchors: Record<string, THREE.Vector3>;
  camera: THREE.PerspectiveCamera;
  width: number;
  height: number;
}

function carPath(u: number) {
  // cubic Bezier from the racing line into the barrier
  const p0 = new THREE.Vector3(0, 0, 0);
  const p1 = new THREE.Vector3(9, 0, 0);
  const p2 = new THREE.Vector3(18, 0, 0.6);
  const p3 = IMPACT;
  const a = 1 - u;
  const pos = new THREE.Vector3()
    .addScaledVector(p0, a * a * a)
    .addScaledVector(p1, 3 * a * a * u)
    .addScaledVector(p2, 3 * a * u * u)
    .addScaledVector(p3, u * u * u);
  const d = new THREE.Vector3()
    .addScaledVector(new THREE.Vector3().subVectors(p1, p0), 3 * a * a)
    .addScaledVector(new THREE.Vector3().subVectors(p2, p1), 6 * a * u)
    .addScaledVector(new THREE.Vector3().subVectors(p3, p2), 3 * u * u);
  return { pos, dir: d.normalize() };
}

export class CrashScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 400);
  private scene = new THREE.Scene();
  private parts: Part[] = [];
  private sim: SimResult | null = null;
  private ground: THREE.Mesh;
  private groundMat: THREE.ShaderMaterial;
  private wall = new THREE.Group();
  private blocks: { obj: THREE.Group; base: number }[] = [];
  private speedLines: THREE.LineSegments;
  private speedSeeds: Float32Array;
  private shards: THREE.LineSegments;
  private shardSeeds: Float32Array;
  private skid: LineSegments2;
  private skidCount = 0;
  private lineMats: LineMaterial[] = [];
  private paperMats: THREE.ShaderMaterial[] = [];
  private offset = 0;
  private lastP = 0;
  private width = 1;
  private height = 1;
  private bay = new THREE.Vector3();
  private bayYaw = 0.28;
  private impactPose = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), dir: new THREE.Vector3() };
  private narrow = false;
  readonly ready: boolean;

  constructor(private canvas: HTMLCanvasElement, wire: WirePart[]) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0xffffff, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.groundMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: groundFrag,
      uniforms: {
        uOffset: { value: 0 },
        uGarage: { value: 0 },
        uTrack: { value: 1 },
        uCam: { value: new THREE.Vector3() },
        uBay: { value: new THREE.Vector3() },
        uBayYaw: { value: 0 },
        uFogNear: { value: 38 },
        uFogFar: { value: 95 },
      },
      extensions: { derivatives: true } as never,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420).rotateX(-Math.PI / 2), this.groundMat);
    this.ground.position.set(20, 0, 0);
    this.scene.add(this.ground);

    this.buildWall();
    this.buildParts(wire);
    ({ lines: this.speedLines, seeds: this.speedSeeds } = this.buildSpeedLines());
    ({ lines: this.shards, seeds: this.shardSeeds } = this.buildShards());
    this.skid = this.buildSkid();
    this.prepareCrash();
    this.ready = true;
  }

  // ------------------------------------------------------------------ building

  private paper(base = C.paper, shade = C.shade) {
    const m = new THREE.ShaderMaterial({
      vertexShader: paperVert,
      fragmentShader: paperFrag,
      uniforms: {
        uPaper: { value: base.clone() },
        uShade: { value: shade.clone() },
        uCam: { value: new THREE.Vector3() },
        uFogNear: { value: 38 },
        uFogFar: { value: 95 },
      },
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1.5,
      polygonOffsetUnits: 2,
    });
    this.paperMats.push(m);
    return m;
  }

  private lineMat(color: THREE.Color, width: number, opacity = 1) {
    const m = new LineMaterial({ color: color.getHex(), linewidth: width, transparent: opacity < 1, opacity, worldUnits: false });
    m.fog = false;
    this.lineMats.push(m);
    return m;
  }

  private buildWall() {
    const geo = new THREE.BoxGeometry(WALL_BLOCK - 0.06, 1.05, 0.95);
    const edges = new THREE.EdgesGeometry(geo);
    const segs = new LineSegmentsGeometry().setPositions(edges.attributes.position.array as Float32Array);
    const white = this.paper(C.paper, new THREE.Color('#d5dce8'));
    const blue = this.paper(new THREE.Color('#deebff'), new THREE.Color('#a9c6f0'));
    const ink = this.lineMat(C.grey, 1.1, 0.9);
    // a debris fence above the barrier: posts and three wires
    const fence: number[] = [];
    for (let i = -40; i <= 110; i++) {
      const x = i * WALL_BLOCK;
      if (i % 3 === 0) fence.push(x, 1.05, WALL_Z + 0.75, x, 3.6, WALL_Z + 0.75);
    }
    for (const y of [1.9, 2.75, 3.55]) fence.push(-40 * WALL_BLOCK, y, WALL_Z + 0.75, 110 * WALL_BLOCK, y, WALL_Z + 0.75);
    const fenceGeo = new LineSegmentsGeometry().setPositions(fence);
    const fenceLines = new LineSegments2(fenceGeo, this.lineMat(new THREE.Color('#b3bac5'), 1, 0.8));
    this.wall.add(fenceLines);
    for (let i = -40; i <= 110; i++) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(geo, i % 2 ? blue : white);
      const l = new LineSegments2(segs, ink);
      g.add(m, l);
      g.position.set(i * WALL_BLOCK, 0.525, WALL_Z + 0.475);
      this.wall.add(g);
      this.blocks.push({ obj: g, base: i * WALL_BLOCK });
    }
    this.scene.add(this.wall);
  }

  private buildParts(wire: WirePart[]) {
    const byId = new Map(wire.map((w) => [w.id, w]));
    PARTS.forEach((def, index) => {
      const w = byId.get(def.id);
      if (!w) return;
      const [x0, y0, z0, x1, y1, z1] = w.bounds;
      const centre = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      const half = new THREE.Vector3(Math.max(0.03, (x1 - x0) / 2), Math.max(0.03, (y1 - y0) / 2), Math.max(0.03, (z1 - z0) / 2));
      const shift = (a: Float32Array) => {
        for (let i = 0; i < a.length; i += 3) {
          a[i] -= centre.x;
          a[i + 1] -= centre.y;
          a[i + 2] -= centre.z;
        }
        return a;
      };
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(shift(w.pos), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(w.nrm, 3));
      g.setIndex(new THREE.BufferAttribute(w.idx, 1));
      const paper = this.paper();
      const mesh = new THREE.Mesh(g, paper);
      const edgeMat = this.lineMat(C.ink, 1.15);
      const edges = new LineSegments2(new LineSegmentsGeometry().setPositions(shift(w.edges)), edgeMat);
      const isoGeo = new THREE.BufferGeometry();
      isoGeo.setAttribute('position', new THREE.BufferAttribute(shift(w.iso), 3));
      const iso = new THREE.LineSegments(isoGeo, new THREE.LineBasicMaterial({ color: C.iso, transparent: true, opacity: 0.28, depthWrite: false }));
      const objects = [mesh, edges, iso];
      for (const o of objects) {
        o.matrixAutoUpdate = false;
        o.frustumCulled = false;
        this.scene.add(o);
      }
      this.parts.push({
        id: def.id,
        index,
        mesh,
        edges,
        iso,
        centre,
        half,
        explode: new THREE.Vector3(...def.explode),
        delay: def.delay,
        wheel: def.id.startsWith('wheel_'),
        paper,
        edgeMat,
        objects,
      });
    });
  }

  private buildSpeedLines() {
    const n = 90;
    const seeds = new Float32Array(n * 4);
    const r = rng(23);
    for (let i = 0; i < n; i++) seeds.set([r() * 60, 0.05 + r() * 2.6, -7 + r() * 15, 2 + r() * 7], i * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#7aa7e8', transparent: true, opacity: 0.55, depthWrite: false }));
    lines.frustumCulled = false;
    this.scene.add(lines);
    return { lines, seeds };
  }

  private buildShards() {
    const n = 260;
    const seeds = new Float32Array(n * 8);
    const r = rng(55);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI * 0.95 + r() * Math.PI * 0.9;
      const sp = 3 + r() * 13;
      seeds.set([Math.cos(a) * sp * 0.9 + 6, 1.5 + r() * 7, Math.sin(a) * sp * 0.6 - 1, 0.04 + r() * 0.16, r() * 6.28, r() * 6.28, r() * 0.4, r()], i * 8);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6), 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#172b4d', transparent: true, opacity: 0.85, depthWrite: false }));
    lines.frustumCulled = false;
    lines.visible = false;
    this.scene.add(lines);
    return { lines, seeds };
  }

  private buildSkid() {
    // four tyre lines from the moment the rear lets go to the barrier
    const pts: number[] = [];
    const steps = 80;
    const tyres: [number, number][] = [
      [1.7, 0.81], [1.7, -0.81], [-1.7, 0.76], [-1.7, -0.76],
    ];
    const pose = (u: number) => this.poseOnPath(u);
    for (const [tx, tz] of tyres) {
      for (let i = 0; i < steps; i++) {
        const a = pose(0.28 + (0.72 * i) / steps);
        const b = pose(0.28 + (0.72 * (i + 1)) / steps);
        const pa = new THREE.Vector3(tx, 0.012, tz).applyQuaternion(a.quat).add(a.pos);
        const pb = new THREE.Vector3(tx, 0.012, tz).applyQuaternion(b.quat).add(b.pos);
        pts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      }
    }
    this.skidCount = steps;
    const geo = new LineSegmentsGeometry().setPositions(pts);
    const skid = new LineSegments2(geo, this.lineMat(new THREE.Color('#a5adba'), 3.2, 0.55));
    skid.frustumCulled = false;
    this.scene.add(skid);
    return skid;
  }

  private poseOnPath(u: number) {
    const { pos, dir } = carPath(u);
    const heading = Math.atan2(-dir.z, dir.x);
    const slip = -0.62 * smooth(span(u, 0.22, 1));
    const quat = new THREE.Quaternion().setFromAxisAngle(UP, heading + slip);
    return { pos, quat, dir };
  }

  private prepareCrash() {
    const end = this.poseOnPath(1);
    this.impactPose = { pos: end.pos, quat: end.quat, dir: end.dir };
    this.sim = simulate({
      ids: this.parts.map((p) => p.id),
      centres: this.parts.map((p) => p.centre),
      half: this.parts.map((p) => p.half),
      carPos: end.pos,
      carQuat: end.quat,
      velocity: end.dir.clone().multiplyScalar(CRUISE),
      wallZ: WALL_Z,
    });
    this.bay.copy(this.sim.restAt).add(new THREE.Vector3(-1.5, 0, -4.2));
  }

  // ------------------------------------------------------------------ per frame

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.narrow = w < 760;
    const dpr = Math.min(window.devicePixelRatio || 1, this.narrow ? 1.6 : 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = this.narrow ? 46 : 32;
    this.camera.updateProjectionMatrix();
    for (const m of this.lineMats) m.resolution.set(w * dpr, h * dpr);
  }

  /** Draws the frame for scroll position p; `time` keeps the idle lap alive before the visitor scrolls. */
  render(p: number, time: number, dt: number): Frame {
    const cruising = p < T.snap;
    if (cruising) this.offset += CRUISE * dt * (1 - 0.6 * span(p, 0.06, T.snap));
    this.lastP = p;

    // --- the car, or what is left of it
    const anchors: Record<string, THREE.Vector3> = {};
    let carPos = new THREE.Vector3();
    let carQuat = new THREE.Quaternion();
    let wheelTurn = 0;
    if (p < T.impact) {
      const u = span(p, T.snap, T.impact);
      const sway = (1 - span(p, 0.05, T.snap)) * 0.18;
      if (u <= 0) {
        carPos.set(0, 0, Math.sin(time * 0.9) * sway);
        carQuat.setFromAxisAngle(UP, -Math.cos(time * 0.9) * sway * 0.05);
      } else {
        const pose = this.poseOnPath(easeInOut(u) * 0.35 + u * 0.65);
        carPos = pose.pos;
        carQuat = pose.quat;
      }
      wheelTurn = (this.offset + carPos.x) / 0.355;
    }
    const debrisS = SIM_SECONDS * (0.35 * span(p, T.impact, T.debrisEnd) + 0.65 * Math.pow(span(p, T.impact, T.debrisEnd), 1.6));
    const toGarage = span(p, T.garageIn, T.garageSet);
    const garageYaw = this.bayYaw + Math.sin(time * 0.22) * 0.08 * span(p, T.garageSet, 1);
    const garageQuat = new THREE.Quaternion().setFromAxisAngle(UP, garageYaw);
    const explodeK = 1.15 + 0.2 * smooth(span(p, T.tags, 0.95));

    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const spin = new THREE.Quaternion();
    for (const part of this.parts) {
      if (p < T.impact || !this.sim) {
        pos.copy(part.centre).applyQuaternion(carQuat).add(carPos);
        quat.copy(carQuat);
        if (part.wheel) quat.multiply(spin.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -wheelTurn));
      } else {
        poseAt(this.sim.tracks[part.index], debrisS, pos, quat);
        if (toGarage > 0) {
          const local = new THREE.Vector3().copy(part.centre).addScaledVector(part.explode, explodeK).add(new THREE.Vector3(0, 0.42, 0));
          const target = local.applyQuaternion(garageQuat).add(this.bay);
          const u = easeInOut(clamp((toGarage - part.delay * 0.9) / 0.62));
          const lift = Math.sin(Math.PI * u) * (1.4 + part.delay * 2);
          pos.lerp(target, u).add(new THREE.Vector3(0, lift, 0));
          quat.slerp(garageQuat, u);
        }
      }
      m.compose(pos, quat, one);
      for (const o of part.objects) {
        o.matrix.copy(m);
        o.matrixWorldNeedsUpdate = true;
      }
      anchors[part.id] = pos.clone();
      // damage shows once the garage has the car
      const hurt = DESTROYED.has(part.id) ? smooth(span(p, T.garageSet - 0.02, T.tags + 0.02)) : 0;
      part.paper.uniforms.uPaper.value.copy(C.paper).lerp(C.hurtPaper, hurt);
      part.paper.uniforms.uShade.value.copy(C.shade).lerp(C.hurtShade, hurt);
      part.edgeMat.color.copy(C.ink).lerp(C.hurtInk, hurt * 0.7);
    }

    // --- the barrier: streams with the track, gives where the car hits it, leaves for the garage
    const wallPush = easeOut(span(p, T.impact, T.impact + 0.018));
    const wallGone = smooth(span(p, T.collapse, T.garageIn + 0.03));
    this.wall.visible = wallGone < 0.999;
    const shift = cruising ? -(this.offset % WALL_BLOCK) : this.frozenShift();
    for (const b of this.blocks) {
      const x = b.base + shift;
      const d = Math.abs(x - IMPACT.x - 0.6);
      const k = Math.max(0, 1 - d / 4.2) * wallPush;
      b.obj.position.set(x, 0.525 - wallGone * 2.4, WALL_Z + 0.475 + k * 0.75);
      b.obj.rotation.set(0, (x - IMPACT.x) * 0.05 * k, k * 0.04);
    }
    this.wall.children[0].position.y = -wallGone * 4;

    // --- skid marks, then the shards of carbon
    const skidU = span(p, T.snap + (T.impact - T.snap) * 0.25, T.impact);
    const skidN = Math.floor(this.skidCount * skidU);
    (this.skid.geometry as LineSegmentsGeometry).instanceCount = skidN > 0 ? skidN * 4 : 0;
    this.skid.visible = skidN > 0 && wallGone < 1;
    this.updateSkidOrder(skidN);
    this.updateShards(p, wallGone);
    this.updateSpeedLines(p, carPos);

    // --- ground
    this.groundMat.uniforms.uOffset.value = cruising ? this.offset : this.frozenOffset();
    this.groundMat.uniforms.uTrack.value = 1 - wallGone;
    this.groundMat.uniforms.uGarage.value = smooth(span(p, T.collapse + 0.02, T.garageIn + 0.06));
    this.groundMat.uniforms.uBay.value.copy(this.bay);
    this.groundMat.uniforms.uBayYaw.value = garageYaw;

    this.placeCamera(p, time, carPos, carQuat);
    for (const mat of this.paperMats) mat.uniforms.uCam.value.copy(this.camera.position);
    this.groundMat.uniforms.uCam.value.copy(this.camera.position);
    if (cruising) this.frozen = { offset: this.offset };
    this.renderer.render(this.scene, this.camera);
    return { anchors, camera: this.camera, width: this.width, height: this.height };
  }

  private frozen = { offset: 0 };
  private frozenOffset() {
    return this.frozen.offset;
  }
  private frozenShift() {
    return -(this.frozen.offset % WALL_BLOCK);
  }

  private updateSkidOrder(_n: number) {
    // segments are stored tyre by tyre; instanceCount reveals each tyre's run in order because
    // LineSegments2 draws instances 0..count-1: interleave once so all four lines grow together
    if (this.skidInterleaved) return;
    const geo = this.skid.geometry as LineSegmentsGeometry;
    const start = geo.attributes.instanceStart as THREE.InterleavedBufferAttribute;
    const data = start.data.array as Float32Array;
    const copy = data.slice();
    const per = this.skidCount;
    for (let tyre = 0; tyre < 4; tyre++) {
      for (let i = 0; i < per; i++) {
        data.set(copy.subarray((tyre * per + i) * 6, (tyre * per + i) * 6 + 6), (i * 4 + tyre) * 6);
      }
    }
    start.data.needsUpdate = true;
    this.skidInterleaved = true;
  }
  private skidInterleaved = false;

  private updateShards(p: number, gone: number) {
    const s = span(p, T.impact, T.debrisEnd) * 2.2;
    const vis = p > T.impact && gone < 0.98;
    this.shards.visible = vis;
    if (!vis) return;
    const arr = (this.shards.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const n = this.shardSeeds.length / 8;
    const o = this.impactPose.pos;
    for (let i = 0; i < n; i++) {
      const [vx, vy, vz, len, a1, a2, delay] = this.shardSeeds.subarray(i * 8, i * 8 + 8);
      const t = Math.max(0, s - delay * 0.3);
      // ballistic until the ground, then it stays where it fell
      const tLand = (vy + Math.sqrt(vy * vy + 2 * 9.81 * 0.6)) / 9.81;
      const tt = Math.min(t, tLand);
      const x = o.x + 1.4 + vx * tt * 0.55;
      const z = Math.min(WALL_Z - 0.05, o.z + vz * tt * 0.55);
      const y = Math.max(0.01, 0.6 + vy * tt - 4.9 * tt * tt);
      const spinA = a1 + tt * 9;
      const dx = Math.cos(spinA) * Math.cos(a2) * len;
      const dy = t >= tLand ? 0 : Math.sin(spinA) * len;
      const dz = Math.sin(a2) * len;
      arr.set([x - dx, y - dy, z - dz, x + dx, y + dy, z + dz], i * 6);
    }
    (this.shards.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.shards.material as THREE.LineBasicMaterial).opacity = 0.85 * (1 - gone);
  }

  private updateSpeedLines(p: number, car: THREE.Vector3) {
    const k = p < T.impact ? 1 - 0.5 * span(p, T.snap, T.impact) : 0;
    this.speedLines.visible = k > 0.01;
    if (!this.speedLines.visible) return;
    const arr = (this.speedLines.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const n = this.speedSeeds.length / 4;
    for (let i = 0; i < n; i++) {
      const [x0, y, z, len] = this.speedSeeds.subarray(i * 4, i * 4 + 4);
      const x = car.x + 30 - ((x0 + this.offset * 1.7) % 60);
      arr.set([x, y, car.z + z, x + len * k, y, car.z + z], i * 6);
    }
    (this.speedLines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.speedLines.material as THREE.LineBasicMaterial).opacity = 0.5 * k;
  }

  private placeCamera(p: number, time: number, carPos: THREE.Vector3, carQuat: THREE.Quaternion) {
    const cam = this.camera;
    const target = new THREE.Vector3();
    const at = new THREE.Vector3();
    const narrow = this.narrow;

    // chase: behind and to the left of the car, low, the barrier on the right of the frame
    const chase = (car: THREE.Vector3, pull: number) => {
      const yaw = new THREE.Euler().setFromQuaternion(carQuat, 'YXZ').y * 0.35;
      const off = new THREE.Vector3(-7.4 - pull * 2.5, 1.55 + pull * 1.2, -3.9 - pull * 1.5).applyAxisAngle(UP, yaw);
      if (narrow) off.multiplyScalar(1.25).add(new THREE.Vector3(0, 0.8, 0));
      return { pos: car.clone().add(off), look: car.clone().add(new THREE.Vector3(2.6, 0.45, 0.9)) };
    };
    const I = this.impactPose.pos;
    const wide = { pos: I.clone().add(new THREE.Vector3(-11, 7.2, -13.5)), look: I.clone().add(new THREE.Vector3(2.2, 0, -1.6)) };
    if (narrow) wide.pos.add(new THREE.Vector3(-4, 3, -5));
    const orbitA = 0.2 * span(this.lastP, T.debrisEnd, T.collapse);
    const orbit = {
      pos: I.clone().add(new THREE.Vector3(-11, 7.2, -13.5).applyAxisAngle(UP, -orbitA)),
      look: wide.look,
    };
    if (narrow) orbit.pos.add(new THREE.Vector3(-4, 3, -5).applyAxisAngle(UP, -orbitA));
    const g = this.bay;
    const garageView = {
      pos: g.clone().add(narrow ? new THREE.Vector3(4.6, 11.5, 17.5) : new THREE.Vector3(8.4, 8.2, 16.4)),
      look: g.clone().add(narrow ? new THREE.Vector3(-0.3, 0.2, 0) : new THREE.Vector3(-0.6, 0.25, 0.2)),
    };

    if (p < T.impact) {
      const c = chase(carPos, span(p, T.snap, T.impact) * 0.4);
      at.copy(c.pos);
      target.copy(c.look);
      at.y += Math.sin(time * 1.3) * 0.03 * (1 - span(p, 0, T.snap));
    } else if (p < T.debrisEnd) {
      const frozen = chase(this.impactPose.pos, 0.4);
      const u = expoOut(span(p, T.impact, T.debrisEnd));
      at.copy(frozen.pos).lerp(wide.pos, u);
      target.copy(frozen.look).lerp(wide.look, u);
    } else if (p < T.garageIn) {
      at.copy(orbit.pos);
      target.copy(orbit.look);
    } else {
      const u = easeInOut(span(p, T.garageIn, T.garageSet));
      at.copy(orbit.pos).lerp(garageView.pos, u);
      target.copy(orbit.look).lerp(garageView.look, u);
      const drift = span(p, T.garageSet, 1);
      at.add(new THREE.Vector3(-drift * 1.2, -drift * 0.5, -drift * 0.8));
    }

    // the hit: a short, sharp shake that dies away
    const hit = span(p, T.impact, T.impact + 0.03);
    if (hit > 0 && hit < 1) {
      const a = (1 - hit) * (1 - hit) * 0.5;
      at.add(new THREE.Vector3(Math.sin(hit * 91) * a, Math.sin(hit * 67 + 1) * a * 0.6, Math.cos(hit * 79) * a));
    }
    cam.position.copy(at);
    cam.lookAt(target);
    // the lap: lift the car clear of the wordmark; the garage: keep the car right of the headline
    const lap = 1 - smooth(span(p, 0.04, T.snap));
    const garage = smooth(span(p, T.garageIn, T.garageSet));
    const shiftX = !narrow && p > T.garageIn ? -this.width * 0.15 * garage : 0;
    const shiftY = (narrow && p > T.garageIn ? this.height * 0.16 * garage : 0) + this.height * (narrow ? 0.1 : 0.17) * lap;
    if (shiftX || shiftY) cam.setViewOffset(this.width, this.height, shiftX, shiftY, this.width, this.height);
    else cam.clearViewOffset();
  }

  dispose() {
    this.renderer.dispose();
  }
}

/** The wire parts, built in a worker once per page. */
export function loadCar(): Promise<WirePart[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../model/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<{ ok: true; parts: WirePart[] } | { ok: false; error: string }>) => {
      w.terminate();
      if (e.data.ok) resolve(e.data.parts);
      else reject(new Error(e.data.error));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message));
    };
    w.postMessage(null);
  });
}

export { FLYING };
