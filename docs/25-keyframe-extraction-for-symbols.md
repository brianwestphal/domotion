# 25 — Animated symbol contents: t=0 paint state

## Context

DM-499 lands resolve-and-inline for `<use href="#sym">` references. Symbols whose contents carry CSS animations (a hover-pulse, a spinning loader, a gentle bobbing chevron) are the long tail.

Domotion's contract is: faithful capture of what Chrome painted at the moment of capture. Animation timing and future frames don't survive — every captured asset is one frame at t=0. DM-508 brings animated symbols in line with that contract: instead of falling back to a `page.screenshot` raster, we bake the t=0 computed paint state declaratively.

## Today's behavior

Implemented in DM-508 (this doc).

`_resolveUseRefs` (`src/capture/script/` `tag === 'svg'` block) inlines `<use>` references into the cloned consumer SVG. After cloning the resolved subtree, `_walkBake` walks both the ORIGINAL DOM target and the cloned replacement in parallel, reading `getComputedStyle` from each original node and baking the resolved values onto the clone:

- Presentation attrs (already in the bake list pre-DM-508): `fill`, `stroke`, `stroke-width`, `stroke-dasharray`, `stroke-linecap`, `stroke-linejoin`, `stroke-opacity`, `fill-opacity`, `opacity`. Skipped when the original has the attribute set inline (avoids overwriting author intent in the unanimated case).
- `transform` (new in DM-508): always baked when the computed value isn't `none`. CSS animations / transitions resolve into the computed transform at the moment of capture, so a `<rect>` with `animation: spin 4s infinite linear` carries e.g. `matrix(0.707, 0.707, -0.707, 0.707, 0, 0)` at one capture moment. Composed with `transform-origin` so the SVG transform attribute (which applies around (0, 0) by default) reproduces what CSS painted around the bbox center.

The animated-subtree raster fallback from DM-499's first version is dropped. We still warn at capture time so consumers know the inlined SVG is a snapshot, not a live animation.

## What this preserves and what it doesn't

**Preserves**: the captured paint exactly matches Chrome's painted output at the moment of capture. A spinner caught mid-rotation appears in the SVG at that rotation. A pulsing icon caught at 70% opacity appears at 70% opacity.

**Doesn't preserve**: animation timing, keyframes, future frames. The SVG output is a static frame.

This matches Domotion's existing behavior for any other time-varying content — the tool captures one frame; consumers who need motion compose multiple captures via the animator pipeline (`docs/08`).

## Why not keyframe extraction

The first draft of this doc proposed walking `document.styleSheets` for `@keyframes` rules, filtering to names referenced by the resolved subtree, rewriting identifiers, and emitting them into the output SVG's `<style>` block. The user's feedback was: we don't actually need to retain keyframe information; we just want the drawing correct for the moment in time.

Resolving via `getComputedStyle` is much simpler:
- ~20 lines of code added to `_walkBake`'s SVG branch.
- No identifier rewriting; no `@keyframes` rule emission.
- Easier to debug — the inlined SVG has concrete attribute values, not animation references that depend on a separate `<style>` block.
- No new attack surface for embedding contexts with strict CSP.

If a future use case demands declarative animation round-trip, the keyframe-extraction approach can be layered in.

## Transform-origin handling

CSS `transform: rotate(45deg)` with `transform-origin: center` and `transform-box: fill-box` rotates around the element's bounding box center. SVG's `transform` attribute applies around (0, 0). To reproduce CSS's effect on the inlined SVG, the bake composes:

```
final = translate(ox, oy) * css_transform * translate(-ox, -oy)
```

`ox`, `oy` come from `getComputedStyle().transformOrigin`, parsed as px values, plus the element's bbox origin (when `transform-box: fill-box` resolves to `0, 0` relative to the bbox, it's at `bbox.x, bbox.y` in parent coords).

For the unanimated case where `transform-origin` is `0 0` (or the element has no transform), the composed transform reduces to the identity / source transform — no overhead.

## Test fixtures

`tests/features.ts` `inline-svg-use-symbol-animated`: a hidden `<symbol id="dm-anim-icon">` with a `<rect>` carrying `animation: dm-fixture-spin 4s infinite linear` (keyframes lock to a 45° rotation for deterministic testing). Consumer `<svg width="32" height="32"><use href="#dm-anim-icon"/></svg>` should capture and emit the rotated rect — diff vs. Chrome's painted output: **0 px**.

The existing `inline-svg-use-symbol` and `inline-svg-use-group` fixtures continue to pass / produce identical output (the new transform-bake is idempotent for unanimated subtrees).

## Open caveats

- **`transform-box` values** (DM-752): all the standard boxes are handled at capture time (`src/capture/script/walker/inline-svg.ts`). `fill-box` (the modern CSS default) and `content-box`/`border-box` add the element's bbox origin; `view-box` (the legacy SVG default) does NOT add the bbox origin (its origin is the SVG viewport); `stroke-box` adds the bbox origin then subtracts half the stroke width. So the bake composes against the correct origin for each `transform-box` rather than assuming `fill-box`.
- **3D transforms**: SVG's `transform` attribute is 2D-only. CSS `transform: rotate3d(...)` resolves to a 4×4 matrix that we'd flatten to the 2D approximation. None of our fixtures use 3D on SVG; not yet validated.
- **JS-driven animations** (`element.animate(...)`): no different from CSS animations from `getComputedStyle`'s perspective. The computed transform reflects the JS animation's current value too. Same bake works.
- **Animation play-state: paused at t=0**: identical to the unpaused case from a paint perspective — the painted state at t=0 is what we capture. Author intent (paused vs. running) doesn't survive.
