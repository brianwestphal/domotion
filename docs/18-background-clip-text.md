---
id: "requirements/background-clip-text"
title: "18 — background-clip: text (vector-masked background stack)"
kind: "contract"
status: "current"
owners: ["text-fonts","paint-effects","product-tooling"]
platforms: []
tickets: ["DM-1053","DM-2366","DM-460","DM-696","DM-749","DM-908"]
code: ["src/render/element-tree-to-svg.ts","tests/background-clip-text-oracle.e2e.test.ts","tests/features.ts"]
aliases: ["docs/18-background-clip-text.md","doc-18"]
---

# 18 — `background-clip: text` (vector-masked background stack)

## Context

Modern marketing pages (Stripe, Resend, Linear, Vercel, etc.) routinely render hero headlines using the CSS pattern:

```css
h1 {
  background: linear-gradient(90deg, #22d3ee, #a855f7, #f97316);
  -webkit-background-clip: text;
          background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
```

The browser composites the headline by painting the gradient INSIDE the glyph silhouettes — what looks like "rainbow text" to the reader. Without first-class support, domotion's renderer paints the gradient as a normal `<rect fill="url(#bg)">` covering the entire headline element AND emits the glyphs separately with the (transparent → fallback) color, producing a wide gradient bar smeared across the headline area while the text itself disappears.

Discovered via DM-460 inspection of `resend-mobile-fold` ("Email for developers" headline).

## Capture

`window.getComputedStyle(el)` exposes:

- `backgroundImage` — already captured (`linear-gradient(...)` / `url(...)` / multi-layer comma list).
- `backgroundClip` — already captured. Per CSS Backgrounds & Borders L4, `text` is a valid value alongside `border-box` / `padding-box` / `content-box`.
- `webkitTextFillColor` — **new** (`CapturedElement.styles.webkitTextFillColor`). This is the property that actually makes the rendered text transparent in the bg-clip:text idiom — the fallback `color` may still report a normal value, so the renderer must consult `webkit-text-fill-color` (or `WebkitTextFillColor` in DOM-camelCase) directly.

## Render

In `src/render/element-tree-to-svg.ts` the bg-image layer loop checks each layer's clip value:

- For non-text clips (`border-box` / `padding-box` / `content-box`), the gradient/image still emits as a `<rect fill="url(#bg)">` over the appropriate box (unchanged).
- For `text` clips, the renderer:
  1. Emits the `<linearGradient>` / `<radialGradient>` / pattern def for the layer (so we have a `url(#bg)` to reference).
  2. **Skips the rect emission** — the gradient should appear inside the glyph shapes only.
  3. Stashes the def URL in a per-element `textBgClipFill` variable that the text rendering block consults.

In the text-rendering block, whenever a text-clipped stack is present:

1. Render the text glyphs via `renderOneText` with opaque fill/stroke colours — this is the mask source, not visible output. Stroke width is retained because Blink's `PaintPhase::kTextClip` includes author stroke geometry.
2. Wrap that markup in an SVG `<mask>` def with `maskUnits="userSpaceOnUse"` and `mask-type:alpha`, matching Blink's `SkBlendMode::kDstIn` alpha mask.
3. Emit the background entries bottom→top through the mask. The bottom entry can be a non-transparent `background-color`; URL images remain capture-selected SVG patterns with exact tile geometry.
4. Paint foreground text after the background. Transparent fill omits its invisible fill pass while a visible author stroke remains; opaque/semitransparent fill paints normally above the clipped background.

**Multi-layer text-clip (DM-696):** when more than one background layer is
clipped to text, the renderer emits one masked `<rect fill="url(#bg-N)">` per
text-clipped layer, walking bottom→top, so stacked gradients/images all paint
through the shared glyph mask (CSS first-layer-on-top order preserved) — not just
the first layer.

**Inherited from an ancestor (DM-749 / DM-908 / DM-2366):** Blink's text-clip
paint phase traverses descendants. The renderer now records the captured parent
relation and, when an element has no clipped stack of its own, consumes the
nearest ancestor's already-built stack. This covers gradient, URL, color,
multiple layers, and opaque/transparent foregrounds while retaining the
ancestor's exact candidate/sizing/positioning facts. The legacy captured
`inheritedTextFillGradient` projection remains a read-compatibility fallback for
older serialized trees.

