import { MAX_PARTS } from '../catalog';

// GLSL for the blueprint. Lines are instanced screen-space quads (one instance per segment) so every
// stroke has an exact pixel width, analytic anti-aliasing and an optional glow; each instance carries
// its part index, which looks up the part's live offset (exploded or pulled out) and colour from small
// uniform tables the engine rewrites every frame. All colours are display (sRGB) values, blended
// additively over an opaque background.

const P = `#define MAXP ${MAX_PARTS}\n`;

export const LINE_VERT = /* glsl */ `${P}
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uViewport;
uniform vec4 uOffset[MAXP];   // xyz offset, w highlight
uniform vec4 uColor[MAXP];    // rgb, intensity
uniform vec4 uWidth;          // core width per kind, device px
uniform vec4 uKindAlpha;      // alpha per kind
uniform float uGlow;          // glow reach, device px
uniform float uUseOffset;
uniform vec2 uFade;           // view-space depth where lines start and finish fading
uniform float uFadeTo;
uniform float uHiBoost;       // alpha multiplier for a lit part (hidden lines of the hovered part show through)
in vec3 position;
in vec3 aA;
in vec3 aB;
in float aPart;
in float aKind;
out vec3 vColor;
out float vAlpha;
out float vD;
out float vHalf;
out vec2 vDir;
out float vHi;
void main() {
  int pi = int(aPart + 0.5);
  int ki = int(aKind + 0.5);
  vec4 o = uOffset[pi];
  vec3 off = o.xyz * uUseOffset;
  vec4 a = modelViewMatrix * vec4(aA + off, 1.0);
  vec4 b = modelViewMatrix * vec4(aB + off, 1.0);
  vec4 ca = projectionMatrix * a;
  vec4 cb = projectionMatrix * b;
  vec2 sa = ca.xy / ca.w * 0.5 * uViewport;
  vec2 sb = cb.xy / cb.w * 0.5 * uViewport;
  vec2 d = sb - sa;
  float L = length(d);
  vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float w = uWidth[ki] * (1.0 + 0.55 * o.w);
  float halfw = max(w, 1.0) * 0.5;
  float hw = halfw + 1.0 + uGlow;
  vec4 c = position.x < 0.5 ? ca : cb;
  c.xy += n * position.y * hw / (0.5 * uViewport) * c.w;
  gl_Position = c;
  vD = position.y * hw;
  vHalf = halfw;
  vDir = dir;
  vHi = o.w;
  vec4 col = uColor[pi];
  vColor = col.rgb;
  float depth = -(position.x < 0.5 ? a.z : b.z);
  float fade = mix(1.0, uFadeTo, smoothstep(uFade.x, uFade.y, depth));
  vAlpha = col.a * uKindAlpha[ki] * min(w, 1.0) * fade * mix(1.0, uHiBoost, o.w);
}
`;

