---
id: "requirements/background-clip-text-url-color-semantics"
title: "181 — background-clip:text URL and color semantics"
kind: "contract"
status: "current"
owners: ["text-fonts","paint-effects","product-tooling"]
platforms: []
tickets: ["DM-2366"]
code: ["src/render/background-clip-text.test.ts","src/render/text-stroke-synthesis.test.ts","tests/features.ts","tools/background-clip-text-oracle.ts"]
aliases: ["docs/181-background-clip-text-url-color-semantics.md","doc-181"]
---

# 181 — `background-clip:text` URL and color semantics

DM-2366 closes the two remaining paint gaps in the vector text-clip route:
source-selected `url()` background images and a non-transparent
`background-color`. Text remains native SVG path/text output; no screenshot of
the glyph run is used to make the comparison pass.

## Pinned Blink decisions

The implementation follows the pinned Chromium paint pipeline rather than
treating `background-clip:text` as a special kind of CSS text fill:

1. `BoxPainterBase::PaintFillLayers` iterates CSS background layers in reverse,
   so the first authored image is painted last/on top.
2. `BoxPainterBase::FillLayerInfo` sets `is_bottom_layer` from
   `!layer.Next()` and only lets that bottom layer paint `background-color`.
   The color therefore uses the bottom layer's effective `background-clip`.
3. `PaintFillLayerBackground` paints that color first and its image second.
4. When the effective clip is `EFillBox::kText`,
   `PaintFillLayerTextFillBox` opens the layer, paints color+image, then applies
   a `SkBlendMode::kDstIn` text mask. Foreground text is painted later.
5. `BoxFragmentPainter::PaintTextClipMask` offsets a sliced inline against its
   continuous imaginary box using writing direction; clone fragments remain
   independent boxes.
6. `TextPainter::TextPaintingStyle` retains `TextStrokeWidth` in
   `PaintPhase::kTextClip`. It replaces paint colors because DstIn consumes
   alpha, not luminance. The glyph mask therefore includes author stroke
   geometry even though the visible foreground stroke is painted later.

Source anchors are
`external/chromium/third_party/blink/renderer/core/paint/box_painter_base.cc`
(`PaintFillLayers`, `FillLayerInfo`, `PaintFillLayerBackground`, and
`PaintFillLayerTextFillBox`),
`box_fragment_painter.cc` (`PaintTextClipMask`), and `text_painter.cc`
(`TextPaintingStyle`).

## Renderer ownership

`paintBackgroundImageLayers` now returns the complete text-clipped background
stack:

- every gradient/URL image remains in CSS source order;
- a non-transparent color is appended as a synthetic bottom entry only when
  the bottom effective clip is `text`;
- normal box/fragment color painting is suppressed in that state;
- URL layers consume the capture-owned selected candidate, natural sizing,
  effective zoom, attachment record, origin, size, position, and repeat facts;
- sliced inline layers consume each fragment's captured stitched
  `backgroundPositioningArea`; clone layers restart against each physical
  fragment.

The text phase builds an SVG `mask` with `mask-type:alpha`, paints stack entries
bottom-to-top through it, and then paints the ordinary foreground fill/stroke.
Transparent text skips the invisible fill while retaining its visible stroke
pass. Opaque or semitransparent text is not a shortcut: the clipped background
still exists beneath the foreground, matching Blink's phase order.

Blink's text-clip pass walks descendant text. The renderer records the captured
parent relation and lets a text node without its own clipped stack consume the
nearest ancestor's already-built stack. This replaces the former
gradient-only/transparent-only ancestor projection and retains URL selection
and geometry without duplicating or reinterpreting capture facts.

## Verification

- `src/render/background-clip-text.test.ts` locks color-only clipping,
  URL+color+multi-layer order, opaque foreground order, descendant ownership,
  and stitched slice geometry.
- `src/render/text-stroke-synthesis.test.ts` locks Blink's alpha-mask stroke
  geometry and the later visible foreground stroke.
- `tests/features.ts` contains URL/color-stack and inherited URL/stroke visual
  fixtures in addition to the established gradient controls.
- `tools/background-clip-text-oracle.ts` captures live Chromium at DPR 1/2,
  removes every text-raster escape from the captured tree, renders SVG, and
  compares saturated URL/color signal edges in a constant four-device-pixel
  disk. It also requires loaded selected-image/natural-sizing records, alpha
  masks, URL pattern defs, and masked solid colors.

The gate fails closed when URL selection/sizing is unavailable, when a text
raster boundary appears, when required structural evidence is absent, or when
either visual leg exceeds the fixed signal-edge/pixel-count bounds.
