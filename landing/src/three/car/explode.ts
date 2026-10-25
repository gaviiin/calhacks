import * as THREE from 'three';
import { sceneState } from '../state';

// Teardown choreography. Each exploded part declares when it leaves (delay/span inside
// the scene's explode factor), where it goes, how it tilts and how far it arcs on the way.
// Parts register here so the tether lines and the HUD can read their live state.

export type ExplodeKey = 'explodeFront' | 'explodeMid' | 'explodeRear' | 'explodeTop';

export type PartSpec = {
  k: ExplodeKey;
  /** Fully exploded displacement, car metres (local to the part's parent). */
  offset: [number, number, number];
  /** Fully exploded tilt, radians. */
  rot?: [number, number, number];
  /** Start / length of this part's move inside the 0..1 explode factor. */
  delay?: number;
  span?: number;
  /** Extra lift at the middle of the move, so parts travel on an arc. */
  arc?: number;
  /** Idle float amplitude once detached. */
  float?: number;
  /** Mount point in the parent's space; a tether line is drawn from here when set. */
  anchor?: [number, number, number];
  /** 'back' settles with a small overshoot (default); 'smooth' for spins and straight pulls. */
  ease?: 'back' | 'smooth';
  /** Continuous rotation once detached, rad/s per axis, scaled by progress. */
  spin?: [number, number, number];
  label?: string;
};

export type PartState = {
  spec: PartSpec;
  /** Eased progress 0..1 (may overshoot slightly). */
  t: number;
  group: THREE.Group | null;
  worldAnchor: THREE.Vector3;
  worldPos: THREE.Vector3;
};

export const parts = new Set<PartState>();

export function registerPart(spec: PartSpec): PartState {
  const state: PartState = { spec, t: 0, group: null, worldAnchor: new THREE.Vector3(), worldPos: new THREE.Vector3() };
  parts.add(state);
  return state;
}

export function unregisterPart(state: PartState) {
  parts.delete(state);
}

/** Mild overshoot so parts settle like they were set down, not slid. */
export function easeOutBack(x: number) {
  const c1 = 1.1;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function partProgress(spec: PartSpec, factor: number) {
  const delay = spec.delay ?? 0;
  const span = spec.span ?? 0.6;
  const u = THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((factor - delay) / span, 0, 1), 0, 1);
  return spec.ease === 'smooth' ? u : easeOutBack(u);
}

const tmp = new THREE.Vector3();

/** Updates one registered part from the scene state. Called from the part's frame loop. */
export function updatePart(state: PartState, time: number) {
  const { spec, group } = state;
  if (!group) return;
  const factor = sceneState[spec.k];
  const t = partProgress(spec, factor);
  state.t = t;
  const floatAmp = (spec.float ?? 0.006) * Math.min(1, t);
  const phase = (spec.offset[0] + spec.offset[2]) * 7.3;
  const lift = (spec.arc ?? 0) * Math.sin(Math.PI * Math.min(1, t));
  group.position.set(
    spec.offset[0] * t + Math.sin(time * 0.9 + phase) * floatAmp * 0.4,
    spec.offset[1] * t + lift + Math.sin(time * 1.3 + phase) * floatAmp,
    spec.offset[2] * t + Math.cos(time * 0.7 + phase) * floatAmp * 0.4
  );
  if (spec.rot || spec.spin) {
    const r = spec.rot ?? [0, 0, 0];
    const s = spec.spin ?? [0, 0, 0];
    const w = Math.min(1, t) * time;
    group.rotation.set(r[0] * t + s[0] * w, r[1] * t + s[1] * w, r[2] * t + s[2] * w);
  }
  if (spec.anchor) {
    tmp.set(spec.anchor[0], spec.anchor[1], spec.anchor[2]);
    group.parent?.localToWorld(state.worldAnchor.copy(tmp));
    group.localToWorld(state.worldPos.copy(tmp));
  }
}

/** Highest explode factor in play and how many parts have left their mounts. */
export function teardownStatus() {
  const s = sceneState;
  const factor = Math.max(s.explodeFront, s.explodeMid, s.explodeRear, s.explodeTop);
  let detached = 0;
  for (const p of parts) if (p.t > 0.5) detached++;
  return { factor, detached, total: parts.size };
}
