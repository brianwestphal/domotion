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
- `mask-image: url("…")` — emitted as `<image>` inside the `<mask>`, sized via `mask-size` (auto / contain / cover / explicit) and offset via `mask-position` (keywords + percentages).
- Multi-layer `mask-image: a, b, c` — flattened into one `<mask>` for the additive composite (the common default). `mask-composite: intersect` chains nested masks.
- `mask-mode: alpha | luminance` — translates to SVG `mask-type` on the `<mask>` element. Defaults to `alpha` for gradients / bitmaps (matches Chromium's practical behavior for `mask-mode: match-source`).

Renderer wiring (`src/render/element-tree-to-svg.ts`): when `el.styles.maskImage` is non-empty, the mask def is pushed into `defsParts` and the rendered group gets `mask="url(#mkN)"`.

## Also implemented (previously the ticket gap)

These two cases now emit SVG output:

1. **`mask-image: element(#id)`** — references another DOM element as the mask source. Implemented (DM-494): the referenced element is captured as a painted snapshot and threaded through `elementMaskRasters` (built from `tree[0].maskRasters`), so an `element()` layer paints from that raster.
2. **same-document `url(#fragment)` masks** (`mask-image: url("#mask-id")` referencing an inline `<mask>` defined in the page) — implemented (DM-493): `rewriteFragmentMaskDef` (`src/render/mask.ts`) rewrites the referenced inline `<mask>` def into the output and resolves the fragment, with `positionFragmentMaskDef` placing it.

Still imperfect:

- **CSS-only `-webkit-mask` shorthand** — when the author uses the vendor-prefixed shorthand and Chromium resolves `getComputedStyle().maskImage` to `none` (some browser-version combos), our emission path bails. CAPTURE_SCRIPT already fallbacks to `cs.webkitMaskImage` on lines 2141-2148; verify that's still firing correctly post-DM-470.

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
