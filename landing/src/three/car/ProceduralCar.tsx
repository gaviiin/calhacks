import { useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { buildCar, CAR } from './buildCar';
import { strut, V } from '../geometry';
import type { CarMaterials } from '../materials';
import { sceneState } from '../state';

type ExplodeKey = 'explodeFront' | 'explodeMid' | 'explodeRear' | 'explodeTop';

/** Parts that separate in exploded view: `offset` is the fully exploded displacement. */
function Exploded({ k, offset, rotate, children }: { k: ExplodeKey; offset: [number, number, number]; rotate?: [number, number, number]; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const a = sceneState[k];
    const g = ref.current;
    if (!g) return;
    g.position.set(offset[0] * a, offset[1] * a, offset[2] * a);
    if (rotate) g.rotation.set(rotate[0] * a, rotate[1] * a, rotate[2] * a);
  });
  return <group ref={ref}>{children}</group>;
}

function Strut({ from, to, w = 0.05, h = 0.015, material }: { from: THREE.Vector3; to: THREE.Vector3; w?: number; h?: number; material: THREE.Material }) {
  const t = useMemo(() => strut(from, to), [from, to]);
  return (
    <mesh position={t.position} quaternion={t.quaternion} material={material} castShadow>
      <boxGeometry args={[w, h, t.length]} />
    </mesh>
  );
}

/** Wishbones, push/pull rod, track rod and upright for one corner. `s` is the side. */
function Suspension({ x, s, rear, m }: { x: number; s: number; rear: boolean; m: CarMaterials }) {
  const legs = useMemo(() => {
    const hubZ = rear ? 0.62 : 0.7;
    const inZ = rear ? 0.19 : 0.25;
    const up = V(x + 0.02, rear ? 0.5 : 0.53, s * hubZ);
    const low = V(x + 0.02, rear ? 0.17 : 0.19, s * hubZ);
    const list: [THREE.Vector3, THREE.Vector3, number?][] = [
      [V(x + 0.22, rear ? 0.5 : 0.56, s * inZ), up],
      [V(x - 0.26, rear ? 0.48 : 0.55, s * inZ), up],
      [V(x + 0.28, rear ? 0.17 : 0.22, s * (inZ - 0.02)), low],
      [V(x - 0.26, rear ? 0.16 : 0.21, s * (inZ - 0.02)), low],
      [V(x + (rear ? 0.3 : 0.32), rear ? 0.3 : 0.36, s * inZ), V(x + 0.1, rear ? 0.3 : 0.36, s * (hubZ - 0.02)), 0.03],
    ];
    // Front pushrod, rear pullrod.
    list.push(rear ? [V(x + 0.05, 0.46, s * (hubZ - 0.03)), V(x - 0.1, 0.16, s * (inZ + 0.02)), 0.024] : [V(x + 0.06, 0.2, s * (hubZ - 0.04)), V(x - 0.12, 0.6, s * (inZ + 0.03)), 0.024]);
    return list;
  }, [x, s, rear]);
  const hubZ = rear ? 0.62 : 0.7;
  return (
    <group>
      {legs.map(([a, b, w], i) => (
        <Strut key={i} from={a} to={b} w={w ?? 0.05} h={w ? w * 0.7 : 0.015} material={m.carbon} />
      ))}
      <mesh position={[x, 0.36, s * (hubZ + 0.03)]} material={m.matte} castShadow>
        <boxGeometry args={[0.11, 0.36, 0.05]} />
      </mesh>
      {rear && (
        <mesh position={[x, 0.33, s * (hubZ + 0.19) * 0.5]} rotation-x={Math.PI / 2} material={m.titanium}>
          <cylinderGeometry args={[0.024, 0.024, hubZ - 0.19, 14]} />
        </mesh>
      )}
    </group>
  );
}

