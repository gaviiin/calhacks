import * as THREE from 'three';
import { applyLivery } from './livery';

/** 2x2 twill carbon weave with per-tow sheen variation, drawn once and tiled. */
function carbonTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#121416';
  ctx.fillRect(0, 0, size, size);
  const cells = 24;
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const horizontal = (x + y) % 4 < 2;
      const g = ctx.createLinearGradient(x * cell, y * cell, horizontal ? x * cell : x * cell + cell, horizontal ? y * cell + cell : y * cell);
      const sheen = 0.85 + 0.3 * Math.random();
      const hi = `rgb(${Math.round(58 * sheen)},${Math.round(62 * sheen)},${Math.round(68 * sheen)})`;
      g.addColorStop(0, '#0b0c0e');
      g.addColorStop(0.5, hi);
      g.addColorStop(1, '#0b0c0e');
      ctx.fillStyle = g;
      ctx.fillRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 8);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Tyre map for the lathe: u runs around the tyre, v along the profile.
 * Sidewalls carry faint lettering and a compound band; the tread stays plain rubber.
 */
function tyreTexture(): THREE.CanvasTexture {
  const w = 2048;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#121314';
  ctx.fillRect(0, 0, w, h);
  // Lathe profile: 6 sidewall points, 7 tread points, 6 sidewall points → v bands.
  // Sidewall bands in v: inner sidewall [0.08, 0.24] (bead → tread), outer [0.74, 0.92] (tread → bead).
  const bands: { v0: number; v1: number; band: number }[] = [
    { v0: 0.1, v1: 0.22, band: 0.25 },
    { v0: 0.76, v1: 0.88, band: 0.735 },
  ];
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const { v0, v1, band } of bands) {
    const y = ((v0 + v1) / 2) * h;
    // compound band: a thin pale ring just inside the tread shoulder
    ctx.fillStyle = 'rgba(225,225,220,0.5)';
    ctx.fillRect(0, band * h, w, 0.012 * h);
    ctx.font = `600 ${Math.round((v1 - v0) * h * 0.5)}px "Barlow Condensed", "Arial Narrow", sans-serif`;
    for (let i = 0; i < 6; i++) {
      const cx = ((i + 0.5) / 6) * w;
      ctx.fillStyle = 'rgba(170,172,175,0.22)';
      ctx.fillText(i % 2 ? 'PIT WALL' : 'C1 · HARD', cx, y);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Pit-box floor markings: 20 m square, alpha only. */
export function pitBoxTexture(): THREE.CanvasTexture {
  const size = 2048;
  const m = size / 20; // px per metre
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  // Faint grid every metre.
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.lineWidth = 1.5;
  for (let i = -10; i <= 10; i++) {
    ctx.beginPath();
    ctx.moveTo(i * m, -size / 2);
    ctx.lineTo(i * m, size / 2);
    ctx.moveTo(-size / 2, i * m);
    ctx.lineTo(size / 2, i * m);
    ctx.stroke();
  }
  // Pit box outline (car is 5.6 m × 2 m, nose +x → right).
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 5;
  ctx.strokeRect(-3.6 * m, -1.55 * m, 7.4 * m, 3.1 * m);
  // Stop line and front-wheel marks in warm yellow.
  ctx.strokeStyle = 'rgba(255,210,70,0.55)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(1.8 * m, -1.55 * m);
  ctx.lineTo(1.8 * m, 1.55 * m);
  ctx.stroke();
  ctx.lineWidth = 5;
  for (const z of [-0.85, 0.85]) {
    ctx.beginPath();
    ctx.moveTo(1.25 * m, z * m);
    ctx.lineTo(2.35 * m, z * m);
    ctx.stroke();
  }
  // Hatched zone behind the car.
  ctx.save();
  ctx.beginPath();
  ctx.rect(-3.6 * m, -1.55 * m, 1.1 * m, 3.1 * m);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 4;
  for (let i = -8; i < 8; i++) {
    ctx.beginPath();
    ctx.moveTo((-3.6 + i * 0.3) * m, -1.6 * m);
    ctx.lineTo((-3.6 + i * 0.3 + 1.6) * m, 1.6 * m);
    ctx.stroke();
  }
  ctx.restore();
  // Technical text.
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.font = `600 ${0.13 * m}px "IBM Plex Mono", monospace`;
  ctx.textAlign = 'left';
  ctx.fillText('PW-01 · BOX 1 · PIT WALL', -3.5 * m, 1.85 * m);
  ctx.textAlign = 'right';
  ctx.fillText('STOP LINE', 3.7 * m, 1.85 * m);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type CarMaterials = ReturnType<typeof createCarMaterials>;

export function createCarMaterials() {
  const carbonMap = carbonTexture();
  const tyreMap = tyreTexture();
  const paintBase = (zone: -1 | 0 | 1 | 2) =>
    applyLivery(
      new THREE.MeshPhysicalMaterial({
        color: '#ffffff',
        metalness: 0.5,
        roughness: 0.3,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 1.0,
        transparent: true,
      }),
      zone
    );
  return {
    /** Zoned livery paint: primary / secondary / accent resolved per pixel. */
    paint: paintBase(-1),
    /** Sidepods: same zoning, own opacity so they can go translucent while exploded. */
    pod: paintBase(-1),
    /** Forced accent (DRS flap, wing tips, stripes on separate parts). */
    accent: paintBase(2),
    /** Forced secondary (dark carbon-painted parts). */
    dark: paintBase(1),
    carbon: new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: carbonMap,
      bumpMap: carbonMap,
      bumpScale: 0.002,
      metalness: 0.2,
      roughness: 0.48,
      clearcoat: 0.5,
      clearcoatRoughness: 0.18,
      envMapIntensity: 0.7,
      transparent: true,
    }),
    /** Matte black for inlets, cockpit, brake ducts: swallows light. */
    matte: new THREE.MeshStandardMaterial({ color: '#050607', metalness: 0.05, roughness: 0.96, transparent: true }),
    rubber: new THREE.MeshPhysicalMaterial({
      color: '#ffffff',
      map: tyreMap,
      metalness: 0.0,
      roughness: 0.72,
      sheen: 0.4,
      sheenRoughness: 0.9,
      sheenColor: new THREE.Color('#2a2c2e'),
      envMapIntensity: 0.8,
      transparent: true,
    }),
    cover: new THREE.MeshPhysicalMaterial({ color: '#1d2126', metalness: 0.9, roughness: 0.36, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 1.2, transparent: true }),
    aluminium: new THREE.MeshStandardMaterial({ color: '#9aa1a8', metalness: 1.0, roughness: 0.34, envMapIntensity: 0.9 }),
    titanium: new THREE.MeshStandardMaterial({ color: '#8a8f96', metalness: 1.0, roughness: 0.34, envMapIntensity: 1.3 }),
    /** Blued exhaust tip. */
    exhaust: new THREE.MeshStandardMaterial({ color: '#6c6a7a', metalness: 1.0, roughness: 0.28, envMapIntensity: 1.4 }),
    visor: new THREE.MeshPhysicalMaterial({ color: '#0a0c10', metalness: 0.6, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6 }),
    rainLight: new THREE.MeshStandardMaterial({ color: '#2a0507', emissive: '#ff2a2a', emissiveIntensity: 3.5, roughness: 0.5 }),
    /** Internals only visible in x-ray mode. */
    internals: new THREE.MeshStandardMaterial({ color: '#36404c', emissive: '#4798ff', emissiveIntensity: 0.5, metalness: 0.8, roughness: 0.45, transparent: true, opacity: 0, depthWrite: false }),
    internalsEdge: new THREE.LineBasicMaterial({ color: '#c9ff4b', transparent: true, opacity: 0, depthWrite: false }),
    wire: new THREE.MeshBasicMaterial({ color: '#c9ff4b', wireframe: true, transparent: true, opacity: 0, depthWrite: false }),
    /** Fresnel ghost for x-ray mode: rim-lit shell, additive. */
    ghost: new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#c9ff4b') }, uAmount: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAmount;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
          gl_FragColor = vec4(uColor * (0.04 + f * 0.85) * uAmount, f * 0.6 * uAmount);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
    /** Evidence particles flowing into the sidepod. */
    stream: new THREE.MeshBasicMaterial({ color: '#c9ff4b', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
}

/** Everything that fades for x-ray mode. */
export function skinMaterials(m: CarMaterials) {
  return [m.paint, m.pod, m.accent, m.dark, m.carbon, m.matte, m.rubber, m.cover] as THREE.Material[];
}
