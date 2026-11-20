---
id: "requirements/document-canvas-background"
title: "Document canvas background propagation"
kind: "contract"
status: "partial"
owners: ["paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-GFE90Q", "DM-8F20GA"]
code:
  [
    "src/capture/script/walker/canvas-background.ts",
    "src/capture/script/walker/document-prepass.ts",
    "src/render/element-tree-to-svg.ts",
    "src/render/background-inline-paint.ts",
    "src/render/document-canvas-background.test.ts",
    "src/capture/document-canvas-background.e2e.test.ts",
  ]
aliases: ["docs/280-document-canvas-background.md", "doc-280"]
---

# Document canvas background propagation

**Status:** a transferred `<body>` background is painted as the document
canvas. An `<html>` background still paints only its color. Gradient layers
tile across the canvas from the root box like any element's (DM-8F20GA,
doc 07).

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
  `backgroundTransfersToView` and stamps `documentRootBox` (the root border box
  stitched to its scroll size, plus border and padding widths, in capture
  coordinates) on the tree root. Iframe documents never transfer to the outer
  canvas.
- The renderer paints the body's color over the capture canvas and its image
  layers positioned against `documentRootBox` (all clips `border-box`) before any
  content, then skips both on the body box. URL layers also keep their live
  canvas attachment record (doc 163).
- `rootBgComputed` still paints only `<html>`'s color, through
  `transparentRootBgRect`. A capture rooted below `<body>` gets no canvas layer
  because there is no captured body to supply its layers.

## Evidence

Full-RGBA, Playwright Chromium 147.0.7727.15, 120 × 120 over white, unchanged
`76c5d65b` → this change: body color with a 10 px margin 9400 → 0 px;
transferred white body with a real `z-index:-1` child 6400 → 0; body gradient
with that child 13865 → 0; URL tiles with a negative child, positioned against an
`<html>` with border and padding, both 0 (the legacy body box had covered the
negative layer). Controls unchanged at 0: `<html>` owning the canvas, body
`contain:paint`, and no background.
