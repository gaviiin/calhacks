// One mutable object links the two worlds: GSAP scrubs its numbers from scroll,
// and the R3F frame loop reads them. Nothing here re-renders React.

export type Livery = {
  name: string;
  /** Painted bodywork. */
  primary: string;
  /** Lower bodywork, nose tip: usually carbon-black. */
  secondary: string;
  /** Flaps, stripes, wheel nuts, HUD. */
  accent: string;
  metalness: number;
  roughness: number;
  /** Rim light behind the car and the floor glow, in sRGB hex. */
  rim: string;
  /** Key light tint. */
  key: string;
};

/** Team-inspired colourways. Palettes only: no marks, logos or sponsor identities. */
export const LIVERIES = {
  pitwall: { name: 'CARBON / LIME', primary: '#171a1f', secondary: '#0a0b0d', accent: '#c9ff4b', metalness: 0.55, roughness: 0.32, rim: '#c9ff4b', key: '#ffffff' },
  scarlet: { name: 'SCARLET / GIALLO', primary: '#c9141b', secondary: '#0c0c0e', accent: '#ffd21f', metalness: 0.12, roughness: 0.3, rim: '#ff5a3c', key: '#fff4ea' },
  silver: { name: 'SILVER / TEAL', primary: '#c9ced3', secondary: '#111317', accent: '#00d8c4', metalness: 0.95, roughness: 0.24, rim: '#19d3c0', key: '#eef6ff' },
  papaya: { name: 'PAPAYA / ANTHRACITE', primary: '#ff7a1a', secondary: '#101215', accent: '#20c2ff', metalness: 0.15, roughness: 0.3, rim: '#ff9a3c', key: '#fff4ea' },
  navy: { name: 'NAVY / CRIMSON', primary: '#0f1d55', secondary: '#090b12', accent: '#ff2e3c', metalness: 0.35, roughness: 0.36, rim: '#ff2e3c', key: '#e6ecff' },
  green: { name: 'RACING GREEN / LIME', primary: '#0b5c48', secondary: '#0a0d0f', accent: '#b8ff3b', metalness: 0.4, roughness: 0.3, rim: '#9dff5a', key: '#f2fff2' },
  alpine: { name: 'AZURE / ROSE', primary: '#1030b8', secondary: '#0a0c12', accent: '#ff6fb6', metalness: 0.3, roughness: 0.32, rim: '#ff6fb6', key: '#eaf0ff' },
} satisfies Record<string, Livery>;

export type LiveryKey = keyof typeof LIVERIES;
export const LIVERY_KEYS = Object.keys(LIVERIES) as LiveryKey[];

/** Palette per scene, in scroll order; `sceneState.liveryT` indexes into it. Kept free of three so the first-paint chunk stays small. */
export const liverySequence: LiveryKey[] = ['pitwall'];
export function setLiverySequence(keys: LiveryKey[]) {
  liverySequence.splice(0, liverySequence.length, ...keys);
}

export type Station = {
  cam: [number, number, number];
  look: [number, number, number];
  fov?: number;
  /** Where the focus point sits in the frame, -1..1 (positive = right / up). */
  screenX: number;
  screenY: number;
  explodeFront?: number;
  explodeMid?: number;
  explodeRear?: number;
  /** Halo and engine cover lift to open the cockpit. */
  explodeTop?: number;
  /** Fresnel ghost + wireframe + internals. */
  xray?: number;
  /** Evidence streams into the sidepod. */
  streams?: number;
  /** Reasoning graph around the cockpit. */
  graph?: number;
  /** Audit trail + flow lines at the rear. */
  audit?: number;
  /** Floor pit-box markings and rim light intensity. */
  rim?: number;
  fade?: number;
  idle?: number;
  /** Overrides for narrow portrait viewports. */
  mobile?: Partial<Pick<Station, 'cam' | 'look' | 'fov'>>;
};

export const sceneState = {
  camX: 0.4, camY: 0.95, camZ: 7.2,
  lookX: 0.1, lookY: 0.45, lookZ: 0,
  fov: 26,
  screenX: 0.14, screenY: -0.12,
  explodeFront: 0, explodeMid: 0, explodeRear: 0, explodeTop: 0,
  xray: 0, streams: 0, graph: 0, audit: 0, rim: 1, fade: 0, idle: 1,
  /** Livery timeline index: floor = palette leaving, ceil = palette arriving, fraction = wipe. */
  liveryT: 0,
  /** Hero light sweep, 0 → 1 once on load. */
  sweep: 0,
  /** Active scene index; drives callout visibility without touching React. */
  section: 0,
};

export type SceneState = typeof sceneState;

if (import.meta.env.DEV) (window as unknown as { __pw: SceneState }).__pw = sceneState;

/** Flattens a station into tween targets for GSAP (livery is sequenced separately). */
export function stationValues(station: Station, mobile = false): Partial<SceneState> {
  const cam = (mobile && station.mobile?.cam) || station.cam;
  const look = (mobile && station.mobile?.look) || station.look;
  return {
    camX: cam[0], camY: cam[1], camZ: cam[2],
    lookX: look[0], lookY: look[1], lookZ: look[2],
    fov: (mobile && station.mobile?.fov) || station.fov || 26,
    screenX: station.screenX, screenY: station.screenY,
    explodeFront: station.explodeFront ?? 0,
    explodeMid: station.explodeMid ?? 0,
    explodeRear: station.explodeRear ?? 0,
    explodeTop: station.explodeTop ?? 0,
    xray: station.xray ?? 0,
    streams: station.streams ?? 0,
    graph: station.graph ?? 0,
    audit: station.audit ?? 0,
    rim: station.rim ?? 1,
    fade: station.fade ?? 0,
    idle: station.idle ?? 0,
  };
}
