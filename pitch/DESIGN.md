# Anneal pitch: design

A persuade surface for Cal Hacks judges. The car is the ledger: the page opens on the car itself, drawn the way the dashboard draws it, and makes the visitor live one crash before any claim.

## World

- **Paper and lines.** White ground; every 3D object is white paper with a blue-grey fresnel shade (`#ffffff` to `#c3d3ea`), deep-blue edges (`#0747a6`, 1.15 px anti-aliased) and faint construction lines (`#4c9aff` at 28%). The track is `#f4f5f7` asphalt with a 2 m and 10 m measuring grid; kerbs and the barrier alternate Atlassian blue `#0052cc` and white.
- **Red is rationed.** `#de350b` / `#bf2600` appear only for the red flag, the impact arrow, overspend bins, late finance and destroyed parts (always with a "Destroyed" label).
- **Neutrals.** Ink `#172b4d`, navy `#091e42` for display type, greys `#f4f5f7` / `#ebecf0` / `#dfe1e6` / `#6b778c` / `#505f79`.
- **Type.** Archivo, variable width: 118-125 expanded italic 800-900 for display (livery lettering), 85 condensed uppercase for labels and table heads, 100 for body. JetBrains Mono only for measured figures, telemetry, code and race-control lines.

## Grammar

Racing objects carry the information, not cards: a telemetry readout, a sector rail, race-control capitals for sourced facts, a timing tower for the proof figures (chequered last row), an accounting schedule with a double-ruled total for the cap, a blueprint-blue sheet (`#0747a6` with a 24/120 px grid) for the learner, kerb strips between chapters, a chequered strip at the close.

## Motion

One authored moment: the scroll-scrubbed crash (lap, impact with a short shake and white flash, red flag, paperwork piling up and collapsing, parts flying into the garage as an exploded drawing with priced tags). Elsewhere motion is quiet: step panels brighten as they centre, counters ease out, one packet travels the system diagram. `prefers-reduced-motion` removes the easing, counters, marquee and diagram packets.

## Responsive

Below 760 px the camera widens, the HUD spans the width, the paperwork shows seven windows and the garage three tags; the method steps become a sticky horizontal strip; tables scroll inside their frames.
