import * as THREE from 'three';
import { LIVERIES, liverySequence, sceneState } from './state';
import { SHEET } from './sheetFrames';

// Livery system: one set of uniforms shared by every painted material.
//
// Base layer: a procedural two-tone zoning (primary / carbon-black lower / accent
// stripe) resolved per pixel from the car-space position. Decal layer: generated
// livery sheets (side + top views) projected onto the bodywork by surface direction.
// Palettes A → B blend along a wipe that sweeps nose → tail with a glowing edge;
// metalness, roughness, clearcoat and metallic flake blend with it.

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
  uCoatA: { value: 1 },
  uCoatB: { value: 1 },
  uCoatRoughA: { value: 0.04 },
  uCoatRoughB: { value: 0.04 },
  uFlakeA: { value: 0 },
  uFlakeB: { value: 0 },
  /** Generated sheets for the leaving (A) and arriving (B) liveries; uSheet* is 0 when none exist. */
  uSideA: { value: null as THREE.Texture | null },
  uTopA: { value: null as THREE.Texture | null },
  uSideB: { value: null as THREE.Texture | null },
  uTopB: { value: null as THREE.Texture | null },
  uSheetA: { value: 0 },
  uSheetB: { value: 0 },
  uFrameSide: { value: new THREE.Vector4(SHEET.side.x0, SHEET.side.y0, SHEET.side.x1, SHEET.side.y1) },
  uFrameTop: { value: new THREE.Vector4(SHEET.top.x0, SHEET.top.zBottom, SHEET.top.x1, SHEET.top.zTop) },
  /** -0.2 … 1.2 so the edge fully clears both ends of the car. */
  uWipe: { value: 1.2 },
  uTime: { value: 0 },
};

/** Current blended palette for lights and overlays, plus the sequence indices in play. */
export const liveryNow = { accent: new THREE.Color(), rim: new THREE.Color(), key: new THREE.Color(), primary: new THREE.Color(), lo: 0, hi: 0, wipe: 0 };

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
  u.uCoatA.value = a.coat;
  u.uCoatB.value = b.coat;
  u.uCoatRoughA.value = a.coatRough;
  u.uCoatRoughB.value = b.coatRough;
  u.uFlakeA.value = a.flake;
  u.uFlakeB.value = b.flake;
  u.uWipe.value = -0.2 + 1.4 * wipe;
  u.uTime.value = t;
  const w = THREE.MathUtils.smoothstep(wipe, 0.15, 0.85);
  liveryNow.accent.copy(tmpA.set(a.accent)).lerp(tmpB.set(b.accent), w);
  liveryNow.rim.copy(tmpA.set(a.rim)).lerp(tmpB.set(b.rim), w);
  liveryNow.key.copy(tmpA.set(a.key)).lerp(tmpB.set(b.key), w);
  liveryNow.primary.copy(tmpA.set(a.primary)).lerp(tmpB.set(b.primary), w);
  liveryNow.lo = lo;
  liveryNow.hi = hi;
  liveryNow.wipe = wipe;
}

export const LIVERY_VERTEX_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarN;
`;
// Object space is car space for every painted part (all lofted in metres), so decals
// stay put while exploded groups move; mirrored groups flip z via the model matrix sign.
export const LIVERY_VERTEX = /* glsl */ `
{
  float lvMirror = modelMatrix[2][2] < 0.0 ? -1.0 : 1.0;
  vCarPos = vec3(position.x, position.y, position.z * lvMirror);
  vCarN = normalize(vec3(normal.x, normal.y, normal.z * lvMirror));
}
`;

export const LIVERY_FRAGMENT_PARS = /* glsl */ `
varying vec3 vCarPos;
varying vec3 vCarN;
uniform vec3 uPrimA, uSecA, uAccA, uPrimB, uSecB, uAccB;
uniform float uMetalA, uMetalB, uRoughA, uRoughB, uWipe, uTime;
uniform float uCoatA, uCoatB, uCoatRoughA, uCoatRoughB, uFlakeA, uFlakeB;
uniform sampler2D uSideA, uTopA, uSideB, uTopB;
uniform float uSheetA, uSheetB;
uniform vec4 uFrameSide, uFrameTop;
uniform float uZone; // -1 auto, 0 primary, 1 secondary, 2 accent
float lvW = 0.0;

// Returns (primary, secondary, accent) weights for a point on the car.
vec3 liveryZone(vec3 p) {
  if (uZone >= 0.0) return vec3(uZone == 0.0 ? 1.0 : 0.0, uZone == 1.0 ? 1.0 : 0.0, uZone == 2.0 ? 1.0 : 0.0);
  float aa = max(fwidth(p.y), 0.002) * 1.5;
  float cut = 0.215 + 0.03 * smoothstep(-2.2, 1.0, p.x);
  float low = 1.0 - smoothstep(cut - aa, cut + aa, p.y);
  float nose = smoothstep(2.42, 2.46, p.x);
  float band = p.y - (0.33 + 0.085 * p.x);
  float stripe = (1.0 - smoothstep(0.016, 0.016 + aa, abs(band))) * smoothstep(-2.3, -2.1, p.x) * (1.0 - smoothstep(1.25, 1.4, p.x));
  stripe *= step(0.2, abs(p.z));
  float spine = (1.0 - smoothstep(0.012, 0.012 + aa, abs(p.z))) * step(0.5, p.y) * (1.0 - smoothstep(-0.9, -0.8, p.x));
  float acc = clamp(stripe + spine, 0.0, 1.0);
  float sec = clamp(max(low, nose) * (1.0 - acc), 0.0, 1.0);
  return vec3(1.0 - sec - acc, sec, acc);
}

