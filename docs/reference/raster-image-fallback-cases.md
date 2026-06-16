# Reference — Raster-image fallback cases

Domotion's contract is a **path-based** SVG: glyphs are `<path>` outlines, gradients are `<linearGradient>` / `<radialGradient>`, borders / shapes are `<rect>` / `<line>` / `<polygon>`. That keeps the output crisp at any zoom and trivially diffable. Where Chromium paints something we **can't express in native SVG** — color emoji, an icon-font pseudo-element glyph, live `<canvas>` pixels, a CSS conic gradient — we fall back to embedding a raster image (PNG, base64 data URI inside an `<image>` element).

This document is the canonical list of those fallback cases. If you add a new one, **add it here**; if you remove one, prune the entry. Keeping this in sync with the code is the rule, not a nice-to-have — consumers reading the output need a single place to look up "why is this paint a raster instead of crisp SVG?".

The fallback cases group into three buckets:

- **Glyph-level fallbacks** stamp an `<image>` over an individual character or sub-element. The rest of the surrounding text still emits as `<path>`.
- **Element-level fallbacks** screenshot a whole element's painted rect and emit one `<image>` in its place.
- **CSS-feature fallbacks** synthesise a raster PNG for a CSS effect SVG has no equivalent for (conic gradient, mask-image element() ref).

Each entry below lists the trigger condition, the code path that captures the raster, the code path that emits the `<image>`, and the canonical doc that explains the design rationale.

---

## Glyph-level fallbacks

### G1. Color emoji and color-bitmap glyphs

Trigger: a codepoint flagged by `src/capture/script/emoji-detect.ts::needsRaster()` — emoji-presentation defaults from Unicode emoji-data (✨ ❌ ✅ ✊ ✋ … ❤ ⭐ 🎉 …, plus the squared 🆎 🆑–🆚 of the Enclosed Alphanumeric Supplement block and the squared/circled CJK 🈁 🈚 🈯 🈲–🈺 🉐 🉑 of the Enclosed Ideographic Supplement block U+1F200–1F2FF), explicit emoji presentation via U+FE0F, regional-indicator flag pairs, and the main emoji blocks (Misc Symbols & Pictographs, Emoticons, Transport & Map Symbols, Supplemental Symbols & Pictographs). For *text-default* emoji codepoints that paint color only when the element's font cascade actually reaches the color-emoji font (e.g. bare ✌ ✒ ✝ ✡, and the U+2600-block symbols), the decision is made per-element by the `isColorGlyph` canvas probe (render the glyph with the element font; raster only if Chromium's rasterizer produced colored pixels) rather than an unconditional list. The **Alchemical Symbols block (U+1F700–1F77F)** is likewise gated through that canvas probe even though it sits inside the otherwise-unconditional main-block range: Chromium paints its covered codepoints as monochrome Apple Symbols path glyphs, so it path-renders unless a cell's cascade reaches the color font. Rastering them unconditionally clipped the tall apparatus glyphs (retort/alembic 🝯 🝰) because the overlay was sized to the font content box, not the glyph ink (DM-1125).

Why: fontkit can't extract outlines from `CBDT` / `sbix` color-bitmap tables — those store PNG sub-images per glyph, not vector contours. Even when a path-font *has* an outline for the codepoint, Chromium overrides the choice to the emoji font for emoji-presentation codepoints.

Capture: each affected char gets a `rasterGlyphs[]` entry on its `textSegments` with `charIndex` (UTF-16) and the painted rect. The post-capture `rasterizeBitmapGlyphs` pass fills in `dataUri` from either (a) the Apple Color Emoji `.ttc`'s sbix tables on macOS, or (b) `page.screenshot({ clip })` for codepoints sbix lacks / non-darwin platforms.

Emit: `src/render/text.ts::rasterGlyphOverlays` (~line 306) stamps one `<image>` per entry at the captured rect with the per-char `suppressGlyph: true` flag preventing the body-size path glyph from rendering underneath.

Doc: [15-color-emoji-rendering.md](../15-color-emoji-rendering.md).

