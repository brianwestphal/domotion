# 17 — Replaced-element static snapshots (`<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>`)

## Context

These element types host browsing contexts or canvas surfaces that domotion cannot meaningfully reproduce as SVG primitives:

- `<canvas>` is a bitmap surface drawn into by author JS (2D / WebGL / WebGPU). The drawn pixels live on the GPU/CPU canvas, not in any DOM the capture script can walk.
- `<video>` paints decoded media frames (or its `poster` attribute) into a media-element box.
- `<iframe>` hosts a separate browsing context. Same-origin frames are recursively captured as vector DOM. Cross-origin frames do the same when their origin is explicitly allowed and Chromium is launched with the matching access configuration; inaccessible frames use this snapshot boundary.
- `<object>` / `<embed>` host plug-in or document content (PDF viewers, SVG documents, etc.) the same way iframes do.

Pre-DM-457 behavior: CAPTURE_SCRIPT logged a `<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>` warning per element and the renderer painted only the element's normal box (background + border + outline + shadow). The element's content area appeared blank — visible holes on real-world pages with hero videos, embedded chart canvases, or framed widgets.

## Requirement

For each `<canvas>` / `<video>` / `<iframe>` / `<object>` / `<embed>` element captured at t=0, embed a Playwright `page.screenshot` of the element's rendered pixels as an `<image>` inside the SVG, positioned at the element's content-box rect. The source bitmap and destination geometry must be expressed in the same transform space: affine rotation/skew is removed while Chromium samples the local surface and is applied once by the existing SVG transform wrapper; pure scale/translation remains baked; projective paint belongs to the outer `transformSubtreeRaster` surface.

The result is pixel-faithful at t=0 to whatever Chromium painted in that element's content area. Live playback (canvas redraw, video playback, iframe scroll, etc.) remains out of scope — this is a static frame, the same as every other domotion capture.

The pre-existing capture warning is **kept**. These element types are still outside the spirit of the rendering contract (they aren't being reproduced from CSS / DOM); the snapshot exists only to avoid ugly holes in real-world captures, and consumers should know they got a frozen raster, not a faithful re-render.

## Capture isolation

The screenshot must show **only** the element's painted pixels — not whatever else Chromium paints in the same screen rect (overlays, sticky headers, modal backdrops, sibling positioned elements, `::before` / `::after` pseudos on non-ancestors, etc.).

Approach: temporary stylesheet that hides everything except the target element and its descendants:

```css
*, *::before, *::after { visibility: hidden !important; }
[data-domotion-snapshot-target], [data-domotion-snapshot-target] *,
[data-domotion-snapshot-target] *::before, [data-domotion-snapshot-target] *::after,
[data-domotion-snapshot-target]::before, [data-domotion-snapshot-target]::after { visibility: visible !important; }
html, body { background: transparent !important; }
```

- `visibility: hidden` preserves layout, so the target's bounding rect doesn't shift while the snapshot is taken.
- The `*` rule hides `::before` / `::after` pseudos **explicitly** (`*::before, *::after`) — `visibility` is inherited, but a pseudo with its own `visibility: visible` would otherwise re-appear — and the re-show rule explicitly re-enables the target's OWN `::before`/`::after` (and its descendants') so the target's pseudos still paint. This is `SNAPSHOT_HIDE_CSS` in `src/capture/index.ts`.
- The target gets `data-domotion-snapshot-target` set on it (and removed in `finally`), which the rule's specificity overrides the `*` rule.
- `html` and `body` background overrides plus `omitBackground: true` on the screenshot keep the page background out of the alpha channel — partially-transparent canvases composite cleanly onto the SVG behind them.

Ancestors of the target are also hidden by the `*` rule. That is intentional: ancestor backgrounds / borders would otherwise leak through the target's transparent regions. The target's own paint is unaffected because `visibility: visible` on the target overrides the inherited `hidden` from ancestors.

The hide stylesheet is injected once before the rasterize pass and removed in `finally`, even if any individual screenshot throws. The data attribute is moved between targets (cleared, then set on the next one) inside the loop.

## Transform, clip, and device-pixel spaces

DM-2380 removed the old translation-only clamp correction. That path read a
live post-transform `getBoundingClientRect()` AABB, subtracted unscaled CSS
border/padding values, sampled that AABB, and copied its left/top clip delta to
the pre-transform destination. A rotated/skewed AABB is not the local content
box, a scaled border is not its computed CSS width, and the renderer then
applied the element's SVG transform a second time.

