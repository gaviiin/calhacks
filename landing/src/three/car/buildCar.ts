import * as THREE from 'three';
import { airfoilXY, bodyRing, densify, loft, plate, plateRing, podRing, ringXZ, triRing, tyreProfile, wheelCoverProfile, V, type BodyStation, type PodStation } from '../geometry';

// A fictional 2022-era ground-effect car, modelled in metres. Nose points +X,
// the visitor's side is +Z, the ground is y = 0. Wheelbase 3.6 m, 2.0 m wide,
// 720 mm tyres on 18" rims. Nothing is borrowed from a real team.

export const CAR = {
  frontAxle: 1.8,
  rearAxle: -1.8,
  tyreR: 0.36,
  rimR: 0.2286,
  frontTyre: { width: 0.305, z: 0.85 },
  rearTyre: { width: 0.405, z: 0.8 },
};

type WingStation = { z: number; x: number; y: number; chord: number; aoa: number };

function wing(stations: WingStation[], thick = 0.1, camber = 0.05) {
  return loft(
    stations.map(s => airfoilXY(s.z, s.x, s.y, s.chord, s.aoa, thick, camber)),
    { start: true, end: true }
  );
}

function span(z0: number, z1: number, n: number, f: (z: number) => Omit<WingStation, 'z'>): WingStation[] {
  return Array.from({ length: n }, (_, i) => {
    const z = z0 + ((z1 - z0) * i) / (n - 1);
    return { z, ...f(z) };
  });
}

const sq = (v: number) => v * v;

/** Endplate section that leans outward toward its top edge (2022 outwash geometry). */
function leaningPlate(x: number, z: number, yBot: number, yTop: number, t: number, lean: number) {
  const ring = plateRing(x, z, yBot, yTop, t);
  const h = Math.max(1e-3, yTop - yBot);
  for (const p of ring) p.z += (lean * (p.y - yBot)) / h;
  return ring;
}

/** Where the monocoque ends and the removable rear bodywork begins (the rear bulkhead). */
export const SEAM_X = -0.35;

/** Control stations of the central body, nose → tail. Exported so internals can be fitted inside the shell. */
export const BODY_STATIONS: BodyStation[] = [
    { x: 2.76, top: 0.305, bot: 0.25, hwTop: 0.028, hwBot: 0.028, rt: 0.026, rb: 0.026 },
    { x: 2.55, top: 0.33, bot: 0.235, hwTop: 0.058, hwBot: 0.054, rt: 0.045, rb: 0.045 },
    { x: 2.25, top: 0.365, bot: 0.22, hwTop: 0.095, hwBot: 0.085, rt: 0.06, rb: 0.07 },
    { x: 1.9, top: 0.405, bot: 0.2, hwTop: 0.13, hwBot: 0.11, rt: 0.07, rb: 0.09 },
    { x: 1.55, top: 0.47, bot: 0.16, hwTop: 0.19, hwBot: 0.15, rt: 0.08, rb: 0.1 },
    { x: 1.25, top: 0.545, bot: 0.13, hwTop: 0.265, hwBot: 0.21, rt: 0.09, rb: 0.1 },
    { x: 0.95, top: 0.615, bot: 0.11, hwTop: 0.3, hwBot: 0.24, rt: 0.1, rb: 0.1 },
    { x: 0.6, top: 0.665, bot: 0.1, hwTop: 0.32, hwBot: 0.27, rt: 0.11, rb: 0.1 },
    { x: 0.2, top: 0.675, bot: 0.1, hwTop: 0.33, hwBot: 0.28, rt: 0.12, rb: 0.1 },
    { x: -0.2, top: 0.67, bot: 0.1, hwTop: 0.32, hwBot: 0.28, rt: 0.12, rb: 0.1 },
    { x: SEAM_X, top: 0.651, bot: 0.1, hwTop: 0.309, hwBot: 0.276, rt: 0.128, rb: 0.1 },
    { x: -0.6, top: 0.62, bot: 0.1, hwTop: 0.29, hwBot: 0.27, rt: 0.14, rb: 0.1 },
    { x: -1.0, top: 0.58, bot: 0.1, hwTop: 0.24, hwBot: 0.24, rt: 0.15, rb: 0.1 },
    { x: -1.4, top: 0.53, bot: 0.1, hwTop: 0.18, hwBot: 0.2, rt: 0.13, rb: 0.1 },
    { x: -1.8, top: 0.48, bot: 0.11, hwTop: 0.12, hwBot: 0.16, rt: 0.1, rb: 0.1 },
    { x: -2.2, top: 0.44, bot: 0.17, hwTop: 0.08, hwBot: 0.1, rt: 0.07, rb: 0.08 },
    { x: -2.5, top: 0.42, bot: 0.25, hwTop: 0.058, hwBot: 0.058, rt: 0.05, rb: 0.05 },
    { x: -2.66, top: 0.405, bot: 0.3, hwTop: 0.04, hwBot: 0.04, rt: 0.035, rb: 0.035 },
];

