# Domotion: CSS 2D transforms

> **2026 source audit:** text inside transformed HTML is not exactly represented
> by the current cumulative scalar/geometric-mean correction. Blink keeps
> zoom-adjusted shaped text in local fragment space and applies the complete
> signed transform in the paint property tree. Rotation, skew, reflection,
> nested origins, and anisotropic scale therefore require captured fragment
> geometry plus an affine matrix; non-affine planes retain the existing outer
> Chromium raster boundary. See
> [the exact text-transform geometry audit](159-exact-text-transform-geometry-audit.md).

Requirements for applying CSS `transform` to rendered SVG element groups in Domotion. Origin: SK-1127 (follow-up from SK-1091). Today our pipeline reads `cs.transform` into `el.styles.filter` (via the existing CSS filter pass-through) but only `transform: translate(…)` round-trips correctly because translation is absorbed by the captured `getBoundingClientRect` position. `rotate`, `scale`, `skew`, and `matrix` render as axis-aligned bounding boxes — the box is in the right viewport position but its internal contents are upright instead of rotated/scaled/skewed.

## Why now

`21-transform-2d.html` shows a grid of rotated and scaled boxes, each with text and a colored border. Our capture has each box at the correct on-page position but renders the internals (border, text, background) un-transformed, so a 30°-rotated red-bordered card with the word "rotate" renders as an upright red-bordered card with un-rotated text. The diff (~2.79%) is dominated by these orientation mismatches.

## Goals

- Capture `cs.transform` and `cs.transformOrigin` per element.
- For non-`none` transforms, wrap the element's rendered `<g>` in an SVG transform that matches Chrome's painted result.
- Compose CSS transforms into SVG transform syntax verbatim where possible (rotate, scale, translate, skew, matrix all share names with SVG).
- Honor `transform-origin` by translating to the origin, applying the transform, and translating back.
- Nested transforms compose naturally because each captured element's `getBoundingClientRect` already reflects the parent's transform — so each element only needs to apply its OWN transform, not its ancestors'.

## Capture changes

`CapturedElement.styles` adds:

- `transform: string` — the CSS `transform` value (e.g. `rotate(30deg)`, `scale(1.5)`, `matrix(1, 0.5, 0, 1, 0, 0)`).
- `transformOrigin: string` — the resolved origin (Chrome returns `Npx Mpx` or `Npx Mpx Npx`).

Both come from `getComputedStyle`. Note: Chrome returns the **computed** transform which preserves percentages on translate (e.g. `translate(50%, 0)` stays as `translate(50%, 0)`); the `getComputedStyle` resolved value is in pixels for translate-percent IF the element has a fixed size at capture time, but for safety the renderer should resolve the percent against the element's box if it sees one.

Important subtlety: `getBoundingClientRect()` returns the **transformed** box (the bounding rect of the rotated/scaled element on the screen). If we apply our own transform on top of that, the result is double-transformed. The simpler path is to capture the **untransformed** box and apply the transform ourselves:

- Use `el.getBoxQuads()` or `el.style.transform = "none"; rect = el.getBoundingClientRect(); el.style.transform = original` to read the pre-transform rect. The latter is hacky; the former is the right primitive but Chromium-specific.

