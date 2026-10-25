import {
  aerofoil,
  atX,
  box,
  every,
  lathe,
  lerp,
  loft,
  merge,
  mirrorShape,
  nearestRows,
  pchip,
  polyline,
  rod,
  rotateShape,
  roundedPoly,
  roundedPolyMeta,
  shape,
  smooth,
  spline,
  stations,
  strut,
  sweep,
  wingRing,
  type Corner,
  type Grid,
  type P2,
  type PartShape,
  type Ring,
  type Vec,
} from './kit';

// A reference car to the 2026 technical regulations: 3,400 mm wheelbase, 1,900 mm wide, 18-inch wheels,
// a two-flap front wing and a two-element rear wing with no beam wing. It is a generic car drawn for
// the desk, not any team's design. Metres; nose toward +x, y up, +z is the driver's right.

export const DIM = {
  wheelbase: 3.4,
  frontAxle: 1.7,
  rearAxle: -1.7,
  front: { r: 0.3525, w: 0.28, z: 0.81 },
  rear: { r: 0.355, w: 0.375, z: 0.7625 },
  rim: 0.2286,
  width: 1.9,
  height: 0.956,
  noseTip: 2.89,
  tail: -2.63,
};

const sq = (t: number) => t * t;

// ------------------------------------------------------------------------------------------ chassis

const COCKPIT_FRONT = 0.8;
const COCKPIT_REAR = -0.13;

const CH = {
  yT: pchip([
    [1.45, 0.555],
    [1.25, 0.592],
    [1.05, 0.628],
    [0.85, 0.66],
    [0.6, 0.676],
    [0.3, 0.681],
    [0.0, 0.684],
    [-0.4, 0.688],
  ]),
  yB: pchip([
    [1.45, 0.285],
    [1.25, 0.222],
    [1.05, 0.16],
    [0.85, 0.116],
    [0.6, 0.094],
    [0.3, 0.086],
    [-0.4, 0.085],
  ]),
  hwT: pchip([
    [1.45, 0.15],
    [1.25, 0.186],
    [1.05, 0.228],
    [0.85, 0.275],
    [0.6, 0.318],
    [0.3, 0.338],
    [0.0, 0.342],
    [-0.2, 0.33],
    [-0.4, 0.298],
  ]),
  hwB: pchip([
    [1.45, 0.118],
    [1.25, 0.146],
    [1.05, 0.18],
    [0.85, 0.218],
    [0.6, 0.252],
    [0.3, 0.27],
    [-0.1, 0.27],
    [-0.4, 0.258],
  ]),
  rT: pchip([
    [1.45, 0.06],
    [1.05, 0.08],
    [0.6, 0.1],
    [0.0, 0.11],
    [-0.4, 0.11],
  ]),
  rB: pchip([
    [1.45, 0.05],
    [1.05, 0.058],
    [0.6, 0.06],
    [-0.4, 0.06],
  ]),
};

/** The cockpit opening at station x: half-width and depth of the notch cut into the top of the tub. */
function opening(x: number): { w: number; d: number } {
  if (x > COCKPIT_FRONT + 1e-9 || x < COCKPIT_REAR - 1e-9) return { w: 0, d: 0 };
  const wMid = 0.245;
  let w: number;
  if (x >= 0.6) w = lerp(wMid, 0.172, smooth((x - 0.6) / (COCKPIT_FRONT - 0.6)));
  else if (x >= 0.05) w = wMid;
  else w = wMid * Math.sqrt(Math.max(0, 1 - sq((0.05 - x) / (0.05 - COCKPIT_REAR))));
  return { w, d: CH.yT(x) - 0.2 };
}

function chassis(): PartShape {
  const xs = stations(1.45, -0.4, 0.035, [COCKPIT_FRONT + 0.008, COCKPIT_FRONT, COCKPIT_REAR + 0.01, COCKPIT_REAR, COCKPIT_REAR - 0.008]);
  const ARC = 4;
  const SEG = [3, 2, 3, 4, 3, 2, 3, 4, 3, 4];
  const ringAt = (x: number) => {
    const o = opening(x);
    const yT = CH.yT(x);
    const yB = CH.yB(x);
    const hwT = CH.hwT(x);
    const hwB = CH.hwB(x);
    // the side runs straight down from the shoulder to a waist, then tucks under toward the keel
    const yW = yB + 0.42 * (yT - yB);
    const hwW = hwT - 0.01;
    const keel = Math.min(hwB, hwW * 0.8);
    // the tub's inner walls lean in toward the seat
    const wFloor = o.w * 0.82;
    const corners: Corner[] = [
      { a: o.w, b: yT, r: 0.012 },
      { a: hwT, b: yT, r: CH.rT(x) },
      { a: hwW, b: yW, r: 0.09 },
      { a: keel, b: yB, r: CH.rB(x) },
      { a: -keel, b: yB, r: CH.rB(x) },
      { a: -hwW, b: yW, r: 0.09 },
      { a: -hwT, b: yT, r: CH.rT(x) },
      { a: -o.w, b: yT, r: 0.012 },
      { a: -wFloor, b: yT - o.d, r: 0.045 },
      { a: wFloor, b: yT - o.d, r: 0.045 },
    ];
    return roundedPolyMeta(corners, ARC, SEG);
  };
  const meta = ringAt(0.3);
  const rings = xs.map((x) => atX(x, ringAt(x).pts));
  // construction lines: every other point on the outside, the corners' middles inside the tub
  const inside = new Set<number>();
  for (let i = meta.corner[7]; i < meta.pts.length; i++) inside.add(i);
  const cols = every(meta.pts.length, 2, false).filter((c) => !inside.has(c));
  for (const k of [7, 8, 9]) cols.push(meta.corner[k] + 2);
  const tub = loft(rings, {
    capStart: true,
    capEnd: true,
    isoRows: nearestRows(xs, 0.1, [COCKPIT_FRONT, COCKPIT_REAR]),
    isoCols: cols,
  });

  // fuel cell behind the seat, and the side impact tubes that run out into each sidepod
  const cell = box([-0.27, 0.39, 0], 0.24, 0.5, 0.46, 0.04);
  const sis: Grid[] = [];
  for (const s of [1, -1]) {
    sis.push(rod([0.56, 0.53, 0.33 * s], [0.56, 0.53, 0.6 * s], 0.032, 14, 4));
    sis.push(rod([0.36, 0.2, 0.28 * s], [0.36, 0.2, 0.58 * s], 0.032, 14, 4));
  }
  // headrest pads around the back of the opening
  const pad: Vec[] = spline(
    [
      [0.32, 0.69, 0.262],
      [0.1, 0.692, 0.262],
      [-0.02, 0.692, 0.215],
      [-0.1, 0.692, 0.11],
      [-0.125, 0.692, 0.0],
      [-0.1, 0.692, -0.11],
      [-0.02, 0.692, -0.215],
      [0.1, 0.692, -0.262],
      [0.32, 0.69, -0.262],
    ],
    40,
  );
  const headrest = sweep(
    pad,
    () =>
      roundedPoly(
        [
          { a: 0.0, b: -0.03, r: 0.02 },
          { a: 0.05, b: -0.03, r: 0.02 },
          { a: 0.05, b: 0.035, r: 0.02 },
          { a: 0.0, b: 0.035, r: 0.02 },
        ],
        3,
        1,
      ),
    [0, 1, 0],
    {
      capStart: true,
      capEnd: true,
      isoRows: every(40, 5),
      isoCols: [],
    },
  );
  return { grids: [tub, cell, headrest, ...sis], lines: [] };
}

// ------------------------------------------------------------------------------------------ nose

