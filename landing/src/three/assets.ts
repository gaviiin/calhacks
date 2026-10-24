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
 *   liveries – per-livery decal atlases (sRGB PNG, car-space UV atlas) if you want
 *             printed graphics on top of the procedural two-tone zones.
 */
export const CAR_ASSETS = {
  model: null as string | null, // e.g. '/models/pitwall-car.glb'
  envMap: null as string | null, // e.g. '/hdr/studio-garage.hdr'
  floor: null as string | null, // e.g. '/textures/pit-floor.jpg'
  liveries: {} as Partial<Record<string, string>>,
};
