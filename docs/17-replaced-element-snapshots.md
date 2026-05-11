# 17 — Replaced-element static snapshots (`<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>`)

## Context

These element types host browsing contexts or canvas surfaces that domotion cannot meaningfully reproduce as SVG primitives:

- `<canvas>` is a bitmap surface drawn into by author JS (2D / WebGL / WebGPU). The drawn pixels live on the GPU/CPU canvas, not in any DOM the capture script can walk.
- `<video>` paints decoded media frames (or its `poster` attribute) into a media-element box.
- `<iframe>` hosts a separate browsing context. Same-origin iframes are walkable in principle, but cross-origin iframes are not — and the cost of re-rendering iframe DOMs through the same pipeline isn't justified by the current use case.
- `<object>` / `<embed>` host plug-in or document content (PDF viewers, SVG documents, etc.) the same way iframes do.

Pre-DM-457 behavior: CAPTURE_SCRIPT logged a `<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>` warning per element and the renderer painted only the element's normal box (background + border + outline + shadow). The element's content area appeared blank — visible holes on real-world pages with hero videos, embedded chart canvases, or framed widgets.

## Requirement

For each `<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>` element captured at t=0, embed a Playwright `page.screenshot` of the element's rendered pixels as an `<image>` inside the SVG, positioned at the element's content-box rect.

The result is pixel-faithful at t=0 to whatever Chromium painted in that element's content area. Live playback (canvas redraw, video playback, iframe scroll, etc.) remains out of scope — this is a static frame, the same as every other domotion capture.

The pre-existing capture warning is **kept**. These element types are still outside the spirit of the rendering contract (they aren't being reproduced from CSS / DOM); the snapshot exists only to avoid ugly holes in real-world captures, and consumers should know they got a frozen raster, not a faithful re-render.

## Capture isolation

The screenshot must show **only** the element's painted pixels — not whatever else Chromium paints in the same screen rect (overlays, sticky headers, modal backdrops, sibling positioned elements, `::before` / `::after` pseudos on non-ancestors, etc.).

Approach: temporary stylesheet that hides everything except the target element and its descendants:

```css
* { visibility: hidden !important; }
[data-domotion-snapshot-target] ,
[data-domotion-snapshot-target] * { visibility: visible !important; }
html, body { background: transparent !important; }
```

- `visibility: hidden` preserves layout, so the target's bounding rect doesn't shift while the snapshot is taken.
- `visibility: hidden` is inherited by `::before` / `::after` pseudos, so non-ancestor pseudos that paint on top of the target's screen rect are hidden for free.
- The target gets `data-domotion-snapshot-target` set on it (and removed in `finally`), which the rule's specificity overrides the `*` rule.
- `html` and `body` background overrides plus `omitBackground: true` on the screenshot keep the page background out of the alpha channel — partially-transparent canvases composite cleanly onto the SVG behind them.

Ancestors of the target are also hidden by the `*` rule. That is intentional: ancestor backgrounds / borders would otherwise leak through the target's transparent regions. The target's own paint is unaffected because `visibility: visible` on the target overrides the inherited `hidden` from ancestors.

The hide stylesheet is injected once before the rasterize pass and removed in `finally`, even if any individual screenshot throws. The data attribute is moved between targets (cleared, then set on the next one) inside the loop.

## Wiring

1. **CAPTURE_SCRIPT**: when `tag` is one of the five replaced types and the element has non-zero area and is not `display: none`, emit a `rasterizeAsImage: true` flag plus the element's content-box rect (border-box minus border + padding, viewport-relative). The warning is still emitted on the same code path.

2. **Post-capture pass — `rasterizeReplacedElements()`** in `src/dom-to-svg.ts`. Runs after `rasterizeBitmapGlyphs` inside `captureElementTreeWithWarnings()`. It:
   - Walks the captured tree collecting `(stableId, contentRect)` pairs for every flagged element.
   - Injects the hide stylesheet via `page.addStyleTag`.
   - For each target: sets `data-domotion-snapshot-target` on the matching element handle (located by a stable `data-domotion-rid` attribute set on the element during the same pass), screenshots its content-box clip with `omitBackground: true`, attaches the data URI back to the captured tree node, and clears the attribute.
   - Removes the hide stylesheet and all `data-domotion-rid` attributes in `finally`.

3. **Renderer**: in `renderElement`, when `el.replacedSnapshot?.dataUri` is set, emit an `<image>` at the content-box rect (mirroring the `<img>` content-box positioning at `dom-to-svg.ts:3787`). The element's normal background / border / outline / shadow paint stays — the image sits on top of the background but inside the borders, exactly like an `<img>`.

4. **Re-rasterization across animation frames**: `frame-merge.ts` dedupes shared static elements by identity. A canvas/video that is identical between frames (same drawn content) will reuse the snapshot from the first frame after the merge pass. Where Chrome painted different pixels in different frames (animated canvas, autoplaying video), each frame's tree carries its own snapshot.

## What still doesn't work

- **Live playback** — autoplaying videos, animating canvases, and iframe interactions are frozen at the t=0 frame.
- **Cross-origin iframes** that paint differently between capture and re-render — we capture whatever Chromium painted at the moment of `page.screenshot`. Network races can cause late-arriving content to not appear in the snapshot.
- **`<canvas>` with `image-rendering: pixelated`** — the snapshot is rasterized at the page's `deviceScaleFactor`; if the consumer scales the SVG further, the embedded PNG will resample. Set `image-rendering: pixelated` on the element to keep crisp pixels — domotion preserves the captured `image-rendering` style.

## Test fixtures

Added under `tests/features.ts`:

- `replaced-canvas-shape` — `<canvas>` drawn with a white rect on a dark background. Verifies the bitmap survives.
- `replaced-video-poster` — `<video poster="…">` not playing. Verifies the poster image is captured.
- `replaced-canvas-overlay` — `<canvas>` with an absolutely-positioned `<div z-index: 10>` overlay. Verifies the overlay does NOT bleed into the canvas snapshot.
- `replaced-canvas-pseudo-overlay` — `<canvas>` covered by a non-ancestor's absolutely-positioned `::after` pseudo. Verifies non-ancestor pseudos are hidden during snapshot.
- `replaced-iframe-same-origin` — same-origin `<iframe>` with simple HTML content. Verifies the iframe's painted pixels appear in the snapshot.

## Cross-platform notes

The snapshot path uses Playwright's standard `page.screenshot({ clip, omitBackground: true })`. Chromium handles the compositing per-platform (CoreText / fontconfig / DirectWrite for any text inside the snapshot, GPU vs software for canvas surfaces, native video decoders for `<video>`). No platform-specific code is needed in the rasterize pass — the output matches Chromium's paint on the host platform by construction.
