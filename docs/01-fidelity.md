# Domotion: rendering fidelity and warnings

Requirements and support matrix for Domotion — the engine that converts captured HTML/CSS into SVG for animated demos. This doc is the contract with consumers about **what CSS features round-trip**.

## Goals

- Faithful visual reproduction of captured DOM as SVG, targeting Chromium on the host platform as the canonical reference.
- Predictable output: if a feature isn't fully supported, the tool says so (it doesn't silently drop content).
- Self-contained SVG: renders identically when embedded in a page or loaded standalone.
- **Cross-platform parity**: works on macOS, Linux, and Windows like any normal npm package, calibrated against Chromium's actual fallback behavior on each platform (CoreText / fontconfig / DirectWrite). **macOS is the most validated platform.** Linux and Windows now have calibrated fallback chains plus generated per-Unicode-block routing tables (`unicode-font-routing.{linux,win32}.generated.ts`, from Chrome CDP sweeps — DM-984 / DM-987) and native glyph extractors (docs 41 / 45), so non-Latin text renders as glyph paths rather than tofu; they are less battle-tested than macOS and CI hardening continues (DM-262). New code must be platform-aware from the start, not macOS-hardcoded. **Help wanted**: bug reports, test runs, and fixes for Linux/Windows from the community are welcome — open an issue or PR on the GitHub repo.

## Support matrix

Checked = round-trips faithfully (passes the region-based diff gate vs. the Chromium capture — `regionCount === 0`, see [doc 12](12-diff-scoring.md)). Partial = works for common cases; edge cases below threshold. Unsupported = captured but not emitted, or emitted approximately; warning is logged.

### Layout & box model

- [x] position: static, relative, absolute
- [~] position: fixed, sticky — paint order correct, but rendered as static snapshot at t=0 (no scroll-following animation)
- [x] display: block, inline, inline-block, flex, grid, table
- [x] multi-column physical flow — text retains Chromium's per-fragment
  `Range.getClientRects()` coordinates across forced column breaks,
  `break-inside: avoid`, and column groups split by `column-span: all`; the
  renderer consumes those captured positions rather than reconstructing
  LayoutNG fragmentation in Node (DM-2161).
- [x] float + clear (text wraps correctly around floats via per-line capture)
- [x] box-sizing, margin, padding, width/height, min/max
- [x] overflow: hidden/scroll/auto/clip (children clipped to padding box); rounded `overflow-clip-margin` follows Blink's pixel-snapped reference-box outsets and coverage-corrected contour (DM-2419)
- [~] overflow: scroll/auto — content clipping and Blink-owned scrollbar
  existence/axis/phase/geometry are retained. Supported author-custom parts
  paint as ordered vector CSS boxes, with dynamic/unsupported paint confined
  to owner-part crops; stock-native theme pixels remain the separate platform
  raster boundary. The exact contract and strict controls are in
  [doc 165](165-native-scrollbar-layout-paint-ownership-audit.md) (DM-2368;
  legacy tracker SK-468).
- [x] CSS resize controls — Blink's exact scroll-container/iframe activation,
  logical-left placement, pixel-snapped corner size, platform dark/light grip,
  scrollbar-only frame, and author `::-webkit-resizer` background/gradient/
  border, and multi-layer inset/outset shadow paint are retained and clipped to
  the fixed CornerRect. Platform corner thickness is measured from the
  active Chromium `ScrollbarTheme`, so macOS overlay/legacy, Aura, and Windows
  values are not collapsed to a hard-coded constant; DPR is divided out.

### Visual / paint

- [x] background-color (all modern CSS color formats: hex/rgb/hsl/hwb/lab/lch/oklab/oklch/color()/color-mix)
- [x] background-image: linear-gradient, radial-gradient, repeating-*, url()
- [x] multiple background layers (first-on-top semantics preserved)
- [x] background-image: conic-gradient — rasterized to a `<pattern><image>` tile (no native SVG conic). See `28-conic-gradient.md`.
- [~] URL `background-size` / `background-position` / `background-repeat` —
  integer explicit repeat, intrinsic `auto auto`, cover with percentage
  position, integer origin/clip, and cloned inline fragments have exact focused
  controls. DM-2477 now captures Blink-equivalent `image-set()` selection,
  density-corrected independent natural dimensions/ratio, orientation, zoom,
  and explicit load/failure state per aligned layer. Single-axis auto-ratio
  lowering, general calc sizing/phase, contain snapping, round/space,
  transformed tile phase, cyclic longhand expansion, and sliced fragments
  remain source-proven gaps. DM-2479 now captures and renders exact
  fixed/transformed-fixed/local/root positioning areas, including viewport
  scrollbars, both local scroll axes, overflow clips, zoom, and stitched canvas
  geometry. The exact contract is in [doc 163](163-url-background-image-geometry-audit.md);
  remaining work is DM-2478, existing DM-2365, and gate DM-2480.