export const LINE_FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;
uniform float uGlowAmt;
uniform float uDash;
in vec3 vColor;
in float vAlpha;
in float vD;
in float vHalf;
in vec2 vDir;
in float vHi;
out vec4 fragColor;
void main() {
  float d = abs(vD);
  float core = clamp(vHalf + 0.5 - d, 0.0, 1.0);
  float glow = 0.0;
  if (uGlow > 0.0) {
    float g = max(d - vHalf, 0.0) / (uGlow * 0.55);
    glow = exp(-g * g) * uGlowAmt * (1.0 + 1.6 * vHi);
  }
  float a = max(core, glow) * vAlpha;
  if (uDash > 0.0) {
    float t = dot(gl_FragCoord.xy, vDir);
    if (mod(t, uDash) > uDash * 0.58) discard;
  }
  if (a < 0.003) discard;
  fragColor = vec4(vColor * a, a);
}
`;

export const SURF_VERT = /* glsl */ `${P}
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
uniform vec4 uOffset[MAXP];
uniform vec4 uColor[MAXP];
uniform float uUseOffset;
in vec3 position;
in vec3 normal;
in float aPart;
out vec3 vN;
out vec3 vV;
out vec4 vCol;
out float vHi;
void main() {
  int pi = int(aPart + 0.5);
  vec4 o = uOffset[pi];
  vec4 mv = modelViewMatrix * vec4(position + o.xyz * uUseOffset, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vCol = uColor[pi];
  vHi = o.w;
  gl_Position = projectionMatrix * mv;
}
`;

/** Glass: a faint fresnel sheen that brightens where the surface turns away, i.e. along its silhouette. */
export const SURF_FRAG = /* glsl */ `
precision highp float;
uniform float uOrtho;
uniform float uSurf;
uniform float uMode;     // 0 glass (additive), 1 solid fill
uniform vec3 uFill;
uniform vec3 uHiFill;
in vec3 vN;
in vec3 vV;
in vec4 vCol;
in float vHi;
out vec4 fragColor;
void main() {
  if (uMode > 0.5) {
    fragColor = vec4(mix(uFill, uHiFill, 0.16 * vHi), 1.0);
    return;
  }
  vec3 n = normalize(vN);
  vec3 v = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(vV);
  float f = 1.0 - abs(dot(n, v));
  float fr = f * f * (0.4 + 0.6 * f);
  float a = (0.018 + 0.5 * fr) * vCol.a * uSurf * (1.0 + 0.8 * vHi);
  fragColor = vec4(vCol.rgb * a, a);
}
`;

export const QUAD_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`;

/** The sheet behind every view: a lifted centre, a vignette and a grid locked to car metres (or pixels). */
export const BG_FRAG = /* glsl */ `
precision highp float;
uniform vec2 uViewport;     // device px
uniform vec3 uBg0;          // centre
uniform vec3 uBg1;          // edge
uniform vec3 uGrid;         // grid colour
uniform vec4 uWorld;        // x0, y0 (car metres at the viewport's bottom-left), metres per device px, 1 = world grid
uniform vec4 uGridSpec;     // minor spacing, major spacing, minor alpha, major alpha
uniform vec2 uOrigin;       // viewport origin, device px
in vec2 vUv;
out vec4 fragColor;
float gridLine(float coord, float spacing, float pxPerUnit) {
  float g = abs(fract(coord / spacing - 0.5) - 0.5) * spacing * pxPerUnit;
  return clamp(1.0 - g, 0.0, 1.0);
}
void main() {
  vec2 p = vUv - 0.5;
  p.x *= uViewport.x / uViewport.y;
  float r = length(p * vec2(0.85, 1.15));
  vec3 col = mix(uBg0, uBg1, smoothstep(0.05, 0.95, r));
  vec2 px = gl_FragCoord.xy - uOrigin;
  float minor;
  float major;
  if (uWorld.w > 0.5) {
    vec2 w = uWorld.xy + px * uWorld.z;
    float ppu = 1.0 / uWorld.z;
    minor = max(gridLine(w.x, uGridSpec.x, ppu), gridLine(w.y, uGridSpec.x, ppu));
    major = max(gridLine(w.x, uGridSpec.y, ppu), gridLine(w.y, uGridSpec.y, ppu));
  } else {
    minor = max(gridLine(px.x, uGridSpec.x, 1.0), gridLine(px.y, uGridSpec.x, 1.0));
    major = max(gridLine(px.x, uGridSpec.y, 1.0), gridLine(px.y, uGridSpec.y, 1.0));
  }
  col += uGrid * (minor * uGridSpec.z + major * uGridSpec.w);
  fragColor = vec4(col, 1.0);
}
`;

export const GROUND_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
out vec3 vW;
void main() {
  vW = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/** A drafting-table grid on the ground plane, fading out a few metres from the car. */
export const GROUND_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uGrid;
uniform float uAlpha;
uniform vec2 uCentre;
uniform float uRadius;
in vec3 vW;
out vec4 fragColor;
float line(float c, float s) {
  float w = fwidth(c / s);
  float g = abs(fract(c / s - 0.5) - 0.5) / max(w, 1e-5);
  return 1.0 - clamp(g, 0.0, 1.0);
}
void main() {
  float minor = max(line(vW.x, 0.1), line(vW.z, 0.1));
  float major = max(line(vW.x, 0.5), line(vW.z, 0.5));
  float d = length(vW.xz - uCentre) / uRadius;
  float fade = 1.0 - smoothstep(0.35, 1.0, d);
  float a = (minor * 0.32 + major * 0.75) * uAlpha * fade;
  if (a < 0.002) discard;
  fragColor = vec4(uGrid * a, a);
}
`;
