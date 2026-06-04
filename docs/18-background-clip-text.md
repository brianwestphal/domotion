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

## Why `<mask>`, not `<clipPath>` or fill-on-text-group

Two simpler-looking approaches were tried and don't work:

- **Direct `fill="url(#bg)"` on the text `<g>`**: SVG's `userSpaceOnUse` gradient coordinates are re-interpreted in the local coordinate system of the painted element. Our text emits glyphs inside a `<g transform="translate(elX, baselineY) scale(s, -s)">` (where `s ≈ 0.018` for fontSize 36). The gradient's outer-coords `x1=24, x2=336` get treated as `x1=24, x2=336` in glyph-local space — which after the inverse scale spans world coords `~24` to `~30`, compressing the entire gradient to ~6 px wide. The result is a uniform-orange (or whatever the last-stop color is) headline.
- **`<clipPath>` containing the rendered text glyphs**: SVG spec allows `<use href="#g0">` inside `<clipPath>`, but Chromium currently does not honor those references — the clipPath ends up empty and the rect is fully clipped out (verified empirically against Chromium 130). Our text glyphs are emitted via `<use>` for dedup (one `<path id="g0">` def, many `<use>` instances), so a clipPath strategy would force inlining every glyph's path data and lose the dedup win.
- **`<mask>` containing the rendered text glyphs**: works in Chromium with `<use>` references. The mask's luminance becomes the alpha channel for the masked rect. White mask glyphs → fully-visible gradient inside glyph shapes; transparent elsewhere → no gradient outside glyphs.

## What's not yet supported

- **`url(...)` background-image clipped to text** — the current code path emits the bg layer as a pattern referencing the image, which would work as a mask source; not exhaustively tested.
- **`text` clip combined with `bg-color` non-transparent** — bg-color paints under all bg-image layers per CSS spec, and CSS doesn't apply bg-clip to bg-color independently. We currently still paint the bg-color rect normally, which is technically wrong if the author wants the bg-color clipped to text too. In practice the bg-clip:text idiom always pairs with `background-color: transparent` (default), so this hasn't surfaced.
- **`-webkit-text-stroke` over a bg-clipped fill** — author often pairs a stroke with the gradient fill; we don't render the stroke. Out of scope for this iteration.

## Test fixture

`tests/features.ts` → `text-bg-clip-gradient`: an `<h1>` with a 90° linear-gradient background, `background-clip: text`, and `-webkit-text-fill-color: transparent`. Verifies the gradient flows through the glyphs (not as a separate rect over the headline area). Residual diff is normal path-text AA-edge noise.