- [x] border (uniform) with border-radius
- [x] border (per-side with different width/style/color)
- [x] box-decoration-break (`slice` default + `clone`) on (a) wrapped inline elements and (b) block-level elements that fragment at a multi-column container boundary — per-fragment paint of background / border / shadow / image. Slice direction depends on the fragmentation axis: inline-axis (wrapped inline) means first fragment owns LEFT + TL/BL, last owns RIGHT + TR/BR, intermediate fragments paint top + bottom only; block-axis (multi-column block) means first owns TOP + TL/TR, last owns BOTTOM + BL/BR, intermediate paint left + right only. Clone mode paints a complete box on every fragment regardless of axis. Slice-mode URL background-image continuation across fragments is not yet supported; its source-owned stitched-box design is in [doc 163](163-url-background-image-geometry-audit.md) and implementation remains DM-2365.
- [x] border-style: solid, dashed, dotted. Mixed-side dashed/dotted borders use
  Blink's full outer-edge side path and miter clip ownership; thick dots inset
  their round-cap endpoints by half the side width, while widths 1--3 retain
  Blink's square-dot endpoint enforcement. Rounded mixed sides stroke the full
  closed border centerline and intersect it with both the border ring and the
  side's rounded miter wedge, preserving dash continuity through corner arcs.
  Adjacent widths never shorten the path or alter its dash phase.
- [x] border-style: double, groove, ridge, inset, outset — implemented in the `src/render/element-tree-to-svg.ts` uniform-border path
- [x] border-radius percentages (e.g. `border-radius: 50%` → circle when symmetric box) — SK-1093
- [x] per-corner border-radius (asymmetric `10px 30px 50px 70px`) and elliptical corners (`50px / 20px`) — DM-300, see docs/14
- [ ] border-image — tracked SK-466
- [x] outline (style/width/color/offset, including dashed/dotted) — SK-1111
- [x] box-shadow: outset and inset, with blur via `<filter feGaussianBlur>` — SK-1101 / SK-1111 / SK-1113
- [x] text-shadow: x/y offset + blur, multi-layered — SK-1113
- [x] opacity (element-level, applies to whole subtree)
- [x] filter (blur, brightness, contrast, drop-shadow, grayscale, hue-rotate, invert, opacity, saturate, sepia, chained); CSS `url(#filter)` references preserve captured inline SVG filter graphs and evaluate them in the HTML element's local reference-box coordinate space, including coordinate-sensitive `feTurbulence` / `feDisplacementMap` chains. HTML reference graphs containing `feConvolveMatrix` use the narrow Chromium-painted surface boundary in doc 148 because their input is Blink's raster `SourceGraphic`; native SVG convolution and non-convolution URL graphs remain vector.
- [x] `::before` / `::after` filter function lists on empty, text, raster-glyph, and image generated content — the authoritative computed list stays on a native SVG CSS-filter group, preserving Blink's list order, sRGB operation space, premultiplication, moving-pixel bounds, transform/opacity nesting, clipping, and existing paint slot (DM-2367; [doc 38](38-pseudo-element-paint.md)).
- [x] mix-blend-mode
- [x] background-blend-mode — each image layer blends with the background stack below it, including the element's background color, inside an isolated group
- [x] backdrop-filter — approximated via a frosted-glass background fallback for the transparent-backdrop case (see doc 19); no true backdrop blur (no SVG equivalent in img-rendered SVG)
- [x] clip-path: inset(), circle(), ellipse(), polygon()
- [x] clip-path: path() — supported (emitted as an SVG `<path>` clip; `src/render/clip-path.ts`)
- [x] mask (mask-image gradient/url() fragment/element() paint refs) — emitted as SVG `<mask>`. See `20-css-mask-emission.md` / `21` / `22`.

### Transforms