const NOSE = {
  yT: pchip([
    [2.765, 0.19],
    [2.75, 0.206],
    [2.7, 0.219],
    [2.62, 0.236],
    [2.4, 0.292],
    [2.1, 0.372],
    [1.8, 0.46],
    [1.6, 0.518],
    [1.45, 0.555],
  ]),
  yB: pchip([
    [2.765, 0.158],
    [2.75, 0.148],
    [2.7, 0.141],
    [2.62, 0.138],
    [2.4, 0.149],
    [2.1, 0.184],
    [1.8, 0.232],
    [1.6, 0.264],
    [1.45, 0.285],
  ]),
  hwT: pchip([
    [2.765, 0.006],
    [2.75, 0.02],
    [2.7, 0.036],
    [2.62, 0.05],
    [2.4, 0.071],
    [2.1, 0.094],
    [1.8, 0.119],
    [1.6, 0.136],
    [1.45, 0.15],
  ]),
  hwB: pchip([
    [2.765, 0.006],
    [2.75, 0.018],
    [2.7, 0.032],
    [2.62, 0.045],
    [2.4, 0.064],
    [2.1, 0.083],
    [1.8, 0.1],
    [1.6, 0.11],
    [1.45, 0.118],
  ]),
};

function nose(): PartShape {
  const xs = stations(2.765, 1.45, 0.03, [2.75]);
  const rings = xs.map((x) => {
    const hwT = NOSE.hwT(x);
    const hwB = NOSE.hwB(x);
    const yT = NOSE.yT(x);
    const yB = NOSE.yB(x);
    const h = yT - yB;
    const pts = roundedPoly(
      [
        { a: 0, b: yT, r: 0 },
        { a: hwT, b: yT, r: Math.min(0.06, hwT * 0.9, h * 0.45) },
        { a: hwB, b: yB, r: Math.min(0.05, hwB * 0.9, h * 0.45) },
        { a: -hwB, b: yB, r: Math.min(0.05, hwB * 0.9, h * 0.45) },
        { a: -hwT, b: yT, r: Math.min(0.06, hwT * 0.9, h * 0.45) },
      ],
      4,
      [2, 3, 3, 3, 2],
    );
    return atX(x, pts);
  });
  const g = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.1, [2.75]), isoCols: every(rings[0].length, 2, false) });
  return shape(g);
}

// ------------------------------------------------------------------------------------------ halo

function halo(): PartShape {
  const half: Vec[] = [
    [-0.1, 0.7, 0.262],
    [-0.078, 0.772, 0.272],
    [-0.02, 0.838, 0.276],
    [0.08, 0.876, 0.272],
    [0.25, 0.892, 0.252],
    [0.42, 0.896, 0.205],
    [0.55, 0.896, 0.135],
    [0.632, 0.896, 0.062],
    [0.66, 0.896, 0.0],
  ];
  const full: Vec[] = [
    ...half,
    ...half
      .slice(0, -1)
      .reverse()
      .map(([x, y, z]) => [x, y, -z] as Vec),
  ];
  const path = spline(full, 97);
  const hoop = sweep(
    path,
    () =>
      roundedPoly(
        [
          { a: -0.017, b: -0.026, r: 0.012 },
          { a: 0.017, b: -0.026, r: 0.012 },
          { a: 0.017, b: 0.026, r: 0.012 },
          { a: -0.017, b: 0.026, r: 0.012 },
        ],
        3,
        1,
      ),
    [0, 1, 0],
    {
      capStart: true,
      capEnd: true,
      isoRows: every(97, 6),
      isoCols: [2, 10],
    },
  );
  const pillarPath = spline(
    [
      [0.655, 0.885, 0],
      [0.74, 0.815, 0],
      [0.82, 0.73, 0],
      [0.875, 0.664, 0],
    ],
    14,
  );
  const pillar = sweep(
    pillarPath,
    (t) =>
      roundedPoly(
        [
          { a: -0.026 + 0.004 * t, b: -0.016, r: 0.012 },
          { a: 0.026 - 0.004 * t, b: -0.016, r: 0.012 },
          { a: 0.026 - 0.004 * t, b: 0.016, r: 0.012 },
          { a: -0.026 + 0.004 * t, b: 0.016, r: 0.012 },
        ],
        3,
        1,
      ),
    [0, 0, 1],
    {
      capStart: true,
      capEnd: true,
      isoRows: [0, 13],
      isoCols: [2, 10],
    },
  );
  const mounts = [1, -1].map((s) => box([-0.1, 0.692, 0.262 * s], 0.07, 0.03, 0.06, 0.006));
  return shape(hoop, pillar, ...mounts);
}

// ------------------------------------------------------------------------------------------ front wing

const FW = {
  span: 0.905,
  xLE: (z: number) => 2.835 - 0.045 * sq(Math.abs(z) / 0.905),
  yLE: (z: number) => 0.112 - 0.03 * smooth((Math.abs(z) - 0.22) / 0.38) + 0.022 * smooth((Math.abs(z) - 0.78) / 0.12),
  chord: (z: number) => 0.3 + 0.06 * smooth((Math.abs(z) - 0.18) / 0.35) - 0.03 * smooth((Math.abs(z) - 0.75) / 0.15),
  aoa: (z: number) => 0.05 + 0.08 * smooth((Math.abs(z) - 0.2) / 0.4),
};

const te = (x: number, y: number, chord: number, aoa: number): [number, number] => [x - chord * Math.cos(aoa), y + chord * Math.sin(aoa)];

function frontWingFlaps(): PartShape {
  const foil = aerofoil(32, 0.1, 0.07);
  const zs = stations(0.135, 0.885, 0.035);
  const f1: Ring[] = [];
  const f2: Ring[] = [];
  for (const z of zs) {
    const [xt, yt] = te(FW.xLE(z), FW.yLE(z), FW.chord(z), FW.aoa(z));
    const tip = smooth((z - 0.78) / 0.1);
    const x1 = xt + 0.026;
    const y1 = yt + 0.013 + 0.032 * tip;
    const c1 = 0.168 - 0.02 * smooth((z - 0.6) / 0.3);
    const a1 = 0.3 + 0.12 * smooth((z - 0.2) / 0.5) + 0.08 * tip;
    f1.push(wingRing(foil, x1, y1, z, c1, a1));
    const [xt1, yt1] = te(x1, y1, c1, a1);
    const c2 = 0.132 - 0.015 * smooth((z - 0.6) / 0.3);
    const a2 = 0.6 + 0.14 * smooth((z - 0.2) / 0.5) + 0.1 * tip;
    f2.push(wingRing(foil, xt1 + 0.022, yt1 + 0.011, z, c2, a2));
  }
  const rows = nearestRows(zs, 0.1);
  const cols = [0, 8, 16, 24];
  return shape(loft(f1, { capStart: true, capEnd: true, isoRows: rows, isoCols: cols }), loft(f2, { capStart: true, capEnd: true, isoRows: rows, isoCols: cols }));
}

