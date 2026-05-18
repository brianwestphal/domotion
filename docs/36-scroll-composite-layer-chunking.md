# 36. Scroll composer: per-chunk compositing layers

The DM-642 patch promotes the entire translating composite onto its own GPU layer (via `transform: translate3d(0, -Ypx, 0)` + `will-change: transform`) and gates each per-segment wrapper with a `visibility` keyframe so only the segments inside the viewport actually paint. On a 5–10 segment page that's enough to recover ~60 fps from the 10–12 fps the unoptimised composer produced.

For very tall captures the composite itself can blow Chromium's per-layer raster budget. The `apple-desktop-scroll` fixture is 1280 × 6015 px and renders at `deviceScaleFactor: 2` (the composer's default — see `src/render/element-tree-to-svg.ts` and the `hiDPIFactor` plumbing). That's a ~30 MB single-layer raster of bytes the GPU never displays at once. Chromium typically caps `--max-layer-size`, decomposes the layer, and silently falls back to repainting it on every frame — which is the worst of both worlds and is the leftover failure mode after DM-642.

This doc captures the requirements for splitting the composite into chunk-sized layers so each chunk fits in the per-layer budget.

## What "chunk" means here

A chunk is a contiguous group of segment wrappers that share a single `<g style="will-change: transform">` host inside the translating composite. The composite still translates as one unit (so the keyframes from `src/scroll/composer.ts` are unchanged); the chunk grouping is purely a paint-layer hint.

## Chunk sizing

- **Default policy**: group every consecutive pair of segments into one chunk. For an 8-segment scroll that yields 4 chunks of ~1600 px each. Each chunk fits well within typical per-layer caps (Chromium's effective cap is around 4096 px on the long axis on most desktop GPUs; mobile is lower).
- **Tail chunk**: if the segment count is odd, the last chunk holds the trailing single segment.
- **Configurable**: `ScrollComposerOptions.chunkSize?: number` — default `2`, callers can override to `1` (every segment its own layer) or any positive integer. `chunkSize <= 0` is rejected.

The pairing policy is a compromise: layer count grows linearly with the page but stays small (a 16-segment scroll = 8 chunks, still tractable), and each chunk stays comfortably below 4096 px even at hi-DPI = 2. Tuning is straightforward if a real fixture demonstrates a sweet spot.

## Markup shape

Each chunk wrapper carries the GPU-layer hint and contains the segment `<g>`s in document order:

```svg
<g style="will-change: transform">
  <g class="scrl-xxxxxx-s0" transform="translate(0 0)">...</g>
  <g class="scrl-xxxxxx-s1" transform="translate(0 800)">...</g>
</g>
```

- `style="will-change: transform"` (NOT `transform` on the wrapper — that would double-translate). The hint alone is enough to convince Chromium to give the wrapper its own backing store.
- The chunk wrapper has no class and no animation of its own; the existing per-segment cull classes inside it still gate paint per segment.
- The chunk wrapper carries no `transform` either; its children's per-segment `translate(0 Y)` already places content correctly inside the composite.

## Interaction with the DM-642 cull

The per-segment `visibility: hidden` keyframes from DM-642 are still emitted unchanged. Chunking adds an additional GPU-eviction path on top: when all segments in a chunk are hidden simultaneously, Chromium can drop the chunk's backing store from GPU memory entirely. (A single big layer can't do that — the layer is always live as long as ANY child is visible.)

The two optimisations stack:

- Cull keyframes (DM-642) → per-frame paint cost drops to "what's currently visible".
- Per-chunk layers (this doc) → GPU memory footprint drops to "what's currently visible-ish" (one chunk in-flight at a time, plus a buffer chunk for the next one entering).

## Interaction with the hoisted overlays (DM-643, DM-645/-647)

The fixed/sticky overlay groups live OUTSIDE the translating composite. They're already on their own layer (the outer SVG layer), so chunking doesn't apply to them. The overlay block remains the last child of the outer `<g>` so it paints over the chunked composite.

## Acceptance criteria

From DM-646:

- A re-rendered `apple-desktop-scroll.svg` plays at 60 fps on a mid-spec laptop. Measurement: open the SVG in Chrome's Performance panel, record a 5 s segment, confirm "Frames" tab shows ≥ 60 fps mean during the steady-state portion of the loop.
- `src/scroll/composer.test.ts`:
  - **Long-scroll emits multiple chunk wrappers**: an 8-segment fixture produces 4 `style="will-change: transform"` chunk wrappers, each containing 2 segment children.
  - **Short scroll keeps one chunk**: a 2-segment fixture stays in one chunk wrapper.
  - **Custom `chunkSize` honored**: explicit `chunkSize: 1` produces N chunks for N segments.
  - **Cull classes unaffected**: the per-segment `scrl-…-sN` classes from DM-642 still emit identically inside chunk wrappers.
  - **Overlays unaffected**: a fixture mixing one chunked composite with one fixed overlay (DM-643) emits the overlay block outside any chunk wrapper.

## Out of scope / follow-ups

- **Adaptive chunk sizing based on capture height**. The static `chunkSize: 2` default is the cheapest thing that works. If a captured page produces wildly varying segment heights, an adaptive policy that targets, say, 2000 px per chunk would be smarter. Defer until we see a fixture that motivates it.
- **Layer eviction telemetry**. We can't observe Chromium's eviction decisions from inside the SVG. If a follow-up shows that real consumers still hit memory pressure, the answer is smaller `chunkSize`, not deeper instrumentation.
- **`contain: paint` on chunk wrappers**. Could trim repaint regions further when a chunk is partially visible. Not measured yet; defer to a real perf-regression ticket.
