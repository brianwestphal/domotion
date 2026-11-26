---
id: "requirements/document-canvas-background"
title: "Document canvas background propagation"
kind: "contract"
status: "partial"
owners: ["paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-GFE90Q", "DM-8F20GA", "DM-84Q07C", "DM-G89D0B"]
code:
  [
    "src/capture/script/walker/canvas-background.ts",
    "src/capture/script/walker/document-prepass.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/background-inline-paint.ts",
    "src/tree-ops/walk-captured-elements.ts",
    "src/capture/embed.ts",
    "src/render/document-canvas-background.test.ts",
    "src/capture/document-canvas-background.e2e.test.ts",
    "src/scroll/composer.test.ts",
  ]
aliases: ["docs/280-document-canvas-background.md", "doc-280"]
---

# Document canvas background propagation

**Status:** the document canvas paints its full background — color and every
image layer — whether `<html>` or a transferred `<body>` supplies it, and
whatever element the capture is rooted at. Gradient layers tile across the
canvas from the root box like any element's (DM-8F20GA, doc 07). A capture
whose canvas supplies its only paint retains the canvas source in the
serialized roots array (DM-G89D0B).

## Source (Chromium `7d859f27`)

- `StyleResolver::PropagateStyleToViewport`
  (`core/css/resolver/style_resolver.cc:3390-3500`): the viewport takes
  `<html>`'s background, or the first `<body>`'s when `<html>` has none
  (`ComputedStyle::HasBackground`: a visible color or any image layer). Missing
  boxes or any containment on either element stop body propagation. Every
  propagated layer is clipped to `border`, so the painting area is the whole
  canvas, and `scroll` attachment becomes `local`.
- `LayoutBoxModelObject::BackgroundTransfersToView`
  (`core/layout/layout_box_model_object.cc:1095-1126`): the box whose background
  moved paints none of it itself (`box_fragment_painter.cc:1923`).
- `ViewPainter::PaintBoxDecorationBackground` (`core/paint/view_painter.cc:76-330`)
  paints it before the root stacking context's negative z-order children
  (`core/paint/paint_layer_painter.cc:471-479`). The root element's box is the
  positioning area.

## Domotion

- Capture flags the top document's transferring body with
  `backgroundTransfersToView` and stamps two root payloads on the tree's first
  element whenever `<html>` or `<body>` supplies a canvas background:
  `documentRootBox` (the root border box stitched to its scroll size, plus
  border and padding widths, in capture coordinates) and
  `documentCanvasBackground`, a child-less record for the source element (its
  `tag` names the source) carrying that element's full style record from the
  same builder every captured element uses — layers, selected-image facts and
  the canvas attachment record (doc 163) — with the root box as its geometry.
  The record exists even when the source element is not captured (a capture
  rooted below `<body>`, e.g. a selector for one card). Iframe documents never
  transfer to the outer canvas.
- When a selector matches but no element boxes survive, the same source record
  occupies the first slot with `documentCanvasOnly: true` and no children.
  The renderer paints its color and layers once inside the frame. Page-scroll
  composition keeps the record in its own segment even when the source element
  has fixed or sticky positioning. A missing selector or a canvas without
  authored paint can still yield an empty array.
- Resource passes that walk the tree — `walkCapturedElements` (conic and
  advanced-gradient rasters, embedded-image resizing) and
  `embedRemoteImages` — visit the record right after its host, so its URL and
  raster-backed layers resolve like any element's.
- The renderer paints the canvas before any content: a `<body>` source's color
  over the render's whole `width × height`, then the source's image layers
  positioned against `documentRootBox` (all clips `border-box`). A transferring
  body skips both on its own box. For a tree with element boxes,
  `transparentRootBgRect` and the multi-frame composers' root rect paint
  `rootBgComputed` once beneath the image layers. Older trees without the record fall back to the captured
  transferring body.
- Multi-frame output: every animator frame and every scroll segment renders
  through `elementTreeToSvgInner(tree, width, height)`, so the canvas spans that
  frame's or segment's own extent; page-scroll segments each carry their
  capture's root box (shifted by their scroll offset), and element-scroll
  segments, which keep only the scroll owner, paint no canvas of their own.

## Evidence

Full-RGBA, Playwright Chromium 147.0.7727.15, 120 × 120 over white, unchanged
`76c5d65b` → this change: body color with a 10 px margin 9400 → 0 px;
transferred white body with a real `z-index:-1` child 6400 → 0; body gradient
with that child 13865 → 0; URL tiles with a negative child, positioned against an
`<html>` with border and padding, both 0 (the legacy body box had covered the
negative layer). Controls unchanged at 0: `<html>` owning the canvas, body
`contain:paint`, and no background.

DM-84Q07C, same harness: `<html>` gradient on a 60 px root (tiling down the
canvas) and `<html>` URL tiles over an `<html>` color beneath a negative layer
both 0 px, with the record removed both > 1000 px; captures rooted at an
80 × 80 clip around a card below a body color, a body gradient and an `<html>`
gradient all 0 px, > 1000 px without the record. A translucent `<html>` color
stays 0 px (painted once). Gradient comparisons keep the clip origin on a
multiple of 4 px: Skia dithers gradients on a 4 × 4 device-space matrix, so an
off-grid clip differs by 1 level in a regular pattern (rasterization phase,
not geometry).

DM-G89D0B compares transparent-background RGBA at 120 × 120. A 60 px-tall
HTML gradient and a translucent HTML color each went from 14,400 different
pixels to zero after a JSON round-trip. The canvas-only positioning area uses
the root fragment's border box. In a separate standards-mode control with
one painted 1 × 1 child, the existing element-tree path uses the 120 px CSSOM
document scroll height for that same 60 px tile, leaving 14,399 different
pixels (DM-CRN48M).
