// Colours shared by the renderer and the page, display RGB 0..1 (kept out of the engine module so the
// page can use them without loading three.js).

export type RGB = [number, number, number];

export const PALETTE = {
  heroBg0: [0.043, 0.106, 0.231] as RGB,
  heroBg1: [0.012, 0.031, 0.078] as RGB,
  sheetBg0: [0.027, 0.063, 0.145] as RGB,
  sheetBg1: [0.016, 0.039, 0.098] as RGB,
  grid: [0.32, 0.55, 1.0] as RGB,
  line: [0.38, 0.74, 1.0] as RGB,
  hi: [0.88, 0.96, 1.0] as RGB,
  ink: [0.76, 0.86, 1.0] as RGB,
  inkHi: [0.42, 0.86, 1.0] as RGB,
  /** condition lamps: the desk's amber and coral */
  hold: [1.0, 0.71, 0.28] as RGB,
  alert: [1.0, 0.45, 0.37] as RGB,
  /** a stopped car nobody has read yet */
  unknown: [0.52, 0.62, 0.8] as RGB,
  /** cost lens ramp, cheapest to dearest */
  costLo: [0.2, 0.4, 0.82] as RGB,
  costHi: [0.86, 0.96, 1.0] as RGB,
};

export const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`;
