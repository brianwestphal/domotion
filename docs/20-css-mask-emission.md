# 20 — CSS mask → SVG `<mask>` emission

## Context

CSS `mask-image` lets authors hide / reveal parts of an element by alpha-or-luminance compositing the element's paint against an image, gradient, or referenced graphic. SVG natively supports the same concept via `<mask>` with a `maskUnits="userSpaceOnUse"` content rect.

Common patterns this ticket scope cares about:

1. **Edge-fade**: `mask-image: linear-gradient(to right, black 0%, transparent 100%)` — used to fade out a horizontal-scroll list, sticky nav, or hero photo edge.
2. **Bitmap mask**: `mask-image: url("./shape.png"); mask-position: center; mask-size: cover;` — used for irregular shape clipping (Apple Mother's Day decorative orbs).
3. **Multi-layer mask**: `mask-image: url(a), linear-gradient(...);` — composited per CSS mask-composite (default `add` = additive).

Until DM-470, the capture path warned `mask: captured but not emitted — mask sources need coordinate-aware emission` for any element with a `mask` shorthand. The warning text was stale: `buildMaskDef()` (`src/render/mask.ts`) already emits SVG `<mask>` defs for gradient and url() layers with size / position / repeat / composite handling. The warning predates the emission feature and was never updated.

## What's already working

`buildMaskDef()` covers:

- `mask-image: linear-gradient(...)` / `radial-gradient(...)` / `repeating-…-gradient(...)` — emitted as `<linearGradient>` / `<radialGradient>` painted into a sized `<rect>` inside the `<mask>`, with `mask-size` / `mask-position` honored.
- `mask-image: url("…")` — emitted as `<image>` inside the `<mask>`, sized via `mask-size` (auto / contain / cover / explicit) and offset via the computed two-axis `mask-position` (percentages, lengths, and linear `calc()` mixtures).
- Multi-layer `mask-image: a, b, c` — flattened into one `<mask>` for the additive composite (the common default). `mask-composite: intersect` chains nested masks.
- `mask-mode: alpha | luminance` — translates to SVG `mask-type` on the `<mask>` element. Defaults to `alpha` for gradients / bitmaps (matches Chromium's practical behavior for `mask-mode: match-source`).

Renderer wiring (`src/render/element-tree-to-svg.ts`): when `el.styles.maskImage` is non-empty, the mask def is pushed into `defsParts` and the rendered group gets `mask="url(#mkN)"`.

## Also implemented (previously the ticket gap)

These two cases now emit SVG output:

1. **`mask-image: element(#id)`** — references another DOM element as the mask source. Implemented (DM-494): the referenced element is captured as a painted snapshot and threaded through `elementMaskRasters` (built from `tree[0].maskRasters`), so an `element()` layer paints from that raster.
2. **same-document `url(#fragment)` masks** (`mask-image: url("#mask-id")` referencing an inline `<mask>` defined in the page) — implemented (DM-493): `rewriteFragmentMaskDef` (`src/render/mask.ts`) rewrites the referenced inline `<mask>` def into the output and resolves the fragment, with `positionFragmentMaskDef` placing it.

Still imperfect:

- **CSS-only `-webkit-mask` shorthand** — when the author uses the vendor-prefixed shorthand and Chromium resolves `getComputedStyle().maskImage` to `none` (some browser-version combos), our emission path bails. CAPTURE_SCRIPT already fallbacks to `cs.webkitMaskImage` on lines 2141-2148; verify that's still firing correctly post-DM-470.

## Exact contain/cover position ownership (DM-2379)

The old URL-mask path sized `<image>` to the whole positioning box and asked
SVG `preserveAspectRatio="xMin|Mid|Max YMin|Mid|Max meet|slice"` to fit and
align it. That is exact only at 0%, 50%, and 100%. `23% 73%`, `17px 9px`, and
`calc(25% + 7px)` were all reduced to one of three alignment buckets.

The source-owned path is now:

1. `primeMaskImageIntrinsics()` awaits Chromium's decoder and records each
   contain/cover URL layer's natural width/height plus a Chromium-laid-out
   intrinsic aspect. The separate aspect is necessary because integer
   `naturalWidth`/`naturalHeight` lose fractional SVG viewBox ratios (a 3:7
   viewBox reports 64x150). The synchronous capture walk consumes those
   page-owned facts as `styles.maskIntrinsic`; it does not guess from the URL.
   The probe activates only for contain/cover layers and is removed after the
   walk.
2. Computed `mask-position` and `mask-size` px terms cross effective CSS zoom
   once during capture. Percentage terms remain unresolved.
3. `resolveMaskContainCoverRect()` (`src/render/mask-position.ts`) reproduces
   Blink's snapped positioning area, contain dependent-dimension rounding,
   cover LayoutUnit precision, and resolution of each physical axis against
   `positioning-area - concrete-tile`. Negative free space is intentional for
   cover.
4. SVG receives that concrete `x/y/width/height` with
   `preserveAspectRatio="none"`. SVG/Skia own sampling that rectangle, but do
   not make a second fit/alignment decision.
5. A sliced wrapped inline builds the same continuous strip as Blink and clips
   it to each physical fragment. `box-decoration-break: clone` and block
   fragments restart the positioning area per fragment. Vertical writing swaps
   the strip axis only; `mask-position` x/y remain physical axes.

The source audit is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`:

- `third_party/blink/renderer/core/paint/background_image_geometry.cc` —
  `ResolveXPosition` / `ResolveYPosition`, `CalculateFillTileSize`, and
  `CalculateRepeatAndPosition` own edge-relative length-percentage resolution,
  contain/cover fitting, snapping, and no-repeat/repeat phase.
- `third_party/blink/renderer/core/css/resolver/css_to_style_map.cc` —
  `MapFillPositionX/Y` stores the physical edge origin plus its exact `Length`.
- `third_party/blink/renderer/core/paint/inline_box_fragment_painter.cc` —
  `PaintRectForImageStrip` and `PaintFillLayer` own slice-vs-clone fragment
  continuation and clipping.
- Chromium DEPS pins Skia
  `62efacd37737505732dbe3d8daa62abd679626a1`; `include/core/SkCanvas.h`'s
  `drawImageRect` destination-rectangle API is the downstream sampling seam.

If Chromium cannot decode a contain/cover URL to a positive intrinsic ratio,
the renderer emits a transparent mask layer with an actionable warning. It
does not make the element accidentally unmasked, and it does not fall back to
the retired Min/Mid/Max quantization that would silently reintroduce the known
wrong geometry.

Focused evidence lives in `src/render/mask-position.test.ts`,
`src/mask.test.ts`, and
`tests/mask-position-contain-cover.e2e.test.ts`. The browser oracle covers
percentage, length, calc, physical vertical-writing axes, CSS zoom, DPR 1/2,
slice/clone fragments, and independently positioned multi-layer masks, plus a
mutation assertion that rejects any contain/cover Min/Mid/Max alignment.

## Independent HTML origin and clip geometry (DM-2472)

URL mask layers no longer size themselves from `mask-clip`. Capture retains
the complete computed `mask-origin` and `mask-clip` lists separately plus
zoom-crossed physical border/padding edges. The source-derived
`mask-origin-clip.ts` resolver cycles both lists independently: mask size,
position, and repeat phase use Blink's origin positioning box, while emitted
pixels are intersected with the clip painting box. `no-clip` deliberately
skips that intersection and receives a viewport-sized SVG mask region so
overflow ink is not cropped by SVG's default mask bounds.

The route covers border/padding/content HTML boxes and their fill/stroke/view
aliases, contain/cover and explicit URL sizes, repetition, multilayer
composition, CSS zoom, physical writing axes, and sliced/cloned inline
fragments. Source and test details are in
[doc 174](174-html-mask-origin-clip-geometry.md); run the strict DPR-1/2 browser
gate with `npm run mask:origin-clip-oracle`.

DM-2494 closes the URL `round`/`space` continuation of that split. Blink's
`BackgroundImageGeometry` resolves tile size and phase from the origin box but
passes `DrawImageTiled` the clip-owned destination. The SVG lowering now gives
its pattern the same painting rectangle; using the smaller positioning box as
the no-repeat-axis cell caused a second mask tile to wrap into the border area.
`src/render/mask-origin-clip.test.ts` pins both modes and the collapsed-box
mutation, while `tests/mask-url-repeat-geometry.e2e.test.ts` matches live
Chromium tile edges and rejects that mutation at DPR 1 and 2.

## Requirement (this ticket)

1. **Update the warning text** at `src/capture/script/walker/masks-clips.ts`. The current text claims masks aren't emitted; the truth is emission works for the common url + gradient cases. Replace with: `"non-trivial mask source — emission may differ from Chromium's actual blur/composite for masks composed of element() references or unresolved url() fragments"`.
2. **Suppress the warning** when `cs.maskImage` is a recognized gradient or `url()` form — those round-trip cleanly through `buildMaskDef()` and don't deserve a per-element warning at capture time.
3. **Document** (this file) what's supported, what isn't, and where the gap is so future regression triage stops mistaking \"mask warning\" for \"masks are completely broken\".

> **Shipped**: the warning now lives in `src/capture/script/walker/masks-clips.ts` (the capture walker, post `src/` reorg — not the old flat `src/dom-to-svg.ts`). It only fires for sources that are neither a gradient, a `url()`, nor an `element()` reference, and reads `non-gradient/non-url()/non-element() mask source — not emitted` — a terser final wording than the draft above, but the same intent: warn only on sources the renderer can't emit.

## What was deferred (now shipped)

- `element()` paint reference support — implemented in DM-494 (raster-snapshot mask layer via `elementMaskRasters`).
- Inline-SVG fragment URL resolution (`url("#mask-id")` referencing an inline `<mask>` defined earlier in the page) — implemented in DM-493 (`rewriteFragmentMaskDef` / `positionFragmentMaskDef` in `src/render/mask.ts`).

## Test fixture

Existing `src/mask.test.ts` exercises `buildMaskDef()` for gradients and url() at the unit level (9 tests). No additional integration fixture is added in this pass — existing real-world coverage on Apple / Resend hits the path.

## Resolved questions

- **Warning scope**: downgraded — it now fires only on sources the renderer can't emit (neither a gradient, a `url()`, nor an `element()` reference). See the "Shipped" note above.
- **`element()` paint reference and inline-SVG fragment masks**: both implemented (DM-494 / DM-493) rather than deferred — see "What was deferred (now shipped)" above.