function frontEndplate(): PartShape {
  const xs = stations(2.89, 2.3, 0.02);
  const yb = pchip([
    [2.89, 0.052],
    [2.87, 0.036],
    [2.8, 0.03],
    [2.3, 0.03],
  ]);
  const yt = pchip([
    [2.89, 0.07],
    [2.86, 0.118],
    [2.8, 0.152],
    [2.65, 0.192],
    [2.5, 0.236],
    [2.38, 0.264],
    [2.3, 0.272],
  ]);
  const t = 0.01;
  const rings = xs.map((x) => {
    const top = yt(x);
    const bot = yb(x);
    return atX(
      x,
      roundedPoly(
        [
          { a: 0.893, b: top, r: t * 0.45 },
          { a: 0.893 + t, b: top, r: t * 0.45 },
          { a: 0.905 + t, b: bot, r: t * 0.45 },
          { a: 0.905, b: bot, r: t * 0.45 },
        ],
        2,
        [1, 3, 1, 3],
      ),
    );
  });
  const plate = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.1), isoCols: [] });
  // footplate: the strip along the bottom edge that turns inboard
  const fx = stations(2.86, 2.32, 0.03);
  const foot = loft(
    fx.map((x) =>
      atX(
        x,
        roundedPoly(
          [
            { a: 0.8, b: 0.042, r: 0.004 },
            { a: 0.905, b: 0.042, r: 0.004 },
            { a: 0.905, b: 0.03, r: 0.004 },
            { a: 0.8, b: 0.03, r: 0.004 },
          ],
          2,
          [3, 1, 3, 1],
        ),
      ),
    ),
    { capStart: true, capEnd: true, isoRows: [0, fx.length - 1], isoCols: [] },
  );
  return shape(plate, foot);
}

function frontWing(): PartShape {
  const foil = aerofoil(40, 0.085, 0.055);
  const zs = stations(-FW.span, FW.span, 0.045);
  const main = loft(
    zs.map((z) => wingRing(foil, FW.xLE(z), FW.yLE(z), z, FW.chord(z), FW.aoa(z))),
    { capStart: true, capEnd: true, isoRows: nearestRows(zs, 0.1), isoCols: [0, 10, 20, 30] },
  );
  const flaps = frontWingFlaps();
  const end = frontEndplate();
  return merge(shape(main), flaps, mirrorShape(flaps), end, mirrorShape(end));
}

// ------------------------------------------------------------------------------------------ suspension

const WISH = { w: 0.048, h: 0.015 };

function frontSuspension(): PartShape {
  const ubj: Vec = [1.722, 0.552, 0.668];
  const lbj: Vec = [1.692, 0.17, 0.706];
  const fore: Vec = [1, 0, 0];
  const grids = [
    strut([1.985, 0.474, 0.162], ubj, WISH.w, WISH.h, fore),
    strut([1.425, 0.466, 0.205], ubj, WISH.w, WISH.h, fore),
    strut([2.025, 0.258, 0.132], lbj, WISH.w, WISH.h, fore),
    strut([1.375, 0.262, 0.176], lbj, WISH.w, WISH.h, fore),
    rod([1.7, 0.205, 0.66], [1.585, 0.528, 0.158], 0.013),
    strut([1.805, 0.308, 0.158], [1.83, 0.3, 0.684], 0.04, 0.014, fore),
    box([1.705, 0.362, 0.735], 0.1, 0.4, 0.05, 0.012),
    rod([1.7, 0.3525, 0.7], [1.7, 0.3525, 0.8], 0.045, 16, 2),
  ];
  // rocker and spring-damper inside the nose top, where the pushrod ends
  grids.push(box([1.6, 0.54, 0.11], 0.08, 0.035, 0.09, 0.008));
  return shape(...grids);
}

function rearSuspension(): PartShape {
  const ubj: Vec = [-1.7, 0.555, 0.615];
  const lbj: Vec = [-1.68, 0.16, 0.65];
  const fore: Vec = [1, 0, 0];
  const grids = [
    strut([-1.44, 0.47, 0.15], ubj, WISH.w, WISH.h, fore),
    strut([-1.98, 0.455, 0.13], ubj, WISH.w, WISH.h, fore),
    strut([-1.38, 0.19, 0.15], lbj, WISH.w, WISH.h, fore),
    strut([-2.02, 0.2, 0.12], lbj, WISH.w, WISH.h, fore),
    rod([-1.71, 0.53, 0.6], [-1.83, 0.2, 0.13], 0.013),
    strut([-1.92, 0.33, 0.13], [-1.9, 0.32, 0.64], 0.04, 0.014, fore),
    box([-1.7, 0.36, 0.672], 0.12, 0.42, 0.06, 0.012),
    // driveshaft with its joints
    rod([-1.7, 0.355, 0.16], [-1.7, 0.355, 0.62], 0.024, 14, 4),
    lathe(
      [
        [0.0, -0.04],
        [0.038, -0.03],
        [0.05, 0.0],
        [0.038, 0.03],
        [0.0, 0.04],
      ],
      20,
      [-1.7, 0.355, 0.2],
      'z',
      { isoRows: [2], isoCols: every(20, 5, false) },
    ),
    lathe(
      [
        [0.0, -0.04],
        [0.038, -0.03],
        [0.05, 0.0],
        [0.038, 0.03],
        [0.0, 0.04],
      ],
      20,
      [-1.7, 0.355, 0.585],
      'z',
      { isoRows: [2], isoCols: every(20, 5, false) },
    ),
  ];
  return shape(...grids);
}

// ------------------------------------------------------------------------------------------ wheels and brakes

function wheel(front: boolean): PartShape {
  const W = front ? DIM.front : DIM.rear;
  const x = front ? DIM.frontAxle : DIM.rearAxle;
  const a = W.w / 2;
  const R = W.r;
  const rim = DIM.rim;
  const c: Vec = [x, R, W.z];
  const tyre: P2[] = [
    [rim + 0.006, -a + 0.016],
    [rim + 0.022, -a + 0.004],
    [rim + 0.06, -a],
    [R - 0.085, -a + 0.002],
    [R - 0.045, -a + 0.01],
    [R - 0.02, -a + 0.026],
    [R - 0.006, -a + 0.05],
    [R, -a + 0.08],
    [R + 0.002, -a / 3],
    [R + 0.003, 0],
    [R + 0.002, a / 3],
    [R, a - 0.08],
    [R - 0.006, a - 0.05],
    [R - 0.02, a - 0.026],
    [R - 0.045, a - 0.01],
    [R - 0.085, a - 0.002],
    [rim + 0.06, a],
    [rim + 0.022, a - 0.004],
    [rim + 0.006, a - 0.016],
  ];
  const tyreG = lathe(tyre, 72, c, 'z', { closed: true, isoRows: [0, 3, 5, 7, 9, 11, 13, 15, 18], isoCols: every(72, 4, false) });
  const rimP: P2[] = [
    [rim + 0.012, -a + 0.006],
    [rim + 0.002, -a + 0.014],
    [rim - 0.012, -a + 0.03],
    [rim - 0.02, -a + 0.06],
    [rim - 0.02, a - 0.06],
    [rim - 0.012, a - 0.03],
    [rim + 0.002, a - 0.014],
    [rim + 0.012, a - 0.006],
  ];
  const rimG = lathe(rimP, 60, c, 'z', { isoRows: [0, 3, 4, 7], isoCols: every(60, 6, false) });
  const cover = lathe(
    [
      [0.0, a - 0.003],
      [0.045, a - 0.003],
      [0.056, a - 0.011],
      [0.205, a - 0.02],
      [rim + 0.004, a - 0.01],
    ],
    60,
    c,
    'z',
    { isoRows: [1, 2, 3, 4], isoCols: every(60, 10, false) },
  );
  const nut = lathe(
    [
      [0.0, a + 0.02],
      [0.03, a + 0.02],
      [0.03, a - 0.004],
    ],
    6,
    c,
    'z',
    { isoRows: [1, 2], isoCols: every(6, 1, false) },
  );
  return shape(tyreG, rimG, cover, nut);
}

