/**
 * Livery sheet frames, in car metres. The reference renders and the generated
 * sheets share one 21:9 canvas per view; the shader samples the cropped sheet.
 * Nose is +x (right in both views); the top view looks down with +z at the bottom.
 */
export const SHEET_ASPECT = 21 / 9;
export const CANVAS_X = { x0: -3.0, x1: 3.1 } as const;
const CANVAS_H = (CANVAS_X.x1 - CANVAS_X.x0) / SHEET_ASPECT; // 2.614 m

/** Full 21:9 canvas extents used by the orthographic reference renders. */
export const CANVAS = {
  side: { x0: CANVAS_X.x0, x1: CANVAS_X.x1, y0: -0.1, y1: -0.1 + CANVAS_H },
  top: { x0: CANVAS_X.x0, x1: CANVAS_X.x1, zBottom: CANVAS_H / 2, zTop: -CANVAS_H / 2 },
} as const;

/** The rows kept after cropping; what the shader's frame uniforms describe. */
export const SHEET = {
  side: { x0: CANVAS_X.x0, y0: -0.05, x1: CANVAS_X.x1, y1: 1.2 },
  top: { x0: CANVAS_X.x0, zBottom: 1.1, x1: CANVAS_X.x1, zTop: -1.1 },
} as const;
