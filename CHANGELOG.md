# Changelog

All notable changes to **Domotion** are documented in this file.

## [0.27.1] - 2026-09-05


No user-facing changes in this range. Everything between v0.27.0 and HEAD is test-lane configuration, CI workflow tooling, fixture fonts for the Windows conformance gate, and documentation; the published package's capture, render, animation, and CLI behavior is unchanged.

## [0.27.0] - 2026-09-04


**🚀 Features**

- Emoji and other color/bitmap glyphs (sbix, CBDT, COLR, OpenType SVG) inside `::before` / `::after` / checkmark content now render through an isolated Chromium-painted surface that replaces only that text, instead of a monochrome outline; pseudo text also honors the computed `font-variant-emoji` preference.

**🐛 Fixes**

- `text-shadow` on text with `-webkit-text-stroke` or underline/line-through decorations now paints the stroke and decorations in the shadow color, and shadow and foreground decorations no longer share a clip id.
- Mixed-script text that spans multiple fallback fonts (for example CJK plus Latin in vertical or transformed text) now maps correctly through the text-fragment geometry pipeline instead of failing the split.
- Generic font families (`serif`, `sans-serif`, etc.) resolved from a live session are now replayed by family name on Linux and Windows and by PostScript name on macOS, matching what fontconfig, DirectWrite, and CoreText each accept.
- macOS Unicode fallback routing now records which faces are optional installs (such as Noto Sans and Noto Sans KR) rather than assuming they are present on every machine.
- `svg-scrubber` no longer accepts play/scrub actions while an SVG is still loading, so controls are not reset by the pending load on slower hosts.
- The `animate` command's outside-region mismatch error now shows where the captured content first diverges, instead of only reporting that it differs.

## [0.26.3] - 2026-09-03


<!-- No user-facing changes in this release. -->

There are no user-facing changes in `v0.26.2..HEAD` — the single commit only adjusts an internal font-path integrity test and adds a non-behavioral `optionalInstall` marker to font-table entries to support it. Nothing in the diff alters capture, rendering, animation, CLI flags, or output, so every template section is omitted.

## [0.26.2] - 2026-09-03


<!-- No user-facing changes in this range: both commits are CI/test/tooling only (a GitHub Actions workflow context linter and an internal color-space oracle test tweak), which the template excludes. -->

## [0.26.1] - 2026-09-03


<!-- No user-facing capture, render, animation, CLI, or fidelity changes in this range; all changes are release/CI infrastructure, tests, and docs, which the directives exclude. -->

## [0.26.0] - 2026-09-03


**🐛 Fixes**

- **Dashed and dotted outlines** now start a fresh dash at each corner and run between the outer corners, matching Chrome's outline painter — this corrects both the dash phasing and the gap widths on square (non-rounded) outlines.
- **Border-collapse:** a `<td>`/`<th>` restyled to `display: block` is no longer pulled into the collapsed table grid, fixing a stroke that was shifted onto the table grid line (~5px off).
- **Windows — real small caps:** faces that carry `smcp`/`c2sc` (e.g. Georgia) now render with the font's actual small-cap glyphs instead of a synthetic 0.7-scaled fallback.
- **Windows — bitmap strikes:** embedded-bitmap/GDI-classic text (e.g. SimSun at small sizes) is retained as a raster so it matches Chrome's native terminal mask rather than being replaced by a vector subset.
- **Windows — `.notdef` glyphs:** an explicitly selected `.notdef` glyph is now painted as an outline the way Chrome paints it after fallback is exhausted, while an ordinary coverage miss still continues to fall back correctly.
- **Windows — unavailable authored families:** an author-named family that isn't installed (e.g. Hiragino Mincho) is now skipped instead of being mis-mapped to SimSun, so CJK text falls back the way Chrome does.
- **Linux — sharper embedded text:** expanded the exact hinted target-strike coverage (Liberation Sans/Serif across more sizes and weights) for pixel-faithful body and heading text; mixed full/small-cap runs are now split into per-size strikes so synthesized small caps match Chrome's independently measured ink heights.

## [0.25.0] - 2026-09-02


**🚀 Features**

