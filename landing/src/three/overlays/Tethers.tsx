import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { parts } from '../car/explode';
import { liveryNow } from '../livery';

const MAX = 64;

/**
 * Exploded-view tethers: a flowing dashed hairline from each detached part back to its
 * mount, with a dot at either end. Fades in with the part's progress.
 */
export default function Tethers() {
  const lines = useRef<THREE.LineSegments>(null);
  const dots = useRef<THREE.InstancedMesh>(null);
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 2 * 3), 3));
    g.setAttribute('lineDistance', new THREE.BufferAttribute(new Float32Array(MAX * 2), 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(MAX * 2), 1));
    g.setDrawRange(0, 0);
    return g;
  }, []);
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#ffffff') }, uTime: { value: 0 } },
        vertexShader: /* glsl */ `
          attribute float lineDistance; attribute float alpha;
          varying float vD; varying float vA;
          void main() { vD = lineDistance; vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uColor; uniform float uTime;
          varying float vD; varying float vA;
          void main() {
            float d = mod(vD - uTime * 0.35, 0.09);
            float on = smoothstep(0.0, 0.015, d) * (1.0 - smoothstep(0.045, 0.06, d));
            gl_FragColor = vec4(uColor * (0.5 + 0.8 * on), (0.25 + 0.75 * on) * vA);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );
  const dotMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }), []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(state => {
    const l = lines.current;
    const d = dots.current;
    if (!l || !d) return;
    const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
    const dist = geometry.getAttribute('lineDistance') as THREE.BufferAttribute;
    const alpha = geometry.getAttribute('alpha') as THREE.BufferAttribute;
    let i = 0;
    let n = 0;
    for (const p of parts) {
      if (!p.spec.anchor || p.t < 0.02 || i >= MAX) continue;
      const a = p.worldAnchor;
      const b = p.worldPos;
      const len = a.distanceTo(b);
      if (len < 0.01) continue;
      const fade = THREE.MathUtils.clamp(p.t * 1.5, 0, 1);
      pos.setXYZ(i * 2, a.x, a.y, a.z);
      pos.setXYZ(i * 2 + 1, b.x, b.y, b.z);
      dist.setX(i * 2, 0);
      dist.setX(i * 2 + 1, len);
      alpha.setX(i * 2, fade);
      alpha.setX(i * 2 + 1, fade);
      dummy.position.copy(a);
      dummy.scale.setScalar(0.012 * fade);
      dummy.updateMatrix();
      d.setMatrixAt(n++, dummy.matrix);
      dummy.position.copy(b);
      dummy.scale.setScalar(0.009 * fade);
      dummy.updateMatrix();
      d.setMatrixAt(n++, dummy.matrix);
      i++;
    }
    pos.needsUpdate = dist.needsUpdate = alpha.needsUpdate = true;
    geometry.setDrawRange(0, i * 2);
    d.count = n;
    d.instanceMatrix.needsUpdate = true;
    l.visible = d.visible = i > 0;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    material.uniforms.uColor.value.copy(liveryNow.accent);
    dotMat.color.copy(liveryNow.accent);
  });

  return (
    <group>
      <lineSegments ref={lines} geometry={geometry} material={material} frustumCulled={false} />
      <instancedMesh ref={dots} args={[undefined, undefined, MAX * 2]} material={dotMat} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 8]} />
      </instancedMesh>
    </group>
  );
}
