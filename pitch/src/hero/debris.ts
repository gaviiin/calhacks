import * as THREE from 'three';
import { rng } from './timeline';

// The crash, simulated once when the page loads and then played back by the scroll, so scrolling up
// un-crashes the car exactly. Parts that stay on the tub ride with it; the rest fly, bounce off the
// barrier and the ground, and settle on whichever face they land.

export const SIM_SECONDS = 3.2;
export const FRAMES = 384;
const DT = 1 / 480;
const G = 9.81;

/** Parts that leave the survival cell when the right front hits the wall. */
export const FLYING = new Set([
  'front_wing', 'nose', 'wheel_f_r', 'wheel_f_l', 'fsusp_r', 'fbrake_r', 'wss_f_r', 'mirror_r', 'sidepod_r',
  'wheel_r_r', 'rsusp_r', 'rbrake_r', 'wss_r_r', 'rear_wing', 'engine_cover', 'floor',
]);

export interface SimInput {
  ids: string[];
  /** part centre in the car's frame */
  centres: THREE.Vector3[];
  half: THREE.Vector3[];
  carPos: THREE.Vector3;
  carQuat: THREE.Quaternion;
  velocity: THREE.Vector3;
  wallZ: number;
}

export interface SimResult {
  /** per part: FRAMES x (px py pz qx qy qz qw), world space */
  tracks: Float32Array[];
  /** where the tub ends up: used to place the impact shards and the camera */
  restAt: THREE.Vector3;
}

const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => new THREE.Vector3(x, y, z))));
const tmp = new THREE.Vector3();

function extent(q: THREE.Quaternion, half: THREE.Vector3, axis: 'y' | 'z', sign: 1 | -1) {
  let best = -Infinity;
  for (const c of corners) {
    tmp.set(c.x * half.x, c.y * half.y, c.z * half.z).applyQuaternion(q);
    best = Math.max(best, sign * tmp[axis]);
  }
  return best;
}

/** The nearest resting orientation that keeps the part's yaw: upright, or on its back. */
function restingQuat(q: THREE.Quaternion) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
  const yaw = Math.atan2(-fwd.z, fwd.x);
  const r = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (up.y < 0) r.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
  return r;
}

interface Body {
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  half: THREE.Vector3;
  grounded: number;
}

function step(b: Body, wallZ: number, friction: number) {
  b.v.y -= G * DT;
  b.v.multiplyScalar(1 - 0.08 * DT);
  b.p.addScaledVector(b.v, DT);
  const wl = b.w.length();
  if (wl > 1e-5) {
    const dq = new THREE.Quaternion().setFromAxisAngle(tmp.copy(b.w).divideScalar(wl), wl * DT);
    b.q.premultiply(dq).normalize();
  }
  const below = extent(b.q, b.half, 'y', -1);
  if (b.p.y - below < 0) {
    b.p.y = below;
    if (b.v.y < 0) b.v.y = -b.v.y * 0.28;
    const keep = Math.max(0, 1 - friction * DT);
    b.v.x *= keep;
    b.v.z *= keep;
    b.w.multiplyScalar(Math.max(0, 1 - 5 * DT));
    b.grounded += DT;
    const slow = b.v.length() < 2.2 ? 1 : 0.15;
    b.q.slerp(restingQuat(b.q), Math.min(1, 6 * DT * slow));
  }
  const reach = extent(b.q, b.half, 'z', 1);
  if (b.p.z + reach > wallZ) {
    b.p.z = wallZ - reach;
    if (b.v.z > 0) b.v.z = -b.v.z * 0.3;
    b.w.multiplyScalar(0.9);
  }
}

export function simulate(input: SimInput): SimResult {
  const rand = rng(1249);
  const n = input.ids.length;
  const tracks = input.ids.map(() => new Float32Array(FRAMES * 7));
  const v0 = input.velocity;

  // the tub and everything bolted to it: one body
  const tub: Body = {
    p: input.carPos.clone(),
    v: new THREE.Vector3(v0.x * 0.5, 1.2, -Math.abs(v0.z) * 0.35),
    q: input.carQuat.clone(),
    w: new THREE.Vector3(0.35, 2.6, -0.5),
    half: new THREE.Vector3(2.3, 0.42, 0.62),
    grounded: 0,
  };
  tub.p.y = tub.half.y - 0.02;
  const bodies: (Body | null)[] = input.ids.map((id, i) => {
    if (!FLYING.has(id)) return null;
    const c = input.centres[i].clone().applyQuaternion(input.carQuat).add(input.carPos);
    const vol = input.half[i].x * input.half[i].y * input.half[i].z * 8;
    const light = vol < 0.05 ? 1 : vol < 0.3 ? 0.7 : 0.45;
    const front = input.centres[i].x > 0.6 ? 1 : 0.55;
    const right = input.centres[i].z > 0.2 ? 1 : 0.6;
    const v = new THREE.Vector3(
      v0.x * (0.45 + 0.35 * rand()) * front,
      (2.2 + 5.5 * rand()) * light * right,
      -Math.abs(v0.z) * (0.2 + 0.5 * rand()) - 2.5 * rand() * right,
    );
    if (id === 'floor') v.set(v0.x * 0.62, 0.4, -0.6);
    const spin = (5 + 11 * rand()) * light;
    const w = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(spin);
    if (id === 'floor') w.set(0, 1.4, 0);
    return { p: c, v, q: input.carQuat.clone(), w, half: input.half[i].clone(), grounded: 0 };
  });

  const perFrame = Math.round(SIM_SECONDS / DT / FRAMES);
  const write = (f: number) => {
    for (let i = 0; i < n; i++) {
      const o = f * 7;
      const b = bodies[i];
      if (b) {
        tracks[i].set([b.p.x, b.p.y, b.p.z, b.q.x, b.q.y, b.q.z, b.q.w], o);
      } else {
        tmp.copy(input.centres[i]).applyQuaternion(tub.q).add(tub.p);
        tmp.y -= tub.half.y - 0.02 - 0.0;
        tracks[i].set([tmp.x, tmp.y, tmp.z, tub.q.x, tub.q.y, tub.q.z, tub.q.w], o);
      }
    }
  };
  for (let f = 0; f < FRAMES; f++) {
    write(f);
    for (let s = 0; s < perFrame; s++) {
      step(tub, input.wallZ, 7);
      for (const b of bodies) if (b) step(b, input.wallZ, 3.2);
    }
  }
  return { tracks, restAt: tub.p.clone().setY(0) };
}

/** Pose of part i at sim time s (seconds), interpolated between stored frames. */
export function poseAt(track: Float32Array, s: number, pos: THREE.Vector3, quat: THREE.Quaternion) {
  const f = Math.min(FRAMES - 1.001, Math.max(0, (s / SIM_SECONDS) * (FRAMES - 1)));
  const i = Math.floor(f);
  const t = f - i;
  const a = i * 7;
  const b = a + 7;
  pos.set(
    track[a] + (track[b] - track[a]) * t,
    track[a + 1] + (track[b + 1] - track[a + 1]) * t,
    track[a + 2] + (track[b + 2] - track[a + 2]) * t,
  );
  quat.set(track[a + 3], track[a + 4], track[a + 5], track[a + 6]);
  const q2 = new THREE.Quaternion(track[b + 3], track[b + 4], track[b + 5], track[b + 6]);
  quat.slerp(q2, t);
}