Recommendation: keep using the transformed rect for layout (it's what Chrome painted, so paint-order and z-stacking work) and apply the transform around (rect.center) so the rendered group rotates/scales around its visual center. This is approximate for non-uniform transforms but works for the common rotate/scale cases.

## Render changes

In `src/render/element-tree-to-svg.ts` `renderElement`, around the existing `<g>` group wrapper that hosts opacity / filter / blend-mode:

1. Parse `el.styles.transform`. If `none`, skip.
2. Resolve `transform-origin` to absolute viewport coords (origin's `(ox, oy)` = `el.x + parsed-x`, `el.y + parsed-y`).
3. Wrap the element's group in `<g transform="translate(ox, oy) <css-transform> translate(-ox, -oy)">`. CSS `rotate(30deg)` → SVG `rotate(30)`. CSS `scale(2)` → SVG `scale(2)`. CSS `translate(10px, 5px)` → SVG `translate(10, 5)`. CSS `matrix(a,b,c,d,e,f)` → SVG `matrix(a b c d e f)` (space-separated). CSS `skew(Xdeg, Ydeg)` → SVG `skewX(X) skewY(Y)`.
4. Multiple comma-separated transform functions in CSS apply left-to-right; SVG's `transform` attribute also applies left-to-right when functions are space-separated. Keep the order verbatim.

## Edge cases

- Static 3D transforms (`rotate3d`, `translate3d`, `perspective`, `matrix3d`) are measured as final border-plane corners while Blink's live transform tree is intact. An affine `matrix3d()` remains a nested vector matrix. A true projective fourth corner, active ancestor `perspective`, preserve-3d flattening, and backface/depth compositing instead activate the inventoried Chromium subtree snapshot: SVG transform attributes cannot perform perspective division or reproduce a 3D rendering context. The outer context emits once as an `<image>` and its reconstructed descendants are suppressed.
- **Audited inline-SVG exception (design-only):** a captured DOM inline `<svg>` is emitted as opaque cloned markup, and the current path does not yet satisfy the preceding boundary inside that clone. Blink flattens SVG graphics-child 3D to an exact used affine CTM, but capture can emit an invalid literal `matrix3d()` attribute; a projective root can be missed; and a `<foreignObject>` raster owner can be recorded below the clone that suppresses it. [Doc 162](162-inline-svg-3d-transform-audit.md) defines the exact affine-freeze/outer-promotion split; implementation is DM-2473/2474 with the independent gate in DM-2475.
- Computed `perspective` and `perspective-origin` are captured independently. `perspective-origin` is the resolved border-box point (for example `15% 70%` on a 200×120 border box becomes `30px 84px`), but it changes neither stacking nor containing-block ownership when perspective computes to `none`.
- `transform-style: preserve-3d` remains a fixed-position containing-block signal even when a grouping property such as `overflow:hidden` forces its **used** transform style to flat. Ownership follows the computed value, exactly as Blink's containing-block predicate does; projective paint still follows the measured/raster boundary above.

This model is source-owned at Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`:

- `ComputedStyle::HasTransformRelatedProperty` (`computed_style.h`) includes transform, preserve-3d, perspective, and transform-related `will-change`; `CalculateIsStackingContextWithoutContainment` (`computed_style.cc`) makes that result a real stacking context.
- `LayoutInline::LayerTypeRequired` (`layout_inline.cc`) explains the non-box split: a static inline has no paint layer for perspective alone; relative positioning supplies one, so the computed-style stacking context becomes observable, while both forms still fail the fixed-container and perspective-node `IsBox()` gates.
- `LayoutObject::ComputeIsFixedContainer` (`layout_object.cc`) accepts a box with that transform-related predicate and separately checks computed `transform-style: preserve-3d`, preserving containment through grouping-property flattening.
- `FragmentPaintPropertyTreeBuilder::UpdatePerspective` (`paint_property_tree_builder.cc`) gates on a box with `HasPerspective()`, applies `UsedPerspective()` around the resolved border-box origin, and explicitly prevents the perspective node itself from flattening. Its fixed-position context switches at `CanContainFixedPositionObjects()`, so a fixed descendant stays under the owning ancestor's nested clips; `perspective:none` does not switch it.
- Chromium-pinned Skia revision `62efacd37737505732dbe3d8daa62abd679626a1` performs the projective point mapping in `SkMatrix::mapPointPerspective` by dividing mapped x/y by the perspective z term. That non-affine division is why the projective surface is Chromium-owned rather than reconstructed from a 2D SVG matrix.

Domotion mirrors those separate decisions rather than inspecting matrix symptoms: `src/capture/script/index.ts` carries the computed perspective/origin values and asks Blink for transform-related `IsBox()` applicability with a candidate-only neutral host carrying the same computed `display`, active perspective, and a fixed child; this avoids mutating the source element or letting independent filter/contain ownership answer the question. Replaced/control and SVG owners retain the compatible fallback. `src/render/stacking.ts` combines the fact with `LayoutInline` layer rules for stacking and uses it directly for fixed-CB classification; `transformSubtreeRaster` owns non-representable paint. Thus static inline perspective is inert, while a positioned non-replaced inline can isolate z-index even though its fixed descendant continues to the viewport. `will-change: perspective` creates stacking/fixed ownership on a box without manufacturing an active perspective node or raster; `will-change: perspective-origin` and `scroll-position` are negative controls.
- Pre-transformed bounding rect: the `getBoundingClientRect` returns the screen-space AABB of the rotated element, which is bigger than the unrotated rect. If we wrap our render in a transform around the captured center, the visual size will look right because we're rotating contents BACK from upright. But text inside the rotated box will be re-rendered along the rotated baseline, which is what we want.
- Nested transforms: each element's captured rect already includes ancestor transforms, but if we apply our own transform we'd double-transform. Solution: apply the element's transform RELATIVE to its OWN center, not the ancestor's coordinate space. This is the same as Chrome's behavior.

## Implementation note (shipped)

The per-named-function mapping above (`rotate(30deg)` → `rotate(30)`, `scale(2)` → `scale(2)`, …) turned out to be unnecessary: `getComputedStyle().transform` returns a resolved `matrix()` or `matrix3d()`. Ordinary 2D transforms still flow through `src/render/transforms.ts`. A matrix3d participating in a static 3D context instead uses the measured-plane path above, because taking only its 2D submatrix discards ancestor perspective and depth.

## Follow-ups to file

- Implementation ticket: "SK-???: apply CSS 2D transforms to SVG rendered groups".
- "Untransformed box capture for accuracy" — for higher fidelity, capture the pre-transform box (via temporary `style.transform = none` round-trip in CAPTURE_SCRIPT) so the visual is exact rather than approximate.
- "3D transform downgrade" — defer until a real test surfaces, but document the warning + 2D-projection path.

## Acceptance criteria

`21-transform-2d.html` test diff drops below 1.5% avg. Rotated and scaled boxes render with their internals oriented to match Chrome. Untransformed elements elsewhere on the page don't regress.
