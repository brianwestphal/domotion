# 126 — Backdrop-filter isolation via Chromium snapshots

**Status: shipped for direct target isolation; Backdrop Root/effect-space
transitions are partial (DM-2357, [doc 187](187-backdrop-source-surface-transitions.md)).**

## Requirement

An element with a non-initial `backdrop-filter` must preserve the pixels Blink
produces after sampling the already-painted backdrop, applying the backdrop
filter chain, compositing the element's own translucent background, and
clipping the result to the element's border contour. The snapshot must occupy
the element's normal paint-order position and replace the box surface while
the element's text and descendants remain vector content above it.

Ordinary `filter` remains vector. It filters the element's own render surface
and is already represented by the renderer's group/filter pipeline.

## Why this needs a raster boundary

An SVG embedded through `<img>` cannot reference the pixels painted behind one
of its groups as a filter input. Blink can: `NeedsEffectIgnoringClipPathAnd2DScale()`
requires an effect for non-empty backdrop filters,
`PopulateBackdropFilterIfNeeded()` attaches `BackdropFilterInfo` to that effect
node, and
`PaintLayer::UpdateCompositorFilterOperationsForBackdropFilter()` builds that
surface before the element's regular filter surface. Blink also appends the
regular `filter` operations to the backdrop chain when both properties occur on
one element, because those effects live on two ordered render surfaces. Pinned
Skia's `SkCanvas::internalSaveLayer()` then supplies the `priorDevice` as the
source of the backdrop filter draw. These facts make the source surface—not the
filter function spelling—the non-vector boundary. Source anchors are Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` in
`paint_property_tree_builder.cc` / `paint_layer.cc` and its pinned Skia
`62efacd37737505732dbe3d8daa62abd679626a1` in `src/core/SkCanvas.cpp`.

Reconstructing the filter primitives in SVG would therefore apply correct math
to the wrong input. Domotion instead records a viewport-relative
`backdropFilterRaster` placeholder during the DOM walk. The node-side raster
pass temporarily hides descendant subtrees, screenshots the filtered box
surface, and the renderer emits one `<image>` at the subtree root before
painting its vector text and descendants. Nested backdrop-filter descendants
therefore keep their own isolation boundary rather than collapsing into an
ancestor bitmap.

## Bounds and stacking contract

Blink's backdrop reference box is the physical border box (or an inline's
physical line bounding box), and its clip path is the pixel-snapped contoured
border. Domotion records `getBoundingClientRect()` in viewport coordinates and
uses the same outward-snapped screenshot pipeline as other Chromium-owned
paint. The rectangular PNG includes the unchanged backdrop pixels outside a
rounded contour, so stamping it over the same already-painted backdrop retains
the visual contour without synthesizing a second SVG clip.

The raster is emitted where the element subtree would have painted. This keeps
ordinary sibling order and ancestor clipping around the replacement image in
the direct document-root cases covered here. It is not a general proof of
ancestor opacity/filter/mask/blend/transform ownership: a viewport-final crop
already contains those effects and the recursively emitted ancestor wrapper can
apply them again. The DM-2357 matrix in doc 187 records that boundary and the
fixed-position sibling-order exception. Before taking each crop, Domotion captures a Chromium
`DOMSnapshot` with layout bounds and paint order. Later-painted, overlapping
subtrees are temporarily hidden while earlier paint—the backdrop input—remains
visible. Top-level descendant subtrees are hidden so their pixels can be
re-emitted as vectors; target ancestors remain visible. A later unrelated
ancestor is hidden only once rather than mutating every descendant. Nodes in
the same global paint group use layout traversal order as the sibling-order
tie-breaker.

The mutation is reversible: prior inline `visibility` value and priority are
restored after every screenshot, including error paths. Temporary
`data-domotion-backdrop-raster` tokens are removed after the pass.

DM-2490 makes diagnostics post-pass-owned. A token that maps to one painted
layout owner, whose complete hide plan resolves and whose screenshot succeeds,
is an exact isolated Chromium materialization and emits no warning. A planner
miss or unavailable DOMSnapshot retains an unisolated Chromium page crop and
emits `status: "partial"`. A failed hide-owner resolution retains a partially
isolated crop and reports the unresolved-owner count. A missing token or failed
screenshot leaves the captured vector box/background (including doc 19's
frosted color only when that fallback was captured) and emits
`status: "unavailable"`. Every diagnostic names that retained output in its
detail rather than repeating the retired claim that all backdrop filters lack
true blur.

## Validation

- `22-deep-backdrop-translucent-stack`: ~1.13% structural failure to trivial,
  2 regions / 0.01%.
- `22-deep-filter-stacking`: ~1.35% structural failure to moderate,
  6 regions / 0.04%; the remaining regions are ordinary filter/border/text
  residuals rather than missing backdrop effects.
- `22-backdrop-filter` is no longer excluded from the HTML visual suite.
- Unit coverage asserts that a populated backdrop raster replaces only the box
  surface and that the isolation planner preserves earlier backdrop nodes while
  suppressing vectorized descendants and later overlap.
- Node warning-state coverage exercises exact success, planner miss,
  DOMSnapshot/node-resolution degradation, missing tokens, and screenshot
  failure without weakening the renderer boundary.
- Playwright coverage captures a real blurred backdrop under a later
  overlapping subtree, compares the raster with an isolated Chromium crop,
  and verifies that the live page's visibility and temporary token are restored.
- DM-2357 adds 17 source-surface families at DPR 1/2, an independent
  `DOMSnapshot` paint-order comparator, and destructive no-surface/final-crop
  mutations. It confirms the narrow direct-target route and records the
  remaining Backdrop Root, generated-pseudo, and fixed-order gaps in doc 187.

The earlier solid body-color approximation remains documented in doc 19 for
historical context and as the explicit unavailable fallback when no Chromium
crop can be retained.
