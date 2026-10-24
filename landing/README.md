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
| `src/three/livery.ts` | Livery shader: generated side/top sheets projected by surface direction over a procedural two-tone base, nose→tail wipe with a glowing edge, metalness/roughness/clearcoat/flake blend. Patched into `MeshPhysicalMaterial` via `onBeforeCompile` |
| `src/three/sheets.ts`, `sheetFrames.ts` | Sheet loader (WebP, resident after first paint, `@1k` on phones) and the car-metre frames shared with the reference renders |
| `src/dev/OrthoSheet.tsx`, `tools/` | Clay reference renders (`?ortho=side|top`), Higgsfield regeneration script, registration/packing, screenshot harness |
| `src/three/geometry.ts` | Modelling kit: filleted box/pod/triangle/plate rings resampled by arc length, Catmull-Rom station densifier, lofts, NACA-style airfoils, tyre and wheel-cover lathe profiles |
| `src/three/car/buildCar.ts` | The car in metres: monocoque, nose, airbox + engine cover, lipped undercut sidepods, floor + diffuser, 4-element front wing with leaning rolled endplates, rear wing + DRS flap + beam wing + swan-neck pylon, halo, cockpit, wheels, brake ducts |
| `src/three/car/ProceduralCar.tsx` | Assembles the geometry: `Pivoted`/`Exploded` teardown groups, suspension, spoked wheels with lift-off aero covers, brakes, radiators, steering wheel, x-ray ghost/wire overlays |
| `src/three/car/explode.ts`, `PowerUnit.tsx` | Teardown choreography registry + easing; power unit (generated GLB or procedural V6) |
| `src/three/car/CarModel.tsx`, `GlbCar.tsx` | Switch: procedural car, or a GLB mapped onto the same exploded groups and material slots |
| `src/three/assets.ts` | **Drop-in slot for generated assets** (see below) |
| `src/three/materials.ts` | Livery paint (zoned / accent / dark / sidepod), clearcoated procedural carbon weave, tyre with sidewall lettering + compound band, aluminium, titanium, visor, fresnel x-ray ghost, pit-box floor markings |
| `src/three/Studio.tsx` | Procedural automotive studio: gradient dome + feathered softboxes rendered into the environment map; livery-tinted key/rim/glow lights; reflective floor with pit-box markings; contact shadows |
| `src/three/overlays/` | `Streams` (evidence into the sidepod), `ReasoningGraph` (cockpit nodes + flowing paths), `AuditTrail` (streamlines + approval nodes), `Tethers` (exploded-view lines from parts to mounts), `Callouts` (DOM labels anchored to the car), `flowMaterial` (dash-flow line shader) |
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

## Liveries

Each of the five liveries in the story is a pair of **projected decal sheets** generated by Higgsfield (GPT Image 2.5) and painted onto the car's own orthographic clay renders, so the artwork lands on the real panels: a 4k right-side sheet and a 2k top sheet per livery, cropped to the car and served as WebP from `public/liveries/<key>/{side,top}.webp` (`@1k` variants for phones; 1.6 MB for all five). The paint shader (`src/three/livery.ts`) picks the side or top sheet per surface from the car-space normal with a narrow wrap seam at the shoulder, keeps the procedural two-tone zoning as the base layer wherever a sheet has no coverage, and blends sheet A → sheet B along the same nose→tail wipe as the palettes. Decals are sampled in object space, so they stay fixed on exploded parts; the far (left) side mirrors the right sheet since it is never on camera. Per-livery finish (`coat`, `coatRough`, `flake` in `LIVERIES`) blends with the wipe too: matte navy, chrome-flake silver, gloss scarlet.

Layouts follow the 2024 cars (stripe pairs, black→silver fade, flashes and yellow nose, lime shoulders) with no logos or trademarks; the only lettering is PIT WALL, EVIDENCE FEED, CONTROLLER, AUDIT TRAIL, PW-01 and the car number.

Regenerating (needs the dev server and `higgsfield auth login`; 4.25 + 2.75 credits per livery):

```bash
node tools/ortho-sheets.mjs 4096          # clay references → livery/ref/{side,top}.png + frames.json
bash tools/liveries.sh scarlet            # Higgsfield CLI, same prompts as the shipped sheets → livery/gen/final/
python3 tools/pack-sheets.py scarlet livery/gen/final/scarlet-side.png livery/gen/final/scarlet-top.png
```

`pack-sheets.py` registers each result to the reference (the model drifts the car a few percent in the frame), masks it with the clay silhouette, reports how much paint still falls outside it, and writes the WebP variants. A livery with `sheets: false` in `src/three/state.ts` renders with the procedural zoning only. Review one livery across every scene with `?livery=navy` on the dev server, and screenshot the hold points with `node tools/shoot.mjs <prefix>`.

## Teardown choreography

