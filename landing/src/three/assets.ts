/**
 * Drop-in slot for generated assets (Higgsfield or any other source).
 *
 * Nothing here is required: with every field null the scene renders the
 * procedural car, the procedural studio and the canvas-drawn textures.
 *
 * To upgrade later, put files under `public/` and point to them:
 *   model   – a GLB of the car. Node names must match `GLB_PART_MAP` in
 *             `car/CarModel.tsx` so the exploded groups, livery zones and x-ray
 *             overlays keep working. Materials named `paint`, `carbon`, `rubber`
 *             are re-bound to the livery system; others are kept as authored.
 *   envMap  – an equirectangular HDR (`.hdr`) studio. Replaces the procedural softboxes.
 *   floor   – an albedo texture for the pit floor (tiled 4 m).
 *   liveries – override the base URL per livery key. By default sheets are read from
 *             `/liveries/<key>/{side,top}.webp` (+ `@1k` variants for phones) when
 *             `LIVERIES[key].sheets` is true. See tools/ortho-sheets.mjs + tools/pack-sheets.py.
 */
export const CAR_ASSETS = {
  model: null as string | null, // e.g. '/models/pitwall-car.glb'
  /**
   * Generated power unit + gearbox mesh (Tripo image-to-3D from a GPT Image render, decimated to
   * 88k triangles with gltf-transform), revealed when the engine cover lifts. The procedural V6 is the fallback.
   * The mesh's long axis is local z; `rotation` turns it down the car's x axis with the gearbox at the rear.
   */
  powerUnit: '/models/power-unit.glb' as string | null,
  powerUnitTransform: {
    rotation: [0, Math.PI / 2, 0] as [number, number, number],
    /** Car x of the engine's front face (behind the fuel cell) and of the gearbox tail. */
    xFront: -0.72,
    xRear: -2.08,
    /**
     * Deform the mesh into the rear bodywork's real cross-section (body rings + the lower
     * part of the engine cover), so nothing pokes through the shell. Off for a hand-fitted GLB.
     */
    fitToBody: true,
  },
  /** Generated pit-garage panorama: reflections + a blurred backdrop. null → procedural gradient dome. */
  envMap: '/hdr/garage.jpg' as string | null,
  floor: null as string | null, // e.g. '/textures/pit-floor.jpg'
  liveries: {} as Partial<Record<string, string>>,
};
