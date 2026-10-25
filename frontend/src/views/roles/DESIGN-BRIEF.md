# Race-day views: design contract (Williams garage)

THESIS: each person's view is a few live instruments that update in place (the car, the track, the money, the chances), not paragraphs. Refuse: walls of KPI tiles, cards-of-icon-heading-text, eyebrows above headings, prose explaining what a number is.

OWN-WORLD: Williams garage white. Cool gray ground (--bg #eef1f5), white panels (k-panel: 1px --line-soft border, 6px radius, soft offset shadow), navy ink (--navy #041e42 for figures and headings, --ink for text), Williams blue (--lime token, #0a5bd8) ONLY for a person's action/approval and the primary button, amber (--hold) waiting, red (--alert) refused/off. Data series: navy and sky (--sky #00a3e0) and gray. The blueprint car stays a navy engineering sheet. Headings: Barlow Condensed caps 15px (k-panel h2). Body DM Sans 13-14px. Every figure, time, id: IBM Plex Mono tabular.

RULES
- First principles: what does this person decide or watch? Put that first, largest. Everything else is secondary or behind a disclosure (<details>) or a hover title.
- At most ONE short line of prose per panel; replace descriptions with a visual: Stack (shares), Meter (value vs limit), Axis (events on a time line), Odds (probabilities), Pill (status icon + word), Figure (one number + label + delta). Import from ./kit.
- Remove repeated explanations, basis strings and source text from the main view; keep them in title= tooltips or a single "Basis" <details> at the bottom.
- No section numbers, no eyebrows, no colored border-left above 1px, no gradient text, no emoji/unicode as icons (use components/icons).
- Status is never colour alone (Pill does icon + word).
- Density: 8px grid; 12-16px gaps; panels in a CSS grid; it must work at 375px (stack) and 1440px.
- States: empty (a one-line hint of what will appear), loading (skeleton bar), live updates in place (no layout jumps).
- Copy: plain words, controls name their action ("Approve", "Choose withdraw").
