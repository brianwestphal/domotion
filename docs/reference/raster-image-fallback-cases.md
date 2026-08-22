# Reference — Raster-image fallback cases

Domotion's contract is a **path-based** SVG: glyphs are `<path>` outlines, gradients are `<linearGradient>` / `<radialGradient>`, borders / shapes are `<rect>` / `<line>` / `<polygon>`. That keeps the output crisp at any zoom and trivially diffable. Where Chromium paints something we **can't express in native SVG** — color emoji, an icon-font pseudo-element glyph, live `<canvas>` pixels, a CSS conic gradient — we fall back to embedding a raster image (PNG, base64 data URI inside an `<image>` element).

This document is the canonical list of those fallback cases. If you add a new one, **add it here**; if you remove one, prune the entry. Keeping this in sync with the code is the rule, not a nice-to-have — consumers reading the output need a single place to look up "why is this paint a raster instead of crisp SVG?".

The fallback cases group into three buckets:

- **Glyph-level fallbacks** stamp an `<image>` over an individual character or sub-element. The rest of the surrounding text still emits as `<path>`.
- **Element-level fallbacks** screenshot a whole element's painted rect and emit one `<image>` in its place.
- **CSS-feature fallbacks** synthesise a raster PNG for a CSS effect SVG has no equivalent for (conic gradient, mask-image element() ref).

Each entry below lists the trigger condition, the code path that captures the raster, the code path that emits the `<image>`, and the canonical doc that explains the design rationale.

> **A raster may reach the output as `<use href="#dmiN">` rather than a literal `<image>`.** Every emit site below writes an `<image>` with its bytes inline, but a post-pass over the assembled document (`hoistDuplicateImagePayloads`, `src/post-processing/hoist-image-payloads.ts`) shares any payload that appears more than once at identical geometry: the bytes move to one `<image id="dmiN">` in a top-level `<defs>` and each occurrence becomes a `<use href="#dmiN">` (wrapped in a `<g>` when the original carried a `clip-path` / `mask` / `filter` / `transform`, since `x`/`y` on a `<use>` is a translate that would otherwise drag the clip along). Applied by `wrapSvg`, `generateAnimatedSvg`, and the scroll composer; the trigger is duplication, not the kind of fallback, so it can affect any entry below. When you're chasing "which fallback produced this raster?", follow the `<use>` to its def and read the def's geometry. See [26-self-contained-svgs.md](../26-self-contained-svgs.md).

---

## Glyph-level fallbacks

### G1. Color emoji and color-bitmap glyphs

Trigger: `src/capture/script/emoji-detect.ts` ports Blink's pinned whole-sequence emoji grammar and records every non-whitespace grapheme as a temporary candidate. Node then runs the candidate through the same declared-family, presentation-priority, system-fallback, and shaping path used for vector text. `selectedGlyphRasterSpans()` keeps the candidate only when the selected glyph's concrete representation is sbix, COLR, CBDT/CBLC, or OpenType SVG. On Windows the native helper's exact selected-gid COLR/SVG/PNG answer outranks a DirectWrite base outline, matching Skia's decision order; an unmarked outline glyph in that same mixed face remains vector. There are no Unicode block lists, named glyph exceptions, canvas color probes, or font-name tests. Consequently arbitrary color icon webfonts are covered, while a monochrome glyph in an emoji-associated block remains vector.

**CSS `font-variant-emoji` changes glyph lookup and fallback priority, not the raster trigger itself.** Explicit VS15/VS16 wins; otherwise Blink's `text`, `emoji`, or Unicode-default variation-selector mode is applied to the whole scanner token. Declared faces are still tried before the priority face. cmap14 exact matches win; a conflicting face-wide color-table answer requeues the cluster, with Blink's one ignore-selector reset on exhaustion. Only the glyph ultimately selected by that process decides whether an overlay exists.

Why: SVG cannot natively reuse sbix/CBDT bitmap strikes or Skia's COLR/SVG glyph paint result as an ordinary monochrome path. The overlay preserves Chromium's selected-glyph paint without changing which face or cluster won fallback.

