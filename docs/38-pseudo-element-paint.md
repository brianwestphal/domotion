# Pseudo-element paint

`::before` and `::after` pseudo-elements are first-class paint surfaces in
Domotion. The capture pass walks each host element's `::before` and `::after`
computed styles, derives a box rect (or text segment) in viewport coordinates,
and routes it through the same render machinery that paints regular elements
— with the per-pseudo overrides described below.

## Captured surfaces

Each pseudo is one of four shapes, decided at capture time:

1. **Image pseudo** — `content: url(...)`. Captured as a `pseudoImage` entry
   on the host element; renders as `<image>` at the inline-block content-box.
2. **Empty-content pseudo** — `content: ""` with a visible paint surface
   (background, border, gradient). Captured as a `pseudoBoxes[]` entry on the
   host; renders as `<rect>` + optional border lines / triangle polygon /
   gradient layer rects.
3. **Text-content pseudo** — `content: "…"` with literal text. Captured as a
   `TextSegment` injected into the host's `textSegments[]`. When the pseudo
   also has its own paint box (bg / border / gradient), the segment carries a
   `pseudoBox` sub-record so the renderer paints box + glyphs together.
4. **Raster pseudo** — text-content pseudo whose codepoints route through a
   color bitmap font (emoji, `U+2713`, PUA icon-font glyphs). Captured with a
   `rasterRect` for post-capture screenshot replacement.

## Per-surface paint coverage

Per-pseudo CSS properties Domotion honors:

