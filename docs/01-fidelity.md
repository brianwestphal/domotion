# Domotion: rendering fidelity and warnings

Requirements and support matrix for Domotion — the engine that converts captured HTML/CSS into SVG for animated demos. This doc is the contract with consumers about **what CSS features round-trip**.

## Goals

- Faithful visual reproduction of captured DOM as SVG, targeting Chromium on the host platform as the canonical reference.
- Predictable output: if a feature isn't fully supported, the tool says so (it doesn't silently drop content).
- Self-contained SVG: renders identically when embedded in a page or loaded standalone.
- **Cross-platform parity**: works on macOS, Linux, and Windows like any normal npm package, calibrated against Chromium's actual fallback behavior on each platform (CoreText / fontconfig / DirectWrite). **macOS is the most validated platform.** Linux and Windows now have calibrated fallback chains plus generated per-Unicode-block routing tables (`unicode-font-routing.{linux,win32}.generated.ts`, from Chrome CDP sweeps — DM-984 / DM-987) and native glyph extractors (docs 41 / 45), so non-Latin text renders as glyph paths rather than tofu; they are less battle-tested than macOS and CI hardening continues (DM-262). New code must be platform-aware from the start, not macOS-hardcoded. **Help wanted**: bug reports, test runs, and fixes for Linux/Windows from the community are welcome — open an issue or PR on the GitHub repo.

## Support matrix

Checked = round-trips faithfully (< ~3% pixel diff vs. Chromium capture). Partial = works for common cases; edge cases below threshold. Unsupported = captured but not emitted, or emitted approximately; warning is logged.

### Layout & box model

- [x] position: static, relative, absolute
- [~] position: fixed, sticky — paint order correct, but rendered as static snapshot at t=0 (no scroll-following animation)
- [x] display: block, inline, inline-block, flex, grid, table
- [x] float + clear (text wraps correctly around floats via per-line capture)
- [x] box-sizing, margin, padding, width/height, min/max
- [x] overflow: hidden/scroll/auto/clip (children clipped to padding box)
- [~] overflow: scroll/auto — content is clipped but native scrollbar chrome is not yet emulated (tracked SK-468)

### Visual / paint

- [x] background-color (all modern CSS color formats: hex/rgb/hsl/hwb/lab/lch/oklab/oklch/color()/color-mix)
- [x] background-image: linear-gradient, radial-gradient, repeating-*, url()
- [x] multiple background layers (first-on-top semantics preserved)
- [x] background-image: conic-gradient — rasterized to a `<pattern><image>` tile (no native SVG conic). See `28-conic-gradient.md`.
- [~] background-size, -position, -repeat — url() layers approximate center/cover
- [x] border (uniform) with border-radius
- [x] border (per-side with different width/style/color)
- [x] box-decoration-break (`slice` default + `clone`) on (a) wrapped inline elements and (b) block-level elements that fragment at a multi-column container boundary — per-fragment paint of background / border / shadow / image. Slice direction depends on the fragmentation axis: inline-axis (wrapped inline) means first fragment owns LEFT + TL/BL, last owns RIGHT + TR/BR, intermediate fragments paint top + bottom only; block-axis (multi-column block) means first owns TOP + TL/TR, last owns BOTTOM + BL/BR, intermediate paint left + right only. Clone mode paints a complete box on every fragment regardless of axis. Slice-mode background-image continuation across fragments is not yet supported (clone-mode bg-image is).
- [x] border-style: solid, dashed, dotted
- [x] border-style: double, groove, ridge, inset, outset — implemented in dom-to-svg.ts uniform-border path
- [x] border-radius percentages (e.g. `border-radius: 50%` → circle when symmetric box) — SK-1093
- [x] per-corner border-radius (asymmetric `10px 30px 50px 70px`) and elliptical corners (`50px / 20px`) — DM-300, see docs/14
- [ ] border-image — tracked SK-466
- [x] outline (style/width/color/offset, including dashed/dotted) — SK-1111
- [x] box-shadow: outset and inset, with blur via `<filter feGaussianBlur>` — SK-1101 / SK-1111 / SK-1113
- [x] text-shadow: x/y offset + blur, multi-layered — SK-1113
- [x] opacity (element-level, applies to whole subtree)
- [x] filter (blur, brightness, contrast, drop-shadow, grayscale, hue-rotate, invert, opacity, saturate, sepia, chained)
- [x] mix-blend-mode
- [ ] backdrop-filter — captured but not emitted (no SVG equivalent in img-rendered SVG)
- [x] clip-path: inset(), circle(), ellipse(), polygon()
- [ ] clip-path: path() — not supported (warning logged if detected)
- [x] mask (mask-image gradient/url() fragment/element() paint refs) — emitted as SVG `<mask>`. See `20-css-mask-emission.md` / `21` / `22`.