function brake(front: boolean): PartShape {
  const x = front ? DIM.frontAxle : DIM.rearAxle;
  const y = front ? DIM.front.r : DIM.rear.r;
  const zDisc = front ? 0.712 : 0.668;
  const ro = front ? 0.139 : 0.134;
  const ri = 0.086;
  const disc = lathe(
    [
      [ri, -0.016],
      [ro, -0.016],
      [ro, 0.016],
      [ri, 0.016],
      [ri, -0.016],
    ],
    48,
    [x, y, zDisc],
    'z',
    { isoRows: [0, 1, 2, 3], isoCols: every(48, 4, false) },
  );
  const caliper = rotateShape(shape(box([x - 0.112, y + 0.056, zDisc], 0.08, 0.15, 0.078, 0.014)), [x, y, zDisc], [0, 0, 1], -0.55);
  const zDuct = front ? 0.615 : 0.548;
  const drum = lathe(
    [
      [0.172, -0.045],
      [0.182, -0.015],
      [0.182, 0.02],
      [0.176, 0.045],
    ],
    40,
    [x, y, zDuct],
    'z',
    { isoRows: [0, 3], isoCols: every(40, 5, false) },
  );
  const scoop = box([x + 0.17, y + 0.07, zDuct], 0.12, 0.11, 0.075, 0.02);
  // vane lines between the disc faces
  const lines: number[] = [];
  for (let k = 0; k < 36; k++) {
    const ang = (k / 36) * Math.PI * 2;
    lines.push(
      x + Math.cos(ang) * (ri + 0.006),
      y + Math.sin(ang) * (ri + 0.006),
      zDisc + 0.0165,
      x + Math.cos(ang + 0.12) * (ro - 0.006),
      y + Math.sin(ang + 0.12) * (ro - 0.006),
      zDisc + 0.0165,
    );
  }
  return merge({ grids: [disc, drum, scoop], lines }, caliper);
}

function wss(front: boolean): PartShape {
  const x = front ? DIM.frontAxle : DIM.rearAxle;
  const z = front ? 0.735 : 0.69;
  return shape(box([x + 0.06, 0.262, z], 0.035, 0.035, 0.035, 0), rod([x + 0.06, 0.244, z], [x + 0.06, 0.226, z], 0.008, 8, 1));
}

// ------------------------------------------------------------------------------------------ steering

function steering(): PartShape {
  const grids: Grid[] = [
    rod([1.82, 0.33, -0.16], [1.82, 0.33, 0.16], 0.022, 14, 6),
    box([1.82, 0.33, 0], 0.08, 0.07, 0.15, 0.012),
    rod([1.79, 0.37, 0], [0.7, 0.555, 0], 0.013, 10, 8),
  ];
  // the wheel itself: rim, grips and the body with its display
  const C: Vec = [0.64, 0.585, 0];
  const tilt = 0.36;
  const e2: Vec = [-Math.sin(tilt), Math.cos(tilt), 0];
  const rimPts = roundedPoly(
    [
      { a: -0.135, b: 0.07, r: 0.05 },
      { a: 0.135, b: 0.07, r: 0.05 },
      { a: 0.135, b: -0.075, r: 0.05 },
      { a: -0.135, b: -0.075, r: 0.05 },
    ],
    6,
    [4, 3, 4, 3],
  );
  const path: Vec[] = rimPts.map(([a, b]) => [C[0] + e2[0] * b, C[1] + e2[1] * b, C[2] + a]);
  path.push(path[0]);
  grids.push(
    sweep(
      path,
      () =>
        roundedPoly(
          [
            { a: -0.012, b: -0.01, r: 0.008 },
            { a: 0.012, b: -0.01, r: 0.008 },
            { a: 0.012, b: 0.01, r: 0.008 },
            { a: -0.012, b: 0.01, r: 0.008 },
          ],
          2,
          1,
        ),
      [1, 0, 0],
      { isoRows: [], isoCols: [1, 7] },
    ),
  );
  const body = rotateShape(shape(box(C, 0.045, 0.11, 0.19, 0.012)), C, [0, 0, 1], tilt);
  const lines = polyline(
    [
      [C[0] - 0.024 - 0.02 * Math.sin(tilt), C[1] + 0.03, -0.05],
      [C[0] - 0.024 - 0.02 * Math.sin(tilt), C[1] + 0.03, 0.05],
      [C[0] - 0.024, C[1] - 0.01, 0.05],
      [C[0] - 0.024, C[1] - 0.01, -0.05],
    ],
    true,
  );
  return merge({ grids, lines }, body);
}

// ------------------------------------------------------------------------------------------ sidepods, cover, mirrors

const POD = {
  zIn: pchip([
    [0.9, 0.3],
    [0.4, 0.312],
    [0.0, 0.31],
    [-0.4, 0.275],
    [-0.9, 0.225],
    [-1.3, 0.185],
    [-1.62, 0.155],
    [-1.92, 0.13],
  ]),
  zOut: pchip([
    [0.9, 0.7],
    [0.7, 0.742],
    [0.4, 0.75],
    [0.05, 0.728],
    [-0.4, 0.668],
    [-0.9, 0.552],
    [-1.3, 0.425],
    [-1.62, 0.305],
    [-1.92, 0.205],
  ]),
  yTopIn: pchip([
    [0.9, 0.64],
    [0.7, 0.656],
    [0.4, 0.651],
    [0.05, 0.622],
    [-0.4, 0.56],
    [-0.9, 0.482],
    [-1.3, 0.404],
    [-1.62, 0.342],
    [-1.92, 0.3],
  ]),
  yTopOut: pchip([
    [0.9, 0.598],
    [0.7, 0.606],
    [0.4, 0.578],
    [0.05, 0.522],
    [-0.4, 0.44],
    [-0.9, 0.352],
    [-1.3, 0.282],
    [-1.62, 0.24],
    [-1.92, 0.215],
  ]),
  yBotOut: pchip([
    [0.9, 0.428],
    [0.7, 0.352],
    [0.4, 0.252],
    [0.05, 0.152],
    [-0.4, 0.09],
    [-0.9, 0.085],
    [-1.92, 0.085],
  ]),
  zOutBot: pchip([
    [0.9, 0.66],
    [0.7, 0.662],
    [0.4, 0.628],
    [0.05, 0.64],
    [-0.4, 0.642],
    [-0.9, 0.54],
    [-1.3, 0.42],
    [-1.62, 0.302],
    [-1.92, 0.203],
  ]),
  yBotIn: pchip([
    [0.9, 0.405],
    [0.7, 0.33],
    [0.4, 0.2],
    [0.05, 0.12],
    [-0.4, 0.085],
    [-1.92, 0.085],
  ]),
  rTop: pchip([
    [0.9, 0.05],
    [0.7, 0.08],
    [0.4, 0.1],
    [0.05, 0.11],
    [-0.4, 0.11],
    [-0.9, 0.1],
    [-1.3, 0.08],
    [-1.62, 0.05],
    [-1.92, 0.03],
  ]),
  rBot: pchip([
    [0.9, 0.05],
    [0.7, 0.08],
    [0.4, 0.1],
    [0.05, 0.07],
    [-0.4, 0.04],
    [-0.9, 0.03],
    [-1.92, 0.01],
  ]),
};

function podCorners(x: number, inset = 0): Corner[] {
  const d = inset;
  return [
    { a: POD.zIn(x) + d, b: POD.yTopIn(x) - d, r: 0.012 },
    { a: POD.zOut(x) - d, b: POD.yTopOut(x) - d, r: Math.max(0.01, POD.rTop(x) - d * 0.8) },
    { a: POD.zOutBot(x) - d, b: POD.yBotOut(x) + d, r: Math.max(0.01, POD.rBot(x) - d * 0.8) },
    { a: POD.zIn(x) + d, b: POD.yBotIn(x) + d, r: 0.012 },
  ];
}

