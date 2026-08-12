# Text layout and SVG placement parity

Domotion treats Chromium-captured geometry as authoritative layout input. It does not re-run CSS inline layout: capture records per-character origins, line boxes, effective ascent/descent, fallback-sensitive text segments, writing mode, direction, zoom-derived transforms, and element boxes. After the HarfBuzz consolidation, both `paths` and `embedded-font` modes consume the same logical run stream and these same captured anchors; they differ only in how glyph outlines are serialized and rasterized.

`npm run fonts:layout:oracle` is the stage-level same-machine gate. Its JSON separates:

1. **Selection:** CDP platform-font records for the rendered node.
2. **Shaping:** a link to the exact glyph gate (`fonts:shaping:exact`).
3. **Metrics/layout:** Chromium Range line boxes and UTF-16 character origins versus the exact captured geometry Domotion passes to its renderer.
4. **Rasterization:** explicitly out of scope; no pixel threshold participates in logical pass/fail.

The default tolerance is `0.001` CSS px. It exists only for JSON/browser floating-point serialization; it is substantially below Chromium's 1/64 CSS-pixel LayoutUnit and cannot hide a changed glyph origin, line break, or box dimension. Override it with `--tolerance` only when the report documents a mathematically justified representation conversion.

Schema v2 records the full doc-120 parity environment fingerprint and emits an independent logical verdict. The negative-control arm disables captured character origins (collapses them to the element origin) and requires at least one fixture to move. If the fingerprint is incomplete or that movement proof is absent, the report says `verdict-withheld` and exits nonzero rather than issuing a plausible green result.

Representative fixtures exercise ligatures/kerning, soft hyphens and wrapping, letter/word spacing, combining marks, RTL, vertical writing, synthetic traits, transforms, line-height, and overall dimensions. Cursor, selection, decoration, action-overlay, clipping, and SVG placement code already consumes the captured `xOffsets`/`yOffsets` and segment rectangles; focused unit suites guard those consumers.

Unsupported CSS text/layout features must take the renderer's visible warning/raster-fallback route. In particular, a layout construct that capture cannot express as line boxes plus per-character origins must not be approximated from HarfBuzz advances. Browser zoom/device scale are recorded as geometry inputs; raster device scaling remains outside the logical comparison.

The machine-readable enumerator is `unsupportedTextParityDiagnostic`. It currently recognizes sideways vertical orientation and non-`none` tate-chu-yoko, names the exact feature, and prescribes raster text fallback. Inputs not in that table remain logical mismatches or supported inputs; they are never opportunistically relabeled `explicit-unsupported`.

Chromium source anchor: revision `7d859f27`, Blink inline layout and `platform/fonts/shaping/harfbuzz_shaper.cc`. HarfBuzz source anchor: `4de187d`. Skia begins after the logical geometry boundary described here.
