import { Suspense, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, useGLTF } from '@react-three/drei';
import * as THREE from 'three';

const FIXED = new URLSearchParams(window.location.search).get('rot');

function Part({ url, material }: { url: string; material: THREE.Material }) {
  const { scene } = useGLTF(url);
  const object = useMemo(() => {
    const root = scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    root.position.sub(centre);
    root.scale.setScalar(1.6 / Math.max(size.x, size.y, size.z));
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = material;
    });
    return root;
  }, [scene, material]);
  useFrame(s => {
    object.rotation.y = FIXED !== null ? Number(FIXED) : s.clock.elapsedTime * 0.4;
  });
  return <primitive object={object} />;
}

/** Dev-only `?part=/models/x.glb`: a generated part on a turntable with the car's titanium. */
export default function PartViewer({ url }: { url: string }) {
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color: '#8a8f96', metalness: 1, roughness: 0.4 }), []);
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#101216' }}>
      <Canvas camera={{ fov: 30, position: [2.4, 1.2, 2.6] }} onCreated={({ camera }) => camera.lookAt(0, 0, 0)}>
        <Environment files="/hdr/garage.jpg" />
        <directionalLight position={[3, 5, 4]} intensity={2} />
        <Suspense fallback={null}>
          <Part url={url} material={material} />
        </Suspense>
      </Canvas>
    </div>
  );
}
