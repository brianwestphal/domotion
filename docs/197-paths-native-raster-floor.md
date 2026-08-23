# Paths-mode native-raster floor matrix

DM-2352 separates logical text identity from the terminal raster difference between Chromium's native Skia glyph masks and consumer-rasterized unhinted SVG outlines. It is an evidence and ratification gate; it does not change the scalar caps in the HTML/Unicode visual harness.

## Ordering contract

Each row carries one complete environment fingerprint, matrix dimensions, lossless native/paths PNG provenance, expected Chromium logical facts, actual Domotion logical facts, and terminal residual measurements. `tools/paths-native-raster-gate.ts` checks in this order:

1. Reject partial evidence, warnings, or a byte-identical/inert raster arm.
2. Require exact PostScript face, source bytes, face index, variation axes, glyph IDs, clusters, advances, offsets, baseline, and six-entry affine matrix.
3. Require a ratified envelope keyed by the complete fingerprint and by font technology, size, weight, subpixel X/Y phase, transform class, and DPR.
4. Require both lossless artifact hashes to be among the reviewed envelope's source artifacts, then compare edge/area/bounds/severity measurements.

A zero-pixel row with the wrong face, gid, advance, baseline, or matrix is therefore `logical-mismatch`; a visually close wrong answer can never become `accepted-rasterization-only`. Fingerprints are not portable between OS images, architectures, Chromium/Skia/HarfBuzz revisions, font inventories, renderer revisions, consumer rasterizers, launch flags, or locales.

## Producer and workflow

`tools/paths-native-raster-producer.ts` accepts a same-run observation bundle, recomputes PNG SHA-256 values from bytes, validates every strict row, and emits normalized platform evidence. `.github/workflows/paths-native-raster-floor.yml` runs this producer on macOS, Linux, and Windows, preserves PNGs losslessly, and aggregates only after all three arms finish. Missing platform artifacts fail closed.

The committed `tools/paths-native-raster-envelopes.json` is deliberately `ratified: false`. A maintainer must review captured artifacts, publish per-fingerprint envelopes with reviewer/time provenance, and rerun the aggregate before this evidence gate can pass. Until then the adjudicator returns `envelope-unratified`, and the existing scalar visual-harness caps remain unchanged.

Source boundary: Blink `core/layout/inline` owns line placement and baseline; pinned HarfBuzz owns glyph IDs, clusters, advances and offsets; Skia `src/core/SkGlyph.cpp`, `SkScalerContext.cpp`, and platform scaler contexts own native mask generation. Only the last boundary is eligible for an envelope.