- [x] transform: translate/rotate/scale/skew/matrix — full 2D affine; static 3D trees are retained as vector planes projected from Chromium-measured corners, including perspective origins, preserve-3d depth ordering, and hidden backfaces. See `06-css-transforms.md`.
- [x] `-webkit-box-reflect` — above/below/left/right reflection duplicates the complete rendered subtree as vectors, resolves signed px/% offsets against Blink's stitched box dimension, and applies optional gradient/image masks as alpha masks. Descendants retain their own independently required raster fallbacks; the reflected subtree itself is never flattened to a screenshot.
- [~] transform: 3D — flattened to its 2D projection (no perspective). See `06-css-transforms.md`.

### Typography

- [x] Font families: generic keywords (`serif`/`sans-serif`/`monospace`/`cursive`) + a handful of installed families. The mapping is platform-specific (macOS today: Helvetica / Times / Courier / SF Pro / SF Mono / Snell Roundhand / Hiragino Sans GB / Apple Symbols / Zapf Dingbats / STIX Two Math; Linux and Windows mappings tracked DM-258 / DM-259 / DM-260). Unmatched families fall through to the platform's sans-serif default. See `03-font-family-chain.md`.
- [x] Webfonts via `@font-face` (DM-227): same-origin sheets are walked for `@font-face` rules; cross-origin fonts (Google Fonts, Adobe Fonts) are picked up by a `requestfinished` listener attached before navigation. Each font buffer is fetched via the browser's request stack, parsed with fontkit, and registered into a per-capture registry that the resolver consults before the on-disk fallbacks.
- [x] Variable webfont axes (DM-228 / DM-229): `wght`, `opsz`, `slnt` driven from CSS `font-weight` / `font-size` / `font-style` via `applyVariationAxes`. WOFF2 buffers are decompressed to TTF (via `wawoff2`) before fontkit parsing — fontkit's WOFF2 variation path returns an instance whose tables can't be read.
- [x] Weight, size, style (italic via SFNSItalic.ttf — SK-1105), variant, stretch
- [x] Vertical baseline placement: CAPTURE_SCRIPT records `canvas.measureText().fontBoundingBoxAscent` for every text-bearing element so the renderer anchors each line's baseline at the exact pixel Chrome paints. fontkit's HHEA-based `font.ascent` is correct for SF Pro / SF Mono (where HHEA = `OS/2.usWinAscent`) but disagrees for Helvetica / Arial / Times / Georgia / Menlo / Courier on macOS, where Chrome reads `winAscent` — at fontSize 32 Helvetica the gap is ~5 px, so larger headings drift up without the captured override (DM-237).
- [x] Baseline pixel-grid snap (paths mode): every path-rendered run's baseline y is rounded to the integer pixel grid (`floor(y + 0.5)`), mirroring Skia's glyph rasterization — for axis-aligned horizontal text Skia keeps quarter-pixel subpixel sampling in **x** but rounds every glyph's **y** to an integer device pixel (`SkGlyphPositionRoundingSpec`, Skia `src/core/SkGlyph.cpp`; the default-on `kBaselineSnap` flag, `SkFont.cpp`). Layout baselines are routinely fractional (line-height accumulates in 1/64px LayoutUnits: 18px × 1.6 → a 28.796875px line box), so without the snap every line whose baseline phase is far from the grid painted with uniformly lighter strokes — each horizontal stem's ink spread across two pixel rows. The snap is suppressed inside transformed subtrees (an emitted `<g transform>` wrapper, a capture-baked transform recorded in `transformCreatesSc`, or a `transform-style: preserve-3d` context): Skia rounds *before* the transform, in the local / composited-layer space, and the 3D composite resamples the layer raster, so the post-transform baseline is legitimately fractional there. Pinned by the `lineheight-residual` feature fixture. (The `<textarea>` line-top rounding under Form controls below is the same mechanism, snapped at capture.)
- [x] letter-spacing, word-spacing, line-height
- [x] text-decoration: underline / overline / line-through × solid / double / dotted / dashed / wavy, with `text-decoration-color`, `text-decoration-thickness`, `text-underline-offset`, and `text-decoration-skip-ink` (gaps computed from actual glyph outlines). Skip-ink follows Blink's dispatch rather than a style whitelist: it applies to **underline and overline, in every line style** including dashed and dotted, and never to line-through — upstream declines that one explicitly, citing the CSSWG issue. Characters excluded from skip-ink are transcribed from `Character::CanTextDecorationSkipInk`: `/`, `\`, `_`, everything in Blink's CJK ideograph-or-symbol tables (which include emoji via `Emoji_Presentation`), and the Hangul and Linear B Ideograms blocks — so underlined CJK and Korean paint an unbroken line, as Chrome does. The exclusion is applied **per character**, so Latin glyphs still open gaps beside CJK ones in mixed text. Each intercept is dilated horizontally by `min(thickness, 13)`. Position and thickness are Blink's rules transcribed (Chromium rev 7d859f27), anchored on the text fragment top via the captured `FloatAscent`: auto thickness is `fontSize/10` (explicit lengths/percentages `roundf`, percent of font size, then `max(1, t)`), the auto underline gap is `max(1, ceil(t/2))` — zeroed by an explicit `text-underline-offset` — line-through sits at `2·FloatAscent/3 − t/2`, overline at `floor(LU(FloatAscent − Ascent)) − floor(t)`, and a double line's second bar offsets by `±(t+1)` (floored for line-through), each bar snapped independently. Only `text-decoration-thickness: from-font` / `text-underline-position: from-font` consult the face's `post` underline metrics, and `text-underline-position: under` reads the OS/2 typo metrics (normalized to the em, Blink's `NormalizedTypoDescent`). Solid/double bars snap at emit exactly as Blink's paint does (`SnapYAxis`: top `floor(y+0.5)`, height `max(floor(t),1)`); dashed/dotted snap to the midline (`floor(top + max(t/2, 0.5))`, +0.5 when the rounded thickness is odd) with the unsnapped stroke width; the wavy centerline sits at the unsnapped rect top + `(t+1)` + 0.5. This geometry is gated by the decoration oracle (`npm run decorations:oracle`, [doc 112](112-decoration-geometry-oracle.md)) — NOT by whole-fixture pixel-diff, which structurally rewards constants fitted against the consumer-owned rasterization gap. Wavy geometry matches Chromium's `decoration_line_painter.cc` (wavelength / control-point formulas, phase anchored per painted fragment); dashed / dotted geometry matches Chromium's `styled_stroke_data.cc` (rounded-thickness dash basis, 3:2 thin / 2:1 thick dash:gap ratios with the gap re-fitted so a whole number of dashes spans the run, proportional two-dash and solid short-run fallbacks, round-cap dots with endpoint insets for thick dotted). Decorations **propagate** to in-flow descendants per CSS Text Decoration 3 §2 — a bold child inside an underlined span paints the ancestor's line, positioned with the decorating box's font metrics — while out-of-flow (`absolute`/`fixed`), floated, and atomic-inline (`inline-block` etc.) descendants are correctly excluded. Applied decorations ACCUMULATE down the ancestor chain like Blink's `AppliedTextDecorations` — a parent underline and grandparent overline both paint, and a child's own `line-through` paints on top of an inherited underline, each line with its own style/color/thickness and its decorating box's font metrics. A `vertical-align`-shifted child (sub/sup) anchors inherited decorations at the DECORATING box's baseline (mirroring Blink's `offset_from_decorating_box`): the propagated entry carries the decorating element's own measured baselines and the renderer snaps to the nearest one when the child's baseline differs by more than 1px — so `<u>H<sub>2</sub>O</u>` paints one continuous underline at the parent's position.
- [x] Multi-line wrapped paragraphs (per-visual-line capture via Range)
- [x] text-align: left/right/center/start/end
- [~] text-align: justify — does not space-stretch (warning logged)
- [x] RTL/bidi + complex-script shaping — Arabic contextual joining, Devanagari cluster reordering / conjuncts, Thai mark-on-base, and CJK GPOS are shaped through `font.layout()` / CoreText (DM-1022 / DM-1028), with paired-bracket mirroring on RTL embedding levels. (fontkit shaping ≈ HarfBuzz; gap < 1% at body sizes.)
- [x] writing-mode: vertical-rl/vertical-lr/sideways-* — upright + rotated vertical runs, text-combine-upright. See `02-writing-mode.md`.
- [x] Color-bitmap glyphs (emoji, author color symbols, etc.): rasterized via Playwright `page.screenshot` and embedded as `<image>`. Blink's pinned whole-sequence grammar drives presentation priority; VS15/VS16 and `font-variant-emoji` follow the real declared-family/fallback walk. The selected shaped glyph's physical sbix/COLR/CBDT/SVG representation—not a codepoint range, font name, or pixel-color probe—owns the raster boundary. See [145-renderer-owned-color-glyph-boundary.md](145-renderer-owned-color-glyph-boundary.md).
- [x] ::first-letter drop caps (rasterized when font-size differs from element) — SK-1114
- [x] `::before` / `::after` generated content — new captures retain Blink's anonymous text/image items, UTF-16 visual fragments, used-font baselines, every `vertical-align` class, bidi/writing planes, slice/clone edges, and fragmentainer translations. The renderer paints that record directly in captured before/after/positioned/stacking slots; it never reconstructs live geometry from host text. Invalid facts fail closed to the scoped Chromium pseudo surface, while old serialized aggregate fields remain readable. The structural and native DPR-1/2 gates are documented in [docs 157](157-pseudo-generated-fragment-geometry-audit.md), [175](175-pseudo-fragment-protocol-oracle.md), [176](176-source-owned-pseudo-fragment-capture.md), and [178](178-direct-pseudo-fragment-rendering.md).
- [x] `background-clip: text` (gradient/image-fill inside glyph shapes) — DM-462. Captured via `webkitTextFillColor`; rendered via SVG `<mask>` over a `<rect fill="url(#bg)">`. See `18-background-clip-text.md`.

