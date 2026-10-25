import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { CarMaterials } from '../materials';
import { sceneState } from '../state';

/**
 * Node-name → exploded group mapping for an authored/generated GLB.
 * Name nodes in the DCC tool (or rename after a Higgsfield `generate_3d` run)
 * with these prefixes and the scroll choreography drives them unchanged.
 */
export const GLB_PART_MAP: Record<string, { k: 'explodeFront' | 'explodeMid' | 'explodeRear' | 'explodeTop'; offset: [number, number, number] }> = {
  fw_main: { k: 'explodeFront', offset: [0.28, -0.07, 0] },
  fw_flap: { k: 'explodeFront', offset: [0.0, 0.14, 0] },
  fw_endplate: { k: 'explodeFront', offset: [0.06, 0.02, 0.2] },
  sidepod: { k: 'explodeMid', offset: [0, 0.16, 0.3] },
  mirror: { k: 'explodeMid', offset: [0, 0.08, 0.12] },
  engine_cover: { k: 'explodeTop', offset: [-0.12, 0.26, 0] },
  halo: { k: 'explodeTop', offset: [0, 0.3, 0] },
  rw_main: { k: 'explodeRear', offset: [-0.14, 0.22, 0] },
  rw_flap: { k: 'explodeRear', offset: [-0.26, 0.42, 0] },
  rw_endplate: { k: 'explodeRear', offset: [-0.06, 0.1, 0.16] },
  diffuser: { k: 'explodeRear', offset: [-0.3, -0.04, 0] },
};

const MATERIAL_SLOTS: Record<string, keyof CarMaterials> = { paint: 'paint', accent: 'accent', carbon: 'carbon', rubber: 'rubber', matte: 'matte', cover: 'cover' };

export default function GlbCar({ m, url }: { m: CarMaterials; url: string }) {
  const { scene } = useGLTF(url);
  const parts = useRef<{ obj: THREE.Object3D; k: keyof typeof sceneState; offset: [number, number, number] }[]>([]);
  const root = useMemo(() => scene.clone(true), [scene]);

  useEffect(() => {
    parts.current = [];
    root.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = mesh.receiveShadow = true;
        const name = (mesh.material as THREE.Material)?.name?.toLowerCase() ?? '';
        const slot = Object.keys(MATERIAL_SLOTS).find(s => name.includes(s));
        if (slot) mesh.material = m[MATERIAL_SLOTS[slot]] as THREE.Material;
      }
      const key = Object.keys(GLB_PART_MAP).find(p => obj.name.toLowerCase().startsWith(p));
      if (key) {
        const { k, offset } = GLB_PART_MAP[key];
        const side = obj.name.toLowerCase().endsWith('_l') ? -1 : 1;
        parts.current.push({ obj, k, offset: [offset[0], offset[1], offset[2] * side] });
        obj.userData.basePosition = obj.position.clone();
      }
    });
  }, [root, m]);

  useFrame(() => {
    for (const p of parts.current) {
      const a = sceneState[p.k] as number;
      const base = p.obj.userData.basePosition as THREE.Vector3;
      p.obj.position.set(base.x + p.offset[0] * a, base.y + p.offset[1] * a, base.z + p.offset[2] * a);
    }
  });

  return <primitive object={root} />;
}
