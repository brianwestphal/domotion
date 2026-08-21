# 148 — Blink SourceGraphic ownership for HTML URL-filter convolution

## Decision

An HTML element whose CSS `filter` references an inline SVG graph containing
`feConvolveMatrix` is emitted as one Chromium-painted image surface. The trigger
is structural: a same-document URL reference plus the primitive (including an
`href`-inherited graph). Ordinary URL filter graphs and filters already inside
native SVG stay on the vector path.

This is not a tuned emboss exception. Every matrix, `order`, `divisor`, `bias`,
`targetX`/`targetY`, `edgeMode`, and `preserveAlpha` value is evaluated by the
capturing Chromium. `filterUnits`, `primitiveUnits`, CSS zoom, descendant
overflow, the target transform, and filter-before-clip ordering are likewise
captured from the live paint. The raster pass scans exact nonzero alpha over the
capture viewport; it has no guessed overflow offset or comparison threshold.

## Why vector lowering is not exact

At pinned Chromium revision `7d859f27`, `PaintLayer::UpdateFilterReferenceBox`
uses `LocalBoundingBoxIncludingSelfPaintingDescendants`; its viewport is the
inline physical-lines box or a box's stitched size. `FilterEffectBuilder`
resolves `filterUnits` against that reference box and `primitiveUnits` against
the same filter construction state. `LayoutSVGResourceContainer::ResolveRectangle`
then distinguishes object-bounding-box from viewport-based user space.

Blink's `FEConvolveMatrix` reverses the author kernel, maps edge modes to Skia
tile modes, derives the divisor when omitted, and supplies an explicit crop to
`MatrixConvolutionPaintFilter`. Pinned Skia applies that kernel to layer-space
pixels and performs input tiling/output cropping. Domotion's previous localized
SVG `<g>` could approximate the coordinate origin, but its `SourceGraphic` was
a newly rasterized vector reconstruction. A high-pass convolution exposes the
different glyph/edge sampling even when the logical boxes match. No SVG
attribute adjustment can restore pixels that were replaced upstream.

## Capture and fallback behavior

`discoverFilters` tags only qualifying HTML consumers. After the DOM walk,
`rasterizeUrlFilterSurfaces` hides unrelated paint, screenshots the complete
capture viewport with transparency, trims the result to its actual alpha extent,
and stores it on `urlFilterRaster`. The renderer emits the image atomically and
does not also emit the subtree or reapply its filter. A transparent successful
result is recorded explicitly; a screenshot failure leaves the data URI absent
and retains the prior vector URL-filter behavior.

Activation is gated by `npm run raster:boundary-oracle`. Pixel content and
atomic replacement are covered by `tests/raster-fallback-content.e2e.test.ts`
and `src/stacking-context.test.ts`. The broader blend/filter-kernel oracle
tracked by DM-2360 was not landed when this boundary was implemented; these
focused gates therefore do not claim to replace that future stage oracle.