Capture: each affected char gets a `rasterGlyphs[]` entry on its `textSegments` with `charIndex` (UTF-16) and the painted rect. The post-capture `rasterizeBitmapGlyphs` pass fills in `dataUri` from either (a) the Apple Color Emoji `.ttc`'s sbix tables on macOS, or (b) `page.screenshot({ clip })` for codepoints sbix lacks / non-darwin platforms. Every sbix stamp is then **self-calibrated against Chrome's actual painted pixels** (`calibrateSbixOverlays`): Apple hand-tunes emoji artwork per strike (a glyph can sit at a different position inside the frame at different ppem, or be redrawn outright), so the embedded high-res strike (≥64 ppem, kept for >1× sharpness) is screenshot-compared to the page's paint — position-tuned artwork gets its destination rect re-solved so the ink bboxes coincide, and redrawn-per-strike artwork (mean pixel difference above a threshold even after alignment) is DEMOTED to the screenshot pixels, exact at 1× at the cost of >1× sharpness for that glyph. Strike-invariant artwork (the overwhelming majority) is left byte-identical.

Emit: `src/render/text.ts::rasterGlyphOverlays` stamps one `<image>` per selected entry. The original source cluster remains in shaping so its selected glyph keeps the CoreText/DirectWrite/FreeType advance that positions later text; `src/render/text-to-path.ts` omits only a glyph whose selected representation is raster-owned from path or embedded-subset emission. The `suppressGlyph` marker is capture metadata, not permission to rewrite a paint-bearing cluster to U+200B—zero-area structural markers and the raw-`<text>` degradation path are the only string-suppression cases. Screenshot-path per-glyph overlays are stamped at the INTEGER-SNAPPED clip the pixels were actually taken from (`clipRectForScreenshot` snaps outward), not the fractional captured rect — stamping at the fractional rect resampled Chrome's paint by the snap phase, measured as a ~1px ink shift on sub-pixel-positioned Apple Color Emoji digit overlays. sbix-stamped overlays keep their calibrated rects.

Doc: [15-color-emoji-rendering.md](../15-color-emoji-rendering.md) and [145-renderer-owned-color-glyph-boundary.md](../145-renderer-owned-color-glyph-boundary.md).

### G2. Unshapeable pseudo-element / segment glyphs (icon-font PUA, color glyphs in `::before`/`::after`)

Trigger: a whole text segment — typically a `::before` / `::after` pseudo-element's content — that contains a codepoint Chromium shapes from an icon font (often a Private-Use-Area codepoint) or paints as a color glyph, where fontkit can't produce an outline.

Why: unlike G1 (which rasters one char and keeps the surrounding run as paths), the *entire segment* has no faithful path representation — the glyph the icon font draws isn't in any outline table we can read. Screenshotting Chromium's painted rect for the segment is the only faithful fallback.

Capture: CAPTURE_SCRIPT sets `pseudoSeg.rasterRect` on the segment (`src/capture/script/walker/pseudo-content.ts` ~lines 805–812). The post-capture `rasterizeBitmapGlyphs` pass screenshots that rect and writes `seg.rasterDataUri` (`src/capture/emoji.ts` ~lines 255–259).

Emit: `src/render/text.ts` emits one `<image>` at the segment's `rasterRect`, clipped to the segment box, in place of the path run — the single-segment overlay (~line 950) and the multi-segment path (~line 1178).

Doc: [38-pseudo-element-paint.md](../38-pseudo-element-paint.md). Tickets: SK-1058 / DM-626.

---

## Element-level fallbacks

### E4. Replaced elements — `<iframe>` / `<canvas>` / `<video>` / `<object>` / `<embed>` and custom elements with open shadow DOM

Trigger: tag is one of those five, OR a custom element (hyphenated tag with `shadowRoot != null`). **Exception (DM-1441):** a same-origin `<iframe>` is NOT rastered — its document is recursed into native SVG instead (see below).

Why: nothing here is reachable through the DOM walk. `<canvas>` is a pixel surface. `<video>` is decoded native pixels. Custom elements' shadow DOM is opaque to the light-DOM walker. Snapshotting at t=0 gives a faithful single-frame raster; live playback / interaction are explicitly out of scope.

