import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { ContactShadows, Environment, MeshReflectorMaterial } from '@react-three/drei';
import * as THREE from 'three';
import { CAR_ASSETS } from './assets';
import { pitBoxTexture } from './materials';
import { liveryNow } from './livery';
import { sceneState } from './state';

/** A softbox with feathered edges, rendered only into the environment map. */
function Softbox({ position, rotation = [0, 0, 0], scale, intensity = 1, color = '#ffffff', feather = 0.35 }: { position: [number, number, number]; rotation?: [number, number, number]; scale: [number, number]; intensity?: number; color?: string; feather?: number }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: intensity }, uFeather: { value: feather } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 uColor; uniform float uIntensity, uFeather; varying vec2 vUv;
          void main(){
            float fx = smoothstep(0.0, uFeather, vUv.x) * smoothstep(1.0, 1.0 - uFeather, vUv.x);
            float fy = smoothstep(0.0, uFeather * 1.4, vUv.y) * smoothstep(1.0, 1.0 - uFeather * 1.4, vUv.y);
            gl_FragColor = vec4(uColor * uIntensity * fx * fy, 1.0);
          }`,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    [color, intensity, feather]
  );
  return (
    <mesh position={position} rotation={rotation} scale={[scale[0], scale[1], 1]} material={material}>
      <planeGeometry />
    </mesh>
  );
}

/** Gradient dome: dark floor tone, faint horizon band, dark ceiling. Gives the paint something to reflect. */
function Dome() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec3 vP;
          void main(){
            float h = vP.y;
            vec3 floorC = vec3(0.012, 0.014, 0.018);
            vec3 horizon = vec3(0.2, 0.21, 0.235);
            vec3 ceil = vec3(0.03, 0.032, 0.038);
            vec3 c = mix(floorC, horizon, smoothstep(-0.6, 0.02, h));
            c = mix(c, ceil, smoothstep(0.05, 0.7, h));
            // soft horizon glow band
            c += vec3(0.05) * exp(-pow((h - 0.06) / 0.08, 2.0));
            gl_FragColor = vec4(c, 1.0);
          }`,
        side: THREE.BackSide,
        toneMapped: false,
      }),
    []
  );
  return (
    <mesh material={material}>
      <sphereGeometry args={[60, 32, 16]} />
    </mesh>
  );
}

