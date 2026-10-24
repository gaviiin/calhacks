import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildCar, CAR } from './buildCar';
import { registerPart, unregisterPart, updatePart, type PartSpec, type PartState } from './explode';
import PowerUnit from './PowerUnit';
import { strut, V } from '../geometry';
import type { CarMaterials } from '../materials';

/**
 * A part that leaves its mount during a teardown scene. Offsets are in the parent's
 * space (mirrored groups flip them automatically); see `explode.ts` for the easing.
 */
function Exploded({ children, ...spec }: PartSpec & { children: ReactNode }) {
  const ref = useRef<THREE.Group>(null);
  const state = useRef<PartState | null>(null);
  const key = JSON.stringify(spec);
  useEffect(() => {
    const st = registerPart(spec);
    st.group = ref.current;
    state.current = st;
    return () => {
      unregisterPart(st);
      state.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useFrame(s => {
    const st = state.current;
    if (!st) return;
    st.group = ref.current;
    updatePart(st, s.clock.elapsedTime);
  });
  return <group ref={ref}>{children}</group>;
}

/** Exploded part that moves and tilts about its own point `at` instead of the car origin. */
function Pivoted({ at, children, ...spec }: PartSpec & { at: [number, number, number]; children: ReactNode }) {
  return (
    <group position={at}>
      <Exploded {...spec} anchor={spec.anchor ?? [0, 0, 0]}>
        <group position={[-at[0], -at[1], -at[2]]}>{children}</group>
      </Exploded>
    </group>
  );
}

/** Aero-faired member: an elliptical section (chord w, thickness h) between two points. */
function Strut({ from, to, w = 0.05, h = 0.015, material }: { from: THREE.Vector3; to: THREE.Vector3; w?: number; h?: number; material: THREE.Material }) {
  const t = useMemo(() => strut(from, to), [from, to]);
  return (
    <group position={t.position} quaternion={t.quaternion}>
      <mesh rotation-x={Math.PI / 2} scale={[w / 2, t.length, h / 2]} material={material} castShadow>
        <cylinderGeometry args={[1, 1, 1, 16]} />
      </mesh>
    </group>
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

/** Ten-spoke rim behind the aero cover, merged into one geometry; `zFront` is its outermost face. */
function spokeGeometry(zFront: number) {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 10; i++) {
    const g = new THREE.BoxGeometry(0.022, 0.15, 0.03);
    g.translate(0, 0.13, zFront - 0.015);
    g.rotateZ((i / 10) * Math.PI * 2);
    parts.push(g);
  }
  const hub = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 24);
  hub.rotateX(Math.PI / 2);
  hub.translate(0, 0, zFront - 0.06);
  parts.push(hub);
  return mergeGeometries(parts, false)!;
}

function Wheel({ x, z, rear, side, m, g }: { x: number; z: number; rear: boolean; side: 1 | -1; m: CarMaterials; g: ReturnType<typeof buildCar> }) {
  const width = rear ? CAR.rearTyre.width : CAR.frontTyre.width;
  const face = width / 2;
  /** The aero cover's dish sits 18 mm inside the tyre face and dips 36 mm; the spokes stay behind it. */
  const coverFace = face - 0.018;
  const k = rear ? 'explodeRear' : 'explodeFront';
  const spokes = useMemo(() => spokeGeometry(coverFace - 0.045), [coverFace]);
  const discZ = -(face - 0.075);
  const t0 = rear ? 0.42 : 0.4;
  /**
   * Engineering exploded view: nut, aero cover and wheel leave along one ray from the hub
   * (mostly down the axle, drifting a little forward and up), each slowly turning once free.
   */
  const ray = (d: number): [number, number, number] => [0.38 * d, 0.16 * d, d];
  return (
    <group position={[x, CAR.tyreR, z]} scale={[1, 1, side]}>
      <Pivoted at={[0, 0, face - 0.008]} k={k} offset={ray(0.7)} rot={[0, 0, 6 * Math.PI]} spin={[0, 0, 1.6]} delay={t0} span={0.22} ease="smooth" float={0.004} label="WHEEL NUT">
        <mesh position-z={face - 0.008} rotation-x={Math.PI / 2} material={m.accent}>
          <cylinderGeometry args={[0.034, 0.03, 0.022, 6]} />
        </mesh>
      </Pivoted>
      {/* axle stub and hub face, visible once the wheel is off */}
      <mesh position-z={0.02} rotation-x={Math.PI / 2} material={m.titanium}>
        <cylinderGeometry args={[0.03, 0.03, 0.26, 20]} />
      </mesh>
      <mesh position-z={discZ + 0.06} rotation-x={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[0.085, 0.085, 0.03, 24]} />
      </mesh>
      <Exploded k={k} offset={ray(0.24)} spin={[0, 0, 0.22]} delay={t0 + 0.16} span={0.3} ease="smooth" float={0.004} anchor={[0, 0, 0]} label="WHEEL">
        <mesh geometry={rear ? g.tyreR : g.tyreF} material={m.rubber} rotation-x={Math.PI / 2} castShadow receiveShadow />
        <mesh rotation-x={Math.PI / 2} material={m.cover}>
          <cylinderGeometry args={[CAR.rimR - 0.004, CAR.rimR - 0.004, width - 0.04, 48, 1, true]} />
        </mesh>
        <mesh position-z={face - 0.016} rotation-x={Math.PI / 2} material={m.aluminium}>
          <cylinderGeometry args={[CAR.rimR + 0.003, CAR.rimR + 0.003, 0.012, 64, 1, true]} />
        </mesh>
        <mesh geometry={spokes} material={m.aluminium} castShadow />
        <Pivoted at={[0, 0, coverFace]} k={k} offset={ray(0.3)} spin={[0, 0, -0.3]} delay={t0 + 0.36} span={0.26} ease="smooth" float={0.006} label="AERO COVER">
          <mesh geometry={rear ? g.coverR : g.coverF} material={m.cover} rotation-x={Math.PI / 2} castShadow />
          {/* accent ring on the cover face */}
          <mesh position-z={coverFace - 0.009} material={m.accent}>
            <ringGeometry args={[0.188, 0.2, 64]} />
          </mesh>
        </Pivoted>
      </Exploded>
      {/* brake assembly and duct stay on the upright */}
      <mesh position-z={discZ} rotation-x={Math.PI / 2} material={m.brakeDisc}>
        <cylinderGeometry args={[0.168, 0.168, 0.03, 48]} />
      </mesh>
      <mesh position={[-0.06, 0.13, discZ]} rotation-z={0.45} material={m.titanium} castShadow>
        <boxGeometry args={[0.07, 0.13, 0.06]} />
      </mesh>
      <mesh position-z={discZ + 0.03} rotation-x={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[0.055, 0.055, 0.1, 20]} />
      </mesh>
      <mesh position-z={-(face + 0.012)} rotation-x={Math.PI / 2} material={m.carbon}>
        <cylinderGeometry args={[0.19, 0.19, 0.05, 48]} />
      </mesh>
      <mesh geometry={g.duct} material={m.carbon} position={[0.0, -CAR.tyreR, -(face + 0.08)]} castShadow />
    </group>
  );
}

/** Finned radiator core that slides out of the sidepod. */
function Radiator({ m }: { m: CarMaterials }) {
  return (
    <Pivoted at={[0.3, 0.34, 0.52]} k="explodeMid" offset={[0.42, 0.06, 0.34]} rot={[0, 0.2, 0]} delay={0.35} span={0.45} arc={0.04} label="RADIATOR">
      <group position={[0.3, 0.34, 0.52]} rotation-y={0.35}>
        <mesh material={m.radiator} castShadow>
          <boxGeometry args={[0.52, 0.3, 0.06]} />
        </mesh>
        <mesh material={m.aluminium}>
          <boxGeometry args={[0.54, 0.32, 0.03]} />
        </mesh>
      </group>
    </Pivoted>
  );
}

/** Steering wheel: lifts out of the cockpit once the halo is up. */
function SteeringWheel({ m }: { m: CarMaterials }) {
  const frame = useMemo(() => {
    const shape = new THREE.Shape();
    const r = 0.03;
    const w = 0.135;
    const h = 0.085;
    shape.moveTo(-w + r, -h);
    shape.lineTo(w - r, -h);
    shape.quadraticCurveTo(w, -h, w, -h + r);
    shape.lineTo(w, h - r);
    shape.quadraticCurveTo(w, h, w - r, h);
    shape.lineTo(-w + r, h);
    shape.quadraticCurveTo(-w, h, -w, h - r);
    shape.lineTo(-w, -h + r);
    shape.quadraticCurveTo(-w, -h, -w + r, -h);
    const hole = new THREE.Path();
    hole.absellipse(0, -0.045, 0.07, 0.03, 0, Math.PI * 2, true, 0);
    shape.holes.push(hole);
    return new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2 });
  }, []);
  return (
    <Pivoted at={[0.52, 0.6, 0]} k="explodeTop" offset={[0.22, 0.36, 0]} rot={[0, 0, -0.9]} delay={0.4} span={0.45} arc={0.06} label="STEERING WHEEL">
      <group position={[0.52, 0.6, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <group rotation-x={-0.5}>
          <mesh geometry={frame} material={m.carbon} position-z={-0.011} castShadow />
          <mesh position={[0, 0.02, 0.008]} material={m.screen}>
            <boxGeometry args={[0.11, 0.065, 0.012]} />
          </mesh>
          {[-1, 1].map(s => (
            <mesh key={s} position={[s * 0.15, -0.01, 0]} material={m.suede}>
              <boxGeometry args={[0.045, 0.1, 0.045]} />
            </mesh>
          ))}
          {[-0.085, -0.055, 0.055, 0.085].map((bx, i) => (
            <mesh key={bx} position={[bx, 0.055, 0.012]} rotation-x={Math.PI / 2} material={i % 2 ? m.accent : m.rainLight}>
              <cylinderGeometry args={[0.008, 0.008, 0.008, 12]} />
            </mesh>
          ))}
          {[-1, 1].map(s => (
            <mesh key={s} position={[s * 0.09, -0.02, -0.03]} material={m.carbon}>
              <boxGeometry args={[0.09, 0.03, 0.006]} />
            </mesh>
          ))}
        </group>
      </group>
    </Pivoted>
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
    <>
      <Pivoted at={[-0.3, 0.4, 0.5]} k="explodeMid" offset={[0.05, 0.22, 0.34]} rot={[0.14, 0.04, 0.03]} delay={0} span={0.55} arc={0.05} label="SIDEPOD">
        <mesh geometry={g.sidepod} material={m.pod} castShadow receiveShadow />
        <mesh geometry={g.inlet} material={m.matte} />
        {ghost(g.sidepod)}
      </Pivoted>
      <Radiator m={m} />
      <Pivoted at={[0.3, 0.12, 0.8]} k="explodeMid" offset={[0.02, -0.1, 0.22]} rot={[0.3, 0, 0]} delay={0.5} span={0.4} label="FLOOR EDGE">
        <mesh geometry={g.floorEdge} material={m.carbon} />
      </Pivoted>
    </>
  );

  const mirror = (
    <Pivoted at={[0.77, 0.74, 0.47]} k="explodeMid" offset={[0.02, 0.1, 0.14]} rot={[0.2, 0, 0.15]} delay={0.22} span={0.4} label="MIRROR">
      <mesh geometry={g.mirrorHousing} material={m.paint} castShadow />
      <mesh position={[0.695, 0.745, 0.47]} rotation-y={Math.PI / 2} material={m.visor}>
        <planeGeometry args={[0.1, 0.055]} />
      </mesh>
      <Strut from={V(0.78, 0.63, 0.3)} to={V(0.78, 0.72, 0.44)} w={0.03} h={0.012} material={m.carbon} />
    </Pivoted>
  );

  const frontFlaps = (
    <>
      <Pivoted at={[2.4, 0.22, 0.58]} k="explodeFront" offset={[0.0, 0.11, 0]} rot={[0, 0, 0.1]} delay={0.24} span={0.45} label="FLAP 3">
        <mesh geometry={g.fwFlap3} material={m.paint} castShadow />
        {[0.34, 0.52, 0.7, 0.86].map(z => (
          <mesh key={z} position={[2.36, 0.27, z]} rotation-z={-0.45} material={m.carbon}>
            <boxGeometry args={[0.16, 0.2, 0.004]} />
          </mesh>
        ))}
      </Pivoted>
      <Pivoted at={[2.28, 0.3, 0.58]} k="explodeFront" offset={[-0.08, 0.22, 0]} rot={[0, 0, 0.18]} delay={0.12} span={0.45} label="FLAP 4">
        <mesh geometry={g.fwFlap4} material={m.accent} castShadow />
      </Pivoted>
      <Pivoted at={[2.55, 0.18, 0.98]} k="explodeFront" offset={[0.08, 0.04, 0.24]} rot={[0, 0.12, -0.12]} delay={0} span={0.45} arc={0.03} label="ENDPLATE">
        <mesh geometry={g.fwEndplate} material={m.paint} castShadow />
        <mesh geometry={g.fwEndplateRoll} material={m.paint} castShadow />
        <mesh position={[2.62, 0.058, 0.99]} material={m.carbon}>
          <boxGeometry args={[0.56, 0.008, 0.075]} />
        </mesh>
        <mesh position={[2.5, 0.2, 1.0]} rotation-x={0.5} material={m.accent}>
          <boxGeometry args={[0.13, 0.005, 0.055]} />
        </mesh>
      </Pivoted>
      <Pivoted at={[1.5, 0.47, 0.31]} k="explodeFront" offset={[0.06, 0.06, 0.1]} delay={0.2} span={0.4} label="CAMERA POD">
        <mesh position={[1.5, 0.47, 0.31]} rotation-z={Math.PI / 2} material={m.matte}>
          <cylinderGeometry args={[0.028, 0.028, 0.17, 16]} />
        </mesh>
        <Strut from={V(1.5, 0.44, 0.2)} to={V(1.5, 0.465, 0.3)} w={0.03} h={0.01} material={m.carbon} />
      </Pivoted>
    </>
  );

  const rearEndplate = (
    <Pivoted at={[-2.5, 0.7, 0.49]} k="explodeRear" offset={[-0.08, 0.12, 0.2]} rot={[0, 0.3, 0.06]} delay={0.5} span={0.45} arc={0.03} label="ENDPLATE">
      <mesh geometry={g.rwEndplate} material={m.paint} castShadow />
    </Pivoted>
  );

  return (
    <group>
      {/* monocoque: nose to the rear bulkhead */}
      <mesh geometry={g.body} material={m.paint} castShadow receiveShadow />
      {ghost(g.body)}
      <mesh geometry={g.noseFairing} material={m.dark} castShadow />

      {/* rear bodywork + engine cover lift as one shell off the power unit; halo and wheel follow */}
      <Pivoted at={[-1.3, 0.6, 0]} k="explodeTop" offset={[-0.2, 0.42, 0]} rot={[0, 0, 0.12]} delay={0} span={0.55} arc={0.06} label="ENGINE COVER">
        <mesh geometry={g.bodyRear} material={m.shell} castShadow receiveShadow />
        {ghost(g.bodyRear)}
        <mesh geometry={g.airbox} material={m.paint} castShadow receiveShadow />
        <mesh geometry={g.intake} material={m.matte} />
        {ghost(g.airbox)}
        {/* exhaust tip and rain light ride on the rear crash structure */}
        <mesh position={[-2.72, 0.415, 0]} rotation-z={Math.PI / 2} material={m.exhaust}>
          <cylinderGeometry args={[0.036, 0.04, 0.2, 24, 1, true]} />
        </mesh>
        <mesh position={[-2.675, 0.33, 0]} material={m.rainLight}>
          <boxGeometry args={[0.02, 0.1, 0.06]} />
        </mesh>
        <mesh position={[-0.36, 1.015, 0]} material={m.matte}>
          <boxGeometry args={[0.035, 0.05, 0.2]} />
        </mesh>
        {[1, -1].map(s =>
          [0, 1, 2, 3, 4].map(i => (
            <mesh key={`${s}-${i}`} position={[-1.05 - i * 0.075, 0.6 - i * 0.022, s * (0.205 - i * 0.012)]} rotation={[0, s * 0.32, -0.3]} material={m.matte}>
              <boxGeometry args={[0.016, 0.034, 0.004]} />
            </mesh>
          ))
        )}
      </Pivoted>
      <Pivoted at={[0.2, 0.86, 0]} k="explodeTop" offset={[0.06, 0.32, 0]} rot={[0, 0, -0.08]} delay={0.2} span={0.5} label="HALO">
        <mesh geometry={g.halo} material={m.paint} castShadow />
        <mesh geometry={g.haloStrut} material={m.paint} position-z={-0.015} castShadow />
        {ghost(g.halo)}
      </Pivoted>
      <SteeringWheel m={m} />

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

      {/* floor and diffuser */}
      <mesh geometry={g.floor} material={m.carbon} rotation-x={Math.PI / 2} position-y={0.11} receiveShadow />
      <Pivoted at={[-2.2, 0.25, 0]} k="explodeRear" offset={[-0.34, -0.06, 0]} rot={[0, 0, -0.08]} delay={0.65} span={0.35} label="DIFFUSER">
        <mesh geometry={g.diffuser} material={m.carbon} castShadow />
        <mesh geometry={g.diffuserWall} material={m.carbon} />
        <mesh geometry={g.diffuserWall} material={m.carbon} scale={[1, 1, -1]} />
        {[-0.3, 0, 0.3].map(z => (
          <mesh key={z} position={[-2.2, 0.27, z]} rotation-z={-0.46} material={m.carbon}>
            <boxGeometry args={[0.78, 0.13, 0.008]} />
          </mesh>
        ))}
      </Pivoted>

      {/* front wing: endplates → flap 4 → flap 3 → flap 2 → mainplane */}
      <Pivoted at={[2.7, 0.1, 0]} k="explodeFront" offset={[0.3, -0.08, 0]} rot={[0, 0, -0.06]} delay={0.48} span={0.45} label="MAINPLANE">
        <mesh geometry={g.fwMain} material={m.carbon} castShadow />
        {ghost(g.fwMain)}
      </Pivoted>
      <Pivoted at={[2.55, 0.14, 0]} k="explodeFront" offset={[0.16, 0.03, 0]} rot={[0, 0, 0.05]} delay={0.36} span={0.45} label="FLAP 2">
        <mesh geometry={g.fwFlap2} material={m.paint} castShadow />
      </Pivoted>
      {frontFlaps}
      <group scale={[1, 1, -1]}>{frontFlaps}</group>
      <mesh position={[2.3, 0.46, 0]} material={m.aluminium}>
        <cylinderGeometry args={[0.004, 0.004, 0.16, 8]} />
      </mesh>
      <mesh position={[2.62, 0.355, 0]} rotation-z={Math.PI / 2} material={m.aluminium}>
        <cylinderGeometry args={[0.005, 0.005, 0.1, 8]} />
      </mesh>

      {/* rear wing: DRS opens first, then the flap lifts, mainplane, endplates fan out, beam wing, diffuser */}
      <Pivoted at={[-2.6, 0.87, 0]} k="explodeRear" offset={[-0.28, 0.44, 0]} rot={[0, 0, 0.06]} delay={0.25} span={0.5} arc={0.08} label="DRS FLAP">
        <group position={[-2.53, 0.865, 0]}>
          <Exploded k="explodeRear" offset={[0, 0, 0]} rot={[0, 0, -0.55]} delay={0} span={0.3} float={0} label="DRS">
            <group position={[2.53, -0.865, 0]}>
              <mesh geometry={g.rwFlap} material={m.accent} castShadow />
              <mesh position={[-2.63, 0.935, 0]} material={m.matte}>
                <boxGeometry args={[0.09, 0.045, 0.1]} />
              </mesh>
            </group>
          </Exploded>
        </group>
      </Pivoted>
      <Pivoted at={[-2.3, 0.8, 0]} k="explodeRear" offset={[-0.16, 0.24, 0]} rot={[0, 0, 0.1]} delay={0.4} span={0.45} arc={0.04} label="MAINPLANE">
        <mesh geometry={g.rwMain} material={m.carbon} castShadow />
        <mesh geometry={g.pylon} material={m.carbon} castShadow />
        {ghost(g.rwMain)}
      </Pivoted>
      <Pivoted at={[-2.4, 0.47, 0]} k="explodeRear" offset={[-0.14, 0.0, 0]} rot={[0, 0, -0.1]} delay={0.6} span={0.4} label="BEAM WING">
        <mesh geometry={g.beam1} material={m.carbon} castShadow />
        <mesh geometry={g.beam2} material={m.carbon} castShadow />
      </Pivoted>
      {rearEndplate}
      <group scale={[1, 1, -1]}>{rearEndplate}</group>

      {/* running gear */}
      <Wheel x={CAR.frontAxle} z={CAR.frontTyre.z} rear={false} side={1} m={m} g={g} />
      <Wheel x={CAR.frontAxle} z={-CAR.frontTyre.z} rear={false} side={-1} m={m} g={g} />
      <Wheel x={CAR.rearAxle} z={CAR.rearTyre.z} rear side={1} m={m} g={g} />
      <Wheel x={CAR.rearAxle} z={-CAR.rearTyre.z} rear side={-1} m={m} g={g} />
      <Suspension x={CAR.frontAxle} s={1} rear={false} m={m} />
      <Suspension x={CAR.frontAxle} s={-1} rear={false} m={m} />
      <Suspension x={CAR.rearAxle} s={1} rear m={m} />
      <Suspension x={CAR.rearAxle} s={-1} rear m={m} />

      {/* power unit behind the fuel cell and energy store: revealed when the engine cover lifts */}
      <PowerUnit m={m} />
      <mesh position={[-0.45, 0.17, 0]} material={m.carbon}>
        <boxGeometry args={[0.46, 0.09, 0.38]} />
      </mesh>
      <mesh position={[-0.45, 0.38, 0]} material={m.matte}>
        <boxGeometry args={[0.46, 0.36, 0.4]} />
      </mesh>
      <group position={[0.9, 0.3, 0]}>
        <mesh material={m.internals}>
          <boxGeometry args={[0.8, 0.14, 0.3]} />
        </mesh>
      </group>
    </group>
  );
}
