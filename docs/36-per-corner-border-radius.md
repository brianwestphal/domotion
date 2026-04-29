# Per-corner border-radius

CSS lets each corner of a rounded rectangle have its own radius — and each radius can be elliptical (different horizontal vs vertical axis). The shorthand `border-radius: 10px 30px 50px 70px` maps to TL=10, TR=30, BR=50, BL=70 (clockwise from top-left), and `border-radius: 50px / 20px` makes every corner a 50×20 ellipse.

SVG `<rect>` only supports a single `rx` (and `ry`) value, so an asymmetric CSS rect cannot be emitted as a `<rect>` faithfully. Domotion handles this with a two-track strategy:

- **Uniform fast path**: when all four corners share a single circular radius, emit `<rect rx="r">`. Cheaper, less markup, no path-arithmetic.
- **Per-corner path**: when corners differ — by radius, by axis pair, or both — emit a `<path>` whose `d` walks the rect clockwise with one elliptical arc per non-zero corner.

The branching lives in `roundedRectSvg(x, y, w, h, corners, attrs)`. Every captured element rect that participates in the box rendering — background fill, gradient layer clip, border stroke, double-border inner/outer strokes, outer/inset box-shadow rect, overflow-clip path — flows through this helper, so per-corner radii survive end-to-end.

## Capture

`CAPTURE_SCRIPT` resolves the four `border-{top-left,top-right,bottom-right,bottom-left}-radius` longhands to `"H V"` axis-pair strings (px-resolved against the captured rect dimensions). Chrome's longhand returns either `"30px"` (single value: H = V = 30) or `"50% 20%"` (axis pair — already resolved against w/h before reaching the renderer).

## Corner-overlap clamp

CSS spec ([css-backgrounds-3 §5.5](https://www.w3.org/TR/css-backgrounds-3/#corner-overlap)) says: if the two corner radii on any edge would together exceed the edge length, all four radii are scaled down by the same factor `f = min(L_i / S_i)` so the worst-offending edge fits exactly. This is what produces the pill shape for `border-radius: 999px` on a short element — without the clamp, two adjacent 999-px corners would overlap visibly.

`parseCornerRadii` applies this scale-down once for the outer rect. After clamping, the helper checks whether all four corners are equal-and-circular; if so, the renderer takes the `<rect rx>` fast path.

## Inner radii

When the bg-image clip box, the border-stroke rect, or an inset-shadow ring is inside the border-box (inset by some amount on each side), the outer corner needs to shrink to the inner corner. CSS specifies that the inner corner of a rounded box is the outer corner pulled in by the adjacent border-side widths — so `rTL.h` shrinks by the left-border width and `rTL.v` shrinks by the top-border width. `insetCornerRadii(corners, top, right, bottom, left)` does this clamp-to-zero shrinkage and returns a fresh `CornerRadii`.

## Path geometry

`roundedRectPath` walks clockwise from `(x + tl.h, y)`:

```
M (x+tl.h)         y
L (x+w-tr.h)       y
A tr.h tr.v 0 0 1  (x+w)         (y+tr.v)
L (x+w)            (y+h-br.v)
A br.h br.v 0 0 1  (x+w-br.h)    (y+h)
L (x+bl.h)         (y+h)
A bl.h bl.v 0 0 1  (x)           (y+h-bl.v)
L (x)              (y+tl.v)
A tl.h tl.v 0 0 1  (x+tl.h)      y
Z
```

A zero-radius corner collapses to a sharp 90° join; the corresponding `A` command is omitted so the `L`s meet at the right-angled point directly.

## DM-300 — what this fixed

`18-border-radius` was painting every box with TL-only radius (the captured `borderTopLeftRadius` was the only longhand resolved, and the renderer fed it as a single `rx` to `<rect>`). The "30/8 (diag)", "10/30/50/70", "elliptical 50/20", "% per corner", and "asymmetric" fixtures all rendered as uniform-cornered approximations. The diff went from 0.73% avg → 0.20% avg after this change with no regressions across the rest of the html-test or features suites.
