# Changelog

All notable changes to **Domotion** are documented in this file.

## [0.2.2] - 2026-05-18


- Fix framer chevron icons rendering via data:URI mask support
- Fix brand logos disappearing due to off-screen transformed ancestor culling
- Fix rotated/skewed element AABB calculation for correct bounding boxes
- Fix px-positioned gradient stops rendering at wrong offsets
- Fix outline clipping at element edges
- Fix paint order for floated elements

## [0.2.1] - 2026-05-18


- Fix rotated/skewed bounding boxes, px gradient stops, outline clipping, and float paint order
- Scale font metrics by ancestor transforms and capture descendants past transformed ancestors
- Emit `clip-path` for `overflow:hidden`/`clip` and resolve `closest-side`/`farthest-side` keywords
- Capture replaced elements at their live painted rect instead of the frozen rect
- Fix input baseline drift for flex-centered inputs and route input text through raster fallback
- Raster-fallback PUA pseudo glyphs when icon fonts are unavailable; emit CSS triangle pseudos as `<polygon>`
- Honor `font-variation-settings` and `font-feature-settings` during shaping
- Correct stacking contexts for `transform-style != flat` and `z-index:0`
- Add `svgz` output, drop off-viewBox and accessibility-hidden content, and support `mask-composite` subtract/intersect/exclude
- Scroll-redesign: pattern grammar, viewport-chunked long scrolls, CLI progress logging with `--quiet`, and reworked public API in `src/index.ts`

## [0.1.1] - 2026-05-11


- Renamed npm package from `domotion` to `domotion-svg`

## [0.1.0] - 2026-05-11


- Initial release

## [0.1.0] - 2026-05-11


- Initial release

