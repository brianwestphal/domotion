# 133 — Replaced elements, controls, and generated-content geometry oracle

`npm run replaced:geometry-oracle` is the live-Chromium decision gate for the
geometry and ownership transitions that do not belong to ordinary CSS box
painting.

The object-fit leg paints an 80×40 intrinsic image into a 200×120 content box
and observes the colored pixel bounds in Chromium. All five sizing modes
(`fill`, `contain`, `cover`, `none`, and `scale-down`) are compared with
`computeObjectFitRect()`, including non-min/mid/max percentages and computed
`calc()` positions. This follows Blink's
`LayoutReplaced::ComputeObjectFitAndPositionRect`: choose the concrete object
size, resolve each position axis against the remaining free space, then clip
paint to the content box. Domotion emits that concrete rectangle directly;
SVG `preserveAspectRatio` is no longer used as a three-bucket approximation
when intrinsic dimensions are available.

The control leg captures live native and author-owned controls. Chromium's
native `appearance` surface must activate `nativeControlRaster`, while
`appearance:none` and an author-painted button must remain on the vector path.
Activation is distinct from materialization: [doc 167](167-native-control-source-frame-rasters.md)
owns the coherent source/isolation frames, alpha, clipping, platform state, and
fail-closed warning contract for the activated native surface.
The generated-content leg compares the painted pixel bounds of positioned
`::before` and `::after` boxes with the capture walker's `pseudoBoxes` records.
It does not prove in-flow generated text origins, line-box baselines,
`vertical-align`, wrapped/bidi/vertical fragments, mixed text and images, or
fragmentainer translation. [Doc 157](157-pseudo-generated-fragment-geometry-audit.md)
audits that separate Blink fragment boundary; DM-2466, DM-2467, and DM-2468
own its decoder/oracle, capture record, and renderer/visual gate respectively.

The 11-row gate has a mutation control that changes object-position and
requires the concrete rectangle to move. Pixel fixtures remain responsible
for final compositing, platform theme pixels, generated glyph outlines, and
the deliberately frozen contents of dynamic replaced surfaces.

Dynamic replaced-surface *transform mapping* is no longer left to a broad
pixel fixture: `tests/replaced-snapshot-transform.e2e.test.ts` independently
compares Chromium and rendered-SVG colored ink at DPR 2 (three-device-pixel
bound) across a partially off-page canvas, nested affine transforms, CSS zoom,
scroll, and a scrolled ancestor overflow clip applied after rotation. It also checks
actual-PNG source-crop scaling, clipped transformed video/inaccessible-iframe
pixels, a vector sibling negative, and projective single ownership.
The 11 rows in this document still own replaced layout/object-fit decisions;
the focused DM-2380 gate owns local-surface raster-to-output mapping.

Broken-image hybrid emission remains an explicit uncovered replaced-content transition.
[Doc 156](156-broken-image-fallback-ownership-audit.md) shows that Blink swaps
the host to a UA-shadow block-flow/inline fallback with its own 18 px threshold,
border/padding/clip, and shaped text geometry. DM-2463 now captures that state
through pierced CDP, including physical boxes/styles, hidden-text/font facts,
DPR selection, and AX semantics. The current 11 rows do not prove hybrid SVG
emission or icon pixels. DM-2465 adds those rows after DM-2464; until then this
oracle must not be cited as end-to-end broken-image parity.