- Debug reproduction bundles now work for animated SVGs: `animate --debug` writes a HAR, expected frames, the captured tree, and the output SVG — the same way `capture --debug` does — and there's a programmatic API for producing these bundles from code.
- CSS `corner-shape` (superellipse / squircle corners) now renders as crisp vector contours.
- `-webkit-box-reflect` reflections are emitted as native vector paint instead of being dropped.
- Static CSS 3D transforms are projected onto vector planes rather than falling back to raster.
- `-webkit-line-clamp` truncation, including the trailing ellipsis, is now captured and rendered.
- Broader native form-control coverage: native scrollbars, the file-upload selector button, and closed `<select>` picker indicators are captured and drawn.
- `font-palette` and COLR palette color fonts are supported.
- Embedded font subsets keep their TrueType hinting by default, sharpening rasterized text on Linux and Windows.

**🐛 Fixes**

- Radial gradients: percentage-based radial ellipses render correctly again, and repeating-radial period, focal, and color-hint geometry now match Chromium.
- Gradient interpolation, legacy `-webkit-gradient` endpoints, and conic-gradient tiling now follow Chromium — and conic gradients paint inside generated (pseudo-element) content.
- Border fidelity: collapsed and fragmented table borders, thin dotted borders, mixed dashed/dotted joints, rounded side clipping, and effective-zoom border geometry all match Chromium more closely.
- Text and shaping: cursive (Arabic) shaping and shaped cluster origins are preserved, dotted-circle insertion follows the font's coverage, MathML fence and italic-token placement is corrected, and font optical sizing is honored.
- Linux text rendering picks the correct fontconfig TTC face index and matches Chromium's glyph strikes for Latin Extended and WenQuanYi headers.
- Text inside affine/projective transforms stays legible and correctly positioned.
- Form fields use Chromium's input text geometry, and closed `<select>` display text is aligned correctly.
- Images and backgrounds: local SVG background tiling and local bitmap natural sizing are restored, and generated (`content:`) image intrinsic paint is preserved.
- Resize handles keep their shadow ink and integer-zoom borders, list markers align to the full marker advance, and flex-item paint order is preserved.
- Looping animations close cleanly at their starting frame, removing a visible seam at the loop point.

## [0.24.0] - 2026-08-16


**🚀 Features**