### Images

- [x] `<img>` with src/width/height
- [x] object-fit (fill/contain/cover/none/scale-down) + object-position → exact Chromium concrete object rectangle (including arbitrary percentages and computed `calc()` lengths)
- [x] `<picture>`/`srcset` → captured as the resolved `<img currentSrc>`
- [~] broken-image fallback — the live Chromium UA-shadow record now drives a
  hybrid result: author and UA container/clip paint stay vector, alt/title text
  uses the ordinary shaped text route, and only the isolated DPR-selected icon
  is raster. The fixed gray mountain/raw-text approximation is removed.
  DPR 1/2, the 17/18 px threshold, LTR/RTL/vertical writing, zoom, author paint,
  clipping, title/empty/missing alt, successful/hidden negatives, and AX are
  covered locally; [doc 156](156-broken-image-fallback-ownership-audit.md)
  retains DM-2465's independent macOS/Linux/Windows proof as the remaining gate.
- [x] `<svg>` inline content (passed through verbatim)

### Form controls

- [x] `<input>` with `value` attr — rendered via path
- [x] `<input>` placeholder — rendered in `::placeholder` color (and font-style, font-weight) — SK-1097 / SK-1100 / SK-1099
- [x] `<textarea>` content — rendered as one path run **per visual line**. A capture-side soft-wrap probe re-lays the value in an off-screen box matching the textarea's content box and type, so Chrome decides the wrap points; each resulting line becomes a `textSegment` with its own x/y and per-char offsets. Where the element carries a raster snapshot instead, that PNG is stamped at the content rect (SK-1108) — see [reference/raster-image-fallback-cases.md](reference/raster-image-fallback-cases.md).
  - **Line y is a measured offset, never a computed one.** Each segment's y is the line-box top plus the probe's own character-rect top. That rect already sits at the font-box top, so Chrome's half-leading is *in* it — the segment base must therefore be the content-box top **before** the half-leading that the single-line `<input>` path folds into `textTop`. Adding both counted the leading twice and pushed every line ~half a leading down (a 14px/21px monospace textarea rendered a uniform ~3px low and clipped its last visible line).
  - **Line y is snapped to a whole pixel.** Chrome positions glyphs subpixel *horizontally* only; the vertical text origin is rounded to an integer device pixel before rasterization. Measured on a box at top `40` / `140.25` / `240.5` / `340.75`: the first ink row lands at `45` / `145` / `246` / `346` — always `round(top)` plus a constant, and always an integer row. This is glyph rasterization, not a scroll-container effect: a `<textarea>` and a plain `<div>` behave identically. A textarea whose border box falls on a fractional y (ordinary page flow readily produces `.4375`) otherwise renders every line up to a pixel off. The renderer already rounds the ascent it adds to reach the baseline, so rounding the line top rounds the baseline.
  - Both are pinned by `tests/textarea-line-baseline.e2e.test.ts`, which sits its textarea at a deliberately fractional `40.4375px` and takes its expected offset from a Chrome-laid-out reference block rather than from our own arithmetic — an oracle that cannot re-assert the bug it guards.
