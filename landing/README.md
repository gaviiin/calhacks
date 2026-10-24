# Pit Wall landing

Cinematic, scroll-driven F1 story for Pit Wall. One procedurally modelled, 2022-era ground-effect car sits in a procedural studio; six scenes dolly the camera around it, wipe a new team-inspired livery across the bodywork, explode the part in focus, switch to x-ray, and finally hand over to an interactive **simulated** incident console (Run → held for Controller → Approve in Simulation → Reset).

Separate from `frontend/` on purpose: it never talks to SpacetimeDB or the finance backend. Its final CTA links to the live evidence feed (`VITE_PITWALL_APP_URL`, default `http://localhost:5173`).

```bash
npm install
npm run dev      # http://localhost:5175
npm run build
```

## Storyboard

| # | Section | Focus | Livery | Car behaviour |
| --- | --- | --- | --- | --- |
| 00 | Hero: *The race ends. The books don't.* | Full car, low side profile | Carbon / lime | Pinned, idle camera drift, one light sweep on load |
| 01 | The problem | Front wing, nose, front suspension | Scarlet / giallo (Ferrari-inspired) | Four wing elements and endplates explode; financial callouts |
| 02 | Ingestion | Sidepods, inlet, core chassis | Silver / teal (Mercedes-inspired) | Sidepods lift and go translucent over the radiators; evidence streams into the inlet and airbox |
| 03 | Reasoning | Cockpit, halo, helmet | Navy / crimson (Red Bull-inspired) | Halo and engine cover lift, x-ray shell + wireframe + internals, pulsing reasoning graph |
| 04 | Control + audit | Rear wing, beam wing, diffuser | Racing green / lime (Aston-inspired) | Rear assembly explodes; flow-viz streamlines; audit path through three approval nodes |
| 05 | The system | Full car, 3/4 front | Carbon / lime | Reassembled; four station callouts |
| 06 | The product | Console | Carbon / lime | Stage pins for one viewport: station chips fly into the console workspace, the console boots in behind a clip wipe, then the live demo |

Papaya/anthracite (McLaren-inspired) and azure/rose (Alpine-inspired) palettes are defined in `LIVERIES` and can be assigned to any scene by changing its `livery` key.

## Architecture

| Path | What |
| --- | --- |
| `src/data/story.ts` | The six scenes: copy, livery key, camera station, exploded parts, callouts; the product station; the livery sequence |
| `src/data/demo.ts` | Demo figures ($450k bonus, $250k threshold) and the provenance trail |
| `src/three/state.ts` | `sceneState`: the mutable object GSAP scrubs and the frame loop reads; `LIVERIES`; station → tween values. No three import, so it stays in the first-paint chunk |
| `src/three/livery.ts` | Livery shader: per-pixel two-tone zones + accent stripe from car-space position, nose→tail wipe with a glowing edge, metalness/roughness blend. Patched into `MeshPhysicalMaterial` via `onBeforeCompile` |
| `src/three/geometry.ts` | Modelling kit: filleted box/pod/triangle/plate rings resampled by arc length, Catmull-Rom station densifier, lofts, NACA-style airfoils, tyre and wheel-cover lathe profiles |
| `src/three/car/buildCar.ts` | The car in metres: monocoque, nose, airbox + engine cover, lipped undercut sidepods, floor + diffuser, 4-element front wing with leaning rolled endplates, rear wing + DRS flap + beam wing + swan-neck pylon, halo, cockpit, wheels, brake ducts |
| `src/three/car/ProceduralCar.tsx` | Assembles the geometry with `Exploded` groups (`explodeFront`/`Mid`/`Rear`/`Top`), suspension, wheels, x-ray ghost/wire overlays, internals |
| `src/three/car/CarModel.tsx`, `GlbCar.tsx` | Switch: procedural car, or a GLB mapped onto the same exploded groups and material slots |
| `src/three/assets.ts` | **Drop-in slot for generated assets** (see below) |
| `src/three/materials.ts` | Livery paint (zoned / accent / dark / sidepod), clearcoated procedural carbon weave, tyre with sidewall lettering + compound band, aluminium, titanium, visor, fresnel x-ray ghost, pit-box floor markings |
| `src/three/Studio.tsx` | Procedural automotive studio: gradient dome + feathered softboxes rendered into the environment map; livery-tinted key/rim/glow lights; reflective floor with pit-box markings; contact shadows |
| `src/three/overlays/` | `Streams` (evidence into the sidepod), `ReasoningGraph` (cockpit nodes + flowing paths), `AuditTrail` (streamlines + approval nodes), `Callouts` (DOM labels anchored to the car), `flowMaterial` (dash-flow line shader) |
| `src/three/Effects.tsx` | Desktop post chain: N8AO ambient occlusion, restrained bloom, AgX tone mapping, vignette, SMAA |
| `src/three/Scene.tsx` | Canvas, adaptive DPR, and the `Rig` that damps the camera between stations, frames the focus point beside the copy column, and syncs livery/x-ray into the materials every frame |
| `src/components/landing/ScrollStory.tsx` | GSAP ScrollTrigger timeline (camera, explode, x-ray, livery index) + the scene sections |
| `src/components/landing/ProductReveal.tsx` | Pinned product handoff: chips → console workspace, clip wipe, boot log |
| `src/components/landing/Preloader.tsx` | Curtain that lifts once the car has rendered three frames |
| `src/components/landing/IncidentDemo.tsx` | Reducer-driven demo; the agent can only reach `held`, a human click approves |
| `src/components/landing/RaceCar.tsx` | SVG car used as the no-WebGL fallback |