- **`background-blend-mode` now supported** — each background image layer blends against the layers below it, including the element's own background color, inside an isolated group.
- **True `backdrop-filter` rendering** — elements with a `backdrop-filter` now preserve Chromium's actual composited backdrop pixels via an isolated snapshot placed at the element's paint position, instead of the frosted-glass color approximation (which remains as a graceful fallback when a snapshot can't be captured).
- **Multi-select listbox options render with real styling** — `<select multiple>` / `size > 1` options now paint from their captured layout and author styles (including `:checked` row backgrounds) rather than native defaults.

**🐛 Fixes**

- **Emoji that previously vanished now render** — default-emoji characters outside the main emoji planes (Watch, Hourglass, the media-control buttons, and the Mahjong Tiles / Playing Cards blocks) now route to the color-emoji path instead of disappearing on faces with no vector glyph.
- **Dotted circles for orphaned combining marks** — standalone Indic/Vedic marks now get the same U+25CC dotted circle Chromium paints, using the resolved fallback face and script, fixing missing or duplicated circles in complex-script text.
- **Gradient stop lengths resolve correctly** — font-relative and viewport-relative gradient lengths (`em`, `rem`, viewport units) and `calc()` sums now resolve in the element's real style context, fixing mispositioned gradient stops.
- **Vertical text baselines** — vertical columns and text-combine (tate-chu-yoko) runs now place glyphs on each run's measured baseline, correcting upright and rotated glyph positioning.
- **`::before` / `::after` box sizing** — generated-content pseudo-elements are now measured through a real Blink layout, so `calc()`, intrinsic sizing, logical properties, and writing mode produce accurate boxes.
- **List markers match Chromium geometry** — disc, circle, square, and disclosure-triangle markers use Blink's exact size, offset, and edge-snapping rules.
- **Multi-column rules respect spanners** — a `column-span: all` element no longer causes the column rule to draw through the spanning content; rules are captured as physical per-row segments.
- **Native form controls keep their outline overflow** — control snapshots now include author outlines (e.g. `:valid` / `:invalid` rings) that extend beyond the themed border box.
- **File-input button labels render as glyph paths**, matching the rest of the text pipeline for consistent typography.

## [0.24.0] - 2026-08-16


**🚀 Features**

- **`background-blend-mode`** — each background image layer now blends against the layers below it, including the element's own background color, inside an isolated group.
- **Real `backdrop-filter` rendering** — elements with a `backdrop-filter` now embed a Chromium-composited raster snapshot that preserves the actual blurred/filtered backdrop pixels, clipped to the element's border contour, instead of the approximate frosted-glass solid fill (which remains as a fallback).
- **Multi-line `<select>` listboxes** — options in a `size`/`multiple` listbox now render with their real per-row layout, author background/text colors, and selected-row paint.

**🐛 Fixes**

- **Gradient length units** — font-relative (`em`, `rem`, viewport) and absolute (`in`, `pt`, `q`) length stops and radial positions now resolve to the correct pixel offsets, including the percentage term inside `calc()`.
- **Default-emoji glyphs no longer vanish** — WATCH, HOURGLASS, the media-control buttons (U+231A–U+23F3), and the Mahjong Tiles / Playing Cards characters now route to the color emoji font instead of dropping out as empty cells.
- **Dotted circles for orphaned combining marks** — standalone/uncovered marks (including lone Vedic marks) now correctly show the dotted-circle placeholder that Chromium paints, and no longer over-insert circles for marks Chromium leaves bare.
- **Multi-column `column-rule`** — column rules are now drawn as per-row segments, so a `column-span: all` element no longer causes a rule to be painted straight through the spanning content.
- **`::before` / `::after` sizing** — generated-content boxes are now measured through a real Blink layout, so `calc()`, CSS variables, intrinsic sizing, logical properties, and writing mode resolve to the correct box and text rects.
- **List markers** — disc, circle, square, and disclosure markers now use Blink's exact ascent-based size/offset geometry and edge snapping, fixing subtle marker size and position drift.
- **Vertical text baselines** — upright, rotated, and text-combine runs in vertical writing modes are placed using each run's captured font ascent, correcting baseline placement for mixed CJK/Latin columns.
- **Native form-control overflow** — control snapshots now include author outlines (e.g. `:valid`/`:invalid` focus outlines) that paint outside the themed border box.
- **File input button label** — the file-picker button label is now emitted as glyph paths for consistent text fidelity.

## [0.24.0] - 2026-08-15


**🚀 Features**

- **`backdrop-filter` now renders faithfully.** Elements with a `backdrop-filter` preserve Chromium's true composited result — the page pixels sampled behind the element, the filter chain, translucent background, descendants, and border clipping — via an isolated raster snapshot, replacing the old solid frosted-glass fallback.

**🐛 Fixes**

- **More emoji render instead of vanishing.** Watch, hourglass, and media-control buttons (Misc Technical: U+231A–U+23F3) plus the Mahjong Tiles and Playing Cards blocks now paint from the color-emoji font on platforms where Chromium selects it, instead of dropping to an empty cell.
- **List markers match Chromium geometry.** Disc, circle, square, and disclosure-triangle markers use Blink's font-metric integer sizing/offset and physical pixel snapping, so marker size, position, and disclosure direction are correct across font sizes.
- **Vertical text sits on the right baseline.** Upright glyphs, rotated runs, and text-combine (tate-chu-yoko) cells now use each run's captured font ascent, fixing glyphs that dropped ~0.85em below their cell in mixed columns.
- **Gradient lengths resolve correctly.** Font-relative and viewport-relative gradient stop/position units (`em`, `rem`, `vw`, …) and `calc()` expressions with percentage terms now resolve against the right context, and exact CSS absolute units (`in`, `pt`, `Q`, `cm`, `mm`, `pc`) convert at spec 96dpi.
- **Listbox options paint with author styling.** Multi-row selects (`multiple` / `size > 1`) now use the browser-measured row geometry and resolved author styles — including selected-row background and text color — instead of reconstructing rows from native constants.
- **Native controls keep author outline overflow.** Themed control snapshots now include author `outline` visual overflow (e.g. `:valid` / `:invalid` outlines) rather than clipping to the border box.
- **File-input button labels render as glyph paths**, matching the rest of Domotion's text output.
- **Orphan combining marks get their dotted circle.** Lone marks that Chromium circles (e.g. standalone Vedic marks) now have the dotted circle inferred from shaping, even when it can't be observed at capture time.

## [0.23.0] - 2026-08-14


**⚠️ Breaking Changes**

- **Page navigation now waits for `load` instead of network-idle by default.** Real-world pages that keep analytics, long-polling, or streaming requests open no longer stall or time out before capture. If you relied on the old behavior for a controlled, finite request chain, pass `--network-idle` on the CLI (or `networkIdle: true` in a template config) to restore the stricter wait.

**🚀 Features**

- **Vertical writing modes now render as crisp, scalable glyphs.** `vertical-rl`, `vertical-lr`, and `sideways-*` text uses Blink-matched line-relative transforms instead of a rasterized element snapshot, so it stays selectable and sharp at any scale.
- **`font-variant-alternates` with `@font-feature-values` is now honored.** `stylistic`, `styleset`, `character-variant`, `swash`, `ornaments`, `annotation`, and `historical-forms` resolve to their OpenType features, scoped to the declaring font family.
- **CSS `url(#filter)` references to inline SVG filter graphs are preserved** and evaluated in the element's local coordinate space, so coordinate-sensitive `feTurbulence` / `feDisplacementMap` chains render as Chromium paints them.
- **New `--network-idle` capture flag** to opt into waiting for 500 ms of network quiescence during navigation.

**🐛 Fixes**

- **Windows font selection** now tries the preferred standard face before the hardcoded/DirectWrite fallback, matching Chromium (e.g. U+2100 now paints Times New Roman rather than Lucida/Tahoma).
- **Vertical-mode text-emphasis marks** now take their metrics and position from the correct fallback face instead of an em-fraction approximation.
- **CSS counters** now follow document tree order across siblings and both `::before`/`::after` pseudo-elements.
- **Non-affine 3D subtrees** (`preserve-3d` / `matrix3d`) and **OS-native form controls** (`appearance` other than `none`) are now captured as Chromium bitmap snapshots where SVG can't reproduce their projective or platform-themed paint.
- **Dynamically discovered fonts** (e.g. runtime-installed Vedic faces) now shape correctly, keeping HarfBuzz's dotted-circle marks for leading combining characters.

## [0.22.2] - 2026-08-13


<!-- No user-facing changes in this range: both commits only stabilize test assertions across CI font inventories. Template requires omitting empty sections, leaving no output. -->

There are no user-facing changes in `v0.22.1..HEAD` — both commits only stabilize font-fallback test assertions across CI runner font inventories (test-only changes, which the template excludes). Every section would be empty, so the release notes are intentionally blank.

## [0.22.1] - 2026-08-13


_(No user-facing changes in this release — all changes are test-only environment fixes.)_

## [0.22.0] - 2026-08-13


**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.22.0] - 2026-08-13


