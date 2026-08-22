# Pseudo-element paint

`::before` and `::after` pseudo-elements are first-class paint surfaces in
Domotion. The capture pass walks each host element's `::before` and `::after`
computed styles, measures a generated-content layout probe in Chromium, and
records its box rect (or text segment) in viewport coordinates,
and routes it through the same render machinery that paints regular elements
— with the per-pseudo overrides described below.

## Captured surfaces

Each pseudo is one of four shapes, decided at capture time:

1. **Image pseudo** — `content: url(...)`. Captured as an entry in the host
   element's `pseudoImages[]` array; renders as `<image>` at the inline-block
   content-box.
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

Chromium does not expose a DOM rect for a pseudo layout object. For text
content, capture therefore materializes a non-painting real child, copies the
entire resolved pseudo `CSSStyleDeclaration`, inserts the resolved generated
text, and reads its text and border-box rects. This keeps variables, `calc()`,
intrinsic sizing, logical properties, writing mode, and the complete pseudo
font in Blink's own layout path. Arithmetic reconstruction remains only as a
compatibility fallback for older captured trees.

## Per-surface paint coverage

Per-pseudo CSS properties Domotion honors:

| Property              | Empty-content       | Text-content        | Image          | Notes |
|-----------------------|---------------------|---------------------|----------------|-------|
| `background-color`    | yes                 | yes                 | n/a            | Resolved to sRGB at capture time. |
| `background-image`    | yes (gradients/url) | yes (gradients/url) | n/a            | Multiple comma-separated layers; emit in reverse order so layer 0 paints on top. |
| `background-position` / `-size` | yes      | yes                 | n/a            | Captured alongside a `background-image` and threaded into the layer emit. For a radial gradient the px component of the position slides the gradient core (Stripe's keynote glow uses `-90px 90px` to push the pink radial into the lower-left corner). |
| `opacity` (0 < o < 1) | yes                 | yes                 | yes            | Wraps the pseudo's complete paint in a `<g opacity>` so a translucent glow paints at its true strength (the Stripe glow is `0.45`). `opacity: 0` is dropped entirely — see below. |
| `border-radius`       | yes (uniform)       | yes (uniform)       | n/a            | Single-value shorthand; clamped to `min(r, w/2, h/2)` for capsule shapes. |
| `border` (uniform)    | yes                 | yes                 | n/a            | `<rect stroke=...>` with style: solid / dashed / dotted. |
| `border` (per-side)   | yes (`<line>` per)  | yes (`<line>` per)  | n/a            | Single-side borders paint as a `<line>`; CSS triangles detected + emitted as `<polygon>`. |
| `padding`             | yes                 | yes                 | yes            | Inflates the paint box around the text content. |
| `transform`           | yes                 | yes                 | yes            | See § Transform below. |
| `transform-origin`    | yes                 | yes                 | yes            | Pre-baked into a translate-transform-translate matrix at render time. |
| `z-index` (negative)  | yes                 | no                  | no             | A negative-z `::after` paints BEHIND the host content instead of on top. See § Paint order. |
| CSS filter functions  | yes                 | yes                 | yes            | `blur`, `brightness`, `contrast`, `drop-shadow`, `grayscale`, `hue-rotate`, `invert`, `opacity`, `saturate`, `sepia`, and ordered lists. See § Filter. |
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
- For image content: the generated replaced image, with the origin resolved
  against its captured pseudo box.

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

The pseudo's authoritative computed `filter` is captured when non-`none` for
empty, text, raster-glyph, and image generated content. The renderer retains
the complete string as the CSS `filter` property on an SVG `<g>` around the
pseudo's complete paint. This covers `blur`, `brightness`, `contrast`,
`drop-shadow`, `grayscale`, `hue-rotate`, `invert`, `opacity`, `saturate`,
`sepia`, and ordered function lists. It also deliberately retains identity
values such as `blur(0px)`: Blink still creates an effect/stacking node for a
computed non-`none` filter.

Computed CSSOM lengths are pre-effective-zoom CSS pixels while the captured
pseudo boxes and SVG viewport are physical CSS pixels. Capture therefore
scales only `px` terms in filter lists, transform origins/translations, and
generated-image geometry exactly once by the host's effective zoom. Percentages,
unitless color-function amounts, angles, and transform linear components stay
unchanged. This keeps a zoomed `blur(2px)` at its painted 2.5 px radius under
`zoom: 1.25` without double-scaling DPR.

This is a native vector route, not shorthand-to-`<fe*>` translation. At pinned
Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`,
`FilterEffectBuilder::BuildFilterEffect` feeds each operation's output into the
next operation in list order, sets every CSS shorthand primitive to sRGB,
disables primitive-bounds clipping, and validates premultiplication at the
Skia boundary (`third_party/blink/renderer/core/paint/filter_effect_builder.cc`,
`platform/graphics/filters/paint_filter_builder.cc`). Bare SVG primitives use
different color-interpolation and filter-region defaults, so the retired
`<feGaussianBlur>` plus fixed oversized region was not an equivalent model.
Computed serialization is owned by
`third_party/blink/renderer/core/css/properties/computed_style_utils.cc`.

The nesting is `content → filter → transform → opacity`; ancestor clips and
the pseudo's existing before/after/negative-z paint slot remain outside that
atom. That mirrors Blink's paint-property sequence in
`paint_property_tree_builder.cc`: the filter consumes local content before the
transform moves it, while grouped opacity consumes the filtered result. Moving
pixels (`blur` and `drop-shadow`) therefore use Chromium's real filter output
bounds instead of a hard-coded percentage region.

The enumerated shorthand functions do not cross a raster boundary. A CSS
`url(#filter)` graph is not a shorthand function and remains a separate
reference-graph representation class; HTML `SourceGraphic` convolution uses
the explicit Chromium surface boundary in
[doc 148](148-sourcegraphic-url-filter-surfaces.md). That boundary must not be
generalized to shorthand lists merely because they move or recolor pixels.

## `::first-letter` and `initial-letter` (drop caps)

A styled `::first-letter` is emitted as its own native-SVG text segment,
carrying the pseudo's font-family / size / weight / style / variant, color and
`text-shadow`, plus a `pseudoBox` for its background, border and
border-radius. The host element's body text suppresses the glyphs the pseudo
selected, so the styled segment is the only paint for them. Chrome's selection
rule is mirrored at capture time: skip leading whitespace, take any leading
punctuation, one letter (or a precomposed letter plus its combining marks),
then any trailing punctuation.

`initial-letter: <size> [<sink>]` (CSS Inline 3) makes this more than a font
override — Chromium re-sizes the glyph and takes it out of the normal line
flow. Two of its decisions are not readable from `getComputedStyle` in the
obvious place:

- **Effective size.** `getComputedStyle(el, "::first-letter").fontSize` echoes
  the value the author *specified* — typically a large `em` fallback written
  for engines without `initial-letter` support — not the size Chromium paints.
  What Chromium does report faithfully is the pseudo's computed **content
  box**: its `height` is the cap-height the initial letter was sized to
  (measured across nine variants, exactly `(size − 1) × parent-line-height +
  parent-cap-height`), and its `width` is the glyph's painted **ink** width.
  The effective font-size is therefore derived from that box, against ratios
  read from a 100 px canvas probe of the pseudo's own font: `height /
  capHeightRatio` for a non-floated initial letter, and `height /
  glyphInkHeightRatio` for a floated drop cap (a float box is sized to the
  glyph's own ink, which differs from cap-height for glyphs with descenders or
  round overshoot). Dividing the ink `width` by a canvas *advance* width is
  **not** equivalent — it under-reports the size by the side bearings (~1.8%
  on Georgia, ~7% on Arial).

- **Vertical placement.** For a **non-floated** initial letter (a raised
  and/or sunk cap: `float: none`, `display: inline`), the per-character
  `Range` rect top is the **ascent**-top of the glyph at its effective size,
  so the baseline is `rangeTop + ascent` and the segment anchors at the
  `Range` top directly. Treating that top as the **cap**-top instead paints
  the cap too high by an amount that grows with the cap size (≈4 px at
  `initial-letter: 1`, ≈22 px at `initial-letter: 3`). For a **floated** drop
  cap, Chromium paints the glyph's ink to exactly fill the float's content
  box, so the segment is positioned from that box instead: baseline at the
  content-box bottom, glyph centered horizontally within it.

Both rules were reverse-engineered by comparing Chromium's painted ink (at 8×
device scale) against its reported boxes across nine `initial-letter`
variants — differing size, sink, font, weight and line-height — and they
reproduce the painted cap top to within 0.5 px on every one. Fixture:
`24-deep-initial-letter` in the `html-test` suite.

## What's NOT honored (known gaps)

- **3D transforms** — `rotateX/Y/Z(…)`, `perspective(…)`, `translateZ(…)`.
  The captured matrix is the resolved 2D `matrix(...)` form; 3D content
  collapses to its 2D projection per CSS spec, so `rotateX(…)` looks
  axis-aligned in Domotion's output. Filed as a follow-up.
- **`::first-line`** — partially supported via the multi-segment override
  path (the first segment of a paragraph carries the pseudo's font / weight /
  variant overrides).
- **`::marker`** — list markers paint via the host's marker emit path, not as
  a pseudo. Built-in `list-style-type` numbering systems are resolved by
  `formatListMarker` in `src/render/element-tree-to-svg.ts`: decimal /
  decimal-leading-zero, lower/upper-alpha (latin), lower/upper-roman,
  lower-greek, plus the non-decimal scripts armenian / upper-armenian /
  lower-armenian, georgian, hebrew (additive systems), and arabic-indic /
  cjk-decimal (positional digit substitution) — with the complete per-style
  suffix from `listMarkerSuffix` (`、` for the CJK styles, `. ` otherwise).
  Outside text markers preserve that suffix whitespace and align the full
  marker advance end with the list-item border edge, matching Blink's
  `InlineMarginsForOutside` rather than reconstructing the gap from glyph ink.
  Symbol markers (`disc`, `circle`, `square`, `disclosure-open`, and
  `disclosure-closed`) use Blink's `ListMarker::WidthOfSymbol` /
  `RelativeSymbolMarkerRect` integer formulas with the captured `::marker`
  primary-font ascent, followed by `ToPixelSnappedRect` edge snapping
  (DM-2192). Disclosure triangles follow the physical inline/block direction
  for horizontal, vertical, sideways, and RTL writing directions.
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
  `::before` / `::after`, measures text pseudos with the generated-content
  layout probe, then branches into image / empty-content / text-content /
  raster cases. Produces `pseudoSegments[]` and `pseudoBoxes[]`.
- `src/capture/script/walker/pseudo-inject.ts` — re-anchors each segment's
  `x` / `y` against the host's real text boundaries (capture-time positions
  were relative to the padding box), builds the `pseudoBox` sub-record for
  text-content pseudos.
- `src/capture/types.ts` — `TextSegment.pseudoBox` field definitions.

## Render-side reference

- `src/render/element-tree-to-svg.ts` (the `pseudoBoxes` loop) — empty-
  content and image paint. Owns gradient `<defs>` allocation and preserves the
  pseudo's paint-order slot.
- `src/render/text.ts` — text-content paint. The bg / gradient / border
  emit for `seg.pseudoBox` is duplicated between `renderSingleLineText` and
  `renderMultiSegmentText`.
- `src/render/pseudo-filter.ts` — shared filter / transform / opacity nesting
  for all three generated-content representations.
- `RenderTextOpts.emitPseudoBoxBgLayers` — closure injected by the main
  render loop so the text renderer can emit gradient layers without owning
  the `defsParts` / `clipIdx` state directly.

## `::scroll-marker` / `scroll-marker-group` (DM-1177)

Chrome 135+ lets a scroll container declare `scroll-marker-group: after | before`,
which synthesizes an anonymous marker-group box; each scrollable child whose
`::scroll-marker` has non-`none` content becomes a dot/pill inside it.
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
  for `content: attr(...)` pill labels). Blink explicitly exempts
  `::scroll-marker` from the normal display adjustment that blockifies flex
  children (`style_adjuster.cc`): the inline markers share one anonymous flex
  item. The replica therefore omits the group's flex `gap` and the markers'
  inline-axis padding from flex-item measurement; otherwise its separate DOM
  children would be blockified and make a labeled row wider than Chromium's.
  Block-axis padding and all marker margins remain represented.
- The replica is positioned so the **markers sit flush to the scroller edge**
  (the group's outer padding overlaps the scroller's own padding band, matching
  Chrome's paint): for `after`, the marker row's content-top lands at the
  scroller's bottom; for `before`, content-bottom lands at the scroller's top.
  Marker margins position and separate the individual dots/pills but do not
  expand Chrome's generated group's zero-height content box.
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
