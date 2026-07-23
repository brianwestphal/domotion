# 18 — `background-clip: text` (text-fill via gradient/image)

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

In the text-rendering block, when `textBgClipFill != null` AND the rendered text is transparent (`webkit-text-fill-color: transparent` OR `color` alpha < 0.01):

1. Render the text glyphs as usual via `renderOneText`, but force the glyph fill to white — this is the mask source, not the visible output.
2. Wrap that markup in an SVG `<mask>` def (`maskUnits="userSpaceOnUse"`, sized to the headline element rect).
3. Emit a `<rect>` covering the headline element rect with `fill="url(#bg)"` and `mask="url(#textmask)"`. The mask reveals the gradient through the glyph silhouettes.
4. **Skip** the normal text emission (the masked rect is the visible text).

**Multi-layer text-clip (DM-696):** when more than one background layer is
clipped to text, the renderer emits one masked `<rect fill="url(#bg-N)">` per
text-clipped layer, walking bottom→top, so stacked gradients/images all paint
through the shared glyph mask (CSS first-layer-on-top order preserved) — not just
the first layer.

**Inherited from an ancestor (DM-749 / DM-908):** when an element's text is
transparent but it has NO bg-image of its own, and an ancestor sets
`background-clip: text` + a gradient, the gradient paints through the
descendant's glyphs (Stripe / Resend pattern). Capture walks up to 8 ancestors
and records the nearest such gradient as
`CapturedElement.styles.inheritedTextFillGradient`, plus that ancestor's bbox as
`inheritedTextFillGradientRect` so the gradient resolves against the ancestor's
coordinates (two sibling children then share one continuous ramp). The renderer
uses it only when the element has no text-clip layer of its own.

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

## What's not yet supported

- **`url(...)` background-image clipped to text** — the current code path emits the bg layer as a pattern referencing the image, which would work as a mask source; not exhaustively tested.
- **`text` clip combined with `bg-color` non-transparent** — bg-color paints under all bg-image layers per CSS spec, and CSS doesn't apply bg-clip to bg-color independently. We currently still paint the bg-color rect normally, which is technically wrong if the author wants the bg-color clipped to text too. In practice the bg-clip:text idiom always pairs with `background-color: transparent` (default), so this hasn't surfaced.
- ~~**`-webkit-text-stroke` over a bg-clipped fill**~~ — now supported. The gradient is the element's BACKGROUND (clipped to the text ink); the stroke is the text's foreground paint, which Chrome always draws on top of it — with `-webkit-text-fill-color: transparent` the `paint-order` property has nothing to reorder (it only sequences the text's own fill vs stroke). `paintText`'s mask path renders the glyph mask WITHOUT the stroke (a stroke in a luminance mask was a useless dark ring) and emits a separate transparent-fill stroke pass after the masked gradient rect(s). On Linux the stroke width picks up the synthetic-bold inflation when the face lacks the requested weight (see `docs/42`, "Skia's stroke-frame fake bold"). Visual gate: the `20-deep-text-stroke` html-test fixture's "GRADIENT INK" row; unit gate: `src/render/text-stroke-synthesis.test.ts`.

## Test fixture

`tests/features.ts` → `text-bg-clip-gradient`: an `<h1>` with a 90° linear-gradient background, `background-clip: text`, and `-webkit-text-fill-color: transparent`. Verifies the gradient flows through the glyphs (not as a separate rect over the headline area). Residual diff is normal path-text AA-edge noise.

`tests/features.ts` → `background-clip-text-inherited-from-ancestor`: a `<span>` with the gradient + bg-clip:text wrapping child `<div>`s that hold the text (DM-749 inherited path).

`tests/features.ts` → `background-clip-text-nested-child-wraps`: an H2 (white gradient, bg-clip:text) containing a `<span>` with its OWN gold `... in oklab` gradient, sized so the span wraps to two lines (DM-1053). Verifies the child's own gradient — not the inherited ancestor gradient — fills its glyphs across both line fragments.