**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.22.0] - 2026-08-13


**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.21.1] - 2026-07-04


All three commits in this range are test-only (`test(animator)`) or doc-only (`docs(CLAUDE)`) changes, which the template's frontmatter explicitly excludes ("test-only changes, doc-only changes"). None of them add features, alter behavior a consumer would see, add CLI flags, or break anything.

So there are no user-facing release notes to generate for this range — every section would be empty and is therefore omitted, leaving no output.

## [0.21.0] - 2026-07-04


** Features**

- **New transition set:** directional pushes (right/up/down), `wipe`, `iris`, `zoom-in`/`zoom-out`, plus new radial and clock-hand wipes (`wipe-radial`, `wipe-clock` — with configurable start angle, direction, and cubic-bezier easing). All cross-engine-safe (transform/clip-path/opacity only).
- **Motion preset library:** named enter/exit and easing presets — including a true multi-oscillation spring — so you no longer hand-tune cubic-beziers. Mixed-family transition chains now composite correctly (an entrance effect from a different family than the exit is no longer dropped).
- **Shine overlay:** a swept-glint effect with optional corner radius, anchor auto-sizing, and named easing.
- **Realistic typing overlays:** character-by-character reveal with the caret locked to the true text edge, glyph-path rendering (proportional fonts with pixel-accurate wrapping), optional GPOS kerning, selectable caret shapes (bar/block/underscore), humanized typos (type-wrong → backspace → correct, deterministic), and a `fontFamily` override that can auto-adopt the anchored field's font.
- **`typeResample`:** high-fidelity per-keystroke re-capture of a live field — shows the page's own masking, auto-formatting, and font — with an opt-in `regionOnly` mode to shrink output size.
- **Interaction capture:** force real CSS `:hover`/`:active`/`:focus` states via CDP (`forceState`), `hoverReveal` sugar with auto-detection, a `jsReveal` MutationObserver harness that captures JS-driven feedback (class flips, injected tooltips/menus) and tweens motion deltas in place, and a synthetic hover/focus/press interaction overlay.
- **Creative template pack:** `title-card`, `quote`, `caption`, `cta`, `counter`/`stat` (odometer digit reels), and before/after `compare`.
- **`--brand <file>` brand kit:** one file drives palette, font, radius, logo, and background across every template, and injects CSS variables into captured pages (`capture`/`animate`) so brand-authored pages theme automatically.
- **`--format <preset>` social canvases:** reel/story/square/portrait/landscape (or raw `WxH`), with safe-area insets and per-ratio adaptive type scaling; device mockups scale their bezel and browser chrome with the screen for large/reel captures.
- **`domotion storyboard`:** sequence distinct scenes (title → demo → CTA) into one self-contained animated SVG with inter-scene transitions.
- **Native SVG inlining:** `<img src=*.svg>` now embeds as native vector SVG instead of a rasterized data-URI image — crisp at any zoom, ~33% smaller, and it also handles `object-fit: none`. Inlined SVGs get their ids and CSS class names namespaced so multiple embedded SVGs can't collide.

