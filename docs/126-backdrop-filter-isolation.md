# 126 — Backdrop-filter isolation via Chromium snapshots

**Status: shipped (DM-2171).**

## Requirement

An element with a non-initial `backdrop-filter` must preserve the pixels Blink
produces after sampling the already-painted backdrop, applying the backdrop
filter chain, compositing the element's own translucent background and
descendants, and clipping the result to the element's border contour. The
snapshot must occupy the element's normal paint-order position and replace—not
supplement—the vector subtree.

Ordinary `filter` remains vector. It filters the element's own render surface
and is already represented by the renderer's group/filter pipeline.

## Why this needs a raster boundary

An SVG embedded through `<img>` cannot reference the pixels painted behind one
of its groups as a filter input. Blink can: `PopulateBackdropFilterIfNeeded()`
attaches `BackdropFilterInfo` to a separate effect node, and
`PaintLayer::UpdateCompositorFilterOperationsForBackdropFilter()` builds that
surface before the element's regular filter surface. Blink also appends the
regular `filter` operations to the backdrop chain when both properties occur on
one element, because those effects live on two ordered render surfaces.

Reconstructing the filter primitives in SVG would therefore apply correct math
to the wrong input. Domotion instead records a viewport-relative
`backdropFilterRaster` placeholder during the DOM walk. The node-side raster
pass screenshots those exact Chromium-composited pixels, and the renderer emits
one `<image>` at the subtree root and returns before painting its vector box,
text, or descendants. Nested backdrop-filter descendants naturally collapse
into the nearest snapshotted ancestor.

## Bounds and stacking contract

Blink's backdrop reference box is the physical border box (or an inline's
physical line bounding box), and its clip path is the pixel-snapped contoured
border. Domotion records `getBoundingClientRect()` in viewport coordinates and
uses the same outward-snapped screenshot pipeline as other Chromium-owned
paint. The rectangular PNG includes the unchanged backdrop pixels outside a
rounded contour, so stamping it over the same already-painted backdrop retains
the visual contour without synthesizing a second SVG clip.

The raster is emitted where the element subtree would have painted. This keeps
normal sibling order, opacity ownership, and ancestor clipping around the
replacement image. A later overlapping translucent sibling can still be
present in the page screenshot used to build an individual raster; isolating
that uncommon overlap without losing the sampled backdrop requires a dedicated
paint-order-aware capture pass and is tracked separately.

## Validation

- `22-deep-backdrop-translucent-stack`: ~1.13% structural failure to trivial,
  2 regions / 0.01%.
- `22-deep-filter-stacking`: ~1.35% structural failure to moderate,
  6 regions / 0.04%; the remaining regions are ordinary filter/border/text
  residuals rather than missing backdrop effects.
- `22-backdrop-filter` is no longer excluded from the HTML visual suite.
- Unit coverage asserts that a populated backdrop raster replaces the complete
  vector subtree.

The earlier solid body-color approximation remains documented in doc 19 for
historical context and as a pre-raster fallback when no snapshot is available.