/** Airbox + engine cover stations: rounded-triangle intake above the driver, tapering spine to the tail. */
export const AIRBOX_STATIONS = [
    { x: -0.05, apex: 0.98, base: 0.7, hw: 0.15, r: 0.045 },
    { x: -0.35, apex: 0.96, base: 0.66, hw: 0.19, r: 0.06 },
    { x: -0.8, apex: 0.83, base: 0.58, hw: 0.21, r: 0.08 },
    { x: -1.3, apex: 0.69, base: 0.48, hw: 0.16, r: 0.07 },
    { x: -1.8, apex: 0.57, base: 0.4, hw: 0.1, r: 0.055 },
    { x: -2.3, apex: 0.48, base: 0.37, hw: 0.055, r: 0.035 },
    { x: -2.62, apex: 0.43, base: 0.36, hw: 0.03, r: 0.025 },
];

export function buildCar() {
  // ---------------------------------------------------------------- central body
  // Nose → monocoque → rear crash structure. Box sections with fillets: flat decks,
  // vertical flanks, rounded lower edges, a round tapering nose. One spline, lofted
  // in two pieces: the monocoque (capped at the rear bulkhead) and the rear bodywork,
  // an open shell that lifts off with the engine cover.
  const bodyRings = densify(BODY_STATIONS, 4).map(s => ({ x: s.x, ring: bodyRing(s) }));
  const body = loft(bodyRings.filter(r => r.x >= SEAM_X - 1e-6).map(r => r.ring), { start: true, end: true });
  const bodyRear = loft(bodyRings.filter(r => r.x <= SEAM_X + 1e-6).map(r => r.ring), { start: false, end: true });

  const airbox = loft(densify(AIRBOX_STATIONS, 4).map(s => triRing(s.x, s.apex, s.base, s.hw, s.r)), { start: true, end: true });
  const intake = loft([triRing(-0.025, 0.945, 0.79, 0.125, 0.035), triRing(-0.3, 0.93, 0.78, 0.115, 0.035)], { start: true, end: true });

  // Sidepod (right-hand side; mirrored in the component): lipped inlet, undercut, downwash ramp, coke-bottle.
  const podStations: PodStation[] = [
    { x: 0.98, zIn: 0.25, zOut: 0.7, yTopIn: 0.53, yTopOut: 0.5, yBotOut: 0.37, yBotIn: 0.35, rTop: 0.05, rBot: 0.05, zOutBot: 0.62 },
    { x: 0.78, zIn: 0.25, zOut: 0.745, yTopIn: 0.565, yTopOut: 0.525, yBotOut: 0.31, yBotIn: 0.3, rTop: 0.08, rBot: 0.07, zOutBot: 0.66 },
    { x: 0.4, zIn: 0.25, zOut: 0.755, yTopIn: 0.57, yTopOut: 0.5, yBotOut: 0.22, yBotIn: 0.2, rTop: 0.09, rBot: 0.08, zOutBot: 0.71 },
    { x: 0.0, zIn: 0.25, zOut: 0.74, yTopIn: 0.555, yTopOut: 0.45, yBotOut: 0.135, yBotIn: 0.12, rTop: 0.1, rBot: 0.06, zOutBot: 0.72 },
    { x: -0.5, zIn: 0.24, zOut: 0.7, yTopIn: 0.5, yTopOut: 0.36, yBotOut: 0.11, yBotIn: 0.11, rTop: 0.1, rBot: 0.04, zOutBot: 0.69 },
    { x: -1.0, zIn: 0.22, zOut: 0.62, yTopIn: 0.43, yTopOut: 0.27, yBotOut: 0.11, yBotIn: 0.11, rTop: 0.09, rBot: 0.03, zOutBot: 0.62 },
    { x: -1.5, zIn: 0.17, zOut: 0.52, yTopIn: 0.33, yTopOut: 0.18, yBotOut: 0.11, yBotIn: 0.11, rTop: 0.06, rBot: 0.02, zOutBot: 0.52 },
    { x: -1.95, zIn: 0.13, zOut: 0.42, yTopIn: 0.23, yTopOut: 0.135, yBotOut: 0.11, yBotIn: 0.11, rTop: 0.03, rBot: 0.015, zOutBot: 0.42 },
    { x: -2.25, zIn: 0.08, zOut: 0.3, yTopIn: 0.16, yTopOut: 0.118, yBotOut: 0.11, yBotIn: 0.11, rTop: 0.015, rBot: 0.01, zOutBot: 0.3 },
  ];
  const sidepod = loft(densify(podStations, 4).map(s => podRing(s)), { start: true, end: true });
  // Inlet: matte recess sitting 5 mm proud of the painted front cap.
  const inlet = loft([podRing({ x: 0.985, zIn: 0.31, zOut: 0.665, yTopIn: 0.505, yTopOut: 0.48, yBotOut: 0.385, yBotIn: 0.375, rTop: 0.04, rBot: 0.04, zOutBot: 0.61 }), podRing({ x: 0.75, zIn: 0.32, zOut: 0.64, yTopIn: 0.5, yTopOut: 0.47, yBotOut: 0.39, yBotIn: 0.38, rTop: 0.04, rBot: 0.04, zOutBot: 0.6 })], { start: true, end: true });

  // ---------------------------------------------------------------- floor + diffuser
  const floorPlan: [number, number][] = [
    [1.32, 0.24], [1.18, 0.5], [0.98, 0.72], [0.55, 0.8], [-0.6, 0.8], [-1.3, 0.78], [-1.72, 0.7], [-2.05, 0.56], [-2.4, 0.5],
    [-2.4, -0.5], [-2.05, -0.56], [-1.72, -0.7], [-1.3, -0.78], [-0.6, -0.8], [0.55, -0.8], [0.98, -0.72], [1.18, -0.5], [1.32, -0.24],
  ];
  const floor = plate(floorPlan, 0.022, 0.002);
  const diffuserStations = [
    { x: -1.55, bot: 0.088, top: 0.108, hw: 0.5 },
    { x: -1.9, bot: 0.12, top: 0.142, hw: 0.54 },
    { x: -2.2, bot: 0.2, top: 0.222, hw: 0.57 },
    { x: -2.45, bot: 0.31, top: 0.332, hw: 0.58 },
    { x: -2.6, bot: 0.39, top: 0.41, hw: 0.56 },
  ];
  const diffuser = loft(densify(diffuserStations, 3).map(s => bodyRing({ x: s.x, top: s.top, bot: s.bot, hwTop: s.hw, hwBot: s.hw, rt: 0.008, rb: 0.008 })), { start: true, end: true });
  const diffuserWall = loft(
    densify(diffuserStations, 3).map(s => plateRing(s.x, s.hw - 0.006, s.bot, s.bot + 0.14 + 0.1 * Math.max(0, (-1.9 - s.x) / 0.7), 0.01)),
    { start: true, end: true }
  );
  const floorEdge = loft(
    [plateRing(0.95, 0.8, 0.11, 0.13, 0.008), plateRing(0.4, 0.81, 0.11, 0.165, 0.008), plateRing(-0.3, 0.81, 0.11, 0.16, 0.008), plateRing(-0.9, 0.79, 0.11, 0.13, 0.008)],
    { start: true, end: true }
  );

  // ---------------------------------------------------------------- front wing
  const sp = (z: number) => sq(Math.abs(z) / 0.95);
  const le1 = (z: number) => 2.89 - 0.05 * sp(z);
  const y1 = (z: number) => 0.085 + 0.045 * (1 - sp(z));
  const c1 = (z: number) => 0.42 + 0.08 * (1 - sp(z));
  const tip = (z: number) => 1 - 0.35 * sq(Math.max(0, (Math.abs(z) - 0.75) / 0.18));
  const fwMain = wing(span(-0.95, 0.95, 27, z => ({ x: le1(z), y: y1(z), chord: c1(z), aoa: 0.07 })), 0.075, 0.045);
  const fwFlap2 = wing(span(-0.93, 0.93, 25, z => ({ x: le1(z) - c1(z) * 0.78, y: y1(z) + 0.055, chord: 0.24 * tip(z), aoa: 0.26 })), 0.09, 0.05);
  const fwFlap3 = wing(span(0.22, 0.93, 11, z => ({ x: le1(z) - c1(z) * 0.78 - 0.17, y: y1(z) + 0.125, chord: 0.19 * tip(z), aoa: 0.42 })), 0.1, 0.05);
  const fwFlap4 = wing(span(0.26, 0.91, 10, z => ({ x: le1(z) - c1(z) * 0.78 - 0.31, y: y1(z) + 0.2, chord: 0.15 * tip(z), aoa: 0.6 })), 0.1, 0.05);
  const fwEndplate = loft(
    densify(
      [
        { x: 2.97, z: 0.955, yBot: 0.055, yTop: 0.1 },
        { x: 2.85, z: 0.96, yBot: 0.05, yTop: 0.17 },
        { x: 2.7, z: 0.965, yBot: 0.05, yTop: 0.26 },
        { x: 2.5, z: 0.975, yBot: 0.05, yTop: 0.305 },
        { x: 2.3, z: 0.99, yBot: 0.06, yTop: 0.3 },
        { x: 2.18, z: 1.005, yBot: 0.09, yTop: 0.26 },
      ],
      3
    ).map(s => leaningPlate(s.x, s.z, s.yBot, s.yTop, 0.012, 0.09)),
    { start: true, end: true }
  );
  // Rolled top edge of the endplate.
  const fwEndplateRoll = new THREE.TubeGeometry(
    new THREE.CatmullRomCurve3([V(2.93, 0.11, 0.962), V(2.85, 0.17, 0.968), V(2.7, 0.26, 0.985), V(2.5, 0.305, 1.0), V(2.3, 0.3, 1.015), V(2.18, 0.26, 1.03)]),
    24,
    0.014,
    10
  );

  // ---------------------------------------------------------------- rear wing
  const lift = (z: number) => 0.07 * sq(Math.max(0, (Math.abs(z) - 0.39) / 0.08));
  const rwMain = wing(span(-0.47, 0.47, 21, z => ({ x: -2.26 + 0.03 * (Math.abs(z) / 0.47) ** 4, y: 0.79 + lift(z), chord: 0.34 - 0.06 * sq(Math.abs(z) / 0.47), aoa: 0.1 })), 0.1, 0.06);
  const rwFlap = wing(span(-0.46, 0.46, 21, z => ({ x: -2.53, y: 0.865 + lift(z), chord: 0.25 - 0.03 * sq(Math.abs(z) / 0.46), aoa: 0.4 })), 0.1, 0.05);
  const rwEndplate = loft(
    densify(
      [
        { x: -2.12, z: 0.485, yBot: 0.46, yTop: 0.8 },
        { x: -2.3, z: 0.488, yBot: 0.41, yTop: 0.96 },
        { x: -2.55, z: 0.49, yBot: 0.4, yTop: 1.0 },
        { x: -2.75, z: 0.49, yBot: 0.43, yTop: 0.98 },
        { x: -2.86, z: 0.49, yBot: 0.5, yTop: 0.9 },
      ],
      3
    ).map(s => plateRing(s.x, s.z, s.yBot, s.yTop, 0.012)),
    { start: true, end: true }
  );
  const beam1 = wing(span(-0.42, 0.42, 7, () => ({ x: -2.32, y: 0.43, chord: 0.15, aoa: 0.28 })), 0.1, 0.05);
  const beam2 = wing(span(-0.4, 0.4, 7, () => ({ x: -2.46, y: 0.5, chord: 0.11, aoa: 0.5 })), 0.1, 0.05);
  const pylon = loft(
    densify(
      [
        { y: 0.4, cx: -2.02, hx: 0.19, hz: 0.022 },
        { y: 0.58, cx: -2.13, hx: 0.14, hz: 0.017 },
        { y: 0.76, cx: -2.26, hx: 0.09, hz: 0.014 },
        { y: 0.85, cx: -2.32, hx: 0.06, hz: 0.012 },
      ].map(s => ({ x: s.y, ...s })),
      3
    ).map(s => ringXZ(s.y, s.cx, 0, s.hx, s.hz, s.hz * 0.9)),
    { start: true, end: true }
  );

  // ---------------------------------------------------------------- cockpit + halo
  const haloPts = [V(-0.32, 0.72, 0.34), V(-0.18, 0.84, 0.37), V(0.05, 0.875, 0.36), V(0.3, 0.875, 0.32), V(0.52, 0.865, 0.22), V(0.66, 0.855, 0.08), V(0.68, 0.855, 0)];
  const haloCurve = new THREE.CatmullRomCurve3([...haloPts, ...haloPts.slice(0, -1).reverse().map(p => V(p.x, p.y, -p.z))], false, 'centripetal');
  const halo = new THREE.TubeGeometry(haloCurve, 96, 0.03, 14);
  const haloStrut = plate([[0.655, 0.868], [0.705, 0.868], [0.93, 0.6], [0.87, 0.59]], 0.03, 0.004);
  const rimPath = new THREE.CatmullRomCurve3([V(0.62, 0.68, 0), V(0.58, 0.68, 0.19), V(0.3, 0.68, 0.27), V(-0.1, 0.68, 0.27), V(-0.2, 0.68, 0.14), V(-0.2, 0.68, -0.14), V(-0.1, 0.68, -0.27), V(0.3, 0.68, -0.27), V(0.58, 0.68, -0.19)], true, 'centripetal');
  const cockpitRim = new THREE.TubeGeometry(rimPath, 64, 0.022, 10);
  const cockpitWell = plate([[0.6, 0.0], [0.56, 0.18], [0.3, 0.26], [-0.1, 0.26], [-0.18, 0.12], [-0.18, -0.12], [-0.1, -0.26], [0.3, -0.26], [0.56, -0.18]], 0.012, 0.004);

  // ---------------------------------------------------------------- wheels
  const tyreF = new THREE.LatheGeometry(tyreProfile(CAR.tyreR, CAR.frontTyre.width, CAR.rimR), 96);
  const tyreR = new THREE.LatheGeometry(tyreProfile(CAR.tyreR, CAR.rearTyre.width, CAR.rimR), 96);
  const coverF = new THREE.LatheGeometry(wheelCoverProfile(CAR.rimR, CAR.frontTyre.width), 64);
  const coverR = new THREE.LatheGeometry(wheelCoverProfile(CAR.rimR, CAR.rearTyre.width), 64);
  const duct = loft(
    [
      bodyRing({ x: 0.16, top: 0.5, bot: 0.3, hwTop: 0.02, hwBot: 0.02, rt: 0.018, rb: 0.018, cz: 0 }),
      bodyRing({ x: 0.02, top: 0.53, bot: 0.25, hwTop: 0.05, hwBot: 0.05, rt: 0.03, rb: 0.03, cz: 0 }),
      bodyRing({ x: -0.14, top: 0.52, bot: 0.24, hwTop: 0.05, hwBot: 0.05, rt: 0.03, rb: 0.03, cz: 0 }),
    ],
    { start: true, end: true }
  );

  // ---------------------------------------------------------------- small parts
  const mirrorHousing = loft(
    [
      bodyRing({ x: 0.84, top: 0.77, bot: 0.715, hwTop: 0.045, hwBot: 0.04, rt: 0.02, rb: 0.02, cz: 0.47 }),
      bodyRing({ x: 0.76, top: 0.785, bot: 0.705, hwTop: 0.065, hwBot: 0.06, rt: 0.03, rb: 0.03, cz: 0.47 }),
      bodyRing({ x: 0.7, top: 0.78, bot: 0.71, hwTop: 0.06, hwBot: 0.055, rt: 0.028, rb: 0.028, cz: 0.47 }),
    ],
    { start: true, end: true }
  );
  const noseFairing = loft(
    [bodyRing({ x: 2.62, top: 0.25, bot: 0.2, hwTop: 0.05, hwBot: 0.06, rt: 0.02, rb: 0.02 }), bodyRing({ x: 2.36, top: 0.24, bot: 0.19, hwTop: 0.07, hwBot: 0.08, rt: 0.025, rb: 0.025 })],
    { start: true, end: true }
  );

  return {
    body, bodyRear, airbox, intake, sidepod, inlet,
    floor, diffuser, diffuserWall, floorEdge,
    fwMain, fwFlap2, fwFlap3, fwFlap4, fwEndplate, fwEndplateRoll,
    rwMain, rwFlap, rwEndplate, beam1, beam2, pylon,
    halo, haloStrut, cockpitRim, cockpitWell,
    tyreF, tyreR, coverF, coverR, duct,
    mirrorHousing, noseFairing,
  };
}

export type CarGeometry = ReturnType<typeof buildCar>;
