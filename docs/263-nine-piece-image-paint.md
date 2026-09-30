---
id: "requirements/nine-piece-image-paint"
title: "263 — Shared nine-piece border and mask image paint"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: []
tickets: ["DM-PQN8QN"]
code:
  [
    "src/render/nine-piece.ts",
    "src/render/nine-piece.test.ts",
    "src/render/borders.ts",
    "src/render/mask.ts",
    "tests/features.ts",
  ]
aliases: ["docs/263-nine-piece-image-paint.md", "doc-263"]
---

# 263 — Shared nine-piece border and mask image paint

URL border images, gradient border images, and URL mask borders parse slice, width, outset, fill, and repeat inputs through `parseNinePieceInputs`. `ninePieceGrid` snaps the destination rectangle and widths once before the nine slots are routed to the relevant SVG emitter. Each URL slot samples the same original source image, avoiding seams from independently resized copies.

`paintNinePiece` sends four corners, four edges, and an optional center to each emitter. Edge and center tile periods and phases come from `ninePieceTileAxis`: `repeat` centers a natural tile, `round` fits an integral count, and `space` divides remaining space among the count plus one gaps. The center repeats on each non-stretch axis, including gradient border images. The `space` mode skips an axis when no complete tile fits.

The snap, common source image, and `space` gap calculations follow `NinePieceImagePainter::PaintPieces`, `NinePieceImageGrid`, `CalculateSpaceNeeded`, and `ComputeTileParameters` in the vendored Chromium source at `external/chromium/third_party/blink/renderer/core/paint/nine_piece_image_painter.cc` (revision `7d859f27`). The browser fixtures in `tests/features.ts` compare rendered output for gradient and mask-border center `space` cases; `src/render/nine-piece.test.ts` covers the slot and repeat matrix.
