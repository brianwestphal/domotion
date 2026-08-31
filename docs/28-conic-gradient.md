---
id: "requirements/conic-gradient"
title: "28 — Conic-gradient backgrounds"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: []
tickets: ["DM-2620","DM-2327","DM-526","DM-547","DM-549","DM-550"]
code: ["src/render/conic-raster.ts","src/render/element-tree-to-svg.ts","src/render/gradients.ts"]
aliases: ["docs/28-conic-gradient.md","doc-28"]
---

# 28 — Conic-gradient backgrounds

## Context

CSS `conic-gradient(...)` and `repeating-conic-gradient(...)` paint color stops around an angular axis (a "pie chart" sweep) instead of along a line (linear) or radius (radial). Common authoring patterns:

- Hard-stop checkerboard tiles — `repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px` — used as alpha-checkerboards behind semi-transparent swatches.
- Pie / donut progress meters and ring loaders.
- Brand artwork (rainbow disks, color wheels, sweep-shaded buttons).

SVG has **no native conic-gradient primitive**. Domotion therefore freezes the
tile Chromium painted and embeds it as an SVG image pattern. This is an
intentional representation boundary, not an approximation of Blink's conic
algorithm in Domotion.

## Decision (per DM-547)

**Implementation path: Chromium-painted pattern raster.** During normal capture,
the same live Chromium page paints each conic layer into a PNG at its concrete
physical tile size. Domotion embeds it as
`<pattern><image href="data:image/png;base64,…"/></pattern>`. The historical
CPU/Sharp rasterizer is retained only as a best-effort fallback for direct-tree
or helper-absent callers; it is not the supported fidelity path.

Rejected alternatives:

- **Many-stop linearGradient approximation** — crisp at any scale but ~36–72 wedge slices per layer (200+ SVG nodes), and the hard-stop checkerboard case stair-steps unless the slice count is impractically high.
- **`<foreignObject>` HTML fallback** — works in browsers, breaks in librsvg / Preview / QuickLook. Domotion's portability contract rules this out.

## Scope

**Full CSS conic syntax in v1** (per user direction). Specifically:

