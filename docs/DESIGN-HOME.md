# Design spec: the parts-first dashboard

Working name in this file: **Anneal** (see names.md). Swap the wordmark; nothing else depends on it.

One sentence for the implementer: **a light Williams-garage page with one dark glass display case in it; the car sits in the case, the parts ledger sits beside it, and everything else is an instrument that answers "what did the race do to the parts, and what did that do to the money".**

Tokens and surface classes live in `glass-tokens.css` (import it after `styles.css`). Class names below refer to it.

---

## 0. The five decisions

1. **Light page, dark stage.** The page stays Williams garage (cool gray ground, white glass, navy ink). The car lives in one dark navy glass "stage" (`.glass--dark`), the only dark object on the page, so it is the highest-contrast thing in the first viewport and reads as front and center by luminance alone. Arguments against going all-dark: the CFO and accounting content (entries, amounts, rules, audit rows) is long-form mono text that reads better dark-on-light; the current identity is light; and a dark page would make the stage disappear into it. The stage also casts a faint blue light spill onto the ground beneath it (`--g-stage-spill`), which is the "display case" effect.
2. **One car drawn, both cars present.** One WebGL instance (one context, one engine). The other car is never hidden: each car tab on the stage carries an 11-cell heat strip of its parts in the current lens.
3. **Four lenses: Life (default), Condition, Cap, Cost.** Life is the thesis ("the car is the ledger"), so it is the default; the stage auto-switches to Condition while a car is stopped or an incident is unassessed (today's rule), and back to Life when assessed.
4. **One drill-down pattern: peek, sheet, route.** Hover (or tap) shows a peek; click opens a right side sheet; the sheet's footer links to the full role view. Nothing expands in place (layout must not jump at 4 re-renders/s).
5. **Fake glass for panels, real glass only where it floats.** Grid panels get translucency over a static, pre-blurred mesh ground (no `backdrop-filter`). Real `backdrop-filter` only on the top bar, the stage overlays, peeks, the side sheet and toasts.

---

## a. Information architecture

### Top-level nav (top bar, 56px, sticky, `.glass--bar`)

```
[glyph ANNEAL]   Car · Garage · Strategy · Books · Audit        [▶ Replay  L32  ↺]  [●●●●●● services]  [Inbox 37]  [seat ◉]
```

| Nav item | Route | What it is | Today's source |
|---|---|---|---|
| **Car** (home) | `#/` | The new home, built around the stage | new `HomeView` |
| **Garage** | `#/day/garage` | Engineers, chief mechanic, Team Principal | `PitWallView` (drill-down) |
| **Strategy** | `#/day/strategy` | Head of strategy | `StrategyView` |
| **Books** | `#/books/:tab` | Sub-tabs: **Entries** (`AccountingView`) · **Cap** (`CFOView`) · **Ledger** (today's `BooksView`) | merged |
| **Audit** | `#/audit` | Proof + audit rows + rules | `AuditTabsView` + `PitWallProof` |
| Inbox | `#/inbox` | Badge button on the right, not a tab | `InboxView` |

- The old "Race day" tab and the Garage | Strategy | Accounting | CFO sub-tab row both go away: roles are top-level now, and "Accounting" + "CFO" fold into Books.
- The seat selector moves into an avatar menu (`seat ◉`), 32px circle with the role initials; "read only" shows as a lock glyph on the avatar.
- Services (OpenF1, SpacetimeDB, Jev, Claude, ERP, Notify): six 8px lamps in one cluster; hover peek lists name + state word. Not words in the bar.
- Replay control (demo-critical) lives in the bar: `Replay` button (play/pause glyph), the lap as a mono chip `L32`, reset glyph. Reuse `ReplayControl.tsx`.
- Nav active state: ink text + a 2px Williams-blue bar under the label (inside the 56px), never a filled pill.

### Home: first viewport at 1440×900

```
y=0    ┌─ top bar 56 ─────────────────────────────────────────────────────────────────────┐
y=72   │ alert rail 40: [✕ 2 Grid penalty] [✕ 3 Damaged] [◷ 3 To decide] [? 1 Question]   │
y=128  ┌──────────────── STAGE (cols 1–8, 912×520, dark glass) ──────┐┌─ PARTS (9–12) ──┐
       │ [23 ALB P14 ●Running ▮▮▮▮▮▮▮▮▮▮▮][43 COL OUT ✕ ▮▮▮…]  flag L32 tyre  [Life|Cond|Cap|Cost] ⤧ ││ 11 rows,        │
       │                                                         ││ life bars,      │
       │                hero drawing (iso, explodable)           ││ due, spare,     │
       │      [Gearbox · Penalty QAT]   [Floor · Damaged]        ││ cap $           │
       │ legend                         [⚡ 315 km/h · 3 g · L28] ││                 │
       │ ─ side ── front ── rear ── underside (compact strip) ── ││ footer: $1.2m   │
y=648  └─────────────────────────────────────────────────────────┘└─────────────────┘
y=664  ┌──────── RACE TIMELINE (cols 1–8, 236) ──────────────────┐┌─ AGENT (9–12) ──┐
       │ track / 23 / 43 / agent swimlanes + cost step line      ││ Needs you (3)   │
y=900  │ (fully visible)                                         ││ cards…  ▼ fold  │
```

Above the fold: alert rail, stage, parts ledger, race timeline, the top of Agent activity (its "Needs you" cards). That is the whole pitch in one screen: the car, the parts' lives, what the race did by lap and what it cost, what the agent did and what waits for a person.

Below the fold (in order): Cost cap, Spares & factory (row C, Agent activity continues in cols 9–12), then Season odds, Running order, Proof (row D), then one `Basis` disclosure (assumptions from `race/life.py` and the price book) at the very bottom.

A click or hover away: every part's full life story (part sheet), the incident chain (incident sheet, today's `IncidentFlow` steps + `BeliefHistory`), entry lines, rule hits, running order gaps, sim history, latency detail.

---

## b. The hero (the stage)

### Frame

- `.glass--dark.stage`, cols 1–8, 912×520 at 1440. Radius `--r-stage` (20px). The blueprint's `Sheet` renders inside with `variant="compact"`; set `--r-lg: 16px` on `.stage` so `.bp-sheet` (which reads `var(--r-lg, 2px)`) rounds to match, inset 4px from the stage rim (the 4px rim is the glass edge: a lighter navy band with the specular highlight; the drawing paper sits in it like a sheet in a frame).
- Override heights on home only: `.stage .bp-sheet--compact .bp-hero { height: 392px }`, `.stage .bp-sheet--compact .bp-views { grid-template-rows: 112px }`. Total 392 + 112 + 2×4 rim + borders ≈ 520.
- Hide the existing `.bp-head` title block ("Car blueprint / Reference 2026 chassis…") on home: that subtitle is the kind of sentence the founder wants gone. Its car tabs, lens control and Explode move into overlays (below). Keep `.bp-hints` but collapse to one glyph (`?`) whose peek lists "Drag to turn · Hover to pull out · Click to pin · E explode".
- The 372px parts column inside `BlueprintStage` (`.bp-body` second column) is not used on home; the Parts ledger panel replaces it (it is the same data plus life, spares and cap). Easiest build: a new `HomeStage` that renders `Sheet` directly with the same state hooks as `BlueprintStage` (lift `pointer`, `rowHover`, `pin`, `lens` into a small `useStageState()` context shared with the ledger).

### Overlays (all `.glass-chip--dark`, real backdrop blur 12px, max 6 on the canvas at once)

| Position (inside hero, 16px inset) | Overlay | Content |
|---|---|---|
| top-left | **Car tabs** (2 × 208×60, gap 8) | number Barlow 800 30px; code DM Sans 600 12px caps; position mono `P14` or `OUT`; status lamp + word (`Running`, `In the pit`, `Stopped?`, `Out`, `DNS`); under them an **11-cell heat strip** (each cell 14×5, gap 2, radius 1) toned by the current lens, cells in ledger order. Selected tab: brighter fill `--g-dark-chip-on`, 1px `--g-dark-edge-hi` ring. Keys `1`/`2` switch. |
| top-right | **Lens switch** + **Explode** | `.seg--dark` 4 segments `Life · Condition · Cap · Cost` (28px tall), then a 28px square Explode glyph button (`ExplodeIcon`), `E` key. |
| top-center (right of the car tabs, flows left) | **Race strip** | flag lamp + word (`Green`, `SC`, `VSC`, `Red`, `Chequered`); `Race · L32/71` mono with a 64×3 lap progress bar; tyre ring glyph (16px ring, compound letter `S/M/H/I/W` in it, ink-colored, never red/amber: those are status colors) + age `12L`; gap `+4.312`; last pit `P L18`. One chip, 32px tall. Hover: peek with running order top 5 around our car. |
| bottom-left | **Legend** | 3 or 4 swatch+word pairs for the lens (see lens table), 11px labels. |
| bottom-right | **Incident chip** (only when the car follows an incident) | `IconBolt` + `315 km/h · 3.0 g · L28 · Heavy` + belief version `v6` in a small mono tag. Coral lamp if severity ≥ moderate. Click opens the **Incident sheet**. |
| on the car | **Part markers** (`SheetMarker`, max 4) | Damaged, due-with-penalty, no-spare parts only: lamp + `Gearbox · Penalty QAT`, 24px tall. They follow the part on turn/explode (the Sheet already does this). Click = pin. |

### Lenses (`tonesFor` gets two new branches; no shader change: `PartTone` is color/level/ink/pulse)

| Lens | Question | Tone rule (dark-stage colors from `--g-life-d-*`, palette.ts) | Legend |
|---|---|---|---|
| **Life** (default) | How much life is left? | `t = usedPct/100`; color = life ramp on dark (0 `#66c4ff` → .6 `#8aa6d6` → .75 `#ffb547` → .9 `#ff8f4f` → 1.0 `#ff7360`), `level = 0.7 + 0.6·t`, `pulse` when status `due` with a penalty. `replaced` parts: `PALETTE.hi`, level 1.25 (new metal shines). | `New` · `Healthy` · `Watch ≥75%` · `Due` |
| **Condition** | Is it damaged now? | today's rule (P(damaged) ≥ 0.5 coral pulse, ≥ 0.25 amber, else line blue; unknown while assessing) | `Nominal` · `Possible` · `Likely damaged` |
| **Cap** | When does its replacement count? | next replacement lands in **2024** → `hold` amber, level 1.1; **brought forward** this weekend (`broughtForwardCents > 0`) → amber + pulse; **replaced this weekend** (booked) → `hi`, level 1.25; **lasts the season** (`dueEvent = "2025"`) → `PALETTE.unknown`, level 0.5 (recedes); **grid penalty** → coral + pulse. | `Booked` · `Counts 2024` · `Pulled into 2024` · `2025` · `Penalty` |
| **Cost** | What is it worth? | today's sqrt ramp `costLo → costHi` | `$ → $$$` ramp swatch |

Blueprint parts without a `race_part_life` row borrow one: `rear_brakes → brakes`, `steering_rack → front_suspension`, `wheel_speed_sensor → electronics`; `tyre` uses tyre age / stint (`STINT` table) in Life and recedes (level 0.5) in Cap.

### Part callout (hover a part, or hover its ledger row; existing `Callout` slot)

Dark raised chip, 288px wide, 12px padding, anchored by the Sheet. Content top to bottom, every line a label + an indicator, no sentences:

```
GEARBOX                              car 23   ← Barlow 700 16px caps, car mono 11px
◉ Condition   ▕▓▓░░░░░░▏ 18%                  ← lamp + P(damaged) mini meter 96×4
◔ Life        [life-bar 132×6]  86% · 700 km  ← used %, km left
◷ Due         Qatar  ·  Penalty               ← due race short; penalty pill if capNote matches
▦ Spare       ●● track  ● Grove  ◌ make       ← pip groups (counts after reservation)
$ Price       ├──●──┤ $495k  ($381–597k)      ← range bar 96×4, mid mono, band in peek-size mono
⊟ Cap         [2024] +$495k pulled in         ← year pill (amber 2024 / neutral 2025), brought-forward $
```

Pinned (click): the callout stays, gains two buttons at the bottom: `Open part` (side sheet) and `Esc`.

### Pointing at each other

- Hover ledger row → `rowHover` → Sheet `highlight` + pull-out (existing `highlightPull`) + callout on the part's `PRIMARY` anchor; the row gets `.is-lit` (`--g-lit` wash + lamp scales 1.25).
- Hover part on canvas → `pointer` → its ledger row gets `.is-lit`; the car-tab heat-strip cell for that part gets a 1px white ring. No auto-scroll (11 rows fit).
- Click either → pin (existing `pin` state); pinned row shows a 2px inset ring `--g-focus` (a ring, not a colored left border).
- Hover a part marker or the incident chip → the parts it names light (`partsFor`).

---

## c. Panel inventory

All grid panels are `.glass` (fake glass) with `.g-panel-head`: title Barlow Condensed 700 14px caps 0.08em navy, left; one `aside` (a mono figure or a control), right; the full panel description lives in the title's `title=` attribute. Every panel header has an `↗` (16px glyph button) on the far right that opens its sheet; the whole header is also the click target.

| # | Title | Primary indicator (chart form) | Secondary figures | Hover (peek) | Click (sheet) | For |
|---|---|---|---|---|---|---|
| 1 | **Stage** (no title; the car tabs are the title) | the WebGL car toned by lens | car tabs heat strips, race strip, incident chip, markers | part callout | Part sheet / Incident sheet | everyone |
| 2 | **Parts** | **life bar** per part row (gradient track, used % fill, tick at 100%, track spans 0–120%) | per row: status lamp+word, due race code, spare pips, cap $ (amber dot = 2024, gray = 2025); footer: `Due 2024 $1.2m · 4`, `Pulled in $X`, `Penalty 2` | row: km left of life, stress dots (last 6, severity-sized), cap note | **Part sheet**: life **step line** over the weekend (used % by lap, drops = stress events, reset = replaced), stress event list (lap, kind, Jev severity, P, −% life), spares sourcing, price band, cap timing, entries posted for this part, agent decisions on it. Footer: `Open in Garage ↗` | engineers, mechanic, CFO |
| 3 | **Race timeline** | **swimlane by lap** (Q laps left, gap, race laps 1–71): lanes `Track` (flag bands), `23`, `43`, `Agent`; plus a **cost step line** lane (weekend cost mid with low–high band) | lap cursor at the current replay lap; dashed threshold lines at $250k and $1m on the cost lane; aside: `$3.92m` mono | lap column: every event that lap (kind glyph + 3-word label + time) | **Lap sheet** (events of that lap, cost added that lap); click an incident glyph → Incident sheet. Footer: `Open events ↗` (Audit tape) | everyone; the demo narrator |
| 4 | **Agent activity** (merges Waiting for you, Questions, Close & briefs, the proof header) | **Needs you** stack of decision cards (one-click), then the **activity stream** (rows by time, grouped by incident) | header aside: latency lamp + `1 ms` + 48×14 **sparkline** of read→commit; counter `2,549 events`; filter `.seg` `All · Refused · Held · Mine` | row: reason (the audit row's reason text), rule hit, who | **Decision sheet**: entry lines (debit/credit table), posting state (ERP id or held reason + review role), rule (`≤ $250k auto`, `≤ $1m Head of Cost Cap`, `> $1m CFO`), audit trail rows. Footer: `Open in Books ↗` / `Open in Audit ↗` | CFO, accountants, judges |
| 5 | **Alert rail** (not a panel; chips row) | count chips `.g-alert` (icon + mono count + word) | zero-count chips are hidden; none at all → one `✓ All clear` chip | chip: the list (car, part, 4 words each) | the related sheet, filtered (Grid penalty → Parts sheet filtered to penalty) | everyone |
| 6 | **Cost cap** (merges Weekend cost, In the books, Hardware) | **bullet bar**: cap line; year-end P10–P90 band; P50 tick; spent-to-date fill; this weekend's added segment (sky); brought-forward segment (amber hatch) | `P(overspend)` 95% (fig-lg) + `P(material)` 0%; weekend cost **range bar** low–mid–high (`$3.92m`); books **stack bar** posted / held / rejected; `Into 2024 $1.2m` | any segment: its $ value and basis | **Cap sheet** = today's CFO cap content (Odds rows, materiality bands), entries list with posting state. Footer: `Open Cap ↗` | CFO, Head of Cost Cap |
| 7 | **Spares** (merges spares_reserve and NextSteps logistics) | **stock dot strip**: one row per reserved part, pips in three groups `Track` (filled navy) · `Grove` (navy ring) · `Make` (dashed ring + lead days `14d`); a pip that this weekend consumed shows struck (hollow with a slash) | work orders **stack bar** by status (done / approved / awaiting / auto); freight + hand-carry as ETA chips (`Grove → GRU · ETA Thu`) | pip group: counts and lead days | **Logistics sheet**: NextSteps list by owner role with status pills and due times, outward flag glyph. Footer: `Open in Garage ↗` | logistics, chief mechanic |
| 8 | **Season odds** | **step line** of P(P8) across the weekend's sim runs (x = run time, y 0–100%) with the current value as `fig-lg` | expected prize `$65.5m` with delta `−$6.1m` vs baseline; attribution **diverging bar** ours vs rivals; aside `10,000 seasons · 80 ms` | a step: run time, P, prize | **Odds sheet**: `Odds` rows (P-anything outcome distribution), sim history table. Footer: `Open Strategy ↗` | CFO, strategy, TP |
| 9 | **Running order** | **position tower**: 20 rows in two columns of 10, 22px rows, Williams rows navy wash + car number chip | flag lamp + lap in the aside | row: gap / interval, tyre | **Race sheet**: full order with gaps, tyres, pit counts. Footer: `Open Strategy ↗` | strategy, everyone |
| 10 | **Proof** | **latency strip**: three bullet bars (event read→commit mean/last/max ms; commit→screen ms) on a 0–50 ms log axis | seats online (avatar dots + count), audit rows count, decisions allowed vs refused **stack bar** | latency bar: mean/last/max | **Audit sheet**: last 50 audit rows, rules. Footer: `Open Audit ↗` | judges, accountants |
| 11 | **Basis** (disclosure at the bottom) | none (text) | assumptions from `race/life.py` (life km, start used, severity takes), price-book basis | — | — | the curious |

Merges, explicitly: Waiting for you + Questions for people + Close & briefs → **Agent activity › Needs you**. Hardware (CFO) → **Parts** footer. Weekend cost + In the books + Cost cap 2024 → **Cost cap**. Track panel + Running order → **Race strip** (stage) + **Running order** panel. PitWallProof → **Agent activity** header + **Proof**. IncidentFlow strip → **Incident sheet** (opened from the incident chip and timeline). Service strip → top bar lamps.

### Agent activity in detail (the Hyphenate-like part)

**Needs you** (top, always first, max 3 cards then `+N more`):

```
┌──────────────────────────────────────────────────────────────┐
│ ◷ Weekend close & briefs                     $2.9m   [Approve]│  64px tall, .glass--raised-lite
│   111 rows · root 1f2f…  · > $1m · CFO              [Hold ▾]  │
└──────────────────────────────────────────────────────────────┘
```
- Line 1: amber lamp + title (≤ 5 words, DM Sans 600 13px) · amount mono 600 14px · primary button `Approve` (32px, blue).
- Line 2: three mono facts (row count, id, rule hit) 11px muted · secondary `Hold ▾` (menu: Hold, Reject with reason).
- **One click** for in-house postings: the button morphs to a blue `✓ Approved` pill (200ms), the card collapses after 1.2s (`grid-template-rows 1fr → 0fr`), a toast `Approved · $2.9m · Undo` stays 5s if the reducer can revoke. **Outward items** (FIA notice, sends, ERP close) open a 1-line confirm popover anchored on the button: `Send to FIA?  [Send] [Cancel]`.
- A damage question for the chief mechanic renders as a card with 2-3 option buttons (`Repair · Spare tub · Withdraw`), each with its $ in mono under the word.
- Seat without the role: buttons are replaced by the owner chip (`Head of Cost Cap`) and a lock glyph.

**Stream** (below, scrolls inside the panel; row 36px):

```
[⬡]  Posted  #43 COL L5 contact books        $123k   ✓ Posted     10:53:00
[⬡]  Held    #23 ALB quali crash books       $177k   ◷ Held       10:53:07
[◉]  Approved  spare floor to car 23          —      ✓ Approved   10:53:12
[⬡]  Refused  publisher: post over $250k      —      ✕ Refused    10:52:52
```
- Actor glyph 20px: agent = hexagon (`IconAgent`), person = filled circle (`IconPerson`) in Williams blue. The verb is the first word, DM Sans 600; the object is DM Sans 400 truncated with ellipsis; amount mono right-aligned 72px; outcome pill (`.k-pill` tones: Posted = neutral with agent glyph, Approved = blue, Held = amber, Refused = red); time mono 10.5px muted.
- Grouped by incident with a 24px group header: hairline + `L28 · Car 23 crash · $1.4m` mono 11px.
- New row arrives at the top (motion: §f). When the stream is scrolled away from the top, a `3 new ↑` chip appears at the stream top instead of jumping.

---

## d. Visual language: liquid glass on the Williams theme

### Surfaces (bottom to top)

| Level | Class | Recipe (exact values in glass-tokens.css) | backdrop-filter |
|---|---|---|---|
| 0 Ground | `.g-ground` | `--g-ground #e9eef5` + a fixed, static mesh pseudo-element: three radial gradients (Williams blue 9%, sky 10%, navy 6%) placed top-left, top-right and behind the stage. The mesh is what gives the fake glass something to tint against. | no |
| 1 Glass panel | `.glass` | `linear-gradient(180deg, rgba(255,255,255,.80), rgba(255,255,255,.64))`, 1px border `rgba(255,255,255,.72)`, outer ring `0 0 0 1px rgba(4,30,66,.07)`, inset top highlight `inset 0 1px 0 rgba(255,255,255,.95)`, shadow `0 1px 2px rgba(4,30,66,.05), 0 8px 24px -8px rgba(4,30,66,.12), 0 24px 48px -28px rgba(4,30,66,.16)`, specular edge pseudo (`.specular`) | **no** (fake) |
| 2 Raised glass | `.glass--raised` | `rgba(255,255,255,.70)`, `blur(20px) saturate(170%)`, stronger shadow `0 18px 44px -12px rgba(4,30,66,.28)`, specular edge at higher strength | **yes** |
| 2' Raised-lite | `.glass--raised-lite` | decision cards inside a panel: `rgba(255,255,255,.86)` + 1px `--line-soft` + `0 2px 8px -2px rgba(4,30,66,.10)` | no |
| 1' Inset well | `.glass-well` | `rgba(4,30,66,.045)`, `inset 0 1px 2px rgba(4,30,66,.10), inset 0 0 0 1px rgba(4,30,66,.06)`, bottom highlight `0 1px 0 rgba(255,255,255,.8)` | no |
| S Stage | `.glass--dark` | `radial-gradient(120% 90% at 28% 0%, #0f2350 0%, #0b1b3b 30%, #050d20 70%, #030817 100%)`, 1px border `rgba(112,162,255,.24)`, inset top `rgba(170,205,255,.20)`, inner rim `inset 0 0 0 4px rgba(20,44,96,.55)`, shadow `0 2px 4px rgba(3,8,23,.25), 0 30px 60px -24px rgba(3,8,23,.55)` + light spill `0 48px 90px -40px rgba(10,91,216,.45)` | no (it is opaque) |
| S2 Stage chip | `.glass-chip--dark` | `rgba(7,18,44,.62)`, `blur(12px) saturate(140%)`, 1px `rgba(140,180,255,.22)`, inset top `rgba(200,225,255,.14)` | **yes** (small) |

### Corner radii (change from 2px)

`--r-xs 2px` (data bars, meter tracks, swatches: instruments stay crisp) · `--r-sm 6px` (buttons, inputs, segmented controls, rows) · `--r-md 10px` (chips, cards inside panels, peeks) · `--r-lg 16px` (panels, the drawing sheet) · `--r-stage 20px` (stage, side sheet) · pills `999px`.
Why: glass reads as a material only when its edge catches light, and a specular gradient border needs a curve to show. 16px panels with a 4-px family step keep it calm. Data marks stay at 2px so charts still look like instruments, not toys. Concentric rule: inner radius = outer radius − padding (stage 20 − 4 rim = 16 sheet).

### Hairlines

- Light: `1px solid rgba(4,30,66,.08)` (`--g-hair`), with an etched highlight beneath `0 1px 0 rgba(255,255,255,.75)` (`.hairline`). Row separators inside lists use `--g-hair` only.
- Dark: `rgba(112,162,255,.16)` (matches `--bp-rule`), highlight `rgba(200,225,255,.06)`.
- No borders between panel header and body; spacing does it (12px).

### Type (keep the three families; sizes)

| Token | Use | Value |
|---|---|---|
| `--fs-car` | car number on the stage tab | Barlow Condensed 800 30px/1, 0.01em |
| `--fs-display` | page title (route views only; home has none) | Barlow Condensed 700 28px/1.05, 0.035em caps |
| `--fs-title` | panel titles | Barlow Condensed 700 14px/1.2, 0.08em caps, `--navy` |
| `--fs-fig-xl` | the single hero figure of a panel (P(overspend), P8) | Plex Mono 600 32px/1, −0.02em, tnum |
| `--fs-fig-lg` | secondary big figure | Plex Mono 600 22px/1.1 |
| `--fs-fig` | figures in rows | Plex Mono 500 12.5px, tnum |
| `--fs-ui` | controls, row names | DM Sans 600 13px |
| `--fs-body` | the rare text | DM Sans 400 14px/1.5 |
| `--fs-label` | figure labels, legend | DM Sans 600 11px, 0.06em caps, `--muted` |
| `--fs-axis` | chart axes, times | Plex Mono 500 10.5px |

### Status colors (always with an icon and a word)

| Meaning | Light text | Light fill | Wash | On dark stage | Icon |
|---|---|---|---|---|---|
| A person acted / primary | `#0a5bd8` (`--lime`) | `#0a5bd8` | `rgba(10,91,216,.08)` | `#5b9dff` | `IconApproved` / `IconPerson` |
| Agent did it itself (auto) | `--steel #3c4a60` | `#8fa3bf` | `--panel-2` | `#9fb4d8` | `IconAgent` |
| Waiting | `#b45309` (`--hold`) | `#e09a2b` | `rgba(217,119,6,.10)` | `#ffb547` | `IconWaiting` |
| Refused / damaged / penalty | `#c62828` (`--alert`) | `#c62828` | `rgba(198,40,40,.07)` | `#ff7360` | `IconDenied` |
| Live / info | `#00658c` | `#00a3e0` (`--sky`) | `rgba(0,163,224,.10)` | `#66c4ff` | `IconLive` |

### Life gradient (stops; remaining-life semantics)

- Light: `0% #00a3e0` (sky, fresh) → `55% #6f8fb8` (steel blue, mid-life) → `75% #e09a2b` (amber, WATCH threshold in life.py) → `90% #e0662b` → `100% #c62828` (due); past 100% (up to 120% on the track) a red 45° hatch `repeating-linear-gradient(135deg, #c62828 0 3px, #e35d5d 3px 6px)`.
- Dark: `0% #66c4ff` → `60% #8aa6d6` → `75% #ffb547` → `90% #ff8f4f` → `100% #ff7360`.
- Williams blue `#0a5bd8` is deliberately not in the ramp: blue means a person.
- The bar's color is set by position along the fixed full-width gradient (the fill is a clip of the gradient), so a 40%-used part shows sky-to-steel and a 92% part shows the whole ramp to orange; the color at the fill's end is the condition. `replaced` parts show an empty track with a blue-ink `New` pill instead of a bar.

### Chart series

- Car 23 `--g-s-23 #041e42` (navy) / on dark `#c4d9ff`; Car 43 `--g-s-43 #00a3e0` (sky) / on dark `#66c4ff`. Every chart that splits by car uses these two, always in this order.
- Rivals / baseline `#8fa3bf` (`--s1`); bands `rgba(4,30,66,.10)` (P10–P90, low–high); thresholds `--ink` dashed 1px `3 3`.
- Flags on the timeline: SC amber hatch `rgba(224,154,43,.35)` 45°; VSC amber dotted top+bottom 1px; Red `rgba(198,40,40,.18)` solid with an `IconFlag`; chequered: a 6px checker pattern at the last lap.
- Marks: dots 6px (r=3), incident diamonds 8–14px by impact (linear 0–350 km/h), pit ticks 1.5×12px, step lines 1.5px, area bands no stroke. SVG, `shape-rendering: geometricPrecision`, `vector-effect: non-scaling-stroke`.

### Focus, hover, pressed

- Focus: `outline: 2px solid #0a5bd8; outline-offset: 2px` (existing), on dark `#8cc0ff`. Rows: `box-shadow: inset 0 0 0 2px var(--g-focus)` instead of outline (rows are clipped).
- Hover on glass panel: no lift (it would jank at 4 re-renders/s); the header `↗` brightens; rows get `--g-lit` wash `rgba(10,91,216,.06)`, on dark `rgba(102,196,255,.10)`.
- Buttons: primary blue `linear-gradient(180deg, #2a73e6, #0a5bd8)` + inset top `rgba(255,255,255,.28)` + `0 1px 2px rgba(4,30,66,.25)`; hover `#0b52c2` base; pressed `translateY(1px)` + inset shadow; disabled 45% opacity.

### Performance: where backdrop-filter is allowed

Allowed (each is small, floats, and repaints rarely): top bar (1), stage overlay chips (≤ 6 visible, each ≤ 320×64; the callout ≤ 288×240), peeks (transient, 1 at a time), side sheet (1), toasts (≤ 2), the phone's sticky decision bar (1). Max blur radius 20px; never animate the blur radius; never nest a backdrop-filter element inside another.

Not allowed: grid panels, rows, cards inside panels, anything inside a list that re-renders, anything covering more than 25% of the canvas, the stage itself. Panels use the fake glass recipe (translucent fill over the static mesh ground: it is indistinguishable at a glance because the mesh is already smooth).

Other rules: `contain: layout paint` on every `.glass` panel; `content-visibility: auto; contain-intrinsic-size: auto 320px` on below-the-fold rows C and D; animate only `opacity`, `transform`, `clip-path` and the registered `--used` property; `@supports not (backdrop-filter: blur(1px))` → raised glass falls back to `rgba(255,255,255,.96)`; numbers keep `tabular-nums` so 4×/s updates never shift layout; memoize panel bodies on their own slice of race data so one event does not re-render the stage overlays.

---

## e. Indicators over words

### Which indicator for each quantity

| Quantity | Indicator |
|---|---|
| Car position | mono `P14` in the car tab; tower row in Running order |
| Lap | mono `L32/71` + 64×3 progress bar |
| Tyre compound, age | ring glyph with letter + mono `12L` |
| Gap | mono `+4.312` |
| Last pit | mono `P L18`; pit tick on timeline |
| Car status word | lamp + word (`Running`) |
| Incident impact / decel / lap | chip `315 km/h · 3.0 g · L28`; diamond size on timeline |
| Severity belief + versions | 4-cell severity scale (none/light/moderate/heavy) with the current filled; versions as a **step line** of severity over time in the Incident sheet (today's `BeliefHistory` → v1…v6 dots on a line) |
| P(damaged) per part | Condition lens tone; mini meter 96×4 in callout; % mono |
| usedPct / remainingKm / lifeKm | **life bar**; km left in peek |
| status ok/watch/due/damaged/replaced | lamp + word |
| dueEvent | 3-letter race code chip (`LVG`, `QAT`, `ABU`, `2025` = `Lasts`) |
| costCents | mono `$495k` |
| capNote "grid penalty" | red `Penalty` pill + marker on the car |
| broughtForwardCents | amber hatched segment in the Cost cap bullet; `+$X` in callout |
| stressJson | **stress dots** (last 6, dot diameter by severity 4/6/8/10px), and drops on the part's life step line |
| Spares at track / Grove / make | **pip groups** (filled / ring / dashed ring) |
| Action status | Pill (auto = agent neutral, awaiting = amber, approved = blue, done = blue check, rejected = red, cancelled = gray strike) |
| Due time | mono `Thu 14:00` or relative `in 3h` |
| Owner role | role chip (initials circle + role short: `CFO`, `HCC`, `CM`) |
| Outward flag | `IconExternal` glyph |
| Entries debit/credit | two-column mono table in the sheet only |
| Posted / held / rejected | **stack bar** (blue posted by person, steel posted by agent, amber held, red rejected) |
| Cap-relevant | `⊟` cap glyph next to the amount |
| P(target P8) | `fig-xl` + step line history |
| Expected prize, delta | `fig-lg` + delta with arrow |
| Attribution ours vs rivals | diverging bar around 0 |
| Cap P10/P50/P90 vs cap | **bullet bar** |
| P(overspend), P(material) | `fig-xl` / `fig` + a 3-state **stack** (under / minor / material) under it |
| Runtime ms, seasons | mono aside `10,000 · 80 ms` |
| Weekend cost band | **range bar** (low–mid–high) + `$3.92m` mono; step line by lap on the timeline |
| Flag status | lamp + word; band on timeline |
| Running order | position tower |
| Events tape | swimlane marks; count in Agent activity header |
| Seats online | avatar dots (8px) + count |
| Latency mean/last/max | bullet bar on log axis + sparkline in header |
| Audit rows allowed/refused | stack bar + stream rows |
| Rules thresholds | dashed lines on the cost lane; rule chip on cards (`> $1m · CFO`) |
| Service health | six lamps (live = sky, degraded = amber, offline = red, dry run = steel ring, not configured = gray dashed ring) |
| Questions for people | Needs you card with option buttons |
| Close status, Merkle root | status pill + mono `root 1f2f…` truncated, full in peek |

### When a word is allowed

- Allowed: panel titles (2–3 words), control labels that name their action (`Approve`, `Hold`, `Explode`), status words next to a lamp/icon (1–2 words), part names, role names, race names, axis labels, legend labels, figure labels (≤ 3 words, caps 11px).
- Not allowed in the main view: subtitles under titles, sentences explaining a number, "from the cars' running", basis strings, "booked · count when fitted". Those move to `title=` on the panel title or figure label, or into the sheet, or into the single `Basis` disclosure.
- Max one line of text per card (the Needs-you card's fact line is mono facts, not a sentence).
- Every empty state is one short line + a ghost of the chart (skeleton bars), e.g. `No incidents yet` over a dashed swimlane.

---

## f. Motion

Tokens: `--t-fast 120ms`, `--t-base 220ms`, `--t-slow 360ms`, `--t-sheet 280ms`; `--ease` (existing `cubic-bezier(.22,1,.36,1)`, out), `--ease-io cubic-bezier(.65,0,.35,1)`, `--ease-pop cubic-bezier(.34,1.56,.64,1)` (small overshoot, arrivals only).

| What | How | Duration / easing |
|---|---|---|
| Live figure changes | no movement; text color flashes to `--g-ink-hi` then back (`.flash` keyframe); never count-up animations (4×/s would blur) | 600ms `--ease` |
| Bars, meters, life bars | `--used` (registered `@property`) / `transform: scaleX` transitions | `--t-slow` `--ease` |
| Step/cost lines | redraw in place; the newest segment draws in via `stroke-dashoffset` | 360ms |
| New alert chip | enters `scale(.94) → 1` + opacity, then one ring pulse (box-shadow 0 → 8px, fading) | 240ms `--ease-pop` + 900ms ring |
| New stream row | row container `grid-template-rows: 0fr → 1fr` + opacity, from the top; group header count ticks with `.flash` | `--t-base` `--ease` |
| Needs-you approved | button morph to pill 200ms; card collapse 220ms after 1.2s hold | `--ease-io` |
| Part lights on hover | handled by the engine (pull-out, brighten); ledger row wash fade | `--t-fast` |
| New damage on a part | engine `pulse: true` for that part; the marker chip arrives (as alert chip) | engine-timed |
| Lens change | tones crossfade (engine), legend crossfades | `--t-base` |
| Peek | opacity + `translateY(4px → 0)`; open delay 250ms, close delay 80ms | `--t-fast` |
| Side sheet | `translateX(24px) → 0` + opacity; scrim `rgba(4,30,66,.18)` fades; close faster | open `--t-sheet` `--ease`, close 180ms `--ease-io` |
| Lamp `live` | slow breathe of a 0 → 4px halo | 2.4s infinite, only on `.lamp--live` |

Reduced motion (`prefers-reduced-motion: reduce`): no transforms, no pulses, no flash; opacity-only transitions at 120ms; sheet appears without slide; pass `pulse: false` in every `PartTone`; replay still updates values instantly.

---

## g. Layout grids

### 1440 (12 columns, content 1392, outer gutter 24, column gap 16, col ≈ 101.3px)

| Row | Cols 1–4 | Cols 5–8 | Cols 9–12 | Height |
|---|---|---|---|---|
| Alert rail | 1–12 | | | 40 |
| A | **Stage** 1–8 | | **Parts** 9–12 | 520 |
| B | **Race timeline** 1–8 | | **Agent activity** 9–12 (rows B–C, 552, internal scroll) | 236 |
| C | **Cost cap** 1–4 | **Spares** 5–8 | (Agent activity) | 300 |
| D | **Season odds** 1–4 | **Running order** 5–8 | **Proof** 9–12 | 280 |
| E | **Basis** 1–12 (collapsed) | | | 44 |

Vertical rhythm: 16px between rows, 16px under the top bar, panel padding 16px 18px. Max width 1440 content; above 1600 the grid centers, the ground mesh keeps filling the window.

### 1024 (12 columns, content 984, gutter 20, gap 16, col ≈ 67.3px)

| Row | Spans | Height |
|---|---|---|
| Alert rail | 1–12 (scroll-x if needed) | 40 |
| A | Stage 1–8 (hero 340 + strip 96) · Parts 9–12 (compact rows: lamp, name, life bar, due code; spare + $ move into the row peek) | 456 |
| B | Race timeline 1–12 | 220 |
| C | Agent activity 1–6 (rows C–D, 520) · Cost cap 7–12 | 252 |
| D | (Agent activity) · Spares 7–12 | 252 |
| E | Season odds 1–6 · Running order 7–12 | 260 |
| F | Proof 1–12 · Basis 1–12 | auto |

Car tabs shrink to 168×56 (heat strip cells 10×5); race strip drops the gap figure; lens switch shows `Life · Cond · Cap · Cost`.

### 390 (phone: an approver away from the desk; single column, gutter 16, gap 12)

Order:
1. Top bar 52px: glyph + wordmark, `Inbox 37`, menu button (nav opens as a bottom sheet). Replay control and services move into the menu.
2. Alert rail: horizontal scroll, scroll-snap, chips 32px.
3. **Needs you** lifted out of Agent activity to the top: full-width cards, 2-line, buttons 44px tall (touch), `Approve` takes 60% width.
4. Stage: 358×300 hero (`height: 300px`), ortho strip 72px rows; car tabs become a 2-segment control 40px above the hero (outside the canvas); race strip a single line under the tabs; lens switch below the hero as a full-width 4-segment control; markers max 2; callout becomes a bottom sheet on tap.
5. Parts: rows 44px: lamp, name, life bar, due code. Tap row = part lights on the stage (scroll the stage into view only if it is off screen) + peek; second tap = part sheet.
6. Cost cap, 7. Agent activity stream, 8. Race timeline (horizontal scroll inside a well, 10px per lap, initial scroll to the current lap), 9. Spares, 10. Season odds, 11. Running order (one column), 12. Proof, 13. Basis.
- Sticky decision bar (`.glass--raised`, 64px, bottom, safe-area padding) appears when Needs-you has items and is scrolled off screen: `◷ 3 to decide  [Review]`.
- Side sheets become bottom sheets at 88vh with a 4×36 grab handle; swipe down or `Esc` closes.

---

## h. Drill-down pattern: peek → sheet → route

1. **Peek** (hover ≥ 250ms, or tap on touch; `.glass--raised`, radius 10, max 280px, 12px padding). Shows the next level of figures for exactly what is under the pointer: 3–6 label/value lines, no buttons, no sentences. One peek at a time; it never covers the hovered thing (prefer above, then right).
2. **Sheet** (click a row, a chart mark, a chip, or the panel `↗`): right side sheet, 480px wide at 1440 (440 at 1024, bottom sheet on phone), `.glass--raised`, radius 20 on the left corners, full height under the top bar, scrim `rgba(4,30,66,.18)` over the page but **not** over the stage canvas (the stage keeps rendering and pointing: opening a part sheet keeps that part pinned and lit). Sheet anatomy: header (title 2–3 words + object id mono + close), a single primary chart, 2–4 secondary blocks, footer with the route link `Open in Garage ↗`. Sheets stack at most one deep: opening another replaces it (with a back arrow in the header when it came from a sheet link). Deep link: `#/?sheet=part:23-gearbox`, `#/?sheet=incident:<key>`, `#/?sheet=decision:<entryKey>`, `#/?sheet=lap:28`. `Esc` closes; focus returns to the opener.
3. **Route** (the sheet's footer link or the nav): the full role view (`Garage`, `Strategy`, `Books › Entries | Cap | Ledger`, `Audit`), today's views restyled with the glass tokens. Routes keep the alert rail and the top bar; they do not repeat the stage (Garage keeps its own full `BlueprintStage`).

Sheet catalogue (build in this order; each is a component reusing kit pieces):
`PartSheet` (life step line, stress list, spares, price band, cap timing) · `DecisionSheet` (entry lines, posting, rule, audit) · `IncidentSheet` (today's `IncidentFlow` steps as a vertical chain + `BeliefHistory`) · `CapSheet` (CFO cap content) · `LapSheet` · `LogisticsSheet` (NextSteps) · `OddsSheet` · `AuditSheet`.

---

## Build notes (reuse, order, effort)

Reuse: `Pill` (status words), `Meter` (mini meters, latency bullets), `Stack` (posted/held, work orders, outcome stack), `Odds` (Odds sheet), `Axis` (fallback for the swimlane lanes), `Figure` (fig-lg/xl with the new classes), `Panel` (add `onOpen` prop for `↗`), `Sheet` + `SheetMarker` (stage, markers), `Callout` (extend with life/spare/cap rows), `tonesFor` (add `life`, `cap`), `PartLifePanel` data logic (rows, sort, `penalty()`), `HardwarePanel` sums (Parts footer), `ReplayControl`, `ServiceStrip` data (lamps), `NextSteps` (Logistics sheet), `PitWallProof` hooks (`useCommitToScreen`) for the Agent header and Proof.

New SVG charts (no library, each < 120 lines): `LifeBar` (CSS only), `Swimlane` (timeline), `StepLine` (P8 history, life history, cost by lap), `BulletBar` (cap), `RangeBar` (weekend band, price band), `DivergingBar` (attribution), `PipGroup` (spares), `HeatStrip` (car tabs), `Tower` (running order).

Suggested order for a few hours: (1) tokens + ground + `.glass` on existing panels (30 min), (2) home grid with stage + Parts ledger + hover linking + Life lens (90 min), (3) Agent activity with Needs you (45 min), (4) alert rail + timeline (60 min), (5) Cost cap, Spares, Odds restyles reusing CFO pieces (45 min), (6) sheets: Part, Decision, Incident (60 min), (7) phone pass (30 min).
