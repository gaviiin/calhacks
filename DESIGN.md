---
name: Pit Wall
description: The finance desk of Meridian Racing. Agents propose, people approve, the gateway posts, and the whole shift runs on one clock.
colors:
  bg: "#07090c"
  panel: "#0c1118"
  panel-2: "#111823"
  raise: "#151d29"
  line: "#2b323a"
  line-soft: "#1b222b"
  ink: "#f3f3f0"
  steel: "#aab5bc"
  muted: "#8f98a1"
  lime: "#c9ff4b"
  lime-hover: "#d7ff74"
  lime-wash: "rgba(201, 255, 75, 0.1)"
  on-lime: "#06080a"
  hold: "#ffb547"
  hold-wash: "rgba(255, 181, 71, 0.1)"
  alert: "#ff725f"
  alert-wash: "rgba(255, 114, 95, 0.1)"
  s1: "#6d7a84"
  s2: "#f3f3f0"
typography:
  display:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.035em"
  headline:
    fontFamily: "Barlow Condensed, Roboto Condensed, Arial Narrow, sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.035em"
  title:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  label:
    fontFamily: "DM Sans, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
  figure:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    fontFeature: "tnum"
  figure-strong:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, monospace"
    fontSize: "13px"
    fontWeight: 600
    fontFeature: "tnum"
  axis:
    fontFamily: "IBM Plex Mono, ui-monospace, Menlo, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    fontFeature: "tnum"
rounded:
  xs: "1px"
  sm: "2px"
spacing:
  stack: "2px"
  tight: "6px"
  inline: "8px"
  row: "12px"
  gap: "16px"
  panel-y: "18px"
  panel-x: "20px"
  gutter: "24px"
components:
  button-primary:
    backgroundColor: "{colors.lime}"
    textColor: "#0b0f10"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "38px"
  button-primary-hover:
    backgroundColor: "{colors.lime-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 15px"
    height: "38px"
  button-secondary-hover:
    backgroundColor: "{colors.raise}"
  filter:
    backgroundColor: "transparent"
    textColor: "{colors.steel}"
    rounded: "{rounded.sm}"
    padding: "0 11px"
    height: "32px"
  filter-on:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
  flag-approved:
    backgroundColor: "{colors.lime-wash}"
    textColor: "{colors.lime}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
  flag-waiting:
    backgroundColor: "{colors.hold-wash}"
    textColor: "{colors.hold}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
  flag-refused:
    backgroundColor: "{colors.alert-wash}"
    textColor: "{colors.alert}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "5px 9px"
  check-pass:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.steel}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
  check-fail:
    backgroundColor: "{colors.alert-wash}"
    textColor: "{colors.alert}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.sm}"
    padding: "18px 20px"
  inbox-row:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
  inbox-row-selected:
    backgroundColor: "{colors.raise}"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    height: "36px"
  nav-item:
    textColor: "{colors.muted}"
    typography: "{typography.control}"
    padding: "20px 12px 18px"
  nav-item-active:
    textColor: "{colors.ink}"
  nav-count:
    backgroundColor: "{colors.hold-wash}"
    textColor: "{colors.hold}"
    rounded: "{rounded.sm}"
    padding: "1px 6px"
  tooltip:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    width: "260px"
  brandmark:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.on-lime}"
    width: "38px"
    height: "26px"
---

# Design System: Pit Wall

## Overview

**Creative North Star: "The Shift on One Clock"**

Pit Wall is a race team's finance desk read the way a pit wall reads a race: one dark ground, a few hairlines, and one bright signal that means a human made the call. Every actor (FIA feed, sync job, Claude seats, standing approvals, the two people, the ERP gateway, the red team) gets a lane on a shared time axis, so separation of duties is something you see, not something you are told. The landing page (`landing/`) is the parent world; the dashboard keeps its ground, hairlines, lime and three faces, and drops its theatre (livery glow, scene shadows, looping cues) for reading sizes and working density.

