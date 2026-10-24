#!/usr/bin/env bash
# Regenerates the livery sheets with the Higgsfield CLI (same model, prompts and references
# used for the shipped sheets). Costs credits: 4.25 per 4k side sheet, 2.75 per 2k top sheet.
#
#   1. npm run dev                       (reference renders need the dev server)
#   2. node tools/ortho-sheets.mjs 4096  → livery/ref/{side,top}.png
#   3. bash tools/liveries.sh scarlet    → livery/gen/final/scarlet-{side,top}.png
#   4. python3 tools/pack-sheets.py scarlet livery/gen/final/scarlet-side.png livery/gen/final/scarlet-top.png
#
# Requires `higgsfield auth login` once. Liveries: pitwall scarlet silver navy green.
set -euo pipefail
cd "$(dirname "$0")/.."
key="${1:?livery key}"
mkdir -p livery/gen/final

STYLE='STRICT STYLE: flat 2D vector decal artwork, albedo only: uniform flat colours and crisp vector shapes, no specular highlights, no reflections, no glow, no light rays, no shadows, no ambient occlusion, no lighting gradients of any kind (only the colour fades explicitly described in the livery). Background: solid pure black (#000000), nothing else in the image. Tyres flat black. Front wing elements, floor, suspension arms, brake ducts and the halo flat dark carbon grey (#1c1e22). Helmet painted in the team colours. All lettering spelled exactly as given, horizontal, left-to-right, never mirrored, never overlapping other lettering.'
MARKS='MARKINGS: sponsor-style graphics may use ONLY these invented names in clean bold sans-serif capitals: PIT WALL (title partner, largest, along the sidepod flank and on the engine cover), EVIDENCE FEED (sidepod shoulder), CONTROLLER (rear wing endplate), AUDIT TRAIL (front wing endplate), PW-01 (small, beside the cockpit). No other words, no real brand names, logos, trademarks, flags or driver names.'
case "$key" in
  scarlet) LIVERY='LIVERY, 2024 Scuderia style: Rosso Corsa red (#D40000) over the nose, chassis, sidepods, engine cover and rear wing endplates. Along the sidepod shoulder, from the cockpit to the rear wing, runs a continuous pair of thin stripes, white on top and yellow (#FFD400) below; the same stripes continue along the engine cover. The lower third of the sidepods and the floor edge are black. Yellow number 14 with a white outline on the sidepod front. Rear wing endplates red with a white top edge. Helmet red and yellow.' ;;
  silver)  LIVERY='LIVERY, 2024 Silver Arrows style: black (#101214) over the nose and the front half of the chassis, dissolving in one smooth horizontal colour fade into bright silver (#C9CED3) over the cockpit area, engine cover and rear; the sidepods black fading to silver toward the rear; a thin bright teal (#00D8C4) line runs along the lower edge of the sidepod and the floor edge; silver rear wing endplates with a teal stripe; white number 14 outlined in teal on the sidepod. Helmet silver and teal.' ;;
  navy)    LIVERY='LIVERY, 2024 energy-drink team style: dark navy (#0F1D55) over the entire body. The nose tip and the very front of the chassis in bright yellow (#FFD400). Red (#FF2E3C) flashes sweep back from the sidepod inlet along the shoulder toward the rear wing, with yellow and red diagonal accents on the engine cover; the airbox top red; rear wing endplates navy with a red and yellow lower section. White number 14 with a red outline on the sidepod. Helmet navy with red and yellow.' ;;
  green)   LIVERY='LIVERY, 2024 racing-green style: deep British racing green (#0B5C48) over the body. Bright lime (#B8FF3B) stripes run along the sidepod shoulder and the engine cover spine, with lime edges on the front and rear wing endplates; the lower sidepods and the floor edge black; mirrors lime; lime number 14 on the sidepod. Helmet green and lime.' ;;
  pitwall) LIVERY='LIVERY, Pit Wall works style: smooth satin near-black (#1A1D22) over the whole body, no texture pattern. One sharp electric lime (#C9FF4B) stripe rises from the front wing endplate along the flank, over the sidepod shoulder to the rear wing endplate, with a lime spine along the engine cover; the PIT WALL wordmark in lime on the sidepod; lime number 01 on the sidepod. Helmet black with lime.' ;;
  *) echo "unknown livery: $key" >&2; exit 1 ;;
esac

SIDE="The reference image is an orthographic RIGHT-SIDE view of a Formula 1 car rendered as plain light-grey clay, nose pointing right, wheels at the bottom. Produce the car's LIVERY WRAP TEMPLATE: the same car, same view, same silhouette, same position and scale, pixel-aligned with the reference, with a complete professional racing livery painted on it. $STYLE $LIVERY $MARKS"
higgsfield generate create gpt_image_2_5 --image livery/ref/side.png --prompt "$SIDE" --aspect_ratio 21:9 --quality high --resolution 4k --wait --out "livery/gen/final/$key-side.png"

TOP="Reference image 1 is an orthographic TOP (plan) view of a Formula 1 car rendered as plain light-grey clay, nose pointing right; the car's right-hand side is at the bottom of the image. Reference image 2 is the finished right-side view of this same car's livery: reproduce exactly the same livery (colours, stripes, fades, finishes and typography) on the top view. Produce the car's LIVERY WRAP TEMPLATE for the top view: the same car, same view, same silhouette, same position and scale, pixel-aligned with reference 1. $STYLE Paint the nose top, chassis top, sidepod upper surfaces, engine cover, airbox, rear wing upper surface and the tops of the wing endplates. The layout is symmetric: the left half mirrors the right half. $LIVERY The car number large on the nose top; the words PIT WALL along the length of the engine cover between the airbox and the rear wing; EVIDENCE FEED small on the sidepod tops. No other words, no real brand names, logos, trademarks, flags or driver names."
higgsfield generate create gpt_image_2_5 --image livery/ref/top.png --image "livery/gen/final/$key-side.png" --prompt "$TOP" --aspect_ratio 21:9 --quality high --resolution 2k --wait --out "livery/gen/final/$key-top.png"