The replacement follows the pinned Chromium/Skia ownership order:

- Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
  `layout_replaced.cc::ReplacedContentRect` starts from
  `PhysicalContentBoxRect`; `replaced_painter.cc::ScopedReplacedContentPaintState`
  switches to `ReplacedContentTransform` and then `OverflowClip`.
- At that revision,
  `platform/graphics/paint/geometry_mapper.cc::LocalToAncestorVisualRectInternal`
  maps through `SourceToDestinationProjectionInternal` before intersecting the
  mapped clip tree. DevTools' `inspector_highlight.cc::BuildNodeQuads` exposes
  the same `PhysicalContentBoxRect` through `LocalRectToAbsoluteQuad`, converts
  it to viewport space, and applies Blink's absolute/page zoom rules. Therefore
  `DOM.getBoxModel().content` is the source-owned quad; an AABB reconstructed by
  subtracting computed sides is not.
- Chromium's `page_handler.cc::CaptureScreenshot` keeps the clip in CSS/DIP
  coordinates (`viewport_offset = clip.x/y`) and sizes the output bitmap with
  the device scale. Chromium's DEPS-pinned Skia
  `62efacd37737505732dbe3d8daa62abd679626a1` likewise concatenates the CTM
  before the device clip (`SkCanvas.cpp::internalConcat44` / `clipRect`) and
  keeps image source and destination rectangles explicit in
  `SkCanvas.cpp::drawImageRect`; `SkDevice.cpp::drawEdgeAAImageSet` installs a
  true destination clip before forwarding those rectangles to the device.

`rasterizeReplacedElements()` now reproduces the transform space used by the
capture walk. It temporarily replaces only rotation/skew owners on the target's
ancestor chain with the same no-op containing-block transform. It reads the
unclipped output quad, then removes ancestor clipping overflow, `clip`,
`clip-path`, and mask paint nodes while sampling: Blink applies those nodes
after the transform, and retaining them while the transform is neutralized cuts
a different local edge. The captured SVG tree still owns and applies each clip
once after it reapplies the affine transform. Stored scroll offsets and authored
inline priorities are restored; any layout change is accepted only if the
post-suppression surface remains the same size and differs by a translation.
The pass then samples the isolated surface. If
the local surface is partly off-page before its serialized transform brings it
into view, the target is translated into the screenshot bounds only for
sampling. The helper accepts that sample only when the before/after quads differ
by a translation and have identical extents; it then transfers the single
outward-snapped screenshot margin back to the original output quad. A residual
skew/projective quad or a size change is rejected instead of silently falling
back to an AABB. Every temporary declaration and its priority is restored.

`replacedSnapshot.rasterToOutput` records the capture-local content quad, PNG
pixel dimensions, and CSS-pixels-per-image-pixel on each axis. The renderer
continues to emit the mapped `x/y/width/height`; the record proves that DPR is a
source-resolution concern, not an SVG-geometry multiplier. When an expected PNG
is supplied, source crops derive independent X/Y scales from the PNG's actual
dimensions, so DPR 2 no longer crops a CSS rectangle as though the file were
DPR 1. A projective owner suppresses nested replaced snapshots entirely: the
outer Chromium-composited surface is emitted once and vector siblings remain
outside that ownership boundary.

## Wiring

1. **CAPTURE_SCRIPT**: when `tag` is one of the five replaced types and the element has non-zero area and is not `display: none`, assign `data-domotion-rid` and emit a bootstrap content-box rect. That rect is retained only for an untransformed CDP-unavailable fallback; normal capture replaces it with Blink's authoritative quad-derived mapping. The warning is still emitted on the same code path.

