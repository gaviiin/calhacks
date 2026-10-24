import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { CarMaterials } from '../materials';
import { liveryNow } from '../livery';
import { sceneState } from '../state';

/** Evidence streaming into the sidepod inlet and the airbox during the ingestion scene. */
export default function Streams({ m, reduceMotion }: { m: CarMaterials; reduceMotion: boolean }) {
  const COUNT = 260;
  const ref = useRef<THREE.InstancedMesh>(null);
  const curves = useMemo(
    () => [
      new THREE.CatmullRomCurve3([new THREE.Vector3(4.6, 2.6, 2.6), new THREE.Vector3(2.6, 1.5, 1.6), new THREE.Vector3(1.4, 0.7, 0.75), new THREE.Vector3(0.98, 0.44, 0.5)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(3.4, 3.4, -0.4), new THREE.Vector3(2.2, 1.9, 0.6), new THREE.Vector3(1.4, 0.9, 0.6), new THREE.Vector3(0.98, 0.45, 0.48)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(5.2, 1.4, 0.8), new THREE.Vector3(3.2, 1.0, 1.2), new THREE.Vector3(1.6, 0.55, 0.8), new THREE.Vector3(0.98, 0.42, 0.52)]),
      new THREE.CatmullRomCurve3([new THREE.Vector3(2.4, 3.8, 1.8), new THREE.Vector3(1.2, 2.4, 0.8), new THREE.Vector3(0.3, 1.4, 0.2), new THREE.Vector3(-0.02, 0.9, 0)]),
    ],
    []
  );
  const seeds = useMemo(
    () => Array.from({ length: COUNT }, (_, i) => ({ c: i % curves.length, phase: Math.random(), speed: 0.1 + Math.random() * 0.12, len: 0.4 + Math.random() * 1.2, w: 0.6 + Math.random() })),
    [curves.length]
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame(state => {
    const mesh = ref.current;
    if (!mesh) return;
    const a = sceneState.streams;
    mesh.visible = a > 0.01;
    if (!mesh.visible) return;
    m.stream.color.copy(liveryNow.accent);
    const t = reduceMotion ? 0.35 : state.clock.elapsedTime;
    seeds.forEach((seed, i) => {
      const u = (seed.phase + t * seed.speed) % 1;
      const curve = curves[seed.c];
      curve.getPointAt(u, dummy.position);
      dummy.lookAt(curve.getPointAt(Math.min(1, u + 0.01)));
      const fade = Math.min(1, u * 5) * (1 - Math.max(0, (u - 0.85) / 0.15));
      dummy.scale.set(seed.w, seed.w, seed.len).multiplyScalar(a * fade);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, COUNT]} material={m.stream} frustumCulled={false}>
      <boxGeometry args={[0.007, 0.007, 0.09]} />
    </instancedMesh>
  );
}
