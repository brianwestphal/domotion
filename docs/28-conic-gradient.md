# 28 — Conic-gradient backgrounds

## Context

CSS `conic-gradient(...)` and `repeating-conic-gradient(...)` paint color stops around an angular axis (a "pie chart" sweep) instead of along a line (linear) or radius (radial). Common authoring patterns:

- Hard-stop checkerboard tiles — `repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px` — used as alpha-checkerboards behind semi-transparent swatches.
- Pie / donut progress meters and ring loaders.
- Brand artwork (rainbow disks, color wheels, sweep-shaded buttons).

SVG has **no native conic-gradient primitive**. Today the renderer detects a conic layer in `src/dom-to-svg.ts` (`/conic-gradient/i.test(cs.backgroundImage)`), emits a `warn(sel, 'conic-gradient', 'SVG has no conic gradient; layer falls back to nothing')` (line 1631), and drops the layer entirely. Visible fallout: `19-deep-color-mix` shows the currentColor + transparent tinting row against the SVG's white root instead of the intended checkerboard, accounting for the residual ~1 % diff after DM-519.

## Decision (per DM-547)

**Implementation path: pattern-raster fallback.** Render each conic layer into a PNG via `sharp` (or canvas-equivalent) at the laid-out tile size, embed as `<pattern><image href="data:image/png;base64,…"/></pattern>`. Cheap, deterministic, works in every static-image viewer (Preview, QuickLook, librsvg, GitHub markdown previews). Loses crispness when the SVG is viewed at >1× zoom; the design accepts that tradeoff.

Rejected alternatives:

- **Many-stop linearGradient approximation** — crisp at any scale but ~36–72 wedge slices per layer (200+ SVG nodes), and the hard-stop checkerboard case stair-steps unless the slice count is impractically high.
- **`<foreignObject>` HTML fallback** — works in browsers, breaks in librsvg / Preview / QuickLook. Domotion's portability contract rules this out.

## Scope

**Full CSS conic syntax in v1** (per user direction). Specifically:

- `conic-gradient(...)` and `repeating-conic-gradient(...)`.
- `from <angle>` clause (defaults to `from 0deg`, which is the top per CSS spec).
- `at <position>` clause (single keyword, two-token keyword/length pairs, percent positions). Same position grammar already supported in `parseRadialGradient`.
- Color stops with all forms supported by linear/radial: `<color>`, `<color> <pct>`, `<color> <pct> <pct>` (range), `<color> <angle>`, hard stops (two stops at the same offset), `currentColor`, full `color()` / `color-mix()` / `oklch()` etc. (resolved through Chromium's serialised computed value, identical to the linear/radial path).
- Multi-layer composition — conic-gradient as one of several `background-image` layers, alongside linear, radial, and `url(...)` images. Already wired: the layer-iterating loop at `src/dom-to-svg.ts:4477` calls `buildBackgroundLayerDef` per layer; conic just adds a branch.

**Out of scope (deferred):**

- Conic animation via `@property --angle` + transitions. Domotion does not support CSS property animations across frames in general, and conic is no exception.
- Per-frame conic re-rasterization in animated scenes. The renderer composes static frames; if two frames need different conic content, each frame's layer rasterizes independently — but no transition interpolation between conic instances.

## Architecture

### Pre-pass: rasterize conic layers

A new pre-pass — `rasterizeConicGradients` — runs alongside `embedRemoteImages` (DM-512) and `resizeEmbeddedImages` (DM-539) in the capture pipeline. It walks the captured tree, identifies each `conic-gradient(...)` / `repeating-conic-gradient(...)` background layer, rasterizes it to PNG via `sharp`, and stashes the bytes in a new `_conicTileCache` keyed by `(layerText, tileWidth, tileHeight, hiDPIFactor)`.

The pre-pass mirrors `resize-embedded-images.ts`'s structure: walk → collect (layer, consumer rect) tuples → render each unique tuple once → cache result. Two consumers of the same conic layer at the same tile size dedupe to one PNG.

### Render-rect inference

For a `background-size: <w> <h>` (explicit) or `0/24px 24px` (shorthand) layer, the tile is `<w> × <h>` CSS px. For `background-size: auto / cover / contain`, the tile is the element rect (with cover/contain math identical to the existing image-pattern path).

The HiDPI factor follows the embed pipeline: **`embedRemoteImagesHiDPIFactor` (default 2.0)** also drives the conic raster pass. Per user direction: "same as for other images." A tile resolved at `24×24` CSS px renders at `48×48` device px, sharp-resamples down to `24×24` for embedding via the same `<image width=24 height=24>` `<pattern>` path. (Why render-then-shrink? Sharp's antialiased rasterization at 2× and bilinear downsample produces a softer-but-faithful tile; rendering at 1× directly produces aliased hard-stop edges that don't match Chromium's painted output.)

A future option `domotionConicHiDPIFactor` may decouple this from the image-resize knob, but v1 reuses it for symmetry.

### Renderer dispatch

In `src/dom-to-svg.ts:6590 buildBackgroundLayerDef`, add a third branch alongside linear and radial:

```ts
const conic = /^(?:repeating-)?conic-gradient\((.+)\)$/i.exec(layer);
if (conic != null) {
  return { def: buildConicGradientDef(id, layer, w, h, sizeCss) };
}
```

`buildConicGradientDef` looks up the cached PNG bytes for `(layer, tileW, tileH)` and emits:

```svg
<pattern id="bg7" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
  <image href="data:image/png;base64,…" width="24" height="24" />
</pattern>
```

The clip-box rect that consumes this pattern is unchanged — the existing `<rect ... fill="url(#bg7)"/>` emit at line 4513 handles it, identical to a `url(...)` image layer. Background-position offset is applied to the `<pattern>`'s `x`/`y` attrs so multi-layer registration is preserved.

### Conic raster algorithm

Conic-gradient interpolation is angular: at each pixel `(x, y)`, compute `θ = atan2(y - cy, x - cx) - fromAngle` (normalized to `[0, 1)`), look up the color via the stop list (same offset-blend math as linear/radial), and write the resulting RGBA. Implementation lives in a new `src/conic-raster.ts`:

```ts
export interface ConicGradient {
  kind: "conic";
  /** `from <angle>` clause, in CSS degrees. 0 = top, clockwise positive. */
  fromAngleDeg: number;
  /** `at <position>` clause; defaults to {x:50%, y:50%}. Reuses RadialGradient's PosValue. */
  position: { x: PosValue; y: PosValue };
  stops: ConicStop[];
  /** True for `repeating-conic-gradient(...)`. */
  repeating?: boolean;
}

export function parseConicGradient(text: string | null | undefined): ConicGradient | null;
export function rasterizeConic(
  gradient: ConicGradient,
  tileW: number, tileH: number,
  hiDPIFactor: number,
): Promise<Buffer>; // PNG bytes
```

Stops use `<angle>` (e.g. `red 0deg, blue 90deg`) or `<percentage>` (e.g. `red 0%, blue 25%`); both normalize to `[0, 1)` along the sweep. The `0deg/0%` reference point is `from <angle>` (top by default). Hard stops emit two stops at the same offset.

The rasterizer renders into a raw RGBA buffer at `(tileW × hiDPIFactor) × (tileH × hiDPIFactor)`, then asks `sharp.resize(tileW, tileH, { fit: 'fill', kernel: 'lanczos3' })` to downsample. Output is PNG (per the embed pipeline's "every embed is PNG" rule from DM-526).

### Capture-side parser hook

`parseGradient` in `src/gradients.ts` already detects all three gradient kinds and dispatches; add a third arm:

```ts
export type AnyGradient = LinearGradient | RadialGradient | ConicGradient;
export function parseGradient(text: string | undefined | null): AnyGradient | null {
  return parseLinearGradient(text)
      ?? parseRadialGradient(text)
      ?? parseConicGradient(text);
}
```

Existing callers (`parseGradient` consumers in form-controls + dom-to-svg) become tri-state but otherwise unchanged. The form-controls path can keep falling back to "first color stop" for conic if any consumer doesn't want to invoke the raster pipeline (e.g., a slider thumb at 16×16 — wasteful to rasterize), but background-image conic on a normal element flows through the new path.

## Edge cases

- **Hard-stop checkerboards** (`repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px`): the canonical use case from `19-deep-color-mix`. Tile size is `24×24`, hard stops produce four right-angle quadrants. Lanczos downsample of the `48×48` render preserves the right-angle edges with subpixel anti-aliasing matching Chromium.
- **`from` angle outside `[0, 360)`**: normalize via `mod 360`, negative angles add 360 — same as linear-gradient angle handling.
- **`at <position>`** with px / %: reuse `parsePosition` from `gradients.ts` (already covers radial). Center defaults to `(50%, 50%)`.
- **Repeating conic** with a stop list shorter than `360deg`: spec says clone the list across the full sweep. The rasterizer mods the angle by the period (last stop's angle - first stop's angle) before stop-blending.
- **`currentColor`**: resolved at capture time via the host's computed `color`, identical to linear/radial — already done by Chromium's `getComputedStyle` serializer.
- **Multi-layer with conic + linear + url()**: each layer rasterizes / emits independently in the existing layer loop. No special composition: SVG's own painter's algorithm stacks the `<rect fill="url(#bgN)"/>` layers in source order.
- **`background-attachment: fixed` on a conic layer**: rare but valid. Tile sizing basis is the viewport, identical to the existing fixed-image path. The rasterizer doesn't need to know — `buildBackgroundLayerDef` already passes the viewport-anchored `(elX, elY, w, h)` for fixed layers.
- **`background-size: cover / contain` on a conic**: extremely uncommon (conic + cover usually means "fill the element"), but supported by sizing the rasterized tile to the element rect, just like `cover` on a `url()` image.
- **Animated SVGs (`generateAnimatedSvg`)**: the conic raster is per-frame deterministic. If two frames have different conic stops, they produce two different `<pattern>` defs and the cross-fade swap pipeline handles them like any other per-frame def.
- **Unrecognised stop syntax**: `parseConicGradient` returns null on parse failure; `buildBackgroundLayerDef` returns `{ def: "" }`; the layer loop skips it; the warning at `src/dom-to-svg.ts:1631` is downgraded from "always emit" to "emit only if parse fails".

## Performance

- A 24×24 hard-stop tile rasterizes in ~1 ms with sharp at 2× HiDPI. A 200×200 multi-stop conic in ~5 ms. The whole `19-deep-color-mix` page has one conic layer; `_conicTileCache` dedupe keeps the cost flat as the cache hits on subsequent consumers of the same `(layerText, tileSize)` tuple.
- PNG output for a 48×48 hard-stop tile is ~150 bytes after PNG palette quantization. Multi-color smooth-gradient tiles run ~1–4 KB per consumer.
- The pre-pass adds a `Promise.all` over unique tuples; runs in the same process as the existing image-resize pre-pass and shares the worker-pool harness.

## Acceptance criteria

- `19-deep-color-mix` currentColor + transparent tinting row paints the intended grey/white checkerboard. Diff for that fixture drops from ~1 % avg to <0.5 % avg.
- A standalone fixture demonstrating `conic-gradient(red, yellow, green, blue, red)` at `200×200` renders a smooth color-wheel. New: `tests/features/<NN>-conic-gradient.html`.
- A standalone fixture demonstrating `repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px` renders a 24×24 alpha-checkerboard tiled across a `300×300` div.
- A multi-layer fixture (`background: conic-gradient(...), linear-gradient(...), url(bg.png)`) renders with all three layers in the right stacking order.
- Captured SVG contains no `conic-gradient` warning when the layer parses successfully. The warning still fires when the parse fails (so authors notice broken syntax).
- All previously passing html-test, features, and showcase tests stay passing — the conic branch is additive and doesn't touch linear/radial paths.

## Implementation slices

This doc fans out into the following sub-tickets (see DM-547 follow-ups):

1. **Parser** (`parseConicGradient` in `src/gradients.ts` + tests).
2. **Rasterizer + cache** (`src/conic-raster.ts` + `_conicTileCache` + `rasterizeConicGradients` pre-pass mirroring `resize-embedded-images.ts`).
3. **Renderer wiring** (`buildConicGradientDef` branch in `src/dom-to-svg.ts:6590`, warning-emit downgrade).
4. **Fixtures + acceptance** (`tests/features/<NN>-conic-gradient.html`, `19-deep-color-mix` retest, FEATURES.md row).

## Status

- Requirements doc landed (this file). No implementation yet — see follow-up sub-tickets.