### G2. Unshapeable pseudo-element / segment glyphs (icon-font PUA, color glyphs in `::before`/`::after`)

Trigger: a whole text segment — typically a `::before` / `::after` pseudo-element's content — that contains a codepoint Chromium shapes from an icon font (often a Private-Use-Area codepoint) or paints as a color glyph, where fontkit can't produce an outline.

Why: unlike G1 (which rasters one char and keeps the surrounding run as paths), the *entire segment* has no faithful path representation — the glyph the icon font draws isn't in any outline table we can read. Screenshotting Chromium's painted rect for the segment is the only faithful fallback.

Capture: CAPTURE_SCRIPT sets `pseudoSeg.rasterRect` on the segment (`src/capture/script/walker/pseudo-content.ts` ~lines 777–784). The post-capture `rasterizeBitmapGlyphs` pass screenshots that rect and writes `seg.rasterDataUri` (`src/capture/emoji.ts` ~lines 144–148).

Emit: `src/render/text.ts` emits one `<image>` at the segment's `rasterRect`, clipped to the segment box, in place of the path run — the single-segment overlay (~line 852) and the multi-segment path (~line 1062).

Doc: [38-pseudo-element-paint.md](../38-pseudo-element-paint.md). Tickets: SK-1058 / DM-626.

---

## Element-level fallbacks

### E4. Replaced elements — `<iframe>` / `<canvas>` / `<video>` / `<object>` / `<embed>` and custom elements with open shadow DOM

Trigger: tag is one of those five, OR a custom element (hyphenated tag with `shadowRoot != null`).

Why: nothing here is reachable through the DOM walk. `<canvas>` is a pixel surface. `<iframe>` is a separate document. `<video>` is decoded native pixels. Custom elements' shadow DOM is opaque to the light-DOM walker. Snapshotting at t=0 gives a faithful single-frame raster; live playback / interaction are explicitly out of scope.

Capture: `src/capture/script/walker/replaced-elements.ts` tags the live DOM with `data-domotion-rid` and stashes the content-box rect on `captured.replacedSnapshot`. The post-capture `rasterizeReplacedElements()` in `src/capture/index.ts` (~line 997) injects a hide-everything-else stylesheet, screenshots the target's content-box clip with `omitBackground: true`, and writes the data URI back.

Emit: `src/render/element-tree-to-svg.ts` (~line 2115–2122) emits the `<image>` at the content-box rect. If an `imageReplacement.titleText` was captured (sprite path — see E5), a `<title>` child is included so screen readers and tooltips still get accessible text.

Doc: [17-replaced-element-snapshots.md](../17-replaced-element-snapshots.md). Ticket: DM-457.

### E5. CSS sprite-icon image-replacement (`text-indent: -9999px` + `background-image`)

