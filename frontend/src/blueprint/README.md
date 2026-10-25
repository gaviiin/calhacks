# Car blueprint

The race desk's car, drawn as an engineering sheet. An angled 3D view (drag to turn, hover a part to pull it out, click to pin it, Explode to take the car apart) over four rigid drawings: side elevation, front, rear and underside. Every part is priced from the race desk's price book and read for damage from what the desk knows about the car.

- `#/race`: the full stage (`CarBlueprint.tsx`), one tab per team car, with the parts list beside the sheet.
- `#/replay/<season>-<round>`: a compact sheet inside the replay's car stage (`ReplayBlueprint.tsx`), with the sponsors' zones as buttons on the car.
- `frontend/blueprint-dev.html`: the stage on its own with two made-up cars, no SpacetimeDB needed.

## How it is built

| File | What it does |
| --- | --- |
| `model/kit.ts`, `model/car.ts` | A reference car to the 2026 technical regulations, modelled procedurally in metres: lofted cross-sections, aerofoils, lathes and swept tubes. It is generic, not any team's car. |
| `model/mesh.ts` | Turns each part into triangles (depth, glass, picking), construction lines, open edges and creases, and silhouettes along x, y and z for the rigid views. |
| `model/worker.ts`, `load.ts` | Builds the car in a Web Worker (about 150 ms), once per page. |
| `engine/engine.ts`, `engine/shaders.ts` | One WebGL canvas behind the sheet, five scissored viewports. Lines are instanced screen-space quads with analytic anti-aliasing; each instance looks up its part's live offset and colour. The loop sleeps when nothing moves and 30s after the last touch. |
| `Sheet.tsx` | The views, dimensions, callout and sponsor markers laid over the canvas. |
| `catalog.ts` | The 34 drawn parts, mapped onto the 15 lines of `race/prices.py` (bands in GBP at $1.27, lead times, severity templates). Change a price there first, then here. |
| `condition.ts` | What the desk believes about a car's parts: the latest forecast that gave probabilities, else Jev's per-part P(damaged), else the severity a policy or precedent booked the crash at (read through the price book's template and the booking's memo), else nominal. |

Expected repair is P(damaged) times the price-book mid, summed, the same sum `race/effects.py` books, so the blueprint and the booked crash line agree.
