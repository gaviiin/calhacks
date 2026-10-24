import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { createFlowMaterial, lineGeometry } from './flowMaterial';
import { liveryNow } from '../livery';
import { sceneState } from '../state';

/**
 * Rear scene: aero-style streamlines flowing over the rear wing and out of the
 * diffuser (controlled output), plus three approval nodes that light up in
 * sequence along an audit path.
 */
export default function AuditTrail() {
  const flowMat = useMemo(() => createFlowMaterial('#ffffff', 0.22, 0.26, 1.6), []);
  const auditMat = useMemo(() => createFlowMaterial('#ffffff', 0.06, 0.08, 0.5), []);
  const nodeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }), []);
  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }), []);
  const nodes = useRef<THREE.Group>(null);

  const streamlines = useMemo(() => {
    const lines: THREE.BufferGeometry[] = [];
    // over the rear wing
    for (let i = 0; i < 7; i++) {
      const z = -0.42 + (0.84 * i) / 6;
      const y0 = 0.98 + 0.06 * Math.abs(z);
      lines.push(lineGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-1.3, y0 - 0.2, z), new THREE.Vector3(-2.0, y0 - 0.08, z), new THREE.Vector3(-2.6, y0 + 0.02, z), new THREE.Vector3(-3.4, y0 - 0.25, z * 1.3), new THREE.Vector3(-4.6, y0 - 0.55, z * 1.8)]).getPoints(40)));
    }
    // out of the diffuser
    for (let i = 0; i < 6; i++) {
      const z = -0.45 + (0.9 * i) / 5;
      lines.push(lineGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(-1.6, 0.14, z), new THREE.Vector3(-2.4, 0.3, z * 1.1), new THREE.Vector3(-3.2, 0.5, z * 1.5), new THREE.Vector3(-4.4, 0.62, z * 2.1)]).getPoints(36)));
    }
    return lines;
  }, []);

  const NODES: [number, number, number][] = [
    [-2.05, 1.28, 0.9],
    [-3.1, 1.0, 0.95],
    [-3.4, 0.6, 0.75],
  ];
  const audit = useMemo(
    () =>
      lineGeometry(
        new THREE.CatmullRomCurve3([new THREE.Vector3(-2.5, 0.9, 0.5), new THREE.Vector3(...NODES[0]), new THREE.Vector3(...NODES[1]), new THREE.Vector3(...NODES[2]), new THREE.Vector3(-2.7, 0.2, 0.55)]).getPoints(80)
      ),
    []
  );

  useFrame(state => {
    const a = sceneState.audit;
    const t = state.clock.elapsedTime;
    flowMat.uniforms.uAmount.value = a * 0.9;
    flowMat.uniforms.uTime.value = t;
    flowMat.uniforms.uColor.value.copy(liveryNow.accent).lerp(new THREE.Color('#ffffff'), 0.5);
    auditMat.uniforms.uAmount.value = a;
    auditMat.uniforms.uTime.value = t;
    auditMat.uniforms.uColor.value.copy(liveryNow.accent);
    nodeMat.color.copy(liveryNow.accent);
    ringMat.color.copy(liveryNow.accent);
    nodeMat.opacity = a;
    ringMat.opacity = a * 0.8;
    if (nodes.current) {
      nodes.current.visible = a > 0.01;
      nodes.current.children.forEach((n, i) => {
        const phase = (t * 0.6 - i * 0.33) % 1;
        const on = phase < 0.5 ? 1 : 0.55;
        n.scale.setScalar(a * (0.9 + 0.3 * on));
        n.rotation.y = t * 0.8;
      });
    }
  });

  return (
    <group>
      {streamlines.map((g, i) => (
        <primitive key={i} object={new THREE.Line(g, flowMat)} frustumCulled={false} />
      ))}
      <primitive object={new THREE.Line(audit, auditMat)} frustumCulled={false} />
      <group ref={nodes}>
        {NODES.map((p, i) => (
          <group key={i} position={p}>
            <mesh material={nodeMat}>
              <sphereGeometry args={[0.022, 16, 12]} />
            </mesh>
            <mesh material={ringMat} rotation-x={Math.PI / 2}>
              <ringGeometry args={[0.05, 0.056, 40]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}
