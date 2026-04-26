# Domotion: CSS 2D transforms

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

In `src/dom-to-svg.ts` `renderElement`, around the existing `<g>` group wrapper that hosts opacity / filter / blend-mode:

1. Parse `el.styles.transform`. If `none`, skip.
2. Resolve `transform-origin` to absolute viewport coords (origin's `(ox, oy)` = `el.x + parsed-x`, `el.y + parsed-y`).
3. Wrap the element's group in `<g transform="translate(ox, oy) <css-transform> translate(-ox, -oy)">`. CSS `rotate(30deg)` → SVG `rotate(30)`. CSS `scale(2)` → SVG `scale(2)`. CSS `translate(10px, 5px)` → SVG `translate(10, 5)`. CSS `matrix(a,b,c,d,e,f)` → SVG `matrix(a b c d e f)` (space-separated). CSS `skew(Xdeg, Ydeg)` → SVG `skewX(X) skewY(Y)`.
4. Multiple comma-separated transform functions in CSS apply left-to-right; SVG's `transform` attribute also applies left-to-right when functions are space-separated. Keep the order verbatim.

## Edge cases

- 3D transforms (`rotate3d`, `translate3d`, `perspective`, `matrix3d`) — SVG 1.1 doesn't support them. Drop the z component, treat as 2D, and warn.
- `transform-style: preserve-3d` — out of scope for this pass.
- Pre-transformed bounding rect: the `getBoundingClientRect` returns the screen-space AABB of the rotated element, which is bigger than the unrotated rect. If we wrap our render in a transform around the captured center, the visual size will look right because we're rotating contents BACK from upright. But text inside the rotated box will be re-rendered along the rotated baseline, which is what we want.
- Nested transforms: each element's captured rect already includes ancestor transforms, but if we apply our own transform we'd double-transform. Solution: apply the element's transform RELATIVE to its OWN center, not the ancestor's coordinate space. This is the same as Chrome's behavior.

## Follow-ups to file

- Implementation ticket: "SK-???: apply CSS 2D transforms to SVG rendered groups".
- "Untransformed box capture for accuracy" — for higher fidelity, capture the pre-transform box (via temporary `style.transform = none` round-trip in CAPTURE_SCRIPT) so the visual is exact rather than approximate.
- "3D transform downgrade" — defer until a real test surfaces, but document the warning + 2D-projection path.

## Acceptance criteria

`21-transform-2d.html` test diff drops below 1.5% avg. Rotated and scaled boxes render with their internals oriented to match Chrome. Untransformed elements elsewhere on the page don't regress.
