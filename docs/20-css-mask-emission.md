# 20 — CSS mask → SVG `<mask>` emission

## Context

CSS `mask-image` lets authors hide / reveal parts of an element by alpha-or-luminance compositing the element's paint against an image, gradient, or referenced graphic. SVG natively supports the same concept via `<mask>` with a `maskUnits="userSpaceOnUse"` content rect.

Common patterns this ticket scope cares about:

1. **Edge-fade**: `mask-image: linear-gradient(to right, black 0%, transparent 100%)` — used to fade out a horizontal-scroll list, sticky nav, or hero photo edge.
2. **Bitmap mask**: `mask-image: url("./shape.png"); mask-position: center; mask-size: cover;` — used for irregular shape clipping (Apple Mother's Day decorative orbs).
3. **Multi-layer mask**: `mask-image: url(a), linear-gradient(...);` — composited per CSS mask-composite (default `add` = additive).

Until DM-470, the capture path warned `mask: captured but not emitted — mask sources need coordinate-aware emission` for any element with a `mask` shorthand. The warning text was stale: `buildMaskDef()` (`src/dom-to-svg.ts:5802`) already emits SVG `<mask>` defs for gradient and url() layers with size / position / repeat / composite handling. The warning predates the emission feature and was never updated.

## What's already working

`buildMaskDef()` covers:

- `mask-image: linear-gradient(...)` / `radial-gradient(...)` / `repeating-…-gradient(...)` — emitted as `<linearGradient>` / `<radialGradient>` painted into a sized `<rect>` inside the `<mask>`, with `mask-size` / `mask-position` honoured.
- `mask-image: url("…")` — emitted as `<image>` inside the `<mask>`, sized via `mask-size` (auto / contain / cover / explicit) and offset via `mask-position` (keywords + percentages).
- Multi-layer `mask-image: a, b, c` — flattened into one `<mask>` for the additive composite (the common default). `mask-composite: intersect` chains nested masks.
- `mask-mode: alpha | luminance` — translates to SVG `mask-type` on the `<mask>` element. Defaults to `alpha` for gradients / bitmaps (matches Chromium's practical behaviour for `mask-mode: match-source`).

Renderer wiring (`src/dom-to-svg.ts:3266-3284`): when `el.styles.maskImage` is non-empty, the mask def is pushed into `defsParts` and the rendered group gets `mask="url(#mkN)"`.

## What's NOT working (the actual ticket scope)

Cases where emission still falls through with no SVG output:

1. **`mask-image: element(#id)`** — references another DOM element as the mask source. Not common on real-world fixtures, low priority.
2. **`mask-image: url("inline.svg#fragment")`** — fragment into an inline SVG. Not currently parsed; the URL is taken as-is and emitted but the fragment doesn't resolve cross-document.
3. **CSS-only `-webkit-mask` shorthand** — when the author uses the vendor-prefixed shorthand and Chromium resolves `getComputedStyle().maskImage` to `none` (some browser-version combos), our emission path bails. CAPTURE_SCRIPT already fallbacks to `cs.webkitMaskImage` on lines 2141-2148; verify that's still firing correctly post-DM-470.

The misleading warning text is the most visible symptom of the gap between perceived and actual support.

## Requirement (this ticket)

1. **Update the warning text** at `src/dom-to-svg.ts:1127`. The current text claims masks aren't emitted; the truth is emission works for the common url + gradient cases. Replace with: `"non-trivial mask source — emission may differ from Chromium's actual blur/composite for masks composed of element() references or unresolved url() fragments"`.
2. **Suppress the warning** when `cs.maskImage` is a recognised gradient or `url()` form — those round-trip cleanly through `buildMaskDef()` and don't deserve a per-element warning at capture time.
3. **Document** (this file) what's supported, what isn't, and where the gap is so future regression triage stops mistaking \"mask warning\" for \"masks are completely broken\".

## What's deferred

- `element()` paint reference support — out of scope for DM-470; file follow-up if a real-world fixture surfaces the need.
- Inline-SVG fragment URL resolution (`url("#mask-id")` referencing an inline `<mask>` defined earlier in the page) — same.

## Test fixture

Existing `src/mask.test.ts` exercises `buildMaskDef()` for gradients and url() at the unit level (9 tests). No additional integration fixture is added in this pass — existing real-world coverage on Apple / Resend hits the path.

## Open questions for the user

- **Should the warning be removed entirely, or downgraded to fire only on truly-unsupported sources?** I lean toward downgrade (still useful as a heads-up for cases the renderer can't reproduce pixel-perfect), but the user may prefer the cleaner \"warning only when broken\" semantics.
- **Should `element()` paint reference and inline-SVG fragment masks be filed as separate follow-ups now or wait for a real-world fixture to flag them?**
