import { memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import * as THREE from 'three';
import CarModel from './car/CarModel';
import Effects from './Effects';
import { liveryNow, liveryUniforms, syncLivery } from './livery';
import { createCarMaterials, skinMaterials, type CarMaterials } from './materials';
import AuditTrail from './overlays/AuditTrail';
import Callouts from './overlays/Callouts';
import ReasoningGraph from './overlays/ReasoningGraph';
import Streams from './overlays/Streams';
import { sceneState } from './state';
import { StudioEnvironment, StudioFloor, StudioLights } from './Studio';

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color('#ffffff');

/**
 * Camera + material driver. Reads `sceneState` every frame, adds damping so GSAP's
 * scrubbed steps become one continuous dolly, and frames the focus point where the
 * station asks for it (the copy column needs the left of the frame on desktop).
 */
function Rig({ m, reduceMotion, mobile, onReady }: { m: CarMaterials; reduceMotion: boolean; mobile: boolean; onReady: () => void }) {
  const { camera, size } = useThree();
  const pos = useRef(new THREE.Vector3(sceneState.camX, sceneState.camY, sceneState.camZ));
  const look = useRef(new THREE.Vector3(sceneState.lookX, sceneState.lookY, sceneState.lookZ));
  const frames = useRef(0);
  const tmp = useMemo(() => ({ p: new THREE.Vector3(), l: new THREE.Vector3(), d: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3() }), []);
  const skins = useMemo(() => skinMaterials(m), [m]);

  useFrame((state, dt) => {
    const s = sceneState;
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / size.height;
    // Narrow viewports back the camera off so the whole focus area still fits.
    const fit = THREE.MathUtils.clamp(1.6 / aspect, 1, 2.2);

    tmp.l.set(s.lookX, s.lookY, s.lookZ);
    tmp.p.set(s.camX, s.camY, s.camZ).sub(tmp.l).multiplyScalar(fit).add(tmp.l);
    if (!reduceMotion && s.idle > 0) {
      const t = state.clock.elapsedTime;
      tmp.p.x += Math.sin(t * 0.27) * 0.12 * s.idle;
      tmp.p.y += Math.sin(t * 0.41) * 0.05 * s.idle;
      tmp.p.z += Math.cos(t * 0.19) * 0.08 * s.idle;
    }
    if (cam.fov !== s.fov) {
      cam.fov = s.fov;
      cam.updateProjectionMatrix();
    }
    // Truck the camera sideways so the focus lands at (screenX, screenY) in the frame.
    const dist = tmp.p.distanceTo(tmp.l);
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    const halfW = halfH * aspect;
    tmp.d.copy(tmp.l).sub(tmp.p).normalize();
    tmp.r.crossVectors(tmp.d, UP).normalize();
    tmp.u.crossVectors(tmp.r, tmp.d).normalize();
    const sx = mobile ? 0 : s.screenX;
    const sy = mobile ? -0.3 : s.screenY;
    tmp.r.multiplyScalar(-sx * halfW);
    tmp.u.multiplyScalar(-sy * halfH);
    tmp.p.add(tmp.r).add(tmp.u);
    tmp.l.add(tmp.r).add(tmp.u);

    const k = reduceMotion || frames.current < 2 ? 1 : 1 - Math.exp(-dt * 5);
    pos.current.lerp(tmp.p, k);
    look.current.lerp(tmp.l, k);
    cam.position.copy(pos.current);
    cam.lookAt(look.current);

    // Livery + x-ray.
    syncLivery(state.clock.elapsedTime);
    const skin = 1 - 0.56 * s.xray;
    for (const mat of skins) mat.opacity = skin;
    m.pod.opacity = Math.max(0.25, skin - 0.5 * s.explodeMid);
    m.ghost.uniforms.uColor.value.copy(liveryNow.accent).lerp(WHITE, 0.35);
    m.ghost.uniforms.uAmount.value = s.xray;
    m.wire.color.copy(liveryNow.accent);
    m.wire.opacity = 0.07 * s.xray;
    m.internals.emissive.copy(liveryNow.accent);
    m.internals.opacity = 0.16 * Math.max(s.xray, s.explodeMid * 0.6);
    m.internalsEdge.color.copy(liveryNow.accent);
    m.internalsEdge.opacity = 0.85 * Math.max(s.xray, s.explodeMid * 0.5);
    liveryUniforms.uTime.value = state.clock.elapsedTime;

    frames.current++;
    if (frames.current === 3) onReady();
  });
  return null;
}

/** Dev only: lets the screenshot harness inspect the renderer. */
function DebugHook() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __gl: unknown }).__gl = { gl, scene, camera };
  }, [gl, scene, camera]);
  return null;
}

export type SceneProps = { reduceMotion: boolean; running: boolean; onReady: () => void };

function Scene({ reduceMotion, running, onReady }: SceneProps) {
  const m = useMemo(createCarMaterials, []);
  const mobile = useMemo(() => window.matchMedia('(max-width: 900px)').matches, []);
  const [dpr, setDpr] = useState(mobile ? 1.25 : 1.6);
  const [quality, setQuality] = useState<'high' | 'low'>('high');
  useEffect(() => () => Object.values(m).forEach(mat => mat.dispose()), [m]);

  return (
    <Canvas
      shadows
      dpr={dpr}
      frameloop={running ? 'always' : 'never'}
      gl={{ antialias: false, alpha: true, powerPreference: 'high-performance', stencil: false, depth: true }}
      camera={{ fov: 26, near: 0.1, far: 90, position: [0.4, 0.95, 7.2] }}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.AgXToneMapping;
        gl.toneMappingExposure = 1.15;
        gl.shadowMap.type = THREE.PCFSoftShadowMap;
      }}
    >
      <PerformanceMonitor
        onDecline={() => {
          setDpr(d => Math.max(1, d - 0.25));
          setQuality('low');
        }}
        onIncline={() => setDpr(d => Math.min(mobile ? 1.5 : 1.75, d + 0.25))}
        flipflops={2}
      />
      <Suspense fallback={null}>
        <StudioEnvironment />
        <fog attach="fog" args={['#07090c', 10, 34]} />
        <StudioLights />
        <Rig m={m} reduceMotion={reduceMotion} mobile={mobile} onReady={onReady} />
        <CarModel m={m} />
        <Streams m={m} reduceMotion={reduceMotion} />
        <ReasoningGraph />
        <AuditTrail />
        <Callouts />
        <StudioFloor mobile={mobile} />
        {!mobile && <Effects quality={quality} />}
        <DebugHook />
      </Suspense>
    </Canvas>
  );
}

export default memo(Scene);