2. **Post-capture pass — `rasterizeReplacedElements()`** in `src/capture/index.ts`. Runs after `rasterizeBitmapGlyphs` inside `captureElementTreeWithWarnings()`. It:
   - Walks the captured tree collecting `(stableId, contentRect)` pairs for every flagged element.
   - Injects the hide stylesheet via `page.addStyleTag`.
   - Opens one CDP session and reads the target's `DOM.getBoxModel` content (or border quad for the sprite-icon route).
   - For each target: sets `data-domotion-snapshot-target`, neutralizes renderer-owned affine transforms, reads the output quad, then suppresses ancestor overflow/clip/mask paint nodes and translates an off-page local source into sampling bounds when necessary. It screenshots the proven CSS clip with `omitBackground: true`, records the PNG-to-CSS mapping, restores authored declarations, priorities, and scroll offsets, and clears the attribute. The SVG tree retains the ancestor clip and therefore applies it once, after the transform, in Blink's order.
   - Targets under `transformSubtreeRaster` are skipped, and source-image crops are used only when no serialized affine transform would make the final screenshot pixels the wrong local source.
   - Removes the hide stylesheet and all `data-domotion-rid` attributes in `finally`.

3. **Renderer**: in `renderElement`, when `el.replacedSnapshot?.dataUri` is set, emit an `<image>` at the content-box rect (mirroring the `<img>` content-box positioning in `src/render/element-tree-to-svg.ts`). The element's normal background / border / outline / shadow paint stays — the image sits on top of the background but inside the borders, exactly like an `<img>`.

4. **Re-rasterization across animation frames**: each frame composites independently — there is no shared-element merge pass (the old `mergeFrames` fast path was removed; see `docs/08`). Every frame's tree carries its own snapshot, so where Chrome painted different pixels in different frames (animated canvas, autoplaying video) each frame shows its own content, and a canvas/video identical between frames simply re-embeds the same data URI per frame.

Ordinary `<img>` elements do not use this snapshot path. When intrinsic
dimensions are available, their paint rectangle follows Blink's concrete
object-fit/object-position calculation exactly; see
[the replaced-geometry oracle](133-replaced-geometry-oracle.md).

## What still doesn't work

- **Live playback** — autoplaying videos, animating canvases, and iframe interactions are frozen at the t=0 frame.
- **Cross-origin iframes** that paint differently between capture and re-render — we capture whatever Chromium painted at the moment of `page.screenshot`. Network races can cause late-arriving content to not appear in the snapshot.
- **`<canvas>` with `image-rendering: pixelated`** — the snapshot is rasterized at the page's `deviceScaleFactor`; if the consumer scales the SVG further, the embedded PNG will resample. Set `image-rendering: pixelated` on the element to keep crisp pixels — domotion preserves the captured `image-rendering` style.

## Test fixtures

Added under `tests/features.ts`:

- `replaced-canvas-shape` — `<canvas>` drawn with a white rect on a dark background. Verifies the bitmap survives.
- `replaced-canvas-transformed-clip` — an asymmetric canvas partly off the left edge under nested rotate + scale/skew and CSS zoom, with a vector sibling outside raster ownership. Detects double transforms and stretched clip deltas in the visual corpus.
- `replaced-video-poster` — `<video poster="…">` not playing. Verifies the poster image is captured.
- `replaced-canvas-overlay` — `<canvas>` with an absolutely-positioned `<div z-index: 10>` overlay. Verifies the overlay does NOT bleed into the canvas snapshot.
- `replaced-canvas-pseudo-overlay` — `<canvas>` covered by a non-ancestor's absolutely-positioned `::after` pseudo. Verifies non-ancestor pseudos are hidden during snapshot.
- `replaced-iframe-same-origin` — same-origin `<iframe>` with simple HTML content. Verifies the iframe's painted pixels appear in the snapshot.
- `tests/replaced-snapshot-transform.e2e.test.ts` — independent Chromium-vs-SVG ink bounds for a partially off-page canvas under nested rotate + scale/skew, CSS zoom, scroll, and DPR 2; a dedicated transform-then-scrolled-overflow-clip discriminator with scroll restoration; DPR-scaled source-crop mapping (including affine `matrix3d`); clipped transformed video and inaccessible iframe pixels; vector-sibling isolation; and the projective single-owner negative. The affine oracle is bounded to three device pixels and would fail on a doubled transform, stretched bitmap mapping, or a clip sampled in pre-transform space.

## Cross-platform notes

The snapshot path uses Playwright's standard `page.screenshot({ clip, omitBackground: true })`. Chromium handles the compositing per-platform (CoreText / fontconfig / DirectWrite for any text inside the snapshot, GPU vs software for canvas surfaces, native video decoders for `<video>`). No platform-specific code is needed in the rasterize pass — the output matches Chromium's paint on the host platform by construction.