// Projects the side and top sheets onto the surface, weighted by its direction.
// Returns the decal colour; cover is how much of the base it replaces, dark how black it is.
vec3 liverySheet(sampler2D side, sampler2D top, vec3 base, vec3 p, vec3 n, float amount, out float cover, out float dark) {
  cover = 0.0;
  dark = 0.0;
  if (amount <= 0.0) return base;
  vec2 uvS = vec2((p.x - uFrameSide.x) / (uFrameSide.z - uFrameSide.x), (p.y - uFrameSide.y) / (uFrameSide.w - uFrameSide.y));
  vec2 uvT = vec2((p.x - uFrameTop.x) / (uFrameTop.z - uFrameTop.x), (p.z - uFrameTop.y) / (uFrameTop.w - uFrameTop.y));
  // One sheet per surface with a narrow seam at the shoulder (like a real wrap), so
  // lettering present on both sheets never double-prints across the blend band.
  float facing = abs(n.z) + max(n.y, 0.0);
  float sideness = smoothstep(-0.12, 0.12, abs(n.z) - max(n.y, 0.0));
  vec4 dS = texture2D(side, clamp(uvS, 0.0, 1.0));
  vec4 dT = texture2D(top, clamp(uvT, 0.0, 1.0));
  float aS = dS.a * sideness;
  float aT = dT.a * (1.0 - sideness);
  float aSum = aS + aT;
  vec3 dec = aSum > 1e-4 ? (dS.rgb * aS + dT.rgb * aT) / aSum : base;
  cover = clamp(aSum, 0.0, 1.0) * smoothstep(0.08, 0.35, facing) * amount;
  dark = 1.0 - smoothstep(0.015, 0.1, dot(dec, vec3(0.3, 0.59, 0.11)));
  return mix(base, dec, cover);
}

vec3 liveryColor(vec3 p, vec3 n, out float metal, out float rough, out float edge) {
  vec3 z = liveryZone(p);
  vec3 baseA = uPrimA * z.x + uSecA * z.y + uAccA * z.z;
  vec3 baseB = uPrimB * z.x + uSecB * z.y + uAccB * z.z;
  float covA, darkA, covB, darkB;
  vec3 colA = liverySheet(uSideA, uTopA, baseA, p, n, uSheetA, covA, darkA);
  vec3 colB = liverySheet(uSideB, uTopB, baseB, p, n, uSheetB, covB, darkB);
  // Wipe coordinate: 0 at the nose, 1 at the tail, with a slanted leading edge.
  float c = (3.0 - p.x) / 6.0 + (p.y - 0.4) * 0.12;
  float w = smoothstep(c - 0.05, c + 0.05, uWipe);
  lvW = w;
  edge = exp(-pow((c - uWipe) / 0.035, 2.0));
  // Zone-driven metal/rough modulation only where no sheet paints the surface.
  float metalA = uMetalA * (1.0 - z.y * 0.6 * (1.0 - covA));
  float metalB = uMetalB * (1.0 - z.y * 0.6 * (1.0 - covB));
  float roughA = uRoughA + z.y * 0.12 * (1.0 - covA) + 0.16 * darkA * covA;
  float roughB = uRoughB + z.y * 0.12 * (1.0 - covB) + 0.16 * darkB * covB;
  metal = mix(metalA, metalB, w);
  rough = mix(roughA, roughB, w);
  return mix(colA, colB, w);
}

// Metallic flake: tiny per-position normal jitter, faded out once flakes drop below a pixel.
vec3 liveryFlake(vec3 nrm, vec3 p, float amount) {
  if (amount <= 0.0) return nrm;
  vec3 q = p * 900.0;
  vec3 h = fract(sin(vec3(dot(q, vec3(127.1, 311.7, 74.7)), dot(q, vec3(269.5, 183.3, 246.1)), dot(q, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  float px = fwidth(p.x) + fwidth(p.y) + fwidth(p.z);
  float fade = 1.0 - smoothstep(0.0015, 0.006, px);
  return normalize(nrm + (h - 0.5) * 0.55 * amount * fade);
}
`;

/** Patches a MeshPhysicalMaterial so its colour and finish come from the livery system. */
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
        vec3 lvCol = liveryColor(vCarPos, normalize(vCarN), lvMetal, lvRough, lvEdge);
        diffuseColor.rgb *= lvCol;`
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n roughnessFactor = lvRough;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n metalnessFactor = lvMetal;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n normal = liveryFlake(normal, vCarPos, mix(uFlakeA, uFlakeB, lvW));`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += mix(uAccA, uAccB, 0.5) * lvEdge * 2.5;`
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
        material.clearcoat = mix(uCoatA, uCoatB, lvW);
        material.clearcoatRoughness = mix(uCoatRoughA, uCoatRoughB, lvW);
        #endif`
      );
  };
  // Distinct cache key per zone so three compiles separate programs.
  material.customProgramCacheKey = () => `livery-${zone}`;
  return material;
}
