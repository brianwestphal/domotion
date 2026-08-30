---
id: "requirements/html-mask-origin-clip-geometry"
title: "174 — HTML mask-origin / mask-clip geometry"
kind: "contract"
status: "current"
owners: ["paint-effects","layout","product-tooling"]
platforms: []
tickets: ["DM-2379","DM-2472","DM-2494"]
code: ["src/capture/script/index.ts","src/render/mask-origin-clip.test.ts","src/render/mask-origin-clip.ts","src/render/mask.ts","tests/mask-origin-clip.e2e.test.ts","tests/mask-url-repeat-geometry.e2e.test.ts"]
aliases: ["docs/174-html-mask-origin-clip-geometry.md","doc-174"]
---

# 174 — HTML mask-origin / mask-clip geometry

DM-2472 closes the HTML URL-mask box-model gap left by DM-2379. Capture now
retains computed `mask-origin` independently from `mask-clip`, and the renderer
uses separate rectangles for layer positioning and painted-area intersection.

## Blink ownership

The implementation is transcribed from pinned Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `third_party/blink/renderer/core/paint/background_image_geometry.cc`:
  `ComputePositioningAreaAdjustments()` contracts the normal border box from
  `FillLayer::Origin()`, while `ComputeDestRectAdjustments()` independently
  contracts or expands the destination from `EffectiveClip()`. `Calculate()`
  resolves tile size/position against the positioning area and intersects the
  final destination with the paint rect except for `mask-clip:no-clip`.
- `third_party/blink/renderer/core/paint/box_background_paint_context.cc`:
  `NormalPositioningArea()`, `BorderOutsets()`, `PaddingOutsets()`, and
  `VisualOverflowOutsets()` supply the HTML reference geometry. Fragmented
  boxes use the stitched positioning size and per-fragment paint clips.

For HTML layout boxes, Blink maps `fill-box` to `content-box`, and
`stroke-box` / `view-box` to `border-box`. `no-clip` is valid only on the
painting side. Domotion uses the capture viewport as a safe SVG painting-area
superset for no-clip: the masked group has no ink outside its own visual
overflow, so this removes the artificial border-box intersection without
changing observable pixels.

## Capture and emission contract

`src/capture/script/index.ts` captures three independent facts:

1. the complete computed per-layer `mask-origin` list;
2. the complete computed per-layer `mask-clip` list; and
3. physical border and padding edges in `maskBoxInsets`.

The third fact crosses effective CSS zoom once. DOMRects are already in
painted coordinates, while computed padding and border widths are serialized
before zoom (with Chromium's used-border snapping reflected in computed
values). Older captures fall back to their existing width strings and remain
exact at zoom 1.

`src/render/mask-origin-clip.ts` owns HTML box normalization and per-layer
cyclic resolution. `src/render/mask.ts` threads each resolved positioning area
through contain/cover, explicit size, length-percentage/calc position, and
pattern anchoring. A separate painting area drives repeat coverage and an SVG
clipPath. The same separation survives bottom-up multilayer composition and
slice/clone fragment reconstruction. `mask-clip:no-clip` gets an explicit
viewport-sized SVG mask region so SVG's default 120% mask bounds cannot crop
Blink-visible overflow.

DM-2494 threads that painting area into URL pattern lowering as well. This is
observable when one axis is `round` or `space` and the other is `no-repeat`:
Blink computes adjusted tile size and phase from the origin box, but
`DrawImageTiled` receives the clip-owned destination. Reusing the origin box as
the SVG pattern cell made the no-repeat axis wrap into a second row whenever
the clip was larger. The corrected cell owns the paint rectangle while its
image offset still represents the origin-derived phase.

## Evidence

`src/render/mask-origin-clip.test.ts` locks:

- asymmetric border/padding/content rectangles;
- independent cyclic origin and clip lists;
- HTML fill/stroke/view aliases and no-clip;
- same-box negative controls;
- a collapsed-origin-to-clip mutation that must move positioning while leaving
  painting unchanged; and
- URL contain plus repeating pattern emission against different rectangles;
  and
- URL `round`/`space` pattern cells against a larger clip, with the collapsed
  painting-area mutation required to move geometry.

`tests/mask-origin-clip.e2e.test.ts` is the independent Chromium-vs-generated
SVG device-pixel oracle. At DPR 1 and 2 it covers contain, cover, explicit
sizes, repetition, asymmetric boxes, no-clip overflow, CSS zoom, vertical
writing with RTL direction, cyclic multilayer composition, and a same-box
control. A separate DPR-2 leg covers sliced and cloned wrapped inline
fragments. The oracle also rewrites every captured origin to its clip and
requires that retired mutation to be materially worse than production.

`tests/mask-url-repeat-geometry.e2e.test.ts` adds an asymmetric-alpha URL tile
for `round no-repeat` and `space no-repeat`. At DPR 1 and 2, live Chromium and
generated SVG agree on tile count and every device-pixel edge within one pixel;
collapsing the pattern cell to the positioning area creates a forbidden extra
row and must fail independently for both repeat modes.

Run the focused gate with:

```sh
npm run mask:origin-clip-oracle
```

The `paint.masks-clips` semantic state for distinct HTML URL-mask boxes is now
exact. The area remains globally partial only for future SVG effect/property
combinations outside this HTML geometry contract.