function Wheel({ x, z, rear, side, m, g }: { x: number; z: number; rear: boolean; side: 1 | -1; m: CarMaterials; g: ReturnType<typeof buildCar> }) {
  const width = rear ? CAR.rearTyre.width : CAR.frontTyre.width;
  const face = width / 2;
  return (
    <group position={[x, CAR.tyreR, z]} scale={[1, 1, side]}>
      <mesh geometry={rear ? g.tyreR : g.tyreF} material={m.rubber} rotation-x={Math.PI / 2} castShadow receiveShadow />
      <mesh geometry={rear ? g.coverR : g.coverF} material={m.cover} rotation-x={Math.PI / 2} castShadow />
      {/* rim lip, centre-lock nut and its retaining ring */}
      <mesh position-z={face - 0.016} rotation-x={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[CAR.rimR + 0.003, CAR.rimR + 0.003, 0.012, 64, 1, true]} />
      </mesh>
      <mesh position-z={face - 0.022} rotation-x={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[0.052, 0.052, 0.012, 32]} />
      </mesh>
      <mesh position-z={face - 0.008} rotation-x={Math.PI / 2} material={m.accent}>
        <cylinderGeometry args={[0.034, 0.03, 0.022, 6]} />
      </mesh>
      {/* inboard: brake drum, disc hint, duct scoop */}
      <mesh position-z={-(face - 0.05)} rotation-x={Math.PI / 2} material={m.matte}>
        <cylinderGeometry args={[CAR.rimR - 0.004, CAR.rimR - 0.004, 0.09, 48]} />
      </mesh>
      <mesh position-z={-(face + 0.012)} rotation-x={Math.PI / 2} material={m.carbon}>
        <cylinderGeometry args={[0.19, 0.19, 0.05, 48]} />
      </mesh>
      <mesh geometry={g.duct} material={m.carbon} position={[0.0, -CAR.tyreR, -(face + 0.08)]} castShadow />
    </group>
  );
}

/** Power unit, gearbox, fuel cell, ES, radiators, seat. Only visible in x-ray mode. */
function Internals({ m }: { m: CarMaterials }) {
  const parts: { p: [number, number, number]; s: [number, number, number]; r?: [number, number, number] }[] = [
    { p: [-1.05, 0.4, 0], s: [0.55, 0.38, 0.34] }, // block
    { p: [-1.05, 0.56, 0.2], s: [0.5, 0.12, 0.16], r: [0.45, 0, 0] }, // heads
    { p: [-1.05, 0.56, -0.2], s: [0.5, 0.12, 0.16], r: [-0.45, 0, 0] },
    { p: [-1.5, 0.52, 0], s: [0.22, 0.22, 0.22] }, // turbo + MGU-H
    { p: [-1.95, 0.34, 0], s: [0.55, 0.26, 0.26] }, // gearbox
    { p: [-0.45, 0.36, 0], s: [0.5, 0.42, 0.44] }, // fuel cell
    { p: [-0.45, 0.14, 0], s: [0.45, 0.08, 0.4] }, // energy store
    { p: [0.3, 0.33, 0.52], s: [0.5, 0.3, 0.05], r: [0, 0.35, 0] }, // radiators
    { p: [0.3, 0.33, -0.52], s: [0.5, 0.3, 0.05], r: [0, -0.35, 0] },
    { p: [0.9, 0.3, 0], s: [0.8, 0.14, 0.3] }, // pedal box / front bulkhead
  ];
  const edges = useMemo(() => parts.map(p => new THREE.EdgesGeometry(new THREE.BoxGeometry(...p.s))), []);
  return (
    <group>
      {parts.map((p, i) => (
        <group key={i} position={p.p} rotation={p.r ?? [0, 0, 0]}>
          <mesh material={m.internals}>
            <boxGeometry args={p.s} />
          </mesh>
          <lineSegments geometry={edges[i]} material={m.internalsEdge} />
        </group>
      ))}
      {/* seat + driver silhouette */}
      <mesh position={[0.05, 0.42, 0]} rotation-z={-0.55} material={m.internals}>
        <capsuleGeometry args={[0.16, 0.5, 4, 12]} />
      </mesh>
      {/* driveshafts */}
      {[1, -1].map(s => (
        <mesh key={s} position={[-1.8, 0.33, s * 0.3]} rotation-x={Math.PI / 2} material={m.internals}>
          <cylinderGeometry args={[0.02, 0.02, 0.45, 10]} />
        </mesh>
      ))}
    </group>
  );
}