- [x] Native control ownership follows Blink's exact EffectiveAppearance
  cascade boundary (DM-2453, [doc 170](170-blink-effective-appearance-routing.md)):
  complete native hosts use same-frame Chromium rasters, while author-owned
  none/base/base-select and styled host boxes remain structural. Source-owned
  menulist arrows and closed-shadow temporal/search/spin parts are isolated as
  narrow Chromium overlays without flattening the host or value text (DM-2455,
  [doc 171](171-closed-shadow-control-decorations.md)). Author-owned pseudo
  paint is preserved inside that exact closed-part boundary.

### List markers

- [x] `list-style-image: url(...)` on `<li>` — rendered as `<image>` at the marker slot
- [x] `list-style-type`: disc/circle/square/decimal/lower-alpha/lower-roman/… — synthesized as shape or text marker
- [x] Symbol marker geometry + disclosure directions — Blink font-metric integer geometry and physical pixel snapping (DM-2192)
- [x] `::marker` styling (color / font-weight / font-size) — SK-1115

### Stacking

- [x] z-index for positioned siblings (paint order sorted: negative, base, auto/0, positive)
- [~] Nested stacking contexts (trapped z-index inside opacity/transform context) — flattened; may paint above outside sibling
- [x] Float paint order (CSS 2.1 Appendix E step 4), context-wide. A stacking context is painted in the spec's phases rather than in document order: every in-flow block-level descendant's background + border (step 3), then every non-positioned float (step 4), then all in-flow inline content — text, inline boxes, replaced content (step 5), then the positioned / stacking-context children (steps 6-7). Steps 3-5 span the whole context, so:
  - A float paints **above** the background of any block-level sibling, including ones that follow it in document order (the "float overflows its zero-height wrapper, later section's background covers it" case).
  - A float paints **below** every piece of inline content in the context — its own parent's text and any other paragraph's text. This is what `shape-outside` needs: shrinking the exclusion area below the float's border box makes the wrapped text legitimately overlap the painted float, and the overlapping text has to win z whichever paragraph it belongs to.
  - Because the block and inline phases are separate passes, a later block's background can no longer cover an earlier block's text either.
  - Fixture: `float-paint-order-context-wide` in the feature suite covers both directions (a hoisted float under a following paragraph's text; a float above a later sibling's negative-margin background).
  - Two constructs opt out of the phase split and paint atomically, matching CSS: an inline-level box (its background, border and content paint together while walking line boxes), and a `transform-style: preserve-3d` container (children sort by translateZ, which cuts across the paint-step buckets).