- `conic-gradient(...)` and `repeating-conic-gradient(...)`.
- `from <angle>` clause (defaults to `from 0deg`, which is the top per CSS spec).
- `at <position>` clause (single keyword, two-token keyword/length pairs, percent positions). Same position grammar already supported in `parseRadialGradient`.
- Color stops with all forms supported by linear/radial: `<color>`, `<color> <pct>`, `<color> <pct> <pct>` (range), `<color> <angle>`, hard stops (two stops at the same offset), `currentColor`, full `color()` / `color-mix()` / `oklch()` etc. (resolved through Chromium's serialised computed value, identical to the linear/radial path).
- Multi-layer composition — conic-gradient as one of several `background-image` layers, alongside linear, radial, and `url(...)` images. Already wired: the layer-iterating loop at `src/render/element-tree-to-svg.ts` calls `buildBackgroundLayerDef` per layer; conic just adds a branch.

**Out of scope (deferred):**

- Conic animation via `@property --angle` + transitions. Domotion does not support CSS property animations across frames in general, and conic is no exception.
- Per-frame conic re-rasterization in animated scenes. The renderer composes static frames; if two frames need different conic content, each frame's layer rasterizes independently — but no transition interpolation between conic instances.

## Architecture

### Pre-pass: capture Chromium's conic tiles

`rasterizeAdvancedGradients(tree, page)` walks normal and form-control
backgrounds, deduplicates `(layerText, tileWidth, tileHeight)` tuples, and asks
the live page to paint every conic/repeating-conic tuple. Results enter
`_conicTileCache`; two consumers with the same layer and size share one PNG.
`rasterizeConicGradients` subsequently fills cache misses only, preserving the
Chromium-owned result. Its recursive fallback walk includes exact generated
`::before`/`::after` fragment records: those boxes own paint independently of
the host element, so their conic layers are keyed using each fragment's
Blink-captured local border size (DM-2620).

### Render-rect inference

For a `background-size: <w> <h>` (explicit) or `0/24px 24px` (shorthand) layer, the tile is `<w> × <h>` CSS px. For `background-size: auto / cover / contain`, the tile is the element rect (with cover/contain math identical to the existing image-pattern path).

Computed `background-size` is captured in the physical coordinate space used by
`getBoundingClientRect()`: px terms are multiplied by cumulative CSS effective
zoom while percentages stay box-relative. Fractional physical dimensions are
rounded only when allocating the PNG, so cache lookup and SVG pattern geometry
cross the zoom boundary exactly once.

### Renderer dispatch

In `src/render/element-tree-to-svg.ts buildBackgroundLayerDef`, add a third branch alongside linear and radial:

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

### Helper-absent fallback algorithm

Conic-gradient interpolation is angular: at each pixel `(x, y)`, compute `θ = atan2(y - cy, x - cx) - fromAngle` (normalized to `[0, 1)`), look up the color via the stop list (same offset-blend math as linear/radial), and write the resulting RGBA. Implementation lives in a new `src/render/conic-raster.ts`:

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
  width: number, height: number,
): Buffer; // raw RGBA, width × height × 4
```

`rasterizeConic` is synchronous and pure CPU. It exists to keep unsupported
direct-tree/helper-absent use from dying, not to duplicate Blink/Skia. Normal
capture does not use its pixels when Chromium produced the tile.

Stops use `<angle>` (e.g. `red 0deg, blue 90deg`) or `<percentage>` (e.g. `red 0%, blue 25%`); both normalize to `[0, 1)` along the sweep. The `0deg/0%` reference point is `from <angle>` (top by default). Hard stops emit two stops at the same offset.

`rasterizeConic` renders into a raw RGBA buffer at the `width × height` it's handed; the pre-pass passes `(tileW × hiDPIFactor) × (tileH × hiDPIFactor)`, then asks `sharp.resize(tileW, tileH, { fit: 'fill', kernel: 'lanczos3' })` to downsample the raw buffer. Output is PNG (per the embed pipeline's "every embed is PNG" rule from DM-526).

### Capture-side parser hook

`parseGradient` in `src/render/gradients.ts` already detects all three gradient kinds and dispatches; add a third arm:

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
- **Generated pseudo boxes**: an exact source-owned `::before`/`::after`
  fragment may carry a conic background while its host has
  `background-image: none`. The pre-pass collects the pseudo paint and its
  fragment-local border geometry so the renderer emits the same pattern-backed
  box instead of an empty pseudo group (DM-2620).
- **`background-attachment: fixed` on a conic layer**: rare but valid. Tile sizing basis is the viewport, identical to the existing fixed-image path. The rasterizer doesn't need to know — `buildBackgroundLayerDef` already passes the viewport-anchored `(elX, elY, w, h)` for fixed layers.
- **`background-size: cover / contain` on a conic**: extremely uncommon (conic + cover usually means "fill the element"), but supported by sizing the rasterized tile to the element rect, just like `cover` on a `url()` image.
- **Animated SVGs (`generateAnimatedSvg`)**: the conic raster is per-frame deterministic. If two frames have different conic stops, they produce two different `<pattern>` defs and the cross-fade swap pipeline handles them like any other per-frame def.
- **Syntax beyond Domotion's parser**: the supported page-backed path still
  works because Chromium paints the serialized layer directly. The fallback
  parser may fail; a remaining cache miss warns loudly rather than silently
  inventing paint.

## Performance

- A 24×24 hard-stop tile rasterizes in ~1 ms with sharp at 2× HiDPI. A 200×200 multi-stop conic in ~5 ms. The whole `19-deep-color-mix` page has one conic layer; `_conicTileCache` dedupe keeps the cost flat as the cache hits on subsequent consumers of the same `(layerText, tileSize)` tuple.
- PNG output for a 48×48 hard-stop tile is ~150 bytes after PNG palette quantization. Multi-color smooth-gradient tiles run ~1–4 KB per consumer.
- The pre-pass adds a `Promise.all` over unique tuples; runs in the same process as the existing image-resize pre-pass and shares the worker-pool harness.

## Acceptance criteria

- `19-deep-color-mix` currentColor + transparent tinting row paints the intended gray/white checkerboard. Diff for that fixture drops from ~1 % avg to <0.5 % avg.
- A standalone fixture demonstrating `conic-gradient(red, yellow, green, blue, red)` at `200×200` renders a smooth color-wheel. New: `tests/features/<NN>-conic-gradient.html`.
- A standalone fixture demonstrating `repeating-conic-gradient(#ddd 0 25%, white 0 50%) 0/24px 24px` renders a 24×24 alpha-checkerboard tiled across a `300×300` div.
- A multi-layer fixture (`background: conic-gradient(...), linear-gradient(...), url(bg.png)`) renders with all three layers in the right stacking order.
- Supported page-backed capture accepts every conic syntax Chromium serialized,
  without routing through Domotion's fallback parser. Direct-tree/helper-absent
  fallback warns loudly if it cannot parse or produce the required tile.
- All previously passing html-test, features, and showcase tests stay passing — the conic branch is additive and doesn't touch linear/radial paths.

## Implementation slices

This doc fans out into the following sub-tickets (see DM-547 follow-ups):

1. **Parser** (`parseConicGradient` in `src/render/gradients.ts` + tests).
2. **Rasterizer + cache** (`src/render/conic-raster.ts` + `_conicTileCache` + `rasterizeConicGradients` pre-pass mirroring `resize-embedded-images.ts`).
3. **Renderer wiring** (`buildConicGradientDef` branch in `src/render/element-tree-to-svg.ts`, warning-emit downgrade).
4. **Fixtures + acceptance** (`tests/features/<NN>-conic-gradient.html`, `19-deep-color-mix` retest, FEATURES.md row).

## Status

- **Shipped** (DM-549 / DM-550 / DM-2327). Normal capture uses
  `rasterizeAdvancedGradients` with the live Chromium page to paint conic and
  repeating-conic tiles. `rasterizeConicGradients` is a cache-preserving
  best-effort fallback for callers without that page. Then
  `buildConicGradientDef` (`src/render/element-tree-to-svg.ts`) emits it as a
  `<pattern><image>` the element fills with. See the raster-fallback index
  (`docs/reference/raster-image-fallback-cases.md` → C1).
