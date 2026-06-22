# `::scroll-button()` paging-arrow rendering

**Status: supported (DM-1234).** Domotion captures and renders the CSS
`::scroll-button(<direction>)` pseudo-element paging arrows that a scroll
container generates (Chrome 135+). This doc records what Chrome paints, the one
non-obvious behavior that makes them tricky (their containing block is the
viewport), and how the capture reproduces them. It is the companion to the
scroll-marker work in [`38-pseudo-element-paint.md`](38-pseudo-element-paint.md).

## What `::scroll-button()` is

A scroll container can generate paging-arrow buttons via
`::scroll-button(<direction>)` (`left | right | up | down | inline-start |
inline-end | block-start | block-end`), e.g. a carousel declares
`::scroll-button(left)` / `::scroll-button(right)` with `content: "‹"` / `"›"`
and styles them into round buttons. Each button is `:disabled` when the scroller
can't page further in its direction (the left button is disabled at
`scrollLeft: 0`). Reference fixture: the `carousel-2` block in
`external/html-test/niche/scroll-markers.html`.

## What Chrome paints (probed against Chromium 147)

- Chrome paints the **full authored button box** — background, `border-radius`,
  `width`/`height`, the centered `content` glyph in the button `color`. (The
  reference fixture's background is `rgba(255,255,255,0.9)`, so on the white page
  margin the circle is invisible *white-on-white* and only the dark glyph shows —
  forcing the background to a vivid color makes the 36×36 box plainly visible.)
- The disabled button is painted faint per its `:disabled` rule (`opacity: 0.3`).

### The non-obvious part: containing block is the viewport

The author writes `position: absolute; left: 8px; top: 50%` expecting the button
to sit inside the `position: relative` scroller. **Chrome instead lays the
generated button out against the initial containing block (the viewport)**, not
the scroller — exactly like the marker-group, these generated boxes are not
normal descendants of the originating element. Verified by probe-and-match across
two viewport heights: the button center tracked **50% of the viewport height**
(500px at a 1000px viewport, 650px at 1300px) while the scroller stayed put, and
`left`/`right` resolved to insets from the **viewport** edges. This is why a naive
prototype that placed the arrows at the scroller's `left:8px` made the diff worse.

## How capture reproduces them

`_captureScrollButtons()` in `src/capture/script/index.ts` mirrors the
`_captureScrollMarkerGroup` replica-and-measure pattern:

1. **Gate** cheaply: skip unless `getComputedStyle(el, '::scroll-button(left|
   right)').content` is non-`none` (so the per-element cost is one extra
   computed-style read; the CSSOM scan only runs for real scroll-button hosts).
2. **Read the per-side rules from the author stylesheet (CSSOM).**
   `getComputedStyle(el, '::scroll-button(left)')` cannot disambiguate the
   parameterized pseudo — it returns one *merged* style (shared box props, but
   the cascade-last `content` and *both* insets). So `_scrollButtonAuthorRules`
   walks `document.styleSheets`, matches each `::scroll-button(<dir>)` rule whose
   base selector `el.matches(...)`, and collects per-direction declarations plus
   the merged `:disabled` declarations (folding the universal `*` direction in as
   a base).
3. **Resolve geometry by replica.** For each direction, build a `<div>` with the
   author declarations (`content` becomes the centered text), append it to
   `<body>`, and `capture()` it. An absolutely-positioned body child also takes
   the **ICB as its containing block**, so `top:50%` / `left` / `right` /
   `transform` land exactly where Chrome paints the real button — the measured
   rect *is* Chrome's geometry. No manual viewport math.
4. **Enabled/disabled state** comes from the captured scroll offset vs the scroll
   range (`scrollLeft <= 0` ⇒ left/inline-start disabled, `>= maxScroll` ⇒ right/
   inline-end disabled; the vertical pair uses `scrollTop`); when disabled, the
   `:disabled` declarations (e.g. `opacity: 0.3`) are applied to the replica.
5. **Splice as siblings.** The captured button nodes are emitted as siblings of
   the scroller, *after* it (and after the marker group), so they paint outside
   the scroller's overflow clip and above its content (the fixture's `z-index:1`)
   — the same reason the marker group is a sibling, not a child.

Because the buttons are positioned against the viewport, their location relative
to the scroller depends on the capture viewport height — that is Chrome's actual
behavior, and the replica inherits it automatically (same live viewport).

## Validation

On `niche/scroll-markers.html` (`carousel-2`, captured at the suite's 1024×1760
viewport) the rendered arrows match Chrome's paint: correct per-side glyphs
(`‹`/`›`), the faint disabled left button, and viewport-centered positions. The
button-column residual is ~0.27% (glyph-edge anti-aliasing), down from the
buttons being entirely absent. The change is gated, so no other fixture's output
is affected.