The surface is dense and calm. Panels are flat slabs one step lighter than the ground, edged with a hairline and cornered at 2px. Text is DM Sans at 14px; numbers, ids, codes and times are IBM Plex Mono with tabular figures; only page and section headings speak in Barlow Condensed capitals. Colour is almost entirely neutral, so that the three status lamps (lime approved, amber waiting, coral refused) carry their meaning by contrast with everything else. Summaries are sentences and definition lines with the figure inline, never a wall of KPI tiles. The why sits next to the number.

Dark only. The stylesheet declares `color-scheme: dark` and there is no light theme; do not add one.

**Key Characteristics:**
- Near-black ground with tonal panels and hairline edges; no elevation except the floating tooltip.
- Lime is a person's signature or the button that lets them sign; amber is waiting; coral is refused. Each ships with an icon and a word.
- Barlow Condensed capitals for h1 and h2 only; DM Sans for everything a person reads or clicks; Plex Mono for every figure.
- 2px corners throughout; the skewed lime brandmark is the only slanted shape.
- One motion moment: the cap track wipes in left to right. Everything else is a 160ms state change.

## Colors

A cool-graphite neutral ramp with one lime signal and two status lamps, all on a single dark ground.

### Primary
- **Signature Lime** (`lime`): a person's approval and the primary action, nothing else in the work. It fills the Approve, Approve policy and Send answer buttons and the revenue desk's replay actions, the posted segment of the cap track ("Posted, approved by a person"), the bins in the two person lanes of the shift, Approved and Posted flags, approved policy states, and the success outcome after a decision. The brand also carries it in its own marks: the brandmark, the "WALL" half of the wordmark, the 2px current-desk underline, the focus ring and text selection, all inherited from the landing world.
- **Signature Lime, pressed bright** (`lime-hover`): the primary button's hover fill and border only.
- **Lime Wash** (`lime-wash`): the 10% tint behind an Approved flag or a success outcome, with a 45% lime border on flags.

### Secondary
- **Pit Lane Amber** (`hold`): waiting for a person. The inbox count in the nav, "for Controller / for Head of Cost Cap" on every inbox row, Waiting and Question flags, proposed policy states, parked revenue entries, the materiality warning in the why pane, and the "now" line on the shift's time axis. **Amber Wash** (`hold-wash`) sits behind the nav count and waiting flags.

### Tertiary
- **Stewards' Coral** (`alert`): refused or breached. Denied crosses on the lane that tried, refused outcomes, failed kernel checks, rejected policies, the run-rate marker and statement when the year lands over the cap, the +5% material-breach line, infringement documents on the weekend timeline. **Coral Wash** (`alert-wash`) backs failed checks, refused outcomes and FIA decision extracts; refused rows in the audit table carry an even fainter 4% coral tint.

### Neutral
- **Pit Black** (`bg`): the page ground, the shell (at 92% with a 10px backdrop blur), and the inside of text fields.
- **Garage Slate** (`panel`): every panel: cap track, shift, waiting list, why pane, bars, policies, revenue and audit sections.
- **Slate, one step up** (`panel-2`): inset surfaces inside a panel: inbox rows, regulation quotes, policy cards, alert items, code spans, passed kernel checks, the decision bar, the active filter, hovered table rows.
- **Slate, raised** (`raise`): the selected inbox row or table row, button hover, outcome boxes, the tooltip.
- **Hairline** (`line`): control borders (buttons are steel; filters, selects, fields are this), table header rules, the shell's bottom rule, lane baselines, the decision bar's top edge.
- **Soft Hairline** (`line-soft`): panel edges, row dividers inside tables and the why pane, gridlines, the cap track's empty bar, the colophon rule.
- **Paddock White** (`ink`): primary text, the cap line on the track, selected filter borders.
- **Steel** (`steel`): secondary text, h3 labels, agent and system activity on the shift, the proposed segment of the cap track, cost bars, secondary button borders.
- **Muted Steel** (`muted`): tertiary text, axis labels, table headers, field labels, inactive nav, the unclassified outline on the cap track.
- **Series Slate** (`s1`) and **Series White** (`s2`): the two chart series, taken from the world's neutrals (base fees and prize money, performance bonuses on the revenue season chart and its tooltip).

### Named Rules

**The Signature Rule.** In the work, lime means a person signed it or this is the button that lets them sign. If a lime pixel cannot be traced to a human approval or the primary action, it is wrong.