export default function ProceduralCar({ m }: { m: CarMaterials }) {
  const g = useMemo(buildCar, []);
  /** X-ray overlay: fresnel ghost + faint wireframe on the big panels. */
  const ghost = (geometry: THREE.BufferGeometry) => (
    <>
      <mesh geometry={geometry} material={m.ghost} />
      <mesh geometry={geometry} material={m.wire} />
    </>
  );

  const sidepod = (
    <Exploded k="explodeMid" offset={[0, 0.16, 0.3]} rotate={[0.12, 0, 0]}>
      <mesh geometry={g.sidepod} material={m.pod} castShadow receiveShadow />
      <mesh geometry={g.inlet} material={m.matte} />
      {ghost(g.sidepod)}
    </Exploded>
  );

  const mirror = (
    <Exploded k="explodeMid" offset={[0, 0.08, 0.12]}>
      <mesh geometry={g.mirrorHousing} material={m.paint} castShadow />
      <mesh position={[0.695, 0.745, 0.47]} rotation-y={Math.PI / 2} material={m.visor}>
        <planeGeometry args={[0.1, 0.055]} />
      </mesh>
      <Strut from={V(0.78, 0.63, 0.3)} to={V(0.78, 0.72, 0.44)} w={0.03} h={0.012} material={m.carbon} />
    </Exploded>
  );

  const frontFlaps = (
    <>
      <Exploded k="explodeFront" offset={[0.0, 0.1, 0]}>
        <mesh geometry={g.fwFlap3} material={m.paint} castShadow />
      </Exploded>
      <Exploded k="explodeFront" offset={[-0.08, 0.2, 0]}>
        <mesh geometry={g.fwFlap4} material={m.accent} castShadow />
      </Exploded>
      <Exploded k="explodeFront" offset={[0.06, 0.02, 0.2]}>
        <mesh geometry={g.fwEndplate} material={m.paint} castShadow />
        <mesh geometry={g.fwEndplateRoll} material={m.paint} castShadow />
        <mesh position={[2.62, 0.058, 0.99]} material={m.carbon}>
          <boxGeometry args={[0.56, 0.008, 0.075]} />
        </mesh>
        <mesh position={[2.5, 0.2, 1.0]} rotation-x={0.5} material={m.accent}>
          <boxGeometry args={[0.13, 0.005, 0.055]} />
        </mesh>
      </Exploded>
      {/* nose camera pod */}
      <Exploded k="explodeFront" offset={[0.04, 0.03, 0.08]}>
        <mesh position={[1.5, 0.47, 0.31]} rotation-z={Math.PI / 2} material={m.matte}>
          <cylinderGeometry args={[0.028, 0.028, 0.17, 16]} />
        </mesh>
        <Strut from={V(1.5, 0.44, 0.2)} to={V(1.5, 0.465, 0.3)} w={0.03} h={0.01} material={m.carbon} />
      </Exploded>
    </>
  );

  const rearEndplate = (
    <Exploded k="explodeRear" offset={[-0.06, 0.1, 0.16]}>
      <mesh geometry={g.rwEndplate} material={m.paint} castShadow />
    </Exploded>
  );

  const brakeDuctRear = null;
  void brakeDuctRear;

  return (
    <group>
      {/* central body */}
      <mesh geometry={g.body} material={m.paint} castShadow receiveShadow />
      {ghost(g.body)}
      <mesh geometry={g.noseFairing} material={m.dark} castShadow />

      {/* engine cover + airbox lift away with the halo in the cockpit scene */}
      <Exploded k="explodeTop" offset={[-0.1, 0.14, 0]}>
        <mesh geometry={g.airbox} material={m.paint} castShadow receiveShadow />
        <mesh geometry={g.intake} material={m.matte} />
        {ghost(g.airbox)}
        {/* T-cam */}
        <mesh position={[-0.36, 1.015, 0]} material={m.matte}>
          <boxGeometry args={[0.035, 0.05, 0.2]} />
        </mesh>
      </Exploded>
      <Exploded k="explodeTop" offset={[0.0, 0.24, 0]}>
        <mesh geometry={g.halo} material={m.dark} castShadow />
        <mesh geometry={g.haloStrut} material={m.dark} position-z={-0.015} castShadow />
        {ghost(g.halo)}
      </Exploded>

      {/* cockpit: well, rim, headrest, helmet */}
      <mesh geometry={g.cockpitWell} material={m.matte} rotation-x={Math.PI / 2} position-y={0.683} />
      <mesh geometry={g.cockpitRim} material={m.matte} />
      <mesh position={[-0.2, 0.715, 0]} material={m.matte}>
        <boxGeometry args={[0.2, 0.08, 0.36]} />
      </mesh>
      {[1, -1].map(s => (
        <mesh key={s} position={[0.12, 0.705, s * 0.2]} material={m.matte}>
          <boxGeometry args={[0.44, 0.055, 0.07]} />
        </mesh>
      ))}
      <group position={[0.1, 0.655, 0]}>
        <mesh material={m.accent} castShadow>
          <sphereGeometry args={[0.135, 40, 28]} />
        </mesh>
        <mesh material={m.visor}>
          <sphereGeometry args={[0.138, 40, 20, Math.PI - 0.95, 1.9, 1.02, 0.5]} />
        </mesh>
        <mesh position={[-0.11, 0.06, 0]} rotation-z={0.4} material={m.dark}>
          <boxGeometry args={[0.06, 0.03, 0.16]} />
        </mesh>
      </group>

      {sidepod}
      <group scale={[1, 1, -1]}>{sidepod}</group>
      {mirror}
      <group scale={[1, 1, -1]}>{mirror}</group>

      {/* floor, edge wings, diffuser */}
      <mesh geometry={g.floor} material={m.carbon} rotation-x={Math.PI / 2} position-y={0.11} receiveShadow />
      <mesh geometry={g.floorEdge} material={m.carbon} />
      <mesh geometry={g.floorEdge} material={m.carbon} scale={[1, 1, -1]} />
      <Exploded k="explodeRear" offset={[-0.3, -0.04, 0]}>
        <mesh geometry={g.diffuser} material={m.carbon} castShadow />
        <mesh geometry={g.diffuserWall} material={m.carbon} />
        <mesh geometry={g.diffuserWall} material={m.carbon} scale={[1, 1, -1]} />
        {[-0.3, 0, 0.3].map(z => (
          <mesh key={z} position={[-2.2, 0.27, z]} rotation-z={-0.46} material={m.carbon}>
            <boxGeometry args={[0.78, 0.13, 0.008]} />
          </mesh>
        ))}
      </Exploded>

      {/* front wing */}
      <Exploded k="explodeFront" offset={[0.28, -0.07, 0]}>
        <mesh geometry={g.fwMain} material={m.carbon} castShadow />
        {ghost(g.fwMain)}
      </Exploded>
      <Exploded k="explodeFront" offset={[0.14, 0.02, 0]}>
        <mesh geometry={g.fwFlap2} material={m.paint} castShadow />
      </Exploded>
      {frontFlaps}
      <group scale={[1, 1, -1]}>{frontFlaps}</group>
      {/* pitot + antenna */}
      <mesh position={[2.3, 0.46, 0]} material={m.aluminium}>
        <cylinderGeometry args={[0.004, 0.004, 0.16, 8]} />
      </mesh>
      <mesh position={[2.62, 0.355, 0]} rotation-z={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[0.005, 0.005, 0.1, 8]} />
      </mesh>

      {/* rear wing */}
      <Exploded k="explodeRear" offset={[-0.14, 0.22, 0]}>
        <mesh geometry={g.rwMain} material={m.carbon} castShadow />
        <mesh geometry={g.pylon} material={m.carbon} castShadow />
        {ghost(g.rwMain)}
      </Exploded>
      <Exploded k="explodeRear" offset={[-0.26, 0.42, 0]}>
        <mesh geometry={g.rwFlap} material={m.accent} castShadow />
        <mesh position={[-2.63, 0.935, 0]} material={m.matte}>
          <boxGeometry args={[0.09, 0.045, 0.1]} />
        </mesh>
      </Exploded>
      <Exploded k="explodeRear" offset={[-0.05, 0.06, 0]}>
        <mesh geometry={g.beam1} material={m.carbon} castShadow />
        <mesh geometry={g.beam2} material={m.carbon} castShadow />
      </Exploded>
      {rearEndplate}
      <group scale={[1, 1, -1]}>{rearEndplate}</group>

      {/* exhaust + rain light on the rear impact structure */}
      <mesh position={[-2.72, 0.415, 0]} rotation-z={Math.PI / 2} material={m.exhaust}>
        <cylinderGeometry args={[0.036, 0.04, 0.2, 24, 1, true]} />
      </mesh>
      <mesh position={[-2.675, 0.33, 0]} material={m.rainLight}>
        <boxGeometry args={[0.02, 0.1, 0.06]} />
      </mesh>

      {/* running gear */}
      <Exploded k="explodeFront" offset={[0, 0, 0.05]}>
        <Wheel x={CAR.frontAxle} z={CAR.frontTyre.z} rear={false} side={1} m={m} g={g} />
      </Exploded>
      <Exploded k="explodeFront" offset={[0, 0, -0.05]}>
        <Wheel x={CAR.frontAxle} z={-CAR.frontTyre.z} rear={false} side={-1} m={m} g={g} />
      </Exploded>
      <Exploded k="explodeRear" offset={[0, 0, 0.08]}>
        <Wheel x={CAR.rearAxle} z={CAR.rearTyre.z} rear side={1} m={m} g={g} />
      </Exploded>
      <Exploded k="explodeRear" offset={[0, 0, -0.08]}>
        <Wheel x={CAR.rearAxle} z={-CAR.rearTyre.z} rear side={-1} m={m} g={g} />
      </Exploded>
      <Suspension x={CAR.frontAxle} s={1} rear={false} m={m} />
      <Suspension x={CAR.frontAxle} s={-1} rear={false} m={m} />
      <Suspension x={CAR.rearAxle} s={1} rear m={m} />
      <Suspension x={CAR.rearAxle} s={-1} rear m={m} />

      <Internals m={m} />
    </group>
  );
}