**`<iframe>` now recurses when accessible (DM-1441).** When an iframe's `contentDocument` is readable (same-origin — cross-origin `contentDocument` is `null` under the Same-Origin Policy), the capture walker recurses the inner document with the same capture logic, transforms it into the parent's coordinate space (via a temporary `vp`-origin shift), splices it in as the iframe node's child, and marks the iframe node `overflow: hidden` so the renderer clips the inner content to the iframe content box — crisp, scalable, selectable native SVG instead of a raster. An iframe stays a raster `<image>` only when its document is inaccessible: **cross-origin and not allowlisted** (the `--cross-origin-frames` allowlist + `--disable-web-security` lift this for trusted hosts — DM-1442 / Phase 2), a media/pixel frame with no DOM, or a frame that hasn't loaded. See [81-iframe-recursion.md](../81-iframe-recursion.md).

Capture: `src/capture/script/walker/replaced-elements.ts` tags the live DOM with `data-domotion-rid` and stashes a bootstrap content rect on `captured.replacedSnapshot` — but it **skips an iframe that was recursed** (`captured._iframeRecursed === true`, set by `_captureIframeRecursion` in `src/capture/script/index.ts`). The post-capture `rasterizeReplacedElements()` in `src/capture/index.ts` injects a hide-everything-else stylesheet and asks Chromium's `DOM.getBoxModel` for the authoritative content quad. Rotation/skew owners and ancestor overflow/clip/mask paint nodes are neutralized while Chromium samples the local source; the SVG tree reapplies the affine transform and clip once, in Blink's order, and capture restores stored scroll offsets. Off-page sampling is accepted only through a same-size translation mapping. Pure scale/translation remains live/baked; a projective ancestor's `transformSubtreeRaster` owns the entire surface and suppresses the nested snapshot. `rasterToOutput` keeps PNG device pixels separate from CSS destination units, including DPR-scaled expected-image crops. A recursed iframe has no `replacedSnapshot`, so it is skipped throughout. See doc 17 and DM-2380.

Emit: `src/render/element-tree-to-svg.ts::paintRasterSnapshot` (~line 409–419) emits the `<image>` at the content-box rect. If an `imageReplacement.titleText` was captured (sprite path — see E5), a `<title>` child is included so screen readers and tooltips still get accessible text.

Doc: [17-replaced-element-snapshots.md](../17-replaced-element-snapshots.md). Ticket: DM-457.

### E5. CSS sprite-icon image-replacement (`text-indent: -9999px` + `background-image`)