Every exploded part is a `Pivoted`/`Exploded` group in `src/three/car/ProceduralCar.tsx` with a `PartSpec` (`src/three/car/explode.ts`): where it goes, how it tilts, when it leaves (`delay`/`span` inside the scene's 0→1 explode factor), how much it arcs on the way and how much it floats once detached. Progress is `easeOutBack(smoothstep(...))`, so parts settle with a small overshoot and come back in reverse order when the factor returns to 0. Parts register in a module-level set; `overlays/Tethers.tsx` draws a flowing dashed line from each detached part to its mount, the HUD counts parts out (`teardownStatus()`), the camera lens pushes 2° with the factor and the hero light sweep replays once when the car locks back together (`sceneState.flash`).

| Scene | Sequence |
| --- | --- |
| 01 Front wing | endplates fan out → flap 4 → flap 3 → flap 2 → mainplane forward → wheel nut spins off → wheel pulls off the axle → aero cover lifts off the spoked rim, all three on one ray from the hub and slowly turning (brake disc, caliper, axle stub and duct stay on the upright) |
| 02 Sidepods | pods lift and tilt → finned radiators slide out of the inlets → floor edge wings drop → mirrors lift; evidence streams into the radiators |
| 03 Cockpit | rear bodywork + engine cover lift as one shell off the power unit (the body is lofted in two pieces, split at the rear bulkhead) → halo rises → steering wheel lifts out; x-ray shell + reasoning graph |
| 04 Rear | DRS flap opens about its leading edge → flap lifts → mainplane + pylon → endplates fan → beam wing → diffuser drops → rear wheel nuts, wheels and covers |
| 05 / 06 | reverse order back to COMPLETE, flash, then the console handoff |

Callouts hide while the camera station is changing (`sceneState.settled`) and re-acquire once it holds.

## Generated assets in use

| Asset | Source | Where |
| --- | --- | --- |
| Livery sheets (5 × side + top) | GPT Image 2.5 on the clay ortho renders | `public/liveries/` |
| Pit-garage panorama | GPT Image 2.5 (21:9 → padded to 2:1 equirectangular, 2048×1024 JPEG) | `public/hdr/garage.jpg`, `CAR_ASSETS.envMap`; drawn into the environment map behind the strip softboxes and shown as a blurred backdrop |
| Power unit + gearbox mesh | GPT Image 2.5 product render → Tripo H3.1 image-to-3D (untextured) → `gltf-transform simplify/weld/quantize` from 1.96 M to 88 k triangles | `public/models/power-unit.glb`, `CAR_ASSETS.powerUnit` + `powerUnitTransform`; `car/fitToBody.ts` remaps every vertex into the hull's real cross-section between the fuel cell and the gearbox tail (body rings ∪ lower engine-cover triangle, 22 mm margin) so nothing pokes through the shell; rendered with the car's cast-alloy material, procedural V6 as fallback |

Review a GLB on a turntable with `?part=/models/power-unit.glb` (`&rot=1.57` for a fixed angle) on the dev server.

## Dropping in generated assets (Higgsfield or any other source)

Everything renders procedurally today; `src/three/assets.ts` is the single place to point at better assets later:

- `model` – a GLB of the car. `GlbCar.tsx` maps node names (`fw_main`, `fw_flap`, `fw_endplate`, `sidepod`, `mirror`, `engine_cover`, `halo`, `rw_main`, `rw_flap`, `rw_endplate`, `diffuser`, `_l` suffix for the left side) onto the same exploded groups, and re-binds materials named `paint`, `accent`, `carbon`, `rubber`, `matte`, `cover` to the livery system so liveries, x-ray and the exploded views keep working.
- `envMap` – an equirectangular panorama (`.hdr`, `.exr` or a 2:1 JPEG); composited behind the procedural softboxes and shown as a blurred backdrop. `null` falls back to the gradient dome.
- `powerUnit` – a GLB of the engine + gearbox with its long axis on local z; `powerUnitTransform` places it between `xFront` and `xRear`, and `fitToBody` deforms it into the hull (turn off for a hand-fitted mesh).
- `floor` – an albedo for the pit floor.
- `liveries` – override the base URL per livery key (default `/liveries/<key>`), e.g. to host the sheets on a CDN.

Put files under `public/models`, `public/hdr`, `public/textures`.

## Tuning

- Camera, explode amount and callouts per scene: `src/data/story.ts` (`station`, `callouts`). Anchors are in metres; nose is +X, the visitor's side is +Z, ground is y = 0.
- Teardown order, directions, tilt and arcs per part: the `PartSpec` props on each `Pivoted` in `src/three/car/ProceduralCar.tsx`.
- Livery palettes: `LIVERIES` in `src/three/state.ts` (team-inspired colourways, no marks). Zone logic (lower bodywork, nose tip, flank stripe, spine): `liveryZone` in `src/three/livery.ts`.
- Car shape: station tables in `src/three/car/buildCar.ts`.
- Studio light: softbox positions/intensities in `src/three/Studio.tsx`; post chain in `src/three/Effects.tsx`.

`tools/shoot.mjs` screenshots the scene hold points with the cached Chrome for Testing build (set `CHROME` to another executable); `window.__pw` (scene state) and `window.__gl` (renderer) are exposed in dev builds for it.