const POD_ARC = 4;
const POD_SEG = [4, 3, 3, 2];

function sidepod(): PartShape {
  const X0 = 0.9;
  const ring = (x: number, at: number, inset: number) => atX(at, roundedPoly(podCorners(x, inset), POD_ARC, POD_SEG));
  // the inlet: the loft starts inside the duct, rolls over the lip and runs back along the outside
  const inlet: Ring[] = [ring(X0, 0.62, 0.05), ring(X0, 0.8, 0.038), ring(X0, 0.884, 0.03), ring(X0, 0.905, 0.016), ring(X0, 0.902, 0.004)];
  const xs = stations(X0, -1.92, 0.05);
  const outer = xs.map((x) => ring(x, x, 0));
  const rings = [...inlet, ...outer];
  const n = rings[0].length;
  const g = loft(rings, {
    capStart: true,
    capEnd: true,
    isoRows: [0, 3, ...nearestRows(xs, 0.1).map((r) => r + inlet.length)],
    isoCols: every(n, 2, false),
  });
  // cooling gills on the top of the pod, toward the rear
  const lines: number[] = [];
  for (let k = 0; k < 6; k++) {
    const x = -0.52 - k * 0.07;
    const zi = POD.zIn(x) + 0.06;
    const zo = lerp(POD.zIn(x), POD.zOut(x), 0.72);
    const yi = POD.yTopIn(x) + 0.006;
    const yo = lerp(POD.yTopIn(x), POD.yTopOut(x), 0.72) + 0.004;
    lines.push(x, yi, zi, x - 0.03, yo, zo);
  }
  return { grids: [g], lines };
}

function radiator(): PartShape {
  const c: Vec = [0.36, 0.405, 0.505];
  const core = box(c, 0.44, 0.3, 0.055, 0.006);
  const tanks = [box([c[0], c[1] + 0.165, c[2]], 0.46, 0.03, 0.07, 0.01), box([c[0], c[1] - 0.165, c[2]], 0.46, 0.03, 0.07, 0.01)];
  const lines: number[] = [];
  for (let k = 1; k < 18; k++) {
    const x = c[0] - 0.22 + (0.44 * k) / 18;
    lines.push(x, c[1] - 0.148, c[2] + 0.0285, x, c[1] + 0.148, c[2] + 0.0285);
  }
  return rotateShape({ grids: [core, ...tanks], lines }, c, [1, 0, 0], -0.32);
}

/** The engine cover starts behind the cockpit, where the roll hoop and airbox stand. */
const COVER_FRONT = -0.1;

const COVER = {
  yA: pchip([
    [COVER_FRONT, 0.905],
    [-0.16, 0.945],
    [-0.28, 0.956],
    [-0.45, 0.935],
    [-0.75, 0.855],
    [-1.05, 0.765],
    [-1.35, 0.68],
    [-1.62, 0.598],
    [-1.9, 0.522],
    [-2.12, 0.476],
  ]),
  hwA: pchip([
    [COVER_FRONT, 0.07],
    [-0.3, 0.082],
    [-0.65, 0.072],
    [-1.05, 0.06],
    [-1.6, 0.045],
    [-2.12, 0.03],
  ]),
  rA: pchip([
    [COVER_FRONT, 0.05],
    [-0.45, 0.06],
    [-1.2, 0.045],
    [-2.12, 0.025],
  ]),
};

/** Where the cover's lower edge sits: wrapped over the chassis shoulders in front, on the sidepods behind. */
function coverSide(x: number): { y: number; hw: number } {
  const t = smooth((-0.3 - x) / 0.35);
  const chassisY = CH.yT(x) - 0.04;
  const chassisW = CH.hwT(x) + 0.006;
  const podX = Math.max(x, -1.92);
  let podY = POD.yTopIn(podX) - 0.018;
  let podW = POD.zIn(podX) + 0.012;
  if (x < -1.92) {
    const u = smooth((-1.92 - x) / 0.2);
    podY = lerp(podY, 0.345, u);
    podW = lerp(podW, 0.09, u);
  }
  return { y: lerp(chassisY, podY, t), hw: lerp(chassisW, podW, t) };
}

function engineCover(): PartShape {
  const xs = stations(COVER_FRONT, -2.12, 0.05);
  const rings = xs.map((x) => {
    const yA = COVER.yA(x);
    const side = coverSide(x);
    const yB = side.y;
    const hwA = COVER.hwA(x);
    const hwB = side.hw;
    return atX(
      x,
      roundedPoly(
        [
          { a: 0, b: yA, r: 0 },
          { a: hwA, b: yA, r: COVER.rA(x) },
          { a: hwB, b: yB, r: 0.015 },
          { a: -hwB, b: yB, r: 0.015 },
          { a: -hwA, b: yA, r: COVER.rA(x) },
        ],
        4,
        [3, 4, 3, 4, 3],
      ),
    );
  });
  const shell = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.1), isoCols: every(rings[0].length, 2, false) });
  // airbox inlet above the driver's head
  const inletRing = (x: number, k: number, dy: number) =>
    atX(
      x,
      roundedPoly(
        [
          { a: -0.034 * k, b: 0.914 - dy, r: 0.03 * k },
          { a: 0.034 * k, b: 0.914 - dy, r: 0.03 * k },
          { a: 0.098 * k, b: 0.8 + (1 - k) * 0.04 - dy, r: 0.028 * k },
          { a: -0.098 * k, b: 0.8 + (1 - k) * 0.04 - dy, r: 0.028 * k },
        ],
        4,
        [2, 3, 3, 3],
      ),
    );
  const inlet = loft([inletRing(COVER_FRONT - 0.24, 0.7, 0.02), inletRing(COVER_FRONT - 0.016, 0.94, 0), inletRing(COVER_FRONT + 0.007, 1, 0)], {
    capStart: true,
    isoRows: [1, 2],
    isoCols: every(24, 2, false),
  });
  // low fin along the spine
  const fx = stations(-0.66, -1.66, 0.05);
  const fin = loft(
    fx.map((x) => {
      const h = 0.05 * smooth((-0.66 - x) / 0.25) * (1 - smooth((x + 1.42) / -0.24));
      const y0 = COVER.yA(x) - 0.012;
      return atX(
        x,
        roundedPoly(
          [
            { a: -0.004, b: y0 + h + 0.002, r: 0.002 },
            { a: 0.004, b: y0 + h + 0.002, r: 0.002 },
            { a: 0.004, b: y0, r: 0 },
            { a: -0.004, b: y0, r: 0 },
          ],
          1,
          1,
        ),
      );
    }),
    { capStart: true, capEnd: true, isoRows: [], isoCols: [] },
  );
  // the outlet at the tail
  const lines = polyline(
    roundedPoly(
      [
        { a: -0.055, b: 0.49, r: 0.02 },
        { a: 0.055, b: 0.49, r: 0.02 },
        { a: 0.055, b: 0.39, r: 0.02 },
        { a: -0.055, b: 0.39, r: 0.02 },
      ],
      4,
      1,
    ).map(([a, b]) => [-2.125, b, a] as Vec),
    true,
  );
  return { grids: [shell, inlet, fin], lines };
}

