# 195 — Strict ordinary backdrop ownership and raster-floor adjudication

**Status: shipped and gated.** The ordinary-element source-surface matrix now
has exact logical ownership at DPR 1 and 2 without changing its four-code,
1%-diagnostic, or mutation thresholds.

## Source verdict

The source baseline is Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and Chromium's pinned Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

Blink's `paint_property_tree_builder.cc` makes opacity, filter,
backdrop-filter, clip-path/mask, and nonnormal blend states effect nodes and
Backdrop Roots. Its property-tree initialization keeps transform, scroll,
fixed, and sticky translations as separate transform/property nodes; those
states do not change the nearest Backdrop Root. `paint_layer.cc` defines the
backdrop reference from the physical border box (or physical inline line
bounds). Pinned `SkCanvas.cpp` evaluates a backdrop with the prior device as
the source and maps that device into the new layer before restore.

Those decisions produce three distinct routes:

- opacity/blend/mask roots own one source-captured atomic root surface;
- a document-root target below rotate/skew owns one final-space Chromium
  compositor patch at that transformed ancestor; and
- scroll and sticky targets remain ordinary document-root target-boundary
  surfaces. A scroller is never promoted to a terminal backdrop owner.

HarfBuzz has no role in this effect-tree and pixel-surface decision.

## Capture and render contract

`src/capture/backdrop-composite-raster.ts` resolves atomic roots from the
serialized Blink effect-space facts. Mask roots use three explicit screenshots
(source, root-hidden base, isolated root), and store Chromium's changed final
pixels as a sparse patch instead of reverse-engineering a straight-alpha color
through a different color pipeline.

Rotate/skew is the narrower terminal case. The capture pass reads the live
transformed ancestor rectangle, takes source and owner-hidden base frames, and
stores their sparse final-space delta with
`source: chromium-relative-effect-layer-v1`. The renderer emits that surface
outside reconstructed transform/mask/scroll wrappers and does not emit the
captured subtree a second time. Translation/scale-only ancestors remain on the
ordinary counter-transform route.

The terminal route is intentionally not selected for overflow, scroll, fixed,
or sticky. Live testing of a scroll-terminal experiment moved the scroll and
sticky rows from their narrow edge residuals to roughly 96% and 97% changed
pixels, independently falsifying that ownership model.

## Logical versus raster evidence

The strict audit keeps all prior numeric thresholds unchanged:

- a channel changes above four codes;
- the existing pixel diagnostic boundary remains 1%; and
- each destructive mutation must move at least 0.2% of pixels and reach a
  12-code channel delta.

A row above the 1% diagnostic boundary is source-equivalent only when both of
these independent facts hold:

1. every serialized raster rectangle is the exact outward screenshot clip of
   its captured source owner; and
2. every changed device pixel is already a paint edge in the Chromium source.

The second rule is intentionally one-sided. A new or shifted SVG edge in a
source-flat region is a logical-interior mismatch and fails; an edge merely
present in the rendered image cannot excuse it. The rule therefore classifies
consumer HTML/SVG antialiasing phase without turning the 1% diagnostic into a
larger tolerance. Unit controls cover both a source-edge phase delta and an
invented interior pixel.

For atomic and transformed terminal surfaces, the final-composite mutation is
compared over the full source owner rather than only the target rectangle. An
opaque final crop can equal the correct sparse surface inside the target while
still swallowing other owner paint; the full-owner comparison exposes that
over-capture.

## Native DPR result

The local macOS arm64 Chromium 147 run produced `source-exact`, no blockers,
no production gaps, and no backdrop materialization warnings across all 34
rows. The focused rows were:

| Row | DPR 1 changed pixels | DPR 2 changed pixels | Logical verdict |
| --- | ---: | ---: | --- |
| rotate/skew transform | 0 / 8,400 | 1 / 33,004 | exact terminal owner |
| mask root | 472 / 7,920 | 0 / 31,680 | DPR1 source-edge-only; zero logical-interior pixels |
| scroll | 95 / 7,920 | 74 / 31,680 | source-edge-only; document-root owner |
| sticky | 81 / 7,920 | 52 / 31,680 | source-edge-only; document-root owner |

Every row has the expected nearest root, raster-owner count, outward source
clip, screenshot/pass count, vector and sibling order, and discriminating
no-surface plus final-composite mutations. The transform route consumes two
screenshots, mask consumes three, and direct scroll/sticky owners consume one.
Unrelated static-position and unavailable-scrollbar diagnostics remain visible
in the general warning inventory; the dedicated backdrop-warning inventory is
empty and is the strict materialization check.

## Gate

`npm run paint:backdrop-source-audit -- --dpr 1,2` is strict by default and
writes the schema-v2 report plus source/render/under/over/SVG artifacts.
`.github/workflows/backdrop-source-surface-parity.yml` runs the same immutable
matrix on native macOS, Linux, and Windows runners and uploads evidence even on
failure. `tests/backdrop-source-surface-audit.test.ts` protects the source
classifier and raster-floor guard; the browser E2E requires the full DPR-1/2
matrix to return `source-exact`.

This closes the ordinary-element continuation of
[doc 187](187-backdrop-source-surface-transitions.md) and
[doc 194](194-ordinary-backdrop-effect-space.md). Generated-pseudo ownership
remains independently gated by [doc 193](193-generated-pseudo-backdrop-source-ownership.md).
