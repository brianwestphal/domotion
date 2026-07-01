# Changelog

All notable changes to **Domotion** are documented in this file.

## [0.18.0] - 2026-07-01


** Features**

- Same-origin `<iframe>` content now recurses into native SVG — crisp, scalable, and selectable — instead of being flattened to a raster `<image>`. Inner content is clipped to the iframe's content box, with counters, transforms/zoom, and inner `mask`/`clip-path`/`filter` references all resolved correctly.
- Opt-in cross-origin `<iframe>` recursion via the new `--cross-origin-frames` flag, gated by a host allowlist (non-allowlisted frames stay raster snapshots).
- `svg-scrubber --review`: report issues straight from the animated-SVG scrubber. Type a title/category/note, drag one or more regions over the problem area, optionally attach the current frame as a PNG, and save a self-contained, importable `.ticket` capturing the frame time and in/out range — the animated-SVG counterpart to `svg-review`.

** Fixes**

- Hard-cut animation transitions no longer fade across the entire frame when `optimize: true` — SVGO was factoring out and resetting the cut's `step-end` timing-function, so cuts now stay crisp through optimization.
- Transparent canvas/root backgrounds stay transparent in animated, scrolled, and composited output. Previously backgrounds given as `none`, a zero-alpha hex (`#0000`), or `rgba(0,0,0,0)` were painted as an opaque backdrop.

## [0.17.0] - 2026-06-30


**🚀 Features**

- Per-codepoint live system-fallback font resolution now runs on Linux (fontconfig) and Windows (DirectWrite), calibrated against Chromium and on by default — codepoints missing from the static tables now resolve to the same face the browser paints instead of dropping to tofu. Previously macOS-only, so Linux/Windows captures of less-common scripts and symbols are markedly more faithful.
- Added a desktop-Linux Noto font profile, selected automatically at runtime, so output matches the Noto fonts most Ubuntu/Fedora users actually have rather than only the bare CI image's fallback faces.

**🐛 Fixes**

- `border-collapse: collapse` tables now paint each shared grid edge exactly once with the winning border, instead of double-painting adjacent cells' borders and drawing table/row/section box borders as concentric rings.
- Mixed per-side 3D border styles (e.g. `ridge` top/bottom with `groove` left/right) now render with proper light/dark beveling instead of flat, bevel-less sides.
- A `background-clip: text` gradient on an inline that wraps across lines is now painted per line fragment, fixing wrong colors on each line.
- `counter()` / `counters()` now honor built-in counter styles (`upper-roman`, `lower-alpha`, etc.) in `content`, instead of falling back to plain decimal.
- `<input>` fixes: the value is now vertically centered within a tall explicit `line-height`, and it's clipped to the content box so overflowing text no longer bleeds into the padding up to the border.
- `<fieldset>` with `overflow` set no longer clips the top half of its `<legend>`.
- List markers now align to the li's first text line (not its border-box top) and outside text markers use Blink's actual margin model, fixing markers that painted too high or shifted right.
- Color emoji in `::before`/`::after` content is no longer clipped — the raster rect now matches the emoji's square advance.
- Apple-style superscript footnotes now render small and raised (via `numr`→`sups` GSUB), and carousel `::scroll-marker-group` dots and dot scaling are positioned flush at the scroller edge.
- A flex `::after` under `justify-content: space-between` (and flex-/end) now anchors to the content-right edge instead of overshooting past it.

## [0.16.0] - 2026-06-26


**⚠️ Breaking Changes**

- The bare `npx domotion-svg capture …` one-liner no longer resolves now that the package ships multiple bins. Invoke a specific bin instead, e.g. `npx -p domotion-svg domotion capture …`.
- The animated-SVG scrubber bin was renamed from `animated-svg-scrubber` to `svg-scrubber`. Update any scripts or invocations to the new command name (flags and behavior are unchanged).

**🚀 Features**

