import { Suspense, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import ProceduralCar from '../three/car/ProceduralCar';
import { createClayMaterials } from '../three/materials';
import { CANVAS, SHEET_ASPECT } from '../three/sheetFrames';

/**
 * Dev-only route (`?ortho=side|top&px=4096`): the car in neutral clay, rendered
 * orthographically on a transparent 21:9 canvas at the exact sheet frame. The
 * screenshot harness turns this into the reference image a livery is painted on.
 */
function OrthoCamera({ view }: { view: 'side' | 'top' }) {
  const { camera } = useThree();
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    const cx = (CANVAS.side.x0 + CANVAS.side.x1) / 2;
    const halfW = (CANVAS.side.x1 - CANVAS.side.x0) / 2;
    const halfH = halfW / SHEET_ASPECT;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.near = 0.1;
    cam.far = 100;
    if (view === 'side') {
      const cy = (CANVAS.side.y0 + CANVAS.side.y1) / 2;
      cam.up.set(0, 1, 0);
      cam.position.set(cx, cy, 40);
      cam.lookAt(cx, cy, 0);
    } else {
      cam.up.set(0, 0, -1);
      cam.position.set(cx, 40, 0);
      cam.lookAt(cx, 0, 0);
    }
    cam.updateProjectionMatrix();
  }, [camera, view]);
  return null;
}

function Ready() {
  let frames = 0;
  useFrame(() => {
    frames++;
    if (frames === 6) (window as unknown as { __orthoReady: boolean }).__orthoReady = true;
  });
  return null;
}

export default function OrthoSheet({ view, px }: { view: 'side' | 'top'; px: number }) {
  const m = useMemo(createClayMaterials, []);
  const width = px;
  const height = Math.round(px / SHEET_ASPECT);
  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.margin = '0';
  }, []);
  return (
    <div style={{ width, height, overflow: 'hidden', background: 'transparent' }}>
      <Canvas orthographic dpr={1} gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false }} onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}>
        <OrthoCamera view={view} />
        <ambientLight intensity={0.9} />
        <directionalLight position={view === 'side' ? [2, 6, 20] : [2, 20, 4]} intensity={1.6} />
        <directionalLight position={view === 'side' ? [-6, 2, 10] : [-6, 10, -8]} intensity={0.5} color="#dfe8ff" />
        <Suspense fallback={null}>
          <ProceduralCar m={m} />
        </Suspense>
        <Ready />
      </Canvas>
    </div>
  );
}