| Property              | Empty-content       | Text-content        | Image          | Notes |
|-----------------------|---------------------|---------------------|----------------|-------|
| `background-color`    | yes                 | yes                 | n/a            | Resolved to sRGB at capture time. |
| `background-image`    | yes (gradients/url) | yes (gradients/url) | n/a            | Multiple comma-separated layers; emit in reverse order so layer 0 paints on top. |
| `background-position` / `-size` | yes      | yes                 | n/a            | Captured alongside a `background-image` and threaded into the layer emit. For a radial gradient the px component of the position slides the gradient core (Stripe's keynote glow uses `-90px 90px` to push the pink radial into the lower-left corner). |
| `opacity` (0 < o < 1) | yes                 | yes                 | n/a            | Wraps the pseudo's box in a `<g opacity>` so a translucent glow paints at its true strength (the Stripe glow is `0.45`). `opacity: 0` is dropped entirely — see below. |
| `border-radius`       | yes (uniform)       | yes (uniform)       | n/a            | Single-value shorthand; clamped to `min(r, w/2, h/2)` for capsule shapes. |
| `border` (uniform)    | yes                 | yes                 | n/a            | `<rect stroke=...>` with style: solid / dashed / dotted. |
| `border` (per-side)   | yes (`<line>` per)  | yes (`<line>` per)  | n/a            | Single-side borders paint as a `<line>`; CSS triangles detected + emitted as `<polygon>`. |
| `padding`             | yes                 | yes                 | yes            | Inflates the paint box around the text content. |
| `transform`           | yes                 | yes                 | no             | See § Transform below. |
| `transform-origin`    | yes                 | yes                 | no             | Pre-baked into a translate-transform-translate matrix at render time. |
| `z-index` (negative)  | yes                 | no                  | no             | A negative-z `::after` paints BEHIND the host content instead of on top. See § Paint order. |
| `filter: blur(<px>)`  | yes                 | no                  | no             | Translated to `<feGaussianBlur stdDeviation=<px>>`. See § Filter. |
| `color`               | n/a                 | yes (overrides host)| n/a            | Pseudo glyphs paint in their own color, not the host's. |
| `font-size` / `family`| n/a                 | yes (overrides host)| n/a            | Same as `color`. |
| `position: absolute`  | yes                 | yes                 | yes (in flow)  | Resolves `left/top/right/bottom` against the host's padding box. |
| `opacity: 0`          | suppresses paint    | suppresses paint    | suppresses paint | Skips the pseudo entirely (Material-ripple hover overlay pattern). |
| Host degenerate xform | suppresses paint    | suppresses paint    | suppresses paint | When the host's `transform: matrix(...)` has determinant 0, the pseudo doesn't paint (Apple "empty cart" badge pattern). |

## Transform

The pseudo's own `transform` (rotate / scale / translate / matrix / skew) is
captured verbatim from `getComputedStyle(host, '::before').transform`. Chrome
always returns the resolved `matrix(a, b, c, d, e, f)` form, which pastes
directly into an SVG `<g transform="…">` (column-major matrix convention
matches between CSS and SVG).

`transform-origin` resolves to absolute px values in the pseudo's box-local
coordinate system (e.g. `"50px 50px"` for a 100×100 box's default `50% 50%`).
Renderers pre-bake the rotation/scale around that origin as

```svg
<g transform="translate(tx ty) <css-transform> translate(-tx -ty)">…</g>
```

where `(tx, ty) = (pb.x + originX, pb.y + originY)` are viewport-absolute. The
pre-baked form works across SVG consumers that don't support the modern
`transform-origin="…"` attribute, and removes a class of compositor-quirk
inconsistencies between renderers.

The wrap covers the pseudo's entire paint set:

- For empty-content `pseudoBoxes`: rect + per-side border `<line>`s +
  triangle `<polygon>` + rounded-rect stroke — all share the wrapping `<g>`.
- For text-content `pseudoBox`: the bg-color rect, gradient layer rects,
  per-side border lines, **and** the glyph emit + text-decoration +
  raster-glyph overlays — all rotate together so a `transform: rotate(-15deg)`
  on a gradient pill keeps its label aligned to the pill, not to the host's
  baseline.

## Paint order

CSS paints a host's `::before` UNDER its main content and its `::after` OVER
it. Domotion follows that order, with two refinements for `::after` empty-
content boxes:

1. **Fade-overlay `::after`** — a gradient `::after` with no own background-
   color or border (the right-edge headline-mask pattern) is deferred until
   AFTER all descendant rendering, so the gradient overlays the child text it's
   meant to fade rather than painting beneath it.
2. **Negative-z-index `::after`** — when the `::after` carries a numeric
   `z-index < 0`, it paints BEHIND the host's content (and its children),
   overriding the fade-overlay deferral. This is the soft-glow pattern: an
   absolutely-positioned `::after` with `z-index: -10; filter: blur(20px)` and
   a translucent gradient, sitting behind a dark pill to bloom a colored halo
   around its edges (Resend's `.rainbow-border` announcement pill). Painting it
   on top — as the fade-overlay path would — fully tints the pill instead of
   leaving the dark interior with a thin gradient border.

The `z-index` is captured only when it resolves to a number (omitted for
`auto`); a non-negative numeric z-index keeps the default `::before`-under /
`::after`-over ordering.

## Filter

The pseudo's own `filter` is captured when non-`none`. A `blur(<px>)` function
translates to an SVG `<feGaussianBlur>` whose `stdDeviation` equals the CSS
blur length directly (CSS Filter Effects §4.4 defines `blur(r)`'s argument as
the Gaussian standard deviation). The blur `<g filter="…">` nests INSIDE the
pseudo's transform `<g>` so the blur is applied in the pseudo's own coordinate
space and then scaled by its transform — matching Chrome, where `filter`
applies before the element's `transform` moves the result. The filter region
is over-sized (`-100% … 700%`) so a large blur on a short box isn't clipped at
the default `-10% … 110%` filter region.

Only `blur()` is translated today; other filter functions (`drop-shadow`,
`brightness`, `contrast`, …) on a pseudo are not yet honored.

## What's NOT honored (known gaps)

- **3D transforms** — `rotateX/Y/Z(…)`, `perspective(…)`, `translateZ(…)`.
  The captured matrix is the resolved 2D `matrix(...)` form; 3D content
  collapses to its 2D projection per CSS spec, so `rotateX(…)` looks
  axis-aligned in Domotion's output. Filed as a follow-up.
- **`::first-letter` / `::first-line`** — `::first-line` is partially
  supported via the multi-segment override path (the first segment of a
  paragraph carries the pseudo's font / weight / variant overrides);
  `::first-letter` drop caps are not (see DM-779 — initial-letter / line-
  wrap-around layout is a feature gap).
- **`::marker`** — list markers paint via the host's marker emit path, not as
  a pseudo. Built-in `list-style-type` numbering systems are resolved by
  `formatListMarker` in `src/render/element-tree-to-svg.ts`: decimal /
  decimal-leading-zero, lower/upper-alpha (latin), lower/upper-roman,
  lower-greek, plus the non-decimal scripts armenian / upper-armenian /
  lower-armenian, georgian, hebrew (additive systems), and arabic-indic /
  cjk-decimal (positional digit substitution) — with the per-style suffix from
  `listMarkerSuffix` (`、` for the CJK styles, `.` otherwise) (DM-1114).
  *Custom* `@counter-style`-resolved markers still fall back to the UA decimal
  style on the render side (DM-770).
- **`::placeholder`** — input placeholder text routes through the form-
  controls renderer (`src/render/form-controls.ts`), not the pseudo path.
- **`::details-content`** (Chrome 131+) — styles the disclosure body of an open
  `<details>` separately from `<summary>`. The pseudo wraps the real content
  children rather than generating its own DOM node, so its paint doesn't
  round-trip through element capture. The capture layer reads the pseudo's
  `border-top` + `background` (`detailsContentBox`, `src/capture/script/walker/
  form-controls.ts`); the renderer synthesizes the **border-top divider** at the
  summary's bottom edge from the details + summary geometry (`renderDetailsContentBox`,
  `src/render/form-controls.ts`, DM-1152). The divider paints after the content
  (it sits in the summary→content gap, so on-top layering is safe). The pseudo
  *background* is intentionally not painted — it would need to render BEHIND the
  content text, and against the typical near-white body it is sub-perceptible.

## Capture-side reference

- `src/capture/script/walker/pseudo-content.ts` — reads computed styles for
  `::before` / `::after`; branches into image / empty-content / text-content
  / raster cases. Produces `pseudoSegments[]` and `pseudoBoxes[]`.
- `src/capture/script/walker/pseudo-inject.ts` — re-anchors each segment's
  `x` / `y` against the host's real text boundaries (capture-time positions
  were relative to the padding box), builds the `pseudoBox` sub-record for
  text-content pseudos.
- `src/capture/types.ts` — `TextSegment.pseudoBox` field definitions.

## Render-side reference

- `src/render/element-tree-to-svg.ts` (the `pseudoBoxes` loop) — empty-
  content paint. Owns the gradient `<defs>` allocation + transform wrap.
- `src/render/text.ts` — text-content paint. The bg / gradient / border
  emit for `seg.pseudoBox` is duplicated between `renderSingleLineText` and
  `renderMultiSegmentText`; the transform wrap covers box + glyphs + deco +
  raster overlay together.
- `RenderTextOpts.emitPseudoBoxBgLayers` — closure injected by the main
  render loop so the text renderer can emit gradient layers without owning
  the `defsParts` / `clipIdx` state directly.

## `::scroll-marker` / `scroll-marker-group` (DM-1177)

Chrome 135+ lets a scroll container declare `scroll-marker-group: after | before`,
which synthesizes an anonymous marker-group box; each scrollable child whose
`::scroll-marker` has non-`none` content becomes a dot/pill flex item inside it.
`::scroll-marker:target-current` styles the marker of the currently-scrolled-to
item (the active one).

These generated boxes have **no DOM node**, so their geometry can't be measured
directly (`getBoxQuads()` is unavailable, `getComputedStyle(el,
'::scroll-marker-group').height` returns `0px`). Rather than reimplement Chrome's
marker-group flex layout, capture builds a hidden **replica**:

- `src/capture/script/index.ts` (`_captureScrollMarkerGroup`) reads the resolved
  `::scroll-marker-group` and per-item `::scroll-marker` computed styles —
  `:target-current` is already folded into the active marker's computed style by
  the engine, so the active dot/pill needs no special query — and builds a real
  (off-document-flow) `<div>` group with one child per marker (textContent set
  for `content: attr(...)` pill labels). Chrome lays out the replica identically
  to the real group, so its measured rects ARE Chrome's geometry.
- The replica is positioned so the **markers sit flush to the scroller edge**
  (the group's outer padding overlaps the scroller's own padding band, matching
  Chrome's paint): for `after`, the marker row's content-top lands at the
  scroller's bottom; for `before`, content-bottom lands at the scroller's top.
  Marker vertical margins are zeroed in the replica (they space the row
  horizontally but do not expand Chrome's generated group box).
- The walked subtree is spliced into the captured tree as a real **sibling** of
  the scroller (before it for `before`, after it for `after`) via the parent's
  children loop — NOT emitted from inside the scroller's render, which would put
  it inside the scroller's overflow clip (Chrome paints the group outside the
  scrollport) and fight the paint-order pass. As a sibling it needs no
  render-side code: every marker is just a styled box (with text for pills).

Also supported (DM-1234): `::scroll-button(left/right/up/down)` paging arrows.
`getComputedStyle` can't disambiguate the parameterized pseudo, so the per-side
`content` + `:disabled` rules are read from the author stylesheet (CSSOM), and
the geometry is resolved by a replica appended to `<body>` (which, like the real
button, takes the viewport as its containing block — `top:50%` is 50% of the
viewport, not the scroller). See
[`69-scroll-button-rendering.md`](69-scroll-button-rendering.md).