Trigger: the Phark / modern image-replacement idiom — `text-indent <= -1000` (or `text-indent < 0 && overflow:hidden && white-space:nowrap`) PLUS a non-`none` `background-image`. Skipped when the element is itself an `<img>` (it'd double-stack the painted image).

Why: Domotion's path-mode bg-image emission can't reliably slice a sprite atlas to the displayed icon region. Routing through the same screenshot pipeline used for E4 gives the painted slice directly.

Capture: same `data-domotion-rid` + content-box rect mechanism as E4. The handler additionally clears `captured.styles.backgroundImage`, `captured.text`, and `captured.textSegments` so the path pipeline doesn't try to emit a stale bg-image OR the off-screen text underneath the raster. The accessible label is harvested from `aria-label` or the offscreen `text` and stashed as `imageReplacement.titleText` so the rendered `<image>` carries a `<title>` child.

Doc: [23-css-sprite-icons.md](../23-css-sprite-icons.md). Ticket: DM-457 (sprite path).

---

## CSS-feature fallbacks

### C1. `conic-gradient(...)` / `repeating-conic-gradient(...)`

Trigger: any background layer whose CSS value parses as a conic or repeating-conic gradient.

Why: SVG has no native conic-gradient primitive. The cleanest fallback is to rasterise the conic into a PNG tile and embed it as a `<pattern><image href="..."/></pattern>`, which works in every static-SVG viewer (Preview, librsvg, GitHub previews, browsers).

Capture: handled at the rendering / post-capture seam. A pre-pass `rasterizeConicGradients` (`src/capture/index.ts`) walks the captured tree, identifies each conic-gradient background layer, calls `rasterizeConic` (custom RGBA writer in `src/render/conic-raster.ts`) at `tile × hiDPIFactor` device pixels, `sharp.resize(..., { kernel: 'lanczos3' })` down to the CSS tile size, and stashes the PNG bytes in a `_conicTileCache` keyed by `(layerText, tileWidth, tileHeight, hiDPIFactor)`.

Emit: `src/render/element-tree-to-svg.ts::buildConicGradientDef` (~line 4140) emits `<pattern id="..." patternUnits="userSpaceOnUse" ...><image href="data:image/png;base64,..." width="..." height="..."/></pattern>` and refers to it from the element's `fill="url(#...)"`.

Doc: [28-conic-gradient.md](../28-conic-gradient.md).

### C2. `mask-image: element(#id)` paint references

Trigger: CSS `mask-image: element(#some-id)` referencing the *painted* output of another DOM element (not a `<mask>` fragment — that's covered by [21-mask-fragment-references.md](../21-mask-fragment-references.md)).

Why: the spec defines this as "rasterise the target element's paint and use that bitmap as the mask source". SVG can reference foreign elements only through `<mask>` / `<use>` / `<symbol>`, none of which match the CSS `element()` semantics — paint-as-bitmap is the only faithful path.

Capture: CAPTURE_SCRIPT finds each `mask-image: element(#id)` reference, marks the target element with `data-domotion-rid="mr<n>"`, and records `(id, rid, rect, width, height)` on the root tree's `maskRasters[]`. Post-capture, `rasterizeMaskSources` (`src/capture/index.ts`) runs the same hide-everything-else stylesheet pass as E4 / E5 and screenshots the target's painted rect at the page's actual DPR.

Emit: `src/render/element-tree-to-svg.ts::buildMaskDef` (the `<image>` emit is ~line 5427) resolves the data URI from the per-element `elementRasters` lookup when building `<mask>` defs; emits an `<image>` directly inside the `<mask>` with `mask-position` / `mask-size` honored. `mask-mode: match-source` resolves to `luminance` (per the CSS Masking spec — element() paint refs drive mask alpha from RGB luminance).

Doc: [22-mask-element-paint-references.md](../22-mask-element-paint-references.md).

---

## Not in this list

These also emit `<image>` tags but **aren't fallbacks** — they're the renderer faithfully passing through an author-supplied raster:

- `<img src="...">` and `<picture>` elements — the source IS a raster image; we embed it as a data URI (resized to its display size per [27-image-resize-on-embed.md](../27-image-resize-on-embed.md)).
- `background-image: url(...)` — author-supplied raster.
- `list-style-image: url(...)`, marker images (`::marker`).
- Inline SVG icon references (`<use href="#id">` of an inline `<svg>` icon) — these are resolved as native SVG, not rastered. See [24-inline-svg-icon-references.md](../24-inline-svg-icon-references.md).

If a fix moves something from this "not in this list" section into a real fallback (because the synthesis turned out to be too costly to maintain), update both sections.

---

## When to add a new entry

Open the PR that introduces the new raster fallback path. In the same PR:

1. Add an entry above with: trigger condition, why path-mode can't express it, capture site (file:line), emit site (file:line), and a link to the design doc.
2. If the fallback warrants its own design doc, add a numbered `docs/NN-...md` for the rationale and link it from the entry here. This file remains the **index**; the per-feature docs carry the depth.
3. Mention the new entry in the PR description so reviewers can spot it.

When code changes the trigger condition for an existing entry, update the trigger line here in the same commit. When an entry is removed because the renderer learned to emit the feature natively, delete the entry and link the commit that removed it from the relevant numbered doc.
