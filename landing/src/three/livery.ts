import * as THREE from 'three';
import { LIVERIES, liverySequence, sceneState } from './state';

// Livery system: one set of uniforms shared by every painted material. The
// colourway is resolved per pixel from the car-space position (two-tone zones +
// an accent stripe) and blended between two palettes along a wipe that sweeps
// nose → tail with a glowing leading edge. Metalness/roughness blend with it.

export const liveryUniforms = {
  uPrimA: { value: new THREE.Color() },
  uSecA: { value: new THREE.Color() },
  uAccA: { value: new THREE.Color() },
  uPrimB: { value: new THREE.Color() },
  uSecB: { value: new THREE.Color() },
  uAccB: { value: new THREE.Color() },
  uMetalA: { value: 0.5 },
  uMetalB: { value: 0.5 },
  uRoughA: { value: 0.3 },
  uRoughB: { value: 0.3 },
  /** -0.2 … 1.2 so the edge fully clears both ends of the car. */
  uWipe: { value: 1.2 },
  uTime: { value: 0 },
};

/** Current accent colour (linear) for lights and overlays, blended like the paint. */
export const liveryNow = { accent: new THREE.Color(), rim: new THREE.Color(), key: new THREE.Color(), primary: new THREE.Color() };

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

/** Copies the blended palette from `sceneState` into the uniforms. Called every frame. */
export function syncLivery(t: number) {
  const last = liverySequence.length - 1;
  const i = THREE.MathUtils.clamp(sceneState.liveryT, 0, last);
  const lo = Math.floor(i);
  const hi = Math.min(last, lo + 1);
  const wipe = i - lo;
  const a = LIVERIES[liverySequence[lo]];
  const b = LIVERIES[liverySequence[hi]];
  const u = liveryUniforms;
  u.uPrimA.value.set(a.primary);
  u.uSecA.value.set(a.secondary);
  u.uAccA.value.set(a.accent);
  u.uPrimB.value.set(b.primary);
  u.uSecB.value.set(b.secondary);
  u.uAccB.value.set(b.accent);
  u.uMetalA.value = a.metalness;
  u.uMetalB.value = b.metalness;
  u.uRoughA.value = a.roughness;
  u.uRoughB.value = b.roughness;
  u.uWipe.value = -0.2 + 1.4 * wipe;
  u.uTime.value = t;
  const w = THREE.MathUtils.smoothstep(wipe, 0.15, 0.85);
  liveryNow.accent.copy(tmpA.set(a.accent)).lerp(tmpB.set(b.accent), w);
  liveryNow.rim.copy(tmpA.set(a.rim)).lerp(tmpB.set(b.rim), w);
  liveryNow.key.copy(tmpA.set(a.key)).lerp(tmpB.set(b.key), w);
  liveryNow.primary.copy(tmpA.set(a.primary)).lerp(tmpB.set(b.primary), w);
}

export const LIVERY_VERTEX_PARS = /* glsl */ `
varying vec3 vCarPos;
`;
export const LIVERY_VERTEX = /* glsl */ `
vCarPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

export const LIVERY_FRAGMENT_PARS = /* glsl */ `
varying vec3 vCarPos;
uniform vec3 uPrimA, uSecA, uAccA, uPrimB, uSecB, uAccB;
uniform float uMetalA, uMetalB, uRoughA, uRoughB, uWipe, uTime;
uniform float uZone; // -1 auto, 0 primary, 1 secondary, 2 accent

// Returns (primary, secondary, accent) weights for a point on the car.
vec3 liveryZone(vec3 p) {
  if (uZone >= 0.0) return vec3(uZone == 0.0 ? 1.0 : 0.0, uZone == 1.0 ? 1.0 : 0.0, uZone == 2.0 ? 1.0 : 0.0);
  float aa = max(fwidth(p.y), 0.002) * 1.5;
  // Lower bodywork: carbon-black below a line that dips at the sidepod undercut.
  float cut = 0.215 + 0.03 * smoothstep(-2.2, 1.0, p.x);
  float low = 1.0 - smoothstep(cut - aa, cut + aa, p.y);
  // Nose tip.
  float nose = smoothstep(2.42, 2.46, p.x);
  // Flank stripe sweeping up toward the rear.
  float band = p.y - (0.33 + 0.085 * p.x);
  float stripe = (1.0 - smoothstep(0.016, 0.016 + aa, abs(band))) * smoothstep(-2.3, -2.1, p.x) * (1.0 - smoothstep(1.25, 1.4, p.x));
  stripe *= step(0.2, abs(p.z));
  // Centre spine on the engine cover.
  float spine = (1.0 - smoothstep(0.012, 0.012 + aa, abs(p.z))) * step(0.5, p.y) * (1.0 - smoothstep(-0.9, -0.8, p.x));
  float acc = clamp(stripe + spine, 0.0, 1.0);
  float sec = clamp(max(low, nose) * (1.0 - acc), 0.0, 1.0);
  return vec3(1.0 - sec - acc, sec, acc);
}

vec3 liveryColor(vec3 p, out float metal, out float rough, out float edge) {
  vec3 z = liveryZone(p);
  vec3 colA = uPrimA * z.x + uSecA * z.y + uAccA * z.z;
  vec3 colB = uPrimB * z.x + uSecB * z.y + uAccB * z.z;
  // Wipe coordinate: 0 at the nose, 1 at the tail, with a slanted leading edge.
  float c = (3.0 - p.x) / 6.0 + (p.y - 0.4) * 0.12;
  float w = smoothstep(c - 0.05, c + 0.05, uWipe);
  edge = exp(-pow((c - uWipe) / 0.035, 2.0));
  metal = mix(uMetalA, uMetalB, w) * (1.0 - z.y * 0.6);
  rough = mix(uRoughA, uRoughB, w) + z.y * 0.12;
  return mix(colA, colB, w);
}
`;

/** Patches a MeshPhysicalMaterial so its colour comes from the livery system. */
export function applyLivery(material: THREE.MeshPhysicalMaterial, zone: -1 | 0 | 1 | 2 = -1) {
  const uZone = { value: zone };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, liveryUniforms, { uZone });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIVERY_VERTEX_PARS}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\n${LIVERY_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LIVERY_FRAGMENT_PARS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lvMetal, lvRough, lvEdge;
        vec3 lvCol = liveryColor(vCarPos, lvMetal, lvRough, lvEdge);
        diffuseColor.rgb *= lvCol;`
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = lvRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n metalnessFactor = lvMetal;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += mix(uAccA, uAccB, 0.5) * lvEdge * 2.5;`
      );
  };
  // Distinct cache key per zone so three compiles separate programs.
  material.customProgramCacheKey = () => `livery-${zone}`;
  return material;
}