function mirror(): PartShape {
  const zs = [0.396, 0.404, 0.42, 0.53, 0.546, 0.554];
  const k = [0.78, 0.94, 1, 1, 0.94, 0.78];
  const rings = zs.map((z, i) => {
    const s = k[i];
    const cx = 0.705;
    const cy = 0.735;
    return roundedPoly(
      [
        { a: cx + 0.03 * s, b: cy + 0.03 * s, r: 0.024 * s },
        { a: cx + 0.03 * s, b: cy - 0.03 * s, r: 0.024 * s },
        { a: cx - 0.027 * s, b: cy - 0.03 * s, r: 0.006 },
        { a: cx - 0.027 * s, b: cy + 0.03 * s, r: 0.006 },
      ],
      3,
      [1, 1, 1, 1],
    ).map(([a, b]) => [a, b, z] as Vec);
  });
  const housing = loft(rings, { capStart: true, capEnd: true, isoRows: [1, 4], isoCols: [] });
  const glass = polyline(
    [
      [0.676, 0.712, 0.41],
      [0.676, 0.758, 0.41],
      [0.676, 0.758, 0.54],
      [0.676, 0.712, 0.54],
    ],
    true,
  );
  const stalks = [strut([0.7, 0.706, 0.452], [0.745, 0.63, 0.37], 0.03, 0.01, [1, 0, 0]), strut([0.695, 0.718, 0.41], [0.655, 0.682, 0.33], 0.026, 0.01, [1, 0, 0])];
  return { grids: [housing, ...stalks], lines: glass };
}

// ------------------------------------------------------------------------------------------ floor

const FLOOR = {
  hw: pchip([
    [1.13, 0.42],
    [1.12, 0.55],
    [1.09, 0.66],
    [1.02, 0.75],
    [0.9, 0.82],
    [0.72, 0.855],
    [0.4, 0.862],
    [-0.6, 0.86],
    [-0.95, 0.85],
    [-1.12, 0.83],
    [-1.24, 0.78],
    [-1.32, 0.7],
    [-1.38, 0.61],
    [-1.44, 0.565],
    [-1.6, 0.55],
    [-2.12, 0.55],
  ]),
  /** tunnel roof (underside) height */
  yt: pchip([
    [1.13, 0.152],
    [0.9, 0.126],
    [0.5, 0.086],
    [0.0, 0.066],
    [-0.5, 0.06],
    [-1.0, 0.062],
    [-1.42, 0.068],
    [-1.7, 0.112],
    [-2.0, 0.192],
    [-2.12, 0.232],
  ]),
  /** keel (under the chassis, where the plank hangs) */
  yk: pchip([
    [1.13, 0.06],
    [0.9, 0.052],
    [-1.42, 0.05],
    [-1.7, 0.09],
    [-2.0, 0.17],
    [-2.12, 0.21],
  ]),
  /** outer edge strip */
  ye: pchip([
    [1.13, 0.095],
    [0.8, 0.07],
    [0.0, 0.064],
    [-1.42, 0.066],
    [-1.7, 0.1],
    [-2.0, 0.17],
    [-2.12, 0.205],
  ]),
};

const FLOOR_T = 0.01;

function floorCorners(x: number): Corner[] {
  const hw = FLOOR.hw(x);
  const yt = FLOOR.yt(x);
  const yk = FLOOR.yk(x);
  const ye = FLOOR.ye(x);
  const t = FLOOR_T;
  const zEdge = Math.max(0.3, hw - 0.12);
  const zTunOut = Math.max(0.26, hw - 0.17);
  const zTunIn = 0.215;
  const zKeel = 0.16;
  const bottom: Corner[] = [
    { a: hw, b: ye, r: 0 },
    { a: zEdge, b: ye, r: 0.02 },
    { a: zTunOut, b: yt, r: 0.03 },
    { a: zTunIn, b: yt, r: 0.03 },
    { a: zKeel, b: yk, r: 0.02 },
    { a: -zKeel, b: yk, r: 0.02 },
    { a: -zTunIn, b: yt, r: 0.03 },
    { a: -zTunOut, b: yt, r: 0.03 },
    { a: -zEdge, b: ye, r: 0.02 },
    { a: -hw, b: ye, r: 0 },
  ];
  const top: Corner[] = bottom
    .slice()
    .reverse()
    .map((c) => ({ a: c.a, b: c.b + t, r: c.r }));
  return [...bottom, ...top];
}

function floor(): PartShape {
  const xs = stations(1.13, -2.12, 0.05, [-1.42]);
  const SEG = [3, 2, 3, 1, 3, 1, 3, 2, 3, 0, 3, 2, 3, 1, 3, 1, 3, 2, 3, 0];
  const metaAt = (x: number) => roundedPolyMeta(floorCorners(x), 3, SEG);
  const meta = metaAt(0);
  const rings = xs.map((x) => atX(x, metaAt(x).pts));
  // underside construction lines along each tunnel feature, plus the edge
  const bottomCols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => meta.corner[i] + (i === 0 || i === 9 ? 0 : 2));
  const topCols = [meta.corner[11] + 2, meta.corner[18] + 2];
  const body = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.2, [-1.42]), isoCols: [...bottomCols, ...topCols] });

  const grids: Grid[] = [body];
  // plank under the keel, with its skid holes
  grids.push(box([-0.18, 0.043, 0], 2.4, 0.014, 0.3, 0));
  const lines: number[] = [];
  for (const cx of [0.8, 0.3, -0.25, -0.8, -1.2]) {
    const ring: Vec[] = [];
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      ring.push([cx + Math.cos(a) * 0.024, 0.0355, Math.sin(a) * 0.024]);
    }
    lines.push(...polyline(ring, true));
  }
  // fences in the tunnel mouths and strakes in the diffuser, right side (mirrored below)
  const fins: Grid[] = [];
  for (let k = 0; k < 3; k++) {
    const fxs = stations(1.1, 0.42, 0.04);
    const zAt = (x: number) => 0.27 + 0.11 * k + (0.04 + 0.03 * k) * smooth((1.1 - x) / 0.68);
    fins.push(
      loft(
        fxs.map((x) => {
          const top = FLOOR.yt(x) + 0.002;
          const bot = Math.min(top - 0.004, 0.05 + 0.03 * smooth((x - 0.42) / 0.68) * 0.3);
          const z = zAt(x);
          return atX(
            x,
            roundedPoly(
              [
                { a: z - 0.003, b: top, r: 0 },
                { a: z + 0.003, b: top, r: 0 },
                { a: z + 0.003, b: bot, r: 0.002 },
                { a: z - 0.003, b: bot, r: 0.002 },
              ],
              1,
              1,
            ),
          );
        }),
        { capStart: true, capEnd: true, isoRows: [], isoCols: [] },
      ),
    );
  }
  for (const z of [0.22, 0.38]) {
    const sxs = stations(-1.46, -2.1, 0.04);
    fins.push(
      loft(
        sxs.map((x) => {
          const top = FLOOR.yt(x) + 0.002;
          const bot = 0.055 + 0.25 * smooth((-1.46 - x) / 0.64) * 0.3;
          return atX(
            x,
            roundedPoly(
              [
                { a: z - 0.004, b: top, r: 0 },
                { a: z + 0.004, b: top, r: 0 },
                { a: z + 0.004, b: bot, r: 0.003 },
                { a: z - 0.004, b: bot, r: 0.003 },
              ],
              1,
              1,
            ),
          );
        }),
        { capStart: true, capEnd: true, isoRows: [], isoCols: [] },
      ),
    );
  }
  // edge wing along the outer floor edge
  const exs = stations(0.82, -1.1, 0.06);
  const edgeWing = loft(
    exs.map((x) => {
      const z = FLOOR.hw(x) - 0.006;
      const y0 = FLOOR.ye(x) + FLOOR_T;
      const h = 0.045 * smooth((0.82 - x) / 0.3) * smooth((x + 1.1) / 0.3);
      return atX(
        x,
        roundedPoly(
          [
            { a: z - 0.004, b: y0 + h + 0.003, r: 0.002 },
            { a: z + 0.004, b: y0 + h + 0.003, r: 0.002 },
            { a: z + 0.004, b: y0, r: 0 },
            { a: z - 0.004, b: y0, r: 0 },
          ],
          1,
          1,
        ),
      );
    }),
    { capStart: true, capEnd: true, isoRows: [], isoCols: [] },
  );
  fins.push(edgeWing);
  // diffuser side walls
  const dxs = stations(-1.44, -2.12, 0.04);
  fins.push(
    loft(
      dxs.map((x) => {
        const z = FLOOR.hw(x) - 0.004;
        const y0 = FLOOR.ye(x);
        return atX(
          x,
          roundedPoly(
            [
              { a: z - 0.005, b: y0 + 0.13, r: 0.003 },
              { a: z + 0.005, b: y0 + 0.13, r: 0.003 },
              { a: z + 0.005, b: y0, r: 0 },
              { a: z - 0.005, b: y0, r: 0 },
            ],
            1,
            1,
          ),
        );
      }),
      { capStart: true, capEnd: true, isoRows: [0, dxs.length - 1], isoCols: [] },
    ),
  );
  const right = shape(...fins);
  return merge({ grids, lines }, right, mirrorShape(right));
}

