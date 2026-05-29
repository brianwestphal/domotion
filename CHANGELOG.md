# Changelog

All notable changes to **Domotion** are documented in this file.

## [0.6.0] - 2026-05-29


- `elementTreeToSvg` now returns a complete `<svg>` document (the old renderer is `elementTreeToSvgInner`)
- New magic-move transition slides shared elements between frames, morphing size and cross-fading paint changes (honors reduced-motion)
- New CLIs: `svg-review` for consumer fidelity bug reports and `svg-to-video` for GIF/APNG/video export
- Linux and Windows rendering now calibrated to native fonts (FreeType / DirectWrite), with reproducible embedded fonts
- Added a HAR-file capture source
- Text fixes: wavy-underline truncation, transparent gradient stops, embedded text-width scaling, RTL glyph alignment, and emoji raster overlays
- Box fixes: border-radius wedges, dashed-border/outline corner phasing, text-stroke on transparent fill, background-clip:text inheritance, and zoom-scaled radius
- MathML: radical signs, stretchy fence operators, Math-Alphanumeric glyphs, and fraction-bar width
- Support external-file `clip-path` / `mask-image` fragment refs and `clipPathUnits="userSpaceOnUse"`

## [0.5.0] - 2026-05-25


- New declarative animate config — compose multi-frame animations from a config file
- Added overlay primitives: config-level cursor, selector-anchored overlays, and a standalone blink
- Typing overlay now renders a blinking insertion caret
- Blink and pulse intra-frame animations now support repeat / alternate
- Added richer readiness waits before capture, plus repeating-animation support
- Added a `maxWidth` option to the animate config
- Fixed crossfade z-order, push-left/scroll keyframes, and body-gradient capture
- Font-family values are now escaped, and all animator transitions composite correctly

## [0.4.2] - 2026-05-25


- Typing-overlay text now wraps to the box width like a real textarea

## [0.4.1] - 2026-05-25


- Fix an emoji glyph leaking into rendered text output

## [0.4.0] - 2026-05-25


- Text now renders with embedded fonts by default across all outputs.
- Embedded-font output positions glyphs via a single `<text>` x-list for smaller, cleaner SVG.
- Linux support: platform-aware font discovery with a calibrated Linux fallback chain.

## [0.3.3] - 2026-05-25


This commit is a CI/release-workflow fix (asset upload made repo-aware), which the rules exclude. There are no user-facing changes in the provided commits, so there are no release-note bullets to emit.

## [0.3.2] - 2026-05-25


- macOS glyph-extractor binary is now code-signed and notarized in releases

## [0.3.1] - 2026-05-25


Linux CI test fix

## [0.3.0] - 2026-05-25


- MathML now renders fraction bars, square-root/root radicals, and italic Latin/Greek identifiers
- Wavy underlines recalibrated to match Chrome and now break around descenders
- `::first-letter` drop caps no longer clipped or doubled; text under `zoom` and anisotropic scaling sized correctly
- Borders: mixed-width rounded corners and dashed/dotted dash alignment now match Chrome
- `border-image`/`mask-border` support gradient sources, full 9-slice, and `repeat: space`/`round` tiling
- `clip-path` honors `url(#id)` references, `inset(… round …)` radii, and geometry-box keywords
- Backgrounds: `background-blend-mode`, `background-attachment: local` sizing, and gradient text-clip inherited from ancestors
- New font coverage: Source Serif Pro, Hiragino Sans, sub/superscript glyphs, and ⭐/❤️ emoji
- Pseudo-element transforms and inline positioning fixed; box-shadows now paint on clipped popovers/dialogs
- Custom `@counter-style` list markers, `content-visibility: hidden` placeholders, and per-axis overflow clip + `overflow-clip-margin`

## [0.3.0] - 2026-05-24


- MathML now paints fraction bars, radical signs, and italic Latin/Greek identifiers
- Floated `::first-letter` drop caps no longer clip; wavy underlines break around descenders
- Custom `@counter-style` rules and `counter()`/`counters()` now resolve for markers and content
- `border-image`/`mask-border` gain gradient sources, 9-slice tiling, and repeat/round/space
- Dashed and dotted borders now align dashes at corners like Chrome
- `clip-path: url(#id)`, `inset(... round ...)`, and `background-blend-mode` now honored
- CSS `zoom` scales text correctly; `transform-style: preserve-3d` sorts children by depth
- New Source Serif Pro / Hiragino Sans routing; star, heart, and icon-font fallback glyphs paint
- Pseudo-element transforms (rotated badges, check-marks) and `vertical-align` positioning fixed
- `content-visibility: hidden`, `overflow-clip-margin`, and box-shadows escaping overflow clips handled

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