### Transforms

- [x] transform: translate/rotate/scale/skew/matrix — full 2D affine, emitted as an SVG `transform` (Chromium resolves the computed value to `matrix()`/`matrix3d()`, which is what's consumed). See `06-css-transforms.md`.
- [~] transform: 3D — flattened to its 2D projection (no perspective). See `06-css-transforms.md`.

### Typography

- [x] Font families: generic keywords (`serif`/`sans-serif`/`monospace`/`cursive`) + a handful of installed families. The mapping is platform-specific (macOS today: Helvetica / Times / Courier / SF Pro / SF Mono / Snell Roundhand / Hiragino Sans GB / Apple Symbols / Zapf Dingbats / STIX Two Math; Linux and Windows mappings tracked DM-258 / DM-259 / DM-260). Unmatched families fall through to the platform's sans-serif default. See `03-font-family-chain.md`.
- [x] Webfonts via `@font-face` (DM-227): same-origin sheets are walked for `@font-face` rules; cross-origin fonts (Google Fonts, Adobe Fonts) are picked up by a `requestfinished` listener attached before navigation. Each font buffer is fetched via the browser's request stack, parsed with fontkit, and registered into a per-capture registry that the resolver consults before the on-disk fallbacks.
- [x] Variable webfont axes (DM-228 / DM-229): `wght`, `opsz`, `slnt` driven from CSS `font-weight` / `font-size` / `font-style` via `applyVariationAxes`. WOFF2 buffers are decompressed to TTF (via `wawoff2`) before fontkit parsing — fontkit's WOFF2 variation path returns an instance whose tables can't be read.
- [x] Weight, size, style (italic via SFNSItalic.ttf — SK-1105), variant, stretch
- [x] Vertical baseline placement: CAPTURE_SCRIPT records `canvas.measureText().fontBoundingBoxAscent` for every text-bearing element so the renderer anchors each line's baseline at the exact pixel Chrome paints. fontkit's HHEA-based `font.ascent` is correct for SF Pro / SF Mono (where HHEA = `OS/2.usWinAscent`) but disagrees for Helvetica / Arial / Times / Georgia / Menlo / Courier on macOS, where Chrome reads `winAscent` — at fontSize 32 Helvetica the gap is ~5 px, so larger headings drift up without the captured override (DM-237).
- [x] letter-spacing, word-spacing, line-height
- [x] Multi-line wrapped paragraphs (per-visual-line capture via Range)
- [x] text-align: left/right/center/start/end
- [~] text-align: justify — does not space-stretch (warning logged)
- [x] RTL/bidi + complex-script shaping — Arabic contextual joining, Devanagari cluster reordering / conjuncts, Thai mark-on-base, and CJK GPOS are shaped through `font.layout()` / CoreText (DM-1022 / DM-1028), with paired-bracket mirroring on RTL embedding levels. (fontkit shaping ≈ HarfBuzz; gap < 1% at body sizes.)
- [x] writing-mode: vertical-rl/vertical-lr/sideways-* — upright + rotated vertical runs, text-combine-upright. See `02-writing-mode.md`.
- [x] Color-bitmap glyphs (emoji, U+2713, etc.): rasterized via Playwright `page.screenshot` and embedded as `<image>` — SK-1058 / SK-1090
- [x] ::first-letter drop caps (rasterized when font-size differs from element) — SK-1114
- [x] `background-clip: text` (gradient/image-fill inside glyph shapes) — DM-462. Captured via `webkitTextFillColor`; rendered via SVG `<mask>` over a `<rect fill="url(#bg)">`. See `18-background-clip-text.md`.

### Images

- [x] `<img>` with src/width/height
- [x] object-fit (fill/contain/cover/scale-down) + object-position → SVG preserveAspectRatio
- [x] `<picture>`/`srcset` → captured as the resolved `<img currentSrc>`
- [~] broken-image alt fallback — not rendered (blank rect)
- [x] `<svg>` inline content (passed through verbatim)

### Form controls

- [x] `<input>` with `value` attr — rendered via path
- [x] `<input>` placeholder — rendered in `::placeholder` color (and font-style, font-weight) — SK-1097 / SK-1100 / SK-1099
- [x] `<textarea>` content — rasterized via `page.screenshot` for pixel-perfect Chrome word-wrap — SK-1108
- [~] `<button>`, `<select>` chrome: synthesized to UA-default; author-styled `::-webkit-*` pseudos partially supported (tracked SK-1125 / SK-1126)

### List markers

- [x] `list-style-image: url(...)` on `<li>` — rendered as `<image>` at the marker slot
- [x] `list-style-type`: disc/circle/square/decimal/lower-alpha/lower-roman/… — synthesized as shape or text marker
- [x] `::marker` styling (color / font-weight / font-size) — SK-1115

### Stacking

- [x] z-index for positioned siblings (paint order sorted: negative, base, auto/0, positive)
- [~] Nested stacking contexts (trapped z-index inside opacity/transform context) — flattened; may paint above outside sibling

### Rasterized as static snapshot

- `<canvas>`, `<video>`, `<iframe>`, `<object>`, `<embed>` — DM-457. Each element's content-box is screenshot via Playwright under a hide-everything-else stylesheet and embedded as an `<image>` at the captured rect. The result is pixel-faithful to whatever Chromium painted at t=0 (drawn canvas pixels, video poster/current frame, iframe document, plug-in content). Live playback / interaction is still out of scope. The capture warning is still emitted because these element types are out of the spirit of the path-based contract — the snapshot is a frozen raster, not a faithful re-render. See `17-replaced-element-snapshots.md`.

### Out of scope

- CSS animations / transitions — domotion captures a static frame; multi-frame animation is composed at a higher layer (see `src/animation/animator.ts`).
- `@page` print-media rules — screen capture only.

## Warning system

Every call to `captureElementTree()` collects warnings when it encounters a feature from the lists above that doesn't round-trip fully. After the call:

```ts
import { captureElementTree, getLastCaptureWarnings, logCaptureWarnings } from "domotion-svg";

const tree = await captureElementTree(page, "body", viewport);
logCaptureWarnings();      // stderr one-line-per-warning
// or structured:
for (const w of getLastCaptureWarnings()) {
  console.log(w.selector, w.feature, w.detail);
}
```

Each warning has:
- `selector`: a short CSS-selectorish path (up to 5 ancestors) identifying the element.
- `feature`: the feature name (e.g. `transform`, `backdrop-filter`, `<iframe>`, `scrollbar`, `text-align:justify`).
- `detail`: one sentence on what's not supported and/or a tracking ticket reference.

Warnings are deduped by `(feature, selector)` within one capture. They're stored in `html-test-suite.tsx`'s `results.json` under the `warnings` key for each test file, and shown as a badge `(Nw)` next to failing lines in the console output.

## Testing approach

- `tests/features.ts` — 36 focused feature tests exercising one rendering property each. Target <3% pixel diff vs. captured HTML. Every change to fidelity must pass these.
- `tests/showcase.ts` — 3 full-page integration tests derived from real product frames.
- `tests/html-test-suite.tsx` — large external suite covering broadly-supported HTML5 + stable CSS, sourced from `external/html-test/` (clone of `github.com/brianwestphal/html-test`, gitignored). Baseline tracked in `tests/output/html-test/results.json` and visualized via `tests/output/html-test/index.html`. Bootstrap with `git clone https://github.com/brianwestphal/html-test.git external/html-test` (set `HTML_TEST_DIR` env to override).