**Nested child with its own gradient that WRAPS (DM-1053):** a child element can
have its OWN `background-clip: text` gradient nested inside an ancestor that also
uses bg-clip:text — e.g. Resend's "Integrate `this morning`" hero, where the H2
is a white gradient and the inner `<span>` "this morning" is a gold
`linear-gradient(... in oklab, …)`. The child's own gradient must win over the
inherited ancestor one for its run of glyphs. This worked for single-line
children, but when the child's text **wraps to multiple lines** it renders via
the inline-fragment path (`el.inlineFragments.length > 1`), and that path
deliberately skips text-clip layers (it can't per-fragment-mask glyphs). The
result was the child building NO self def and falling through to the inherited
ancestor gradient — painting "this morning" flat white. Fix: for a multi-line
(inline-fragment) element, the renderer still builds its own `text`-clip layer
def(s) against its bbox and stashes them in `textBgClipFills`, so the text-fill
decision prefers the self gradient and routes through the glyph-mask path (which
spans all fragments). Only the `text`-clipped layers are built in this branch;
box-painted layers stay owned by the per-fragment renderer.

## Why `<mask>`, not `<clipPath>` or fill-on-text-group

Two simpler-looking approaches were tried and don't work:

- **Direct `fill="url(#bg)"` on the text `<g>`**: SVG's `userSpaceOnUse` gradient coordinates are re-interpreted in the local coordinate system of the painted element. Our text emits glyphs inside a `<g transform="translate(elX, baselineY) scale(s, -s)">` (where `s ≈ 0.018` for fontSize 36). The gradient's outer-coords `x1=24, x2=336` get treated as `x1=24, x2=336` in glyph-local space — which after the inverse scale spans world coords `~24` to `~30`, compressing the entire gradient to ~6 px wide. The result is a uniform-orange (or whatever the last-stop color is) headline.
- **`<clipPath>` containing the rendered text glyphs**: SVG spec allows `<use href="#g0">` inside `<clipPath>`, but Chromium currently does not honor those references — the clipPath ends up empty and the rect is fully clipped out (verified empirically against Chromium 130). Our text glyphs are emitted via `<use>` for dedup (one `<path id="g0">` def, many `<use>` instances), so a clipPath strategy would force inlining every glyph's path data and lose the dedup win.
- **`<mask>` containing the rendered text glyphs**: works in Chromium with `<use>` references. The mask's luminance becomes the alpha channel for the masked rect. White mask glyphs → fully-visible gradient inside glyph shapes; transparent elsewhere → no gradient outside glyphs.

## URL, color, stroke, and fragment closure (DM-2366)

The earlier URL/color gaps are closed. Blink associates `background-color`
with the bottom FillLayer, paints it before the bottom image, and applies that
layer's clip to both. Domotion mirrors this by stashing a synthetic bottom color
entry only when the bottom effective clip is `text`, suppressing the ordinary
box color rect, then masking color + URL/gradient layers together. URL patterns
use live selected-candidate/natural-sizing facts and the exact background
size/position/repeat/origin/attachment lowering.

Wrapped `slice` inlines use the capture-owned stitched imaginary positioning
box (including RTL/vertical axes); `clone` restarts against each physical
fragment. The mask uses alpha and keeps text-stroke geometry, matching pinned
Blink `TextPainter::TextPaintingStyle`, while the visible foreground stroke
still paints after the background. See doc 181 for source anchors and the
strict DPR1/2 browser oracle.

## Test fixture

`tests/features.ts` → `text-bg-clip-gradient`: an `<h1>` with a 90° linear-gradient background, `background-clip: text`, and `-webkit-text-fill-color: transparent`. Verifies the gradient flows through the glyphs (not as a separate rect over the headline area). Residual diff is normal path-text AA-edge noise.

`tests/features.ts` → `background-clip-text-inherited-from-ancestor`: a `<span>` with the gradient + bg-clip:text wrapping child `<div>`s that hold the text (DM-749 inherited path).

`tests/features.ts` → `background-clip-text-nested-child-wraps`: an H2 (white gradient, bg-clip:text) containing a `<span>` with its OWN gold `... in oklab` gradient, sized so the span wraps to two lines (DM-1053). Verifies the child's own gradient — not the inherited ancestor gradient — fills its glyphs across both line fragments.

`tests/features.ts` → `background-clip-text-url-color-stack` and
`background-clip-text-url-inherited-stroke`: source-selected URL tile,
bottom-layer color, multiple layer order, descendant mask ownership, and
foreground fill/stroke controls. The independent live gate is
`tests/background-clip-text-oracle.e2e.test.ts`.
