---
id: "requirements/affine-text-paint-consumption"
title: "Exact affine text paint consumption"
kind: "contract"
status: "current"
owners: ["text-fonts","paint-effects"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2467","DM-2468","DM-2469","DM-2470","DM-2546","DM-2547","DM-2668"]
code: ["src/capture/text-line-origin.test.ts","src/render/element-tree-to-svg.ts","src/render/text-affine.test.ts","src/render/text-affine.ts","src/render/text-stroke-synthesis.test.ts","tests/text-affine-render.e2e.test.ts","tools/text-affine-baseline-protocol-oracle.ts"]
aliases: ["docs/177-affine-text-paint-consumption.md","doc-177"]
---

# Exact affine text paint consumption

DM-2470 completes the renderer half of the transformed-text protocol introduced
by DM-2469. Text is shaped and positioned in Chromium's transform-neutral,
zoom-adjusted local space, then painted through one complete signed affine
matrix. The renderer no longer converts CSS transforms into font-size scalars,
multiplies unsigned ancestor axes, or repairs the result with an SVG axis-ratio
wrapper.

## Source-owned model

The implementation is derived from the pinned source revisions used by doc 159:

- Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`
- HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`
- Skia `62efacd37737505732dbe3d8daa62abd679626a1`

Blink constructs a complete transform plus origin and physical reference box in
`paint_property_tree_builder.cc:1370-1456,1610-1628` and
`transform_utils.cc:17-49`. `text_fragment_painter.cc:506-529,641-651,730-758`
keeps the shaped fragment origin and metrics local while the paint chunk owns
the transform. HarfBuzz advances and offsets remain relative to the current
point (`hb-buffer.h:175-199`; Blink `shape_result.cc:1517-1573`). Skia then
concatenates the complete CTM before drawing the glyph run
(`SkCanvas.cpp:1336-1354,2442-2462,2580-2599`). None of these boundaries
contains a scalar text-transform calibration.

## Capture and render contract

`CapturedTextPaintGeometry.neutral` contains the ordinary captured text bundle
in the same all-transform-neutral state used to obtain the source fragment
quads. CSS `zoom` remains active in that bundle because it is a shaping/layout
input. Each correlated fragment carries the signed neutral-to-painted affine
matrix, structured Blink line origin, inline origin, shaped origins, and
advances. The line-origin record carries paint snap, integer primary ascent,
writing-mode rotation, decoded physical baseline, effective zoom, and pinned
source provenance.

`src/render/text-affine.ts` builds the CTM already emitted for every captured
ancestor, applies the element's captured transform about its captured origin,
and computes the text residual as:

```text
inverse(emitted element CTM) * Chromium fragment paint matrix
```

The renderer swaps only the text-paint inputs to their neutral values and wraps
the complete paint bundle in that residual matrix. This prevents both a missing
transform and a double transform. Matrix inversion, composition, and
serialization preserve off-diagonals, translation, and determinant sign.

The same residual route covers normal single- and multi-segment text, wrapped
fragments, RTL, vertical writing, input text, glyph paths and bitmap glyphs,
text shadow, decoration, stroke, background-clip text, and the source-owned
error boundary. Singular, non-finite, mixed-plane, uncorrelated, or projective
facts fail closed to the existing outer Chromium raster owner; they never
reactivate scalar placement.

Text-shadow copies retain the complete source text paint shape: fill, author
stroke, and every applied decoration are recolored to the shadow color before
the residual transform. Each shadow copy receives its own decoration clip ids,
so a shifted shadow cannot capture the foreground underline through a duplicate
SVG id. A blurred shadow follows Blink's `DrawLooper`/mask-filter ownership by
blurring `SourceAlpha` and applying the shadow color afterward; it does not
blur the original fill and stroke colors as independent SVG channels.

## Explicit provenance boundaries

DM-2547 closes the ordinary-text baseline provenance boundary. Capture now
constructs `CapturedTextPaintLineOrigin` from the pinned Blink painter order;
render validates its neutral plane, integer ascent, writing rotation, physical
point, zoom, and provenance before applying the residual affine matrix. The
seven-row/eight-mutation logical gate runs natively on macOS, Linux, and
Windows without pixels or a new tolerance. DM-2546 remains the distinct
pre-correlation boundary where several physical `FragmentItem`s correspond to
one line-grouped normal `TextSegment`.

The DM-2467 generated-pseudo protocol is correlated after the transform-neutral
text prepass. Its compatibility projection can therefore lack a matching
neutral bundle even though its physical pseudo fragments are authoritative.
DM-2468 remains the direct source-owned pseudo-record consumer. DM-2470 does
not infer a pseudo matrix from a host rectangle. Similarly, Chromium's ordinary
text-fragment protocol does not expose the generated line-clamp marker; a
transformed clamped owner remains one explicit Chromium surface.

## Focused evidence

- `src/render/text-affine.test.ts` proves signed composition, inversion,
  transform-origin handling, structured line-origin consumption, residual
  cancellation, reflection, and fail-closed singular/mixed planes.
- `src/capture/text-line-origin.test.ts` proves all writing-mode maps, exact
  fractional decomposition, and wrong-plane/provenance/zoom rejection.
- `tools/text-affine-baseline-protocol-oracle.ts` proves seven live logical rows
  and eight destructive mutations before raster comparison.
- `tests/text-affine-render.e2e.test.ts` compares Chromium and generated-SVG ink
  bounds at DPR 1 and 2 across identity, translation, nested transforms,
  anisotropy, skew/reflection, wrap, RTL, vertical writing, zoom,
  transform-box/origin, shadow/decoration/stroke, bitmap glyphs, and the
  line-clamp surface boundary.
- The emitted SVG mutation assertion rejects the retired cumulative-scale,
  anisotropic-correction, and offset-predivision vocabulary.

The local 2026-08-22 run passed the affine helper 3/3, the existing live capture
protocol 5/5, and the complete DPR-1/2 renderer oracle 2/2. The independent
all-platform release evidence is now the hard two-leg matrix/ink gate in
[doc 179](179-transformed-text-all-platform-gate.md), rather than an inference
from this same-machine focused comparison.