Trigger: the Phark / modern image-replacement idiom — `text-indent <= -1000` (or `text-indent < 0 && overflow:hidden && white-space:nowrap`) PLUS a non-`none` `background-image`. Skipped when the element is itself an `<img>` (it'd double-stack the painted image).

Why: Domotion's path-mode bg-image emission can't reliably slice a sprite atlas to the displayed icon region. Routing through the same screenshot pipeline used for E4 gives the painted slice directly.

Capture: same `data-domotion-rid` + content-box rect mechanism as E4. The handler additionally clears `captured.styles.backgroundImage`, `captured.text`, and `captured.textSegments` so the path pipeline doesn't try to emit a stale bg-image OR the off-screen text underneath the raster. The accessible label is harvested from `aria-label` or the offscreen `text` and stashed as `imageReplacement.titleText` so the rendered `<image>` carries a `<title>` child.

Doc: [23-css-sprite-icons.md](../23-css-sprite-icons.md). Ticket: DM-457 (sprite path).

### E6. Projective transform subtree

Trigger: a transform context whose four-corner geometry is non-affine,
including perspective / `preserve-3d` paint. Affine CSS transforms, including
affine `matrix3d()`, are explicitly excluded and remain vector.

Why: SVG transforms are affine and cannot represent perspective projection or
3D depth ordering. Chromium composites the projective context before Domotion
captures that surface.

Capture and emit: `src/capture/index.ts` asks Chromium CDP for live content and
border-box quads correlated to the actual DOM objects; it never appends HTML
corner markers to the candidate. `src/capture/projective-owner.ts` activates on
the measured non-affine fourth corner, climbs to the outer 3D context, and
promotes a context below opaque `svgContent` to the outermost inline-SVG clone
that would otherwise suppress it. Property-only perspective on source-flattened
SVG graphics, 2D matrices, and planar `matrix3d()` remain vector.

`rasterizeProjectiveSurfaces` isolates the selected live owner, retains authored
descendant visibility, excludes the propagated html/body canvas backdrop,
screenshots the complete capture viewport, and trims by real alpha so
overflow/effect ink and DPR are not bounded by a guessed pad.
`src/render/element-tree-to-svg.ts` emits the image once at the inline/replaced
content paint position, before `paintInlineSvg`, and suppresses the clone plus
all nested reconstructed/raster descendants. A projective inline-SVG root, an
HTML ancestor, and HTML 3D under `<foreignObject>` therefore each have one
effective outer owner. See [doc 162](../162-inline-svg-3d-transform-audit.md).
The affine/non-affine boundary is also covered by
`npm run transform:geometry-oracle`, `npm run raster:boundary-oracle`, and the
focused inline-SVG route/pixel oracle.

---

## CSS-feature fallbacks

### C-1. Native form-control host paint

Trigger: an `input`, `select`, `textarea`, `button`, `progress`, or `meter`
whose computed `appearance` is not `none`. A `button` is excluded when a
matching author stylesheet or inline declaration owns its background, border,
shadow, color, font, or padding; authored buttons remain native SVG even when
their computed appearance stays `auto`.

Why: Blink's platform LayoutTheme and native shadow DOM paint OS-specific
control chrome that portable SVG geometry cannot reproduce exactly. Author
button paint does not have that limitation and must remain vector so state
changes, labels, and CSS surfaces are preserved structurally.

Capture and emit: `src/capture/script/index.ts` records the host plus outline
and one-pixel paint overflow, along with private live-node correlation.
`src/capture/native-control-raster.ts` reads one authoritative compositor frame
(`rasterizeFromImagePath`, or one atomic live screenshot) and one atomic
transparent isolation frame for all controls. Static source RGB is accepted
only where isolated alpha proves full opacity; transparent edges and
overlapping siblings stay isolation-owned. Time-dependent paint uses its
complete overlap-free source crop or fails closed. Geometry, frame, and
screenshot failures append a `native-control-raster` warning.
`src/render/element-tree-to-svg.ts` treats the
record as mandatory ownership: it emits the Chromium `<image>` when present,
or nothing for a proved-empty/warned failure, and never falls through to
sampled native chrome. See [doc 167](../167-native-control-source-frame-rasters.md).

### B1. Split native/closed-shadow control decorations

Trigger: Blink EffectiveAppearance leaves a control host structural but a
menulist-button arrow or temporal/search/number closed-shadow part still owns
paint.

Why: theme arrow metrics and pixels are platform-owned; search/spin state and
resources are selected by ThemePainter; temporal indicators use closed-UA
layout plus UA resources. Rebuilding any from sampled glyph constants loses
writing direction, zoom, state, scheme, forced-colors, and platform behavior.

Capture and emit: `pseudo-style-cdp.ts` retains the actual pierced UA nodes and
`native-control-decoration-raster.ts` reads every active decoration from one
transparent, reversible isolation frame. The select arrow is isolated from its
anonymous selected-text child while preserving host geometry and theme inputs.
Identity, interaction state, quads, restoration, alpha, guard, overlap, clip,
and DPR all fail closed with `native-control-decoration-raster`; presence of
the reservation always suppresses sampled form-control glyphs. Menulist arrows
compose after the CSS background and before inset-shadow/border/text; other
parts compose at content paint. See
[doc 171](../171-closed-shadow-control-decorations.md).

### C0. `backdrop-filter`

Trigger: an element whose computed `backdrop-filter` (or prefixed equivalent)
is neither empty nor `none`.

Why: an SVG embedded through `<img>` cannot sample the page pixels already
painted behind an internal group, while Blink's backdrop effect explicitly
filters that earlier paint surface. Rebuilding the filter primitives in SVG
would apply them to the wrong input.

Capture: the DOM walk records a tokenized `backdropFilterRaster` border-box
placeholder. `rasterizeBackdropFilters` in `src/capture/emoji.ts` uses a CDP
DOM snapshot to hide only later-painted overlapping subtrees, screenshots the
target while preserving its earlier backdrop and hiding descendant subtrees,
restores the live DOM, and stores the PNG data URI. Snapshot or mapping failures fall back
to the ordinary full-page crop.

Emit: `src/render/element-tree-to-svg.ts` emits the raster `<image>` at the
element's paint position as its filtered box surface, then emits text and
descendants as vectors above it.

Doc: [126-backdrop-filter-isolation.md](../126-backdrop-filter-isolation.md).

### C0a. Advanced CSS gradient interpolation

Trigger: a linear/radial gradient using Lab, OKLab, LCH, OKLCH, HSL, or HWB
interpolation (including polar hue routes), or a gradient whose stop alpha
varies. Opaque sRGB and sRGB-linear gradients remain native SVG.

Why: SVG exposes only sRGB/linearRGB interpolation and uses unpremultiplied
stop colors. Blink's CSS gradients support the Color 4 spaces and request
premultiplied-alpha interpolation.

Capture and emit: `rasterizeAdvancedGradients` asks the same Chromium session
to paint the exact tile, cached by gradient text and concrete tile size. The
background/mask renderer embeds that tile. Missing cache data warns loudly and
uses best-effort SVG rather than dropping paint. The positive/negative boundary
is gated by `npm run raster:boundary-oracle`; paint values are gated by
`npm run paint:geometry-browser-oracle`.

### C0b. HTML CSS URL filters containing `feConvolveMatrix`

Trigger: an HTML element's computed `filter` contains a same-document
`url(#id)` whose referenced filter graph (including an `href`-inherited graph)
contains `feConvolveMatrix`. Ordinary URL filter graphs and filters applied
inside native SVG are explicit vector negatives.

Why: Blink forms `SourceGraphic` from the HTML paint layer and resolves the
filter reference box/viewport before the primitive runs. `FEConvolveMatrix`
then passes a reversed kernel, edge tile mode, and crop to Skia, which samples
layer-space pixels. Rebuilding the DOM as SVG changes those source samples;
matching the kernel attributes alone cannot recover them.

Capture and emit: the capture walk records `urlFilterRaster`; the Node
`rasterizeUrlFilterSurfaces` pass isolates the live element, screenshots the
whole capture viewport, and trims only pixels with nonzero alpha, preserving
the real filter-region overflow without a padding/threshold constant. The
renderer emits that final surface atomically. Screenshot failure retains the
existing vector URL-filter path. See
[148-sourcegraphic-url-filter-surfaces.md](../148-sourcegraphic-url-filter-surfaces.md).

Pseudo-element shorthand filter functions are an explicit **vector negative**
for this boundary (DM-2367). Empty, text, and generated-image pseudos retain
their computed `blur` / color-matrix / component-transfer / `drop-shadow`
lists on a native SVG CSS-filter group, so Chromium still owns operation order,
sRGB interpolation, premultiplication, and moving-pixel bounds. They must not
be promoted to a screenshot merely because the list contains `blur` or
`drop-shadow`; only a source-owned representation boundary such as the HTML
`SourceGraphic` convolution case above activates C0b.

### C1. `conic-gradient(...)` / `repeating-conic-gradient(...)`

Trigger: any background layer whose CSS value parses as a conic or repeating-conic gradient.

Why: SVG has no native conic-gradient primitive. The cleanest fallback is to rasterise the conic into a PNG tile and embed it as a `<pattern><image href="..."/></pattern>`, which works in every static-SVG viewer (Preview, librsvg, GitHub previews, browsers).

Capture: `rasterizeAdvancedGradients(tree, page)` asks the same live Chromium
page to paint every conic tile, including form-control pseudo backgrounds
enumerated by `collectFormControlConicTiles`. It stores PNG data in
`_conicTileCache`, keyed by serialized layer and concrete physical tile size.
Captured px `background-size` terms include cumulative CSS effective zoom;
percentages remain relative to the already-physical box. The custom
`rasterizeConicGradients` CPU/Sharp path only fills missing entries for
direct-tree/helper-absent callers and never replaces Chromium pixels. A final
miss warns loudly.

Emit: `src/render/element-tree-to-svg.ts::buildConicGradientDef` (~line 4500) emits `<pattern id="..." patternUnits="userSpaceOnUse" ...><image href="data:image/png;base64,..." width="..." height="..."/></pattern>` and refers to it from the element's `fill="url(#...)"`.

Doc: [28-conic-gradient.md](../28-conic-gradient.md).

### C2. `mask-image: element(#id)` paint references

> ⚠️ **Dormant — Chromium does not support CSS `element()` (DM-1450).** Verified on Chromium 147: `element()` parse-rejects (`CSS.supports` false, computed `maskImage: none`), so Chrome paints the consumer unmasked and `discoverMasks` never records a `maskRaster`. This fallback therefore never fires through real capture today (the `mask-element-ref` fixture is a vacuous pass). It's a Firefox-only feature; no Chrome flag enables it. The code is kept (spec-correct, synthetic-input-tested) but is not a live path. See [22-mask-element-paint-references.md](../22-mask-element-paint-references.md).

Trigger: CSS `mask-image: element(#some-id)` referencing the *painted* output of another DOM element (not a `<mask>` fragment — that's covered by [21-mask-fragment-references.md](../21-mask-fragment-references.md)).

Why: the spec defines this as "rasterise the target element's paint and use that bitmap as the mask source". SVG can reference foreign elements only through `<mask>` / `<use>` / `<symbol>`, none of which match the CSS `element()` semantics — paint-as-bitmap is the only faithful path.

Capture: CAPTURE_SCRIPT finds each `mask-image: element(#id)` reference, marks the target element with `data-domotion-rid="mr<n>"`, and records `(id, rid, rect, width, height)` on the root tree's `maskRasters[]`. Post-capture, `rasterizeMaskSources` (`src/capture/index.ts`) runs the same hide-everything-else stylesheet pass as E4 / E5 and screenshots the target's painted rect at the page's actual DPR.

Emit: `src/render/mask.ts::buildMaskDef` (moved out of element-tree-to-svg.ts in DM-1305; `buildMaskDef` is at ~line 496) resolves the data URI from the per-element `elementRasters` lookup when building `<mask>` defs; emits an `<image>` directly inside the `<mask>` with `mask-position` / `mask-size` honored. `mask-mode: match-source` resolves to `luminance` (per the CSS Masking spec — element() paint refs drive mask alpha from RGB luminance).

Doc: [22-mask-element-paint-references.md](../22-mask-element-paint-references.md).

---

## Not in this list

Textarea soft wrapping and vertical writing modes are also **not** fallbacks.
Current capture records their logical line/run geometry and emits vectors.
`elementRaster` remains only so older serialized captured trees can still be
rendered; no live capture path sets it.

The broken-image placeholder is also **not yet** an inventoried raster path.
Current code draws a source-inexact gray vector mountain and raw SVG text.
[The Chromium ownership audit](../156-broken-image-fallback-ownership-audit.md)
shows that the eventual faithful route is hybrid: author/container/clip and
alternative text remain vector, while only Chromium's DPR-selected broken-image
bitmap becomes a minimal raster `<image>`. Add that icon-level entry here only
when the capture and emit sites actually ship; until then, describing it as a
live fallback would misstate the generated SVG.

These also emit `<image>` tags but **aren't fallbacks** — they're the renderer faithfully passing through an author-supplied raster:

- `<img src="...">` (raster) and `<picture>` elements — the source IS a raster image (PNG/JPEG/GIF/WebP/AVIF); we embed it as a data URI (resized to its display size per [27-image-resize-on-embed.md](../27-image-resize-on-embed.md)).
- **`<img src="*.svg">` — inlined as native `<svg>`, NOT raster (DM-1588).** This is the *inverse* of a fallback: an `<image>` that becomes crisp vector. An SVG referenced from an `<img>` used to embed as `<image href="data:image/svg+xml;base64,…">`, which Chromium rasterizes at the element's layout size then scales — so it softens/aliases at high zoom. We now decode the SVG source and splice it in as a positioned, id-namespaced nested `<svg x y width height viewBox preserveAspectRatio>`, so it stays truly resolution-independent (and drops the ~33% base64 bloat). Trigger: `resolveSvgSource(el.imageSrc)` (`src/capture/embed.ts`) returns non-null — i.e. the `<img>` source resolves to `image/svg+xml` (a `.svg` file, a `data:image/svg+xml` URI, or a pre-fetched remote SVG). Rewrite site: `inlineImgSvg` (`src/render/svg-inline.ts`), invoked from `paintImage` in `src/render/element-tree-to-svg.ts`. Falls back to the raster `<image>` path when the source has no usable coordinate system (no viewBox, no absolute width/height, no `<img>` intrinsic size). All `object-fit` values take the native path, including `object-fit: none` (DM-1592 — placed at intrinsic size, positioned by `object-position`, clipped to the content box). Raster `<img>` (PNG/JPEG/…) is unaffected — it stays `<image>`. See [96-native-svg-image-inlining.md](../96-native-svg-image-inlining.md).
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