- New `svg-to-image` bin rasterizes a still SVG to an image in one shot — PNG, JPEG, and PDF, plus WebP, AVIF, and TIFF output.
- New `domotion composite` verb and `composeAnimatedLayers` primitive let you nest one already-animated SVG (cast, scroll capture, template, animate result, or another composite) inside another, each layer independently placed and timed — and composites nest recursively. Ships with a published JSON Schema for the composite config and cross-layer embedded-font de-duplication.
- `svg-to-image` and `svg-review` now accept `--port 0` to bind an OS-assigned free port, and validate `--port` / `--theme-file` at the CLI boundary.
- Single-series column/bar charts now default to a neutral palette with the peak bar in the accent color, instead of per-bar rainbow coloring.

**🐛 Fixes**

- Fixed chained animation transitions: mixing different transition types (crossfade → push-left → scroll → magic-move) no longer leaves frames with missing slide-in/fade-in keyframes — push-left, scroll, and crossfade now animate correctly instead of cutting or revealing empty canvas.
- Nested cast/template animations are now re-anchored to start when their frame becomes visible, fixing desync and mid-loop playback when composited.
- Terminal captures no longer emit a full-viewport background rect that bled past the window edge when composited into window chrome.
- In paths render mode, the glyph registry now resets per generation, so back-to-back in-process renders no longer accumulate stale glyph defs.

## [Unreleased]

** Changed**

- **Renamed the `animated-svg-scrubber` bin to `svg-scrubber`.** The command for the local video-style timeline bench is now `svg-scrubber` (e.g. `npx svg-scrubber out.svg`). This is a breaking change for any script or shortcut that invoked the old name; update call sites to `svg-scrubber`. The flags, behavior, and `src/cli/scrubber.js` entry point are unchanged.

## [0.15.0] - 2026-06-24


** Features**

- **New template system.** Built-in parameterized generators that produce self-contained SVGs through the existing capture/compose pipeline — drive them with the new `domotion template` verb or the `renderTemplateToSvg` API. Ships seven built-ins: lower-third, device-mockup, chart, chat, subscribe, background-loop, and kinetic-text.
- **Charts, chat, and subscribe templates** with rich options — charts support column/bar/line styles, single or multi-series data (grouped or stacked) with legends and a nice auto-scaled axis.
- **Procedural animated backgrounds** (`background-loop`) with seamlessly-looping `aurora`, `orbs`, gradient-pan, grid, stars, and parallax-wave variants, all deterministic from a `seed`.
- **Animated text reveals** (`kinetic-text`) with rise / slide / fade / clip / pop variants.
- **Compose templates into animations.** A frame in an `animate` config can now set `"template": "<name>"` (plus optional `"params"`) instead of capturing a page or cast recording, and frames gain duration/fit control.
- **Third-party templates.** Publish reusable templates as `domotion-template-<name>` npm packages — backed by a new authoring guide, a runnable example package, and a documented discovery convention.
- **Center-origin transforms.** Intra-frame animations now support `transformOrigin`, so scale/rotate can pivot about an element's own box instead of the SVG origin.
- **New example:** a scrolling terminal deploy session embedded in a macOS-style window bezel.
- Added `llms.txt` — a concise, discoverable guide for AI agents that want to use Domotion as a tool.

** Fixes**

- Fixed intra-frame animations that only moved an element's own box and left its subtree static — animated containers (e.g. the lower-third banner) now move their children with them.
- Fixed `background-loop` blobs snapping in/out instead of fading continuously, and grid drift leaving a growing empty margin at the loop seam.
- Smoothed the gradient-pan/grid background variants to pan continuously instead of ping-ponging, and improved the star and wave visuals.
- Fixed template frames in `mode:"full"` cast configs colliding with sibling frames and hijacking the wrong timeline.
- Fixed `domotion term` live capture failing with `posix_spawnp failed.` by self-healing node-pty's non-executable spawn helper.

## [0.14.0] - 2026-06-23


** Features**

