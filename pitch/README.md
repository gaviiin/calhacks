# Anneal: the pitch page

The judges' page for Anneal, the autonomous race accountant. Standalone (Vite, TypeScript, three.js); it never talks to SpacetimeDB or the desks.

```bash
npm install
npm run dev      # http://localhost:5180
npm run build    # dist/, static: deploy the folder anywhere (Vercel: root directory pitch/)
```

The page, in order: the crash at Interlagos (scroll-driven, 3D), the problem, one crash through the team in eight steps, the São Paulo numbers, the demo, every feature and why, inside the hardware process learner, how the cap is forecast, how it fits together, the Hyphenate and SpacetimeDB tracks, how we are different, the stack.

| Path | What |
| --- | --- |
| `src/model/` | Copies of the dashboard's procedural car (`frontend/src/blueprint/model`, `catalog.ts`), built in a Web Worker. Prices in `catalog.ts` mirror `race/prices.py` |
| `src/hero/scene.ts` | The crash: blueprint paper shader, streaming track, barrier, skid marks, shards, camera path, the garage |
| `src/hero/debris.ts` | The crash physics, simulated once on load and played back by the scroll, so scrolling up un-crashes the car |
| `src/hero/overlay.ts` | Telemetry readout, captions, the paperwork windows (illustrative, no Williams documents), the garage's part tags |
| `src/hero/timeline.ts` | The scroll marks every layer reads |
| `src/sections/learner.ts` | A copy of `race/precedents.py` (similarity, match, Wilson bound) run on the 93 real cases São Paulo learns from (`src/data/cases.json`) |
| `src/sections/capsim.ts` | A copy of `race/cap_forecast.py`'s year-end model, 10,000 draws per change |

Figures come from `docs/PITCH.md`, the READMEs and the code; money is press estimates and stated assumptions, as everywhere in the repo.