// ------------------------------------------------------------------------------------------ power unit

function powerUnit(): PartShape {
  const grids: Grid[] = [box([-0.82, 0.215, 0], 0.7, 0.22, 0.34, 0.03)];
  const banks: PartShape[] = [];
  for (const s of [1, -1]) {
    const bank = shape(box([-0.81, 0.4, 0], 0.62, 0.2, 0.15, 0.02), box([-0.81, 0.512, 0], 0.6, 0.045, 0.13, 0.018));
    banks.push(rotateShape(bank, [-0.81, 0.3, 0], [1, 0, 0], -0.7 * s));
  }
  grids.push(rod([-0.47, 0.5, 0], [-1.12, 0.5, 0], 0.07, 18, 6));
  // intake from the airbox down to the plenum
  const intakePath: Vec[] = spline(
    [
      [-0.3, 0.84, 0],
      [-0.42, 0.76, 0],
      [-0.54, 0.64, 0],
      [-0.62, 0.57, 0],
    ],
    12,
  );
  grids.push(
    sweep(
      intakePath,
      (t) =>
        roundedPoly(
          [
            { a: -0.05, b: -0.07 + 0.02 * t, r: 0.03 },
            { a: 0.05, b: -0.07 + 0.02 * t, r: 0.03 },
            { a: 0.05, b: 0.07 - 0.02 * t, r: 0.03 },
            { a: -0.05, b: 0.07 - 0.02 * t, r: 0.03 },
          ],
          3,
          1,
        ),
      [0, 0, 1],
      { capStart: true, capEnd: true, isoRows: [0, 11], isoCols: [] },
    ),
  );
  // turbo: compressor and turbine on one shaft at the back of the engine
  grids.push(
    lathe(
      [
        [0.0, -0.06],
        [0.07, -0.06],
        [0.1, -0.02],
        [0.1, 0.02],
        [0.06, 0.05],
        [0.0, 0.05],
      ],
      28,
      [-1.25, 0.44, 0],
      'x',
      { isoRows: [1, 2, 3, 4], isoCols: every(28, 4, false) },
    ),
  );
  grids.push(
    lathe(
      [
        [0.0, -0.05],
        [0.06, -0.05],
        [0.085, -0.01],
        [0.08, 0.03],
        [0.0, 0.04],
      ],
      24,
      [-1.4, 0.44, 0],
      'x',
      { isoRows: [1, 2, 3], isoCols: every(24, 4, false) },
    ),
  );
  // exhaust runners into the turbine, and the tailpipe
  for (const s of [1, -1]) {
    for (const x0 of [-0.6, -0.8, -1.0]) {
      const path = spline(
        [
          [x0, 0.34, 0.215 * s],
          [x0 - 0.06, 0.33, 0.25 * s],
          [x0 - 0.2, 0.38, 0.2 * s],
          [-1.4, 0.44, 0.07 * s],
        ],
        14,
      );
      grids.push(
        sweep(
          path,
          () =>
            roundedPoly(
              [
                { a: -0.018, b: -0.018, r: 0.017 },
                { a: 0.018, b: -0.018, r: 0.017 },
                { a: 0.018, b: 0.018, r: 0.017 },
                { a: -0.018, b: 0.018, r: 0.017 },
              ],
              2,
              0,
            ),
          [0, 1, 0],
          { isoRows: [], isoCols: [1, 7] },
        ),
      );
    }
  }
  grids.push(rod([-1.44, 0.44, 0], [-2.52, 0.44, 0], 0.037, 18, 10));
  // MGU-K on the left of the block
  grids.push(rod([-0.5, 0.2, -0.235], [-0.76, 0.2, -0.235], 0.062, 18, 4));
  return merge(shape(...grids), ...banks);
}

function energyStore(): PartShape {
  const g = box([-0.2, 0.135, 0], 0.42, 0.075, 0.48, 0.012);
  const lines: number[] = [];
  for (let k = 1; k < 6; k++) {
    const z = -0.24 + (0.48 * k) / 6;
    lines.push(-0.41 + 0.01, 0.1735, z, 0.01 - 0.01, 0.1735, z);
  }
  return { grids: [g], lines };
}

// ------------------------------------------------------------------------------------------ gearbox

const GB = {
  yc: pchip([
    [-1.22, 0.3],
    [-1.6, 0.305],
    [-2.0, 0.318],
    [-2.2, 0.33],
    [-2.53, 0.338],
  ]),
  hh: pchip([
    [-1.22, 0.165],
    [-1.6, 0.14],
    [-2.0, 0.105],
    [-2.1, 0.09],
    [-2.53, 0.048],
  ]),
  hw: pchip([
    [-1.22, 0.165],
    [-1.6, 0.142],
    [-2.0, 0.11],
    [-2.1, 0.095],
    [-2.53, 0.052],
  ]),
};

function gearbox(): PartShape {
  const xs = stations(-1.22, -2.53, 0.04, [-2.05]);
  const meta = roundedPolyMeta(
    [
      { a: -0.1, b: 0.1, r: 0.03 },
      { a: 0.1, b: 0.1, r: 0.03 },
      { a: 0.1, b: -0.1, r: 0.03 },
      { a: -0.1, b: -0.1, r: 0.03 },
    ],
    3,
    2,
  );
  const rings = xs.map((x) => {
    const hw = GB.hw(x);
    const hh = GB.hh(x);
    const r = Math.min(0.035, hh * 0.5);
    const pts = roundedPoly(
      [
        { a: -hw, b: hh, r },
        { a: hw, b: hh, r },
        { a: hw, b: -hh, r },
        { a: -hw, b: -hh, r },
      ],
      3,
      2,
    );
    return atX(x, pts, 0, GB.yc(x));
  });
  const casing = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.1, [-2.05]), isoCols: [...meta.corner.map((c) => c + 1), ...meta.edge.map((e) => e + 1)] });
  const light = box([-2.545, 0.338, 0], 0.024, 0.07, 0.1, 0);
  const lines: number[] = [];
  for (let k = 1; k < 5; k++) {
    const z = -0.05 + (0.1 * k) / 5;
    lines.push(-2.558, 0.305, z, -2.558, 0.371, z);
  }
  return { grids: [casing, light], lines };
}

// ------------------------------------------------------------------------------------------ rear wing

