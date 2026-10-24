import * as THREE from 'three';

/** Dashes that flow along a line; `lineDistance` comes from geometry.computeLineDistances(). */
export function createFlowMaterial(color: THREE.ColorRepresentation, dash = 0.12, gap = 0.18, speed = 0.9) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uDash: { value: dash },
      uGap: { value: gap },
      uSpeed: { value: speed },
    },
    vertexShader: /* glsl */ `
      attribute float lineDistance;
      varying float vD;
      void main() { vD = lineDistance; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime, uAmount, uDash, uGap, uSpeed;
      varying float vD;
      void main() {
        float period = uDash + uGap;
        float d = mod(vD - uTime * uSpeed, period);
        float on = smoothstep(0.0, 0.03, d) * (1.0 - smoothstep(uDash - 0.03, uDash, d));
        float a = (0.18 + 0.82 * on) * uAmount;
        gl_FragColor = vec4(uColor * (0.6 + 1.2 * on), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

export function lineGeometry(points: THREE.Vector3[]) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(g);
  line.computeLineDistances();
  return g;
}

export function segmentsGeometry(pairs: [THREE.Vector3, THREE.Vector3][]) {
  const g = new THREE.BufferGeometry().setFromPoints(pairs.flat());
  const line = new THREE.LineSegments(g);
  line.computeLineDistances();
  return g;
}