**Scroll → scene:** `useStoryTimeline` builds one scrubbed timeline across the story container. Each scene has a camera station; the timeline tweens `sceneState` between stations and holds through the middle of each scene so the copy can be read. The livery is a single float `liveryT` (floor = palette leaving, ceil = palette arriving, fraction = wipe), so scrubbing backwards is deterministic. The R3F `Rig` damps the camera and copies palette colours into the shader uniforms every frame. Nothing in the canvas re-renders on scroll; callout visibility and the HUD telemetry are written straight to the DOM.

**Reduced motion:** no scrubbed timeline; stations and liveries are set instantly when a scene becomes active; no idle drift, no particle streams, no pinned reveal.

**No WebGL:** the SVG car renders instead with the same palette accents.

**Phones (≤ 900 px):** the stage becomes a 58 svh sticky header the story slides under, post-processing and the reflective floor are off, the chapter rail becomes a strip under the stage, and each station has a `mobile` camera override.

## Dropping in generated assets (Higgsfield or any other source)

Everything renders procedurally today; `src/three/assets.ts` is the single place to point at better assets later:

- `model` – a GLB of the car. `GlbCar.tsx` maps node names (`fw_main`, `fw_flap`, `fw_endplate`, `sidepod`, `mirror`, `engine_cover`, `halo`, `rw_main`, `rw_flap`, `rw_endplate`, `diffuser`, `_l` suffix for the left side) onto the same exploded groups, and re-binds materials named `paint`, `accent`, `carbon`, `rubber`, `matte`, `cover` to the livery system so liveries, x-ray and the exploded views keep working.
- `envMap` – an equirectangular `.hdr` studio; replaces the procedural softboxes.
- `floor` – an albedo for the pit floor.
- `liveries` – per-livery decal atlases if printed graphics are wanted on top of the procedural two-tone zones.

Put files under `public/models`, `public/hdr`, `public/textures`.

## Tuning

- Camera, explode amount and callouts per scene: `src/data/story.ts` (`station`, `callouts`). Anchors are in metres; nose is +X, the visitor's side is +Z, ground is y = 0.
- Explode directions per part: `Exploded` offsets in `src/three/car/ProceduralCar.tsx`.
- Livery palettes: `LIVERIES` in `src/three/state.ts` (team-inspired colourways, no marks). Zone logic (lower bodywork, nose tip, flank stripe, spine): `liveryZone` in `src/three/livery.ts`.
- Car shape: station tables in `src/three/car/buildCar.ts`.
- Studio light: softbox positions/intensities in `src/three/Studio.tsx`; post chain in `src/three/Effects.tsx`.

A Playwright harness for scene screenshots and a frame-rate/draw-call sample lives outside the repo during development; `window.__pw` (scene state) and `window.__gl` (renderer) are exposed in dev builds for it.