const RW = {
  span: 0.505,
  xLE: (z: number) => -2.055 - 0.025 * sq(Math.abs(z) / 0.505),
  yLE: (z: number) => 0.758 + 0.038 * Math.pow(smooth((Math.abs(z) - 0.28) / 0.22), 1.3),
  chord: (z: number) => 0.3 - 0.035 * sq(Math.abs(z) / 0.505),
  aoa: (z: number) => 0.17 + 0.05 * (Math.abs(z) / 0.505),
};

function rearEndplate(): PartShape {
  const xs = stations(-1.97, -2.63, 0.02);
  const yb = pchip([
    [-1.97, 0.66],
    [-2.02, 0.58],
    [-2.1, 0.53],
    [-2.3, 0.48],
    [-2.5, 0.445],
    [-2.63, 0.44],
  ]);
  const yt = pchip([
    [-1.97, 0.78],
    [-2.0, 0.84],
    [-2.06, 0.895],
    [-2.15, 0.93],
    [-2.35, 0.944],
    [-2.55, 0.944],
    [-2.63, 0.93],
  ]);
  const t = 0.012;
  const rings = xs.map((x) =>
    atX(
      x,
      roundedPoly(
        [
          { a: 0.499, b: yt(x), r: t * 0.45 },
          { a: 0.499 + t, b: yt(x), r: t * 0.45 },
          { a: 0.505 + t, b: yb(x), r: t * 0.45 },
          { a: 0.505, b: yb(x), r: t * 0.45 },
        ],
        2,
        [1, 4, 1, 4],
      ),
    ),
  );
  const plate = loft(rings, { capStart: true, capEnd: true, isoRows: nearestRows(xs, 0.1), isoCols: [] });
  const lines: number[] = [];
  for (let k = 0; k < 4; k++) {
    const y = 0.9 - k * 0.028;
    lines.push(-2.46, y, 0.519, -2.6, y - 0.012, 0.519);
  }
  return { grids: [plate], lines };
}

function rearWing(): PartShape {
  const foil = aerofoil(40, 0.1, 0.075);
  const foilF = aerofoil(32, 0.1, 0.07);
  const zs = stations(-RW.span, RW.span, 0.035);
  const main: Ring[] = [];
  const flap: Ring[] = [];
  for (const z of zs) {
    const x = RW.xLE(z);
    const y = RW.yLE(z);
    const c = RW.chord(z);
    const a = RW.aoa(z);
    main.push(wingRing(foil, x, y, z, c, a));
    const [xt, yt] = te(x, y, c, a);
    const s = Math.abs(z) / RW.span;
    flap.push(wingRing(foilF, xt + 0.022, yt + 0.013, z, 0.205 - 0.02 * s * s, 0.5 + 0.05 * s));
  }
  const rows = nearestRows(zs, 0.1);
  const grids: Grid[] = [
    loft(main, { capStart: true, capEnd: true, isoRows: rows, isoCols: [0, 10, 20, 30] }),
    loft(flap, { capStart: true, capEnd: true, isoRows: rows, isoCols: [0, 8, 16, 24] }),
  ];
  // central pillar from the crash structure up to the mainplane
  const ys = stations(0.4, 0.768, 0.04);
  grids.push(
    loft(
      ys.map((y) => {
        const cx = lerp(-2.215, -2.17, (y - 0.4) / 0.37);
        return roundedPoly(
          [
            { a: cx + 0.07, b: -0.012, r: 0.011 },
            { a: cx + 0.07, b: 0.012, r: 0.011 },
            { a: cx - 0.07, b: 0.012, r: 0.006 },
            { a: cx - 0.07, b: -0.012, r: 0.006 },
          ],
          3,
          1,
        ).map(([a, b]) => [a, y, b] as Vec);
      }),
      { capStart: true, capEnd: true, isoRows: [0, ys.length - 1], isoCols: [] },
    ),
  );
  grids.push(box([-2.34, 0.902, 0], 0.08, 0.036, 0.06, 0.012));
  const end = rearEndplate();
  return merge(shape(...grids), end, mirrorShape(end));
}

// ------------------------------------------------------------------------------------------ electronics

function electronics(): PartShape {
  const grids: Grid[] = [];
  for (const s of [1, -1]) {
    const path = spline(
      [
        [1.3, 0.32, 0.1 * s],
        [0.95, 0.2, 0.2 * s],
        [0.4, 0.16, 0.255 * s],
        [-0.3, 0.15, 0.258 * s],
        [-0.9, 0.2, 0.22 * s],
        [-1.4, 0.26, 0.16 * s],
        [-1.85, 0.3, 0.12 * s],
      ],
      60,
    );
    grids.push(
      sweep(
        path,
        () =>
          roundedPoly(
            [
              { a: -0.008, b: -0.008, r: 0.0075 },
              { a: 0.008, b: -0.008, r: 0.0075 },
              { a: 0.008, b: 0.008, r: 0.0075 },
              { a: -0.008, b: 0.008, r: 0.0075 },
            ],
            2,
            0,
          ),
        [0, 1, 0],
        { capStart: true, capEnd: true, isoRows: [], isoCols: [1, 7] },
      ),
    );
    grids.push(rod([1.95, 0.445, 0.106 * s], [2.07, 0.445, 0.098 * s], 0.016, 12, 2));
  }
  grids.push(box([0.25, 0.27, -0.44], 0.24, 0.07, 0.16, 0.008));
  grids.push(box([-0.2, 0.974, 0], 0.07, 0.024, 0.2, 0.008));
  grids.push(box([-0.2, 0.96, 0], 0.03, 0.02, 0.03, 0));
  grids.push(rod([1.56, 0.515, 0], [1.56, 0.6, 0], 0.004, 6, 2));
  grids.push(rod([-0.8, 0.83, 0], [-0.8, 0.905, 0], 0.004, 6, 2));
  grids.push(rod([2.74, 0.19, 0], [2.865, 0.19, 0], 0.005, 6, 2));
  return shape(...grids);
}

// ------------------------------------------------------------------------------------------ the car

export function buildCarShapes(): Record<string, PartShape> {
  const fs = frontSuspension();
  const rs = rearSuspension();
  const fb = brake(true);
  const rb = brake(false);
  const wf = wheel(true);
  const wr = wheel(false);
  const sf = wss(true);
  const sr = wss(false);
  const pod = sidepod();
  const rad = radiator();
  const mir = mirror();
  return {
    chassis: chassis(),
    halo: halo(),
    nose: nose(),
    front_wing: frontWing(),
    fsusp_r: fs,
    fsusp_l: mirrorShape(fs),
    fbrake_r: fb,
    fbrake_l: mirrorShape(fb),
    wheel_f_r: wf,
    wheel_f_l: mirrorShape(wf),
    wss_f_r: sf,
    wss_f_l: mirrorShape(sf),
    steering: steering(),
    sidepod_r: pod,
    sidepod_l: mirrorShape(pod),
    radiator_r: rad,
    radiator_l: mirrorShape(rad),
    engine_cover: engineCover(),
    mirror_r: mir,
    mirror_l: mirrorShape(mir),
    floor: floor(),
    power_unit: powerUnit(),
    energy_store: energyStore(),
    gearbox: gearbox(),
    rsusp_r: rs,
    rsusp_l: mirrorShape(rs),
    rbrake_r: rb,
    rbrake_l: mirrorShape(rb),
    wheel_r_r: wr,
    wheel_r_l: mirrorShape(wr),
    wss_r_r: sr,
    wss_r_l: mirrorShape(sr),
    rear_wing: rearWing(),
    electronics: electronics(),
  };
}