** Fixes**

- Single-line `<input>` value text is now vertically centered for all input types, matching Chrome.
- Corrected typing and `typeResample` caret geometry — height from the font's real ascent+descent, centered on the line box, and accounting for letter/word-spacing.
- Hover cursor now lands on the element exactly as the hover state appears, instead of arriving mid-glide.
- Multiple overlays of the same kind in one frame now get unique ids — previously only one revealed.
- Composite clip-scale resize no longer clips too narrow in Firefox.
- Local-font alias family-key normalization now matches the lookup side, fixing some font resolutions.
- Compare-template labels track their region and stay centered in the pill.

## [0.20.0] - 2026-07-02


** Features**

- Paired-motion animations (a move + a fade on the same element, as used by the kinetic-text and lower-third templates) now emit as a **single** CSS animation instead of two, keeping the transform and opacity in perfect lockstep.
- Fused tracks can now carry their own duration, delay, and easing — e.g. a fast fade layered over a slower slide, or different curves per property — while still rendering as one timeline.

** Fixes**

- Firefox no longer flashes the transparent page-through background for a moment at every frame cut in multi-frame SVGs (cut, magic-move, crossfade, push, and scroll transitions). Chromium and Safari were already unaffected.
- Single-frame looping animations (kinetic-text, lower-third) no longer flash or appear to run "as two separate steps" at the loop edge in Firefox.

## [0.19.1] - 2026-07-01


** Fixes**

- Cursor overlay click pulses now replay on every loop of an animated SVG instead of firing once and freezing after the first pass — the click rings reappear each time the pointer repeats its motion.

## [0.19.0] - 2026-07-01


** Features**

- Add an opt-in accessible name and long description to the root `<svg>`: pass a title/description (or the new `--title` / `--desc` CLI flags) to emit `role="img"` with `<title>`/`<desc>`, giving inline-embedded demos an accessible name for screen readers. Works across single-frame, animated, and scroll output.

** Fixes**

- `domotion capture <url>` now embeds remote `<img>` and background images by default, so its output is fully self-contained with no external asset references — matching the animate and template pipelines.
- Cursor overlays are now emitted as CSS animations instead of SMIL, fixing pointer drift in Safari when the animation goes offscreen (tab-switch or scrolled away) and returns.
- Scroll-composed SVGs now honor `prefers-reduced-motion: reduce`, pinning the demo to the top frame instead of animating regardless of the viewer's motion preference.

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