- New `domotion term` command turns a recorded terminal session into a self-contained animated SVG with real text and faithful color — import an asciinema v2 `.cast` file, or capture a command live with `domotion term -- <cmd ...>`. Sessions render incrementally as a scrolling line pool (far smaller output), include a blinking cursor on input lines, honor mid-session terminal resizes, and can be themed (light/dark) and composed into larger animations.
- Add `--chrome` device bezels to the capture CLI — wrap a capture in a `phone`, `browser`, or `window` frame, with `--chrome-label` to set the URL/title text.
- Render conic-gradient backgrounds on form-control pseudo-elements (range slider thumb/track, color swatch, and `<progress>`/`<meter>` parts), rasterized at the exact part size.
- Render CSS `scroll-marker-group` dot/pill navigation and `::scroll-button` paging arrows.
- Complete the CSS named-color table to all 148 CSS Color 4 names, so colors like `rebeccapurple` and `cornflowerblue` now resolve in gradient and conic-gradient stops instead of being dropped.
- Support `mask-size: contain | cover` positioning.

** Fixes**

- Big batch of text-shaping and emoji fidelity fixes: honor `text-spacing-trim` for CJK fullwidth punctuation, place the synthetic dotted circle for orphaned complex-script marks the way Chrome does (LTR/RTL, CJK/Hangul tone marks, Kirat Rai modifiers), size color emoji to Chrome's advance square instead of ~20% too small, hide orphaned variation selectors instead of painting tofu, and route several precomposed letters through HarfBuzz to match Chrome's mark placement.
- Resolve `font-family: 'Helvetica Neue'` to the real Helvetica Neue face (not plain Helvetica), and route `U+2215` DIVISION SLASH through the correct system fallback — fixing a range of glyphs that previously diverged from Chrome.
- Stop stamping a color-emoji bitmap over monochrome glyphs (🌐/🎤) when the font cascade routes them to a non-emoji font.
- Border fixes: collapsed-table cell borders now paint inside their own box rather than centered on the grid line, and a single bordered side with `border-radius` paints its full rounded corner arc instead of being cut off.
- Form-control fixes: native `<meter>` paints Chrome's grooved bar with the correct value inset, plus `<details>` marker centering and the `::details-content` divider.
- Static `::after` badge placement: collapse a wrapped badge's leading space so it left-aligns, and flow an in-flow badge to the end of a text-less block host instead of its top-right corner.
- Right-align custom `@counter-style` markers via the suffix gap, matching Chrome.
- Animator: a push-left or scroll frame that is last in the loop no longer fades out across its hold.

## [0.13.3] - 2026-06-17


Based on the single commit:

- Fix multi-line typing animations revealing all lines at once in Safari

## [0.13.2] - 2026-06-17


Based on the single commit:

- Fix typing-overlay caret sticking at x=0 at the start of each line in multi-line text

## [0.13.1] - 2026-06-17


- Fix typing-overlay caret lagging behind revealed text during type-on animation

## [0.13.0] - 2026-06-17


- New `svg-to-video` export with alpha/transparent output and frame-center sampling to fix boundary ghosting
- Animations now hold the last frame at 100% by default instead of fading it out on loop
- New declarative `animate` pipeline with cursor/action, frames-out/onFrame, and overlay-resolution primitives, exposed on the public API
- Fixed reused SVG content vanishing on seeked animation renders (element-id deduping across frames)
- New public helpers: `contentBox()` padding-inset box, `resolveOverlays()` anchor→coords, and `borderBox`/`resolveCursorTarget`
- Better complex-script text: Grantha/Indic matra reordering fixes, synthesized dotted circles for covered combining marks, and path-rendered SMP alchemical symbols
- "SF Pro Text" now resolves to its installed OTF for full glyph coverage
- Drop-cap initial letters now fill and center within their content box
- Synthesized small-caps now scale punctuation and symbols in all-small-caps and unicase
- `<summary>` markers honor `::marker` color/font-size/inside position; pseudo-element gradient glows honor background-position/-size and opacity

## [0.12.0] - 2026-06-07


- Fixed list marker rendering for `<ul>`/`<ol>` items
- Corrected East-Asian font feature shaping
- Fixed vertical punctuation positioning in vertical text
- Fixed disclosure triangle arrows on `<details>`/`<summary>`

## [0.11.0] - 2026-06-06


