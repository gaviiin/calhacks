import { Suspense, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { CAR_ASSETS } from '../assets';
import { fitGeometryToBody } from './fitToBody';
import type { CarMaterials } from '../materials';

/** Procedural V6 turbo-hybrid unit + gearbox: what the engine cover lifts off to reveal. */
function ProceduralPowerUnit({ m }: { m: CarMaterials }) {
  const manifolds = useMemo(() => {
    const tube = (s: number) =>
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([new THREE.Vector3(-0.85, 0.52, s * 0.19), new THREE.Vector3(-1.05, 0.5, s * 0.25), new THREE.Vector3(-1.3, 0.47, s * 0.2), new THREE.Vector3(-1.46, 0.5, s * 0.08)]),
        24,
        0.028,
        10
      );
    const runner = (s: number, x: number) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.56, s * 0.17), new THREE.Vector3(x - 0.03, 0.5, s * 0.25)]), 6, 0.02, 8);
    return { r: tube(1), l: tube(-1), runners: [1, -1].flatMap(s => [-0.85, -1.0, -1.15].map(x => runner(s, x))) };
  }, []);
  return (
    <group>
      {/* block, heads, plenum */}
      <mesh position={[-1.05, 0.38, 0]} material={m.titanium} castShadow>
        <boxGeometry args={[0.56, 0.3, 0.3]} />
      </mesh>
      {[1, -1].map(s => (
        <mesh key={s} position={[-1.05, 0.53, s * 0.17]} rotation-x={s * 0.5} material={m.aluminium} castShadow>
          <boxGeometry args={[0.5, 0.14, 0.16]} />
        </mesh>
      ))}
      <mesh position={[-1.0, 0.64, 0]} material={m.carbon} castShadow>
        <capsuleGeometry args={[0.1, 0.42, 6, 14]} />
      </mesh>
      <mesh position={[-1.0, 0.64, 0]} rotation-z={Math.PI / 2} material={m.carbon}>
        <cylinderGeometry args={[0.11, 0.11, 0.48, 18]} />
      </mesh>
      {/* turbo + MGU-H at the rear, exhaust runners into the manifolds */}
      <mesh position={[-1.48, 0.5, 0]} material={m.exhaust} castShadow>
        <sphereGeometry args={[0.11, 20, 14]} />
      </mesh>
      <mesh position={[-1.6, 0.5, 0]} rotation-z={Math.PI / 2} material={m.titanium}>
        <cylinderGeometry args={[0.06, 0.06, 0.16, 16]} />
      </mesh>
      <mesh geometry={manifolds.r} material={m.exhaust} />
      <mesh geometry={manifolds.l} material={m.exhaust} />
      {manifolds.runners.map((geo, i) => (
        <mesh key={i} geometry={geo} material={m.exhaust} />
      ))}
      <mesh position={[-2.2, 0.42, 0]} rotation-z={Math.PI / 2} material={m.exhaust}>
        <cylinderGeometry args={[0.035, 0.035, 0.9, 14]} />
      </mesh>
      {/* gearbox + rear crash structure core */}
      <mesh position={[-1.95, 0.36, 0]} material={m.carbon} castShadow>
        <boxGeometry args={[0.6, 0.26, 0.22]} />
      </mesh>
      <mesh position={[-2.35, 0.36, 0]} material={m.carbon}>
        <boxGeometry args={[0.3, 0.18, 0.14]} />
      </mesh>
    </group>
  );
}

function GlbPowerUnit({ url, m }: { url: string; m: CarMaterials }) {
  const { scene } = useGLTF(url);
  const object = useMemo(() => {
    const t = CAR_ASSETS.powerUnitTransform;
    const root = scene.clone(true);
    // Turn the mesh down the car's x axis, then bake every mesh into car space.
    const holder = new THREE.Group();
    holder.add(root);
    holder.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
    holder.updateMatrixWorld(true);
    const meshes: THREE.Mesh[] = [];
    root.traverse(o => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    const bounds = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const mesh of meshes) {
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) bounds.expandByPoint(v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(mesh.matrixWorld));
    }
    const group = new THREE.Group();
    const size = bounds.getSize(new THREE.Vector3());
    for (const mesh of meshes) {
      let geometry: THREE.BufferGeometry;
      if (t.fitToBody) {
        geometry = fitGeometryToBody(mesh.geometry, mesh.matrixWorld, bounds, t.xFront, t.xRear);
      } else {
        geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
        const scale = (t.xFront - t.xRear) / size.x;
        geometry.translate(-bounds.min.x, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2).scale(scale, scale, scale).translate(t.xRear, 0.14, 0);
      }
      const out = new THREE.Mesh(geometry, m.alloy);
      out.castShadow = true;
      group.add(out);
    }
    return group;
  }, [scene, m]);
  return <primitive object={object} />;
}

/** The power unit: a generated GLB when `CAR_ASSETS.powerUnit` is set, the procedural unit otherwise. */
export default function PowerUnit({ m }: { m: CarMaterials }) {
  if (!CAR_ASSETS.powerUnit) return <ProceduralPowerUnit m={m} />;
  return (
    <Suspense fallback={<ProceduralPowerUnit m={m} />}>
      <GlbPowerUnit url={CAR_ASSETS.powerUnit} m={m} />
    </Suspense>
  );
}