**The Three Lamps Rule.** Lime approved, amber waiting, coral refused, and each lamp ships with its icon (check, clock or question, cross) and a word ("Approved", "Waiting for the Controller", "Rejected"). A lamp colour on text without an icon is drift, not precedent.

**The Neutral Series Rule.** Data series are the world's greys (`s1`, `s2`, `steel`, `muted`). The three lamps never encode a series, so a coloured mark on a chart always means a status.

The build currently also lights lime on the live-source indicators in the shell, the "seat held by this browser" note, passed kernel-check icons, the allowed marks in the why-pane trail and audit table (including agent and gateway steps), the trial-balance proof line, the "inside the cap" run-rate sentence, and link hovers. These predate the rule's enforcement and are not precedent for new surfaces. Amber on the shift's "now" line is the one non-waiting use of amber.

## Typography

**Display Font:** Barlow Condensed (with Roboto Condensed, Arial Narrow)
**Body Font:** DM Sans (with system-ui)
**Label/Mono Font:** IBM Plex Mono (with ui-monospace, Menlo)

**Character:** A motorsport condensed capital for the few words that name a place, a humanist sans for everything a person reads or clicks, and a plain monospace that makes every figure line up like a timing screen.

### Hierarchy
- **Display** (700, 30px, 1.05, 0.035em, uppercase): the h1 of a desk page: Inbox, Revenue desk, Evidence, Audit log.
- **Headline** (700, 21px, 1.1, 0.035em, uppercase): panel headings: Cost cap 2026, The shift, Waiting for a person, Where January went, House policies.
- **Title** (DM Sans 600, 13px, 1.35, steel): h3 labels inside panels and the why pane ("What it considered", "Trail", "Kernel checks, re-performed from source"), often led by a 14px icon.
- **Body** (DM Sans 400, 14px, 1.5): running text; explanatory paragraphs cap at 64 to 72ch, regulation quotes and reasons at 1.6 line height. The cap statement reads at 17px steel with the figures in ink.
- **Control** (DM Sans 600, 13px): buttons, the seat select, nav items (13.5px).
- **Label** (DM Sans 600, 12px): flags, inbox kind labels, filters (12.5px), treatment tags (11px). Sentence case, never tracked capitals.
- **Figure** (Plex Mono 400, 12.5px, tabular): amounts, ids, policy keys, check ids, times. **Figure Strong** (600, 13 to 14px) for the headline value of a legend or desk line.
- **Axis** (Plex Mono 500, 10.5px, tabular, muted): chart ticks, the cap track axis, "now".

### Named Rules

**The Two-Headline Rule.** Barlow Condensed capitals belong to h1 and h2 only. Body, labels, buttons and numbers never set in Barlow. The one sanctioned exception is the why pane's title, which carries a record's own name: it sets in Barlow at 22px in the record's own case (a memo, an invoice), and a policy key sets in Plex Mono 600 at 16px because it is a code.

**The Timing Screen Rule.** Every money amount, id, code, time and check result is Plex Mono with tabular figures, right-aligned in tables. A number set in DM Sans is a bug.

## Layout

The page is a single centred column, max 1480px, padded 22px top, 24px sides, 48px bottom. Work views stack full-width panels on a one-column grid with 16px gaps. The overview reads top to bottom: the cap track, the shift (nine possible lanes, 30px each, labels in a 188px gutter that shrinks to 116px below 560px of chart width), then a split of the waiting list beside the why pane, then the desk lines. The split is `list | why` with the why pane at 380 to 500px; the audit view is `table | 380px permissions matrix`. Both side panes are sticky 78px from the top, under the 62px sticky shell, and scroll internally.

Panels pad 18px by 20px; the why pane is padding-free and divides its sections with soft hairlines at 16px by 20px. Inbox rows sit 2px apart. Within panels the rhythm is 6px between chips and filters, 8px between buttons, 12 to 14px between a heading block and its content.

Responsive behaviour: at 1180px the shell's sources and seat wrap to a second row, and both splits collapse to one column with the side pane un-stuck. At 720px the shell stops being sticky, the nav becomes a horizontal scroller with a right-edge mask fade, the live-source indicators hide, the gutter drops to 16px, panels pad 14px, and inbox rows, key-value lists, trails and policy rows reflow to one or two columns. The dashboard works at phone width for an approver away from the desk.