/** Procedural automotive studio: long strip lights over the car, soft walls, dark gradient dome. */
export function StudioEnvironment() {
  // A generated garage panorama (equirectangular) replaces the gradient dome behind the
  // same strip softboxes, so the paint reflects a real room while the key highlights stay.
  const files = CAR_ASSETS.envMap ?? undefined;
  return (
    <Environment resolution={512} frames={1} near={0.5} far={120} files={files} background={!!files} backgroundBlurriness={0.55} backgroundIntensity={0.22}>
      {!files && <Dome />}
      {/* key stripe: the long overhead softbox every car studio uses */}
      <Softbox position={[0, 5.2, 1.4]} rotation={[Math.PI / 2, 0, 0]} scale={[14, 1.6]} intensity={9} color="#fff6ea" feather={0.3} />
      {/* second stripe behind, cooler, for the top-rear surfaces */}
      <Softbox position={[0, 5.4, -2.6]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 1.0]} intensity={4.5} color="#dfe8ff" feather={0.3} />
      {/* front wall: a big dim softbox so the flank facing the camera gets a gradient */}
      <Softbox position={[0, 1.6, 9]} rotation={[0, Math.PI, 0]} scale={[16, 3.2]} intensity={1.05} color="#ffffff" feather={0.45} />
      {/* rear wall, slightly lower */}
      <Softbox position={[0, 1.2, -9]} scale={[16, 2.4]} intensity={1.1} color="#e9efff" feather={0.45} />
      {/* end rims on nose and tail */}
      <Softbox position={[10, 1.8, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[4, 2.2]} intensity={2.4} color="#ffffff" feather={0.4} />
      <Softbox position={[-10, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} scale={[4, 2.2]} intensity={2.4} color="#ffffff" feather={0.4} />
      {/* floor bounce */}
      <Softbox position={[0, -1.5, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[14, 10]} intensity={0.22} color="#aeb6c2" feather={0.5} />
    </Environment>
  );
}

/** Scene lights that follow the livery: key, coloured rim, floor glow and the hero sweep. */
export function StudioLights() {
  const key = useRef<THREE.DirectionalLight>(null);
  const rim = useRef<THREE.SpotLight>(null);
  const glow = useRef<THREE.PointLight>(null);
  const sweep = useRef<THREE.SpotLight>(null);
  const white = useMemo(() => new THREE.Color('#ffffff'), []);
  useFrame(() => {
    const s = sceneState;
    if (key.current) key.current.color.copy(liveryNow.key);
    if (rim.current) {
      rim.current.color.copy(liveryNow.rim).lerp(white, 0.25);
      rim.current.intensity = 70 * s.rim * (1 - s.fade * 0.6);
      rim.current.target.position.set(-0.5, 0.5, 0);
      rim.current.target.updateMatrixWorld();
    }
    if (glow.current) {
      glow.current.color.copy(liveryNow.rim).lerp(white, 0.3);
      glow.current.intensity = 14 * s.rim * (1 - s.fade * 0.7);
    }
    if (sweep.current) {
      const sw = s.flash > 0 ? 1 - s.flash : s.sweep;
      sweep.current.position.x = -5 + 10 * sw;
      sweep.current.intensity = Math.sin(Math.PI * Math.min(1, sw)) * 140;
      sweep.current.target.position.set(sweep.current.position.x, 0.4, 0);
      sweep.current.target.updateMatrixWorld();
    }
  });
  return (
    <>
      <ambientLight intensity={0.08} />
      <directionalLight ref={key} position={[3.5, 7, 4.5]} intensity={2.0} castShadow shadow-mapSize={[2048, 2048]} shadow-bias={-0.00012} shadow-normalBias={0.02} shadow-camera-left={-4.2} shadow-camera-right={4.2} shadow-camera-top={3.2} shadow-camera-bottom={-3.2} shadow-camera-near={1} shadow-camera-far={20} />
      <directionalLight position={[-5, 3, -4]} intensity={0.9} color="#dde8ff" />
      <spotLight ref={rim} position={[-3.5, 2.6, -4.5]} angle={0.6} penumbra={1} intensity={70} distance={16} decay={1.5} />
      <pointLight ref={glow} position={[-0.6, 0.35, -1.6]} intensity={14} distance={8} decay={2} />
      <spotLight ref={sweep} position={[-5, 3.4, 2.4]} angle={0.32} penumbra={1} intensity={0} distance={14} decay={1.6} color="#ffffff" />
    </>
  );
}

export function StudioFloor({ mobile }: { mobile: boolean }) {
  const markings = useMemo(pitBoxTexture, []);
  const markRef = useRef<THREE.MeshBasicMaterial>(null);
  useFrame(() => {
    if (markRef.current) markRef.current.opacity = 0.7 * sceneState.rim * (1 - sceneState.fade);
  });
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position-y={0}>
        <planeGeometry args={[60, 60]} />
        {mobile ? (
          <meshStandardMaterial color="#0a0c10" roughness={0.55} metalness={0.4} />
        ) : (
          <MeshReflectorMaterial blur={[360, 120]} resolution={1024} mixBlur={1} mixStrength={2.4} roughness={0.85} depthScale={1.0} minDepthThreshold={0.5} maxDepthThreshold={1.4} color="#0a0c10" metalness={0.55} mirror={0.55} />
        )}
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.003}>
        <planeGeometry args={[20, 20]} />
        <meshBasicMaterial ref={markRef} map={markings} transparent opacity={0.9} depthWrite={false} toneMapped={false} />
      </mesh>
      <ContactShadows position={[0, 0.002, 0]} scale={14} blur={2.4} far={1.6} opacity={0.9} resolution={mobile ? 512 : 1024} frames={Infinity} color="#000000" />
    </group>
  );
}