- Auto-detect and render the correct mouse cursor for each element, matching CSS cursor keywords
- Render color emoji in more Unicode blocks: Enclosed Ideographic Supplement, Dingbats, and Enclosed Alphanumerics
- Fix combining-mark and pre-base matra positioning to match Chrome, with expanded dotted-circle script coverage
- Render "SF Pro Text", "SF Pro" optical sizes, and "New York Medium" with their correct optical-size font cuts
- Fix `background-clip: text` on nested and multi-line elements, and mis-anchored `::before`/`::after` markers
- Keep hoisted flex children painting correctly under `flex-direction: *-reverse`
- Add a crop rectangle with aspect-ratio lock to the animated-SVG scrubber

## [0.10.1] - 2026-06-05


- Fix font-rendering crash on Linux when generating SVGs with mixed scripts

## [0.10.0] - 2026-06-05


- Render vertical writing-mode text, drop caps, and `<textarea>` content as native SVG instead of screenshot overlays
- Vertical writing-mode gains text-emphasis marks, decoration painting, tate-chu-yoko, and baseline/rotation fixes
- Broaden font fallback: Brahmic complex-script shaping, Unicode NFD decomposition, dotted circles, and bundled LastResort
- Calibrate per-Unicode-block font routing across macOS, Linux, and Windows DirectWrite
- New `animated-svg-scrubber` app: play/scrub, zoom/pan, range-to-MP4 export, and trim-to-SVG
- Fix BiDi paired-bracket mirroring to resolve across wrapped lines, not per line
- Scroll improvements: per-action easing, exact `until <position>` landing, and linear easing default
- Soften the host-content glow into a blurred behind-content layer
- Fix auto-cursor timing so the pointer clicks before the change it triggers
- Publish a formal JSON Schema for the animate config

## [0.9.0] - 2026-06-01


- Vertical writing-mode text now renders as native SVG, with underline/overline/line-through and correct sideways-lr orientation
- `::first-letter` drop caps now render as native SVG, including text-shadow and pixel-accurate cap-top positioning
- `<textarea>` content and text-flavored `<input>` now render as native SVG instead of a raster screenshot
- Fixed fade-overlay `::after` content so it paints on top of descendant text
- Added Linux per-Unicode-block font routing and recalibrated macOS symbol-row fallbacks
- Bundled a LastResort fallback font as the final glyph fallback on non-macOS platforms
- Routed CJK Extension B–H and Compatibility Supplement glyphs through PingFang
- Fixed SF Compact font routing on macOS
- Resolved the primary font to the first installed family in the stack and render its real `.notdef` glyph for unmapped codepoints, matching Chrome's placeholder and clearing tofu mismatches across dozens of Unicode blocks (CJK extensions, Egyptian Hieroglyphs, Sutton SignWriting, Kana Supplement, Arabic Mathematical, and more)

## [0.8.0] - 2026-05-30


Looking at the commits, here are the user-facing release notes:

```markdown
- Fix drop-cap position when rendered from a rasterized image
- Fix positioning of `::before`/`::after` pseudo-elements that carry a transform
- Stop clipping vertical writing-mode raster images to the narrower content rect
- Route additional symbol code points (U+25C8, ♀♂⚥, Misc Technical) to correct fallback fonts
- Broaden Unicode coverage across more script blocks
- Improve svg-review diff interactions

## [0.7.0] - 2026-05-30


- Render CSS `text-emphasis` marks
- Capture CSS Transforms 2 standalone `rotate`/`scale`/`translate` properties
- Capture inline SVG `<filter>` defs referenced by `filter: url(#id)`
- Accept the canonical `paint-order: stroke` shorthand
- Synthesize small-caps in embedded fonts that lack the OpenType feature
- Fix emoji, drop-cap, and vertical-writing-mode text rasterization glitches
- Fix `::after`/`::first-letter` pseudo-element placement in flex and wrapped layouts
- Fix cover-mode background image positioning and `<image>` pixel snapping
- Better RTL bracket mirroring and soft-hyphen line-wrap handling
- `svg-review`: figure-level click for lightbox; captions survive deletion

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