## Elevation & Depth

Flat. Depth is tone, not shadow: Pit Black ground, Garage Slate panels, one step up for inset surfaces, one more for selected and raised states, each step edged by a hairline. The sticky shell separates itself with a 92% ground fill, a 10px backdrop blur and a hairline bottom rule. The landing world's livery glow and scene shadows stay on the landing; the dashboard has none.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45)`): the chart tooltip on the shift and the revenue charts. Nothing else.

### Named Rules

**The Ground Plane Rule.** Panels sit on the ground; they are never lifted. If something needs to feel above the page, it is a tooltip, and it is the only thing that casts a shadow.

## Shapes

Machined, not soft. Every container, control, chip, flag, field, tooltip and track corner is 2px; colour keys, legend swatches and shift bins round to 1px. Lines are 1px hairlines, with 2px reserved for emphasis: the current-desk underline, the cap line on the track, the focus ring (2px lime, 2px offset). Regulation quotes and timeline moments are marked by a 1px left rule (steel for regulation, amber or coral for a moment's status), not a box. The cap track's unclassified segment is an inset 1px outline, empty inside. The run-rate marker is a small solid triangle pointing up at the track.

The only slanted form is the brandmark: a lime block skewed -12deg and clipped to a parallelogram.

**The 2px Rule.** Corners are 2px or 1px. No pills, no circles on containers, no radius above 2px. (The cost-cap bars currently round their right end at 3px; treat that as drift.)

## Components

### Buttons
Square-shouldered and quiet until one is lime.
- **Shape:** 2px corners, 38px tall, 15px side padding, DM Sans 600 13px, 7px gap to a 14px icon.
- **Primary:** Signature Lime fill and border with near-black text. Used once per decision bar for the human's affirmative act ("Approve", "Approve policy", "Approve as Dana Okafor", "Send answer") and for the revenue desk's replay actions ("Replay 2024 to Spa", "Run the Belgian Grand Prix weekend").
- **Hover / Focus:** primary brightens to the hover lime; secondary moves its border from steel to ink and fills with the raised slate. 160ms on the expo-out ease. Focus is the global 2px lime ring.
- **Secondary:** transparent with a steel border and ink text; Reject, Advance, Run the independent audit.
- **Disabled:** 38% opacity, not-allowed cursor. Buttons disable while no seat is held or no reason has been typed.

### Chips
- **Status flags:** 5px by 9px, 2px corners, label type, an icon then a word, on the lamp's wash with a 45% lamp-colour border. Approved/Posted (check), Waiting for / Question for a person / Parked for (clock or question), Rejected (cross).
- **Filters:** 32px tall, hairline border, steel text, a muted mono count; on hover the border goes steel and text ink; selected is ink border, ink text, one-step-up fill. They act as tabs (`role="tab"`).
- **Treatment tags:** 11px label, 1px hairline, 2px corners; inside the cap uses a steel border with ink text, outside is muted, adjustment is an ink border.
- **Kernel checks:** mono 11.5px chips; a pass is steel text on the one-step-up slate with a lime check, a fail is coral on coral wash with a cross.

### Cards / Containers
- **Corner Style:** 2px.
- **Background:** Garage Slate on Pit Black.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 1px soft hairline.
- **Internal Padding:** 18px by 20px; 14px at phone width. Inset blocks inside (regulation quotes, policy cards, alerts) use the one-step-up slate with 10 to 14px padding and no border.

### Inputs / Fields
- **Style:** Pit Black fill (darker than the panel it sits in), 1px hairline, 2px corners, 36px minimum height, 8px by 10px padding; labels above in muted 12px.
- **Focus:** the border shifts to steel; no glow.
- **Disabled:** 50% opacity.
- **Select:** the seat and view selects share the field shape on the panel fill with a drawn muted chevron, 34px tall, steel border on hover.

### Navigation
The shell is a sticky 62px bar: brand lockup, desk tabs, then live sources and the seat select. Desk tabs are DM Sans 600 13.5px in muted, ink on hover, ink with a 2px lime underline sitting on the shell's bottom hairline when current. The Inbox tab carries an amber count chip in mono. Live sources are mono 11px labels with a live icon (lime when reachable, coral when down). At phone width the tabs scroll horizontally and the sources hide.

### Cap Track (signature)
Relevant Costs against the cap on one 18px bar on the soft-hairline fill: a lime segment for posted (approved by a person), a steel segment for proposed by the agents, a 1px muted outline for still to classify, each separated by a 2px gap. A 2px ink line marks the cap, a 1px coral line the +5% material breach, and a steel triangle (coral when over) marks the run rate labelled for what it is ("January × 12"). Mono axis ticks sit below; a legend of definition lines gives each segment's label and figure. The bar enters with the system's one motion moment: a 900ms clip-path wipe from left to right on the expo-out ease (`cubic-bezier(0.22, 1, 0.36, 1)`), disabled under reduced motion.

### The Shift (signature)
A swim-lane chart, one lane per actor, binned on one shared time axis. Agent, system and evidence activity is steel (evidence at 60%); the two person lanes are lime. A refused attempt is a 7px coral cross on the lane that tried it, at the top of the lane. Each lane label carries its count, its refused count, and a one-line note of what that actor may do. A muted gridline sits at each nice time step; the amber "now" line marks the present. Hovering shows an ink crosshair and the tooltip; clicking opens those rows in the audit log.

### Inbox Row and Why Pane (signature)
Each waiting item is a full-width button on the one-step-up slate: a kind column (14px icon plus Policy, Revenue entry, Question or Claude proposal), the title and proposal on two lines, the mono amount, and an amber "for Controller" on the right. Hover adds a hairline; selected raises the fill and outlines in steel. The why pane beside it is one panel split by soft hairlines: head with status flag, proposal and treatment tag, regulation quote, what it considered, the trail (mark, time, who, what, with refused steps in coral), and a sticky decision bar at the foot with the reason field, the lime primary and the steel Reject.

### Brandmark
A 38 by 26px lime block, skewed -12deg and clipped to a parallelogram, holding "PW" in Barlow 800 13px near-black. Beside it the wordmark "PIT WALL" in Barlow 800 19px at 0.08em tracking, "WALL" in lime, over the lockup line "MERIDIAN RACING · FINANCE DESK". The favicon is the same lime parallelogram.

## Do's and Don'ts

### Do:
- **Do** keep lime for a person's approval and the primary action (plus the brand's own marks and the focus ring), so a lime pixel always means a human signed.
- **Do** pair every status with its icon and a word: check + "Approved", clock + "Waiting for the Controller", cross + "Rejected" or "refused".
- **Do** show a refused attempt where it happened: a coral cross on the lane that tried, a coral outcome in the why pane, a 4% coral row in the audit table.
- **Do** set every figure, id, code and time in IBM Plex Mono with tabular figures, right-aligned in tables.
- **Do** build depth from the four tones (ground, panel, inset, raised) and two hairlines (`line-soft` for panel edges and row dividers, `line` for controls, table heads and the shell rule).
- **Do** use the desk's own icon set: 16px grid, 1.6 stroke, square caps, miter joins, `currentColor`.
- **Do** put the figure inside a sentence or a definition line ("$X of Relevant Costs posted against a $215m cap"), with the why next to it.
- **Do** keep 2px corners on everything that has a corner.

### Don't:
- **Don't** add a light theme; the desk is dark only.
- **Don't** colour a data series, a hover, a connection indicator or a decoration lime, amber or coral; chart series are `s1`, `s2`, `steel` and `muted`.
- **Don't** let a status colour stand alone on a word or a dot without its icon.
- **Don't** set body text, labels, buttons or numbers in Barlow Condensed, and don't track small labels into spaced capitals.
- **Don't** lift dashboard panels with shadows or glows; only the tooltip floats.
- **Don't** round anything past 2px or make a pill.
- **Don't** animate content in. The cap track's wipe is the one motion moment; everything else is a 160ms state change, and all of it stops under reduced motion.
- **Don't** summarise a desk with a row of KPI tiles.