### Rasterized as static snapshot

- `<canvas>`, `<video>`, `<iframe>`, `<object>`, `<embed>` — DM-457 / DM-2380. Each element's Blink content quad is sampled via Playwright under a hide-everything-else stylesheet and embedded as an `<image>` through one explicit PNG-device-pixel → SVG-CSS-pixel mapping. Renderer-owned affine transforms are neutralized for the sample and applied once in SVG; projective contexts stay one outer Chromium surface. The result is pixel-faithful to whatever Chromium painted at t=0 (drawn canvas pixels, video poster/current frame, iframe document, plug-in content), including off-page clipping, zoom, scroll, and DPR. Live playback / interaction is still out of scope. The capture warning is still emitted because these element types are out of the spirit of the path-based contract — the snapshot is a frozen raster, not a faithful re-render. See `17-replaced-element-snapshots.md`.

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

- `tests/features.ts` — ~100 focused feature tests exercising one rendering property each. Each must pass the region-based diff gate (`regionCount === 0`, see [doc 12](12-diff-scoring.md)) vs. the captured HTML. Every change to fidelity must pass these.
- `tests/showcase.ts` — 3 full-page integration tests derived from real product frames.
- `tests/html-test-suite.tsx` — large external suite covering broadly-supported HTML5 + stable CSS, sourced from `external/html-test/` (clone of `github.com/brianwestphal/html-test`, gitignored). Baseline tracked in `tests/output/html-test/results.json` and visualized via `tests/output/html-test/index.html`. Bootstrap with `git clone https://github.com/brianwestphal/html-test.git external/html-test` (set `HTML_TEST_DIR` env to override).
