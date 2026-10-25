import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createFlowMaterial, segmentsGeometry } from './flowMaterial';
import { liveryNow } from '../livery';
import { sceneState } from '../state';

/**
 * Reasoning nodes and logic pathways around the cockpit: a small graph that
 * pulses while the car is in diagnostic mode. Three larger nodes mark the
 * interpret / calculate / checkpoint stages.
 */
export default function ReasoningGraph() {
  const nodes = useRef<THREE.InstancedMesh>(null);
  const linesMat = useMemo(() => createFlowMaterial('#ffffff', 0.08, 0.14, 0.7), []);
  const nodeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const { points, geometry, scales } = useMemo(() => {
    const rng = (seed: number) => {
      let s = seed;
      return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    };
    const r = rng(42);
    const centre = new THREE.Vector3(0.1, 0.82, 0);
    const pts: THREE.Vector3[] = [];
    const sc: number[] = [];
    // three stage nodes, then a cloud
    pts.push(new THREE.Vector3(0.75, 1.05, 0.45), new THREE.Vector3(-0.35, 1.25, 0.3), new THREE.Vector3(0.2, 0.95, -0.7));
    sc.push(2.6, 2.6, 2.6);
    for (let i = 0; i < 30; i++) {
      const th = r() * Math.PI * 2;
      const ph = Math.acos(2 * r() - 1);
      const rad = 0.45 + r() * 0.5;
      pts.push(new THREE.Vector3(centre.x + rad * 1.2 * Math.sin(ph) * Math.cos(th), centre.y + rad * 0.7 * Math.cos(ph) + 0.12, centre.z + rad * Math.sin(ph) * Math.sin(th)));
      sc.push(0.8 + r() * 0.8);
    }
    const pairs: [THREE.Vector3, THREE.Vector3][] = [];
    pts.forEach((p, i) => {
      const near = pts.map((q, j) => ({ j, d: p.distanceTo(q) })).filter(o => o.j !== i).sort((a, b) => a.d - b.d).slice(0, i < 3 ? 4 : 2);
      near.forEach(o => {
        if (o.j > i || i < 3) pairs.push([p, pts[o.j]]);
      });
    });
    return { points: pts, geometry: segmentsGeometry(pairs), scales: sc };
  }, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(state => {
    const a = sceneState.graph;
    const mesh = nodes.current;
    if (!mesh) return;
    mesh.visible = a > 0.01;
    linesMat.uniforms.uAmount.value = a;
    linesMat.uniforms.uTime.value = state.clock.elapsedTime;
    linesMat.uniforms.uColor.value.copy(liveryNow.accent);
    nodeMat.color.copy(liveryNow.accent);
    nodeMat.opacity = a;
    if (!mesh.visible) return;
    const t = state.clock.elapsedTime;
    points.forEach((p, i) => {
      const pulse = 1 + 0.25 * Math.sin(t * 2.2 + i * 1.7);
      dummy.position.copy(p);
      dummy.scale.setScalar(0.014 * scales[i] * pulse * (0.2 + 0.8 * a));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      <lineSegments geometry={geometry} material={linesMat} frustumCulled={false} />
      <instancedMesh ref={nodes} args={[undefined, undefined, points.length]} material={nodeMat} frustumCulled={false}>
        <sphereGeometry args={[1, 12, 10]} />
      </instancedMesh>
    </group>
  );
}
