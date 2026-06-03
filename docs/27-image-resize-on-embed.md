# 27 — Image resize-on-embed

## Context

The `embedRemoteImages` pre-pass (DM-512, doc 26) inlines every http(s) image referenced by the captured tree as a `data:` URI so the SVG loads in offline viewers. It inlines **at source resolution** — whatever bytes the CDN returns end up in the SVG verbatim.

Modern publishers (NYT, Apple, Stripe) serve images far larger than they render. A `<img>` placed at `300×200` CSS pixels typically resolves an `srcset` entry of `1500×1000` (or larger) so the same element looks crisp on retina hardware at 2× / 3×. Inlining the source bytes preserves that headroom — and bloats the SVG by 5–30× with no visible benefit at the captured viewport size, because the SVG itself is a fixed-resolution document and the consumer's display scale is already baked into the `width`/`height` of the captured tree.

A captured nytimes.com homepage with `selfContained: true` produces a ~1.5 MB SVG today; the same capture with images downscaled to render-rect × 2× targets ~300–500 KB. The 50–80 % size reduction matters for distribution / archival use and for any consumer that ingests the SVG over a network.

## Today's behavior (pre-DM-526)

`embedRemoteImages` fetches each unique URL once, base64-encodes the response, and stashes the result in `_dataUriCache` keyed by source URL. `embedAsDataUri(url)` returns the cached entry on the next call. There is no awareness of how the URL is consumed, no link from cache entry back to the rendered element rect, and no decode/re-encode pipeline.

## DM-526 behavior (this doc)

A new optional pre-pass — invoked alongside or after `embedRemoteImages` — walks the captured tree, computes the **render-rect target size** for every consumer of every inlined URL, downscales each image to that target, and writes the resized PNG bytes back into the data-URI cache.

### When the pass runs

A separate `embedRemoteImagesResize` flag on `CaptureOptions` controls the pass. Default: **false** (opt-in). The flag has no effect unless `selfContained: true` (or the bare `embedRemoteImages` call) has already populated the data-URI cache — there is nothing to resize otherwise.

```ts
const rec = new DemoRecorder("https://www.nytimes.com", {
  width: 1280, height: 800,
  selfContained: true,                  // DM-512 — inline remote URLs
  embedRemoteImagesResize: true,        // DM-526 — downscale before inlining
  embedRemoteImagesHiDPIFactor: 2,      // DM-526 — default 2.0
});
```

The bare entry point is exported as `resizeEmbeddedImages(tree, options)`, mirroring `embedRemoteImages`.

### Resize threshold

A consumer's rect is determined per element (see *Render-rect inference* below). The resize pass downscales **only when the source is meaningfully larger**:

```
shouldResize = sourceWidth  > targetWidth  * hiDPIFactor
            || sourceHeight > targetHeight * hiDPIFactor
```

Otherwise the source bytes are kept untouched. Two reasons:

1. Re-encoding a JPEG that's already correctly sized accumulates compression artifacts with no size benefit.
2. Tiny icons (16×16, 32×32, sprites) are often delivered at exact target size; running them through a decode/encode round-trip can grow the file.

**Keep-whichever-is-smaller (DM-542):** even when the resize threshold IS crossed, if the resized PNG ends up larger than the original source bytes, the source is kept (`resize-embedded-images.ts` compares `out.length >= sourceBytes.length`). So a resize never makes a given image bigger than leaving it alone.

### HiDPI factor

`embedRemoteImagesHiDPIFactor` (default `2.0`) multiplies the target render rect to leave headroom for users viewing the SVG on retina displays or zoomed in. `1.0` produces the smallest output (and matches Chromium's painted resolution at `devicePixelRatio: 1`); `3.0` covers iPhone-Pro-class density. Fractional values are allowed. Values < `1.0` are clamped to `1.0` — going below render rect would produce a visibly blurry SVG even at default zoom.

### Output format

**Every resized image is re-encoded as PNG.** Per user direction (DM-526): predictable lossless output, no JPEG generational loss across re-encodes, universal SVG-viewer support, and animation-frame-friendly.

Implications:

- **JPEG photos grow per-pixel** — PNG is lossless and JPEG isn't. The expectation is that the resize ratio (1500×1000 → 600×400 = 6.25× fewer pixels) more than compensates. For images where the resize threshold isn't crossed, the source bytes pass through unchanged, so JPEG-as-JPEG is preserved when no resize is needed.
- **Animated GIFs become a still image** (first frame). DM-526 does not preserve animation; if the consumer needs animation, the URL should be excluded from the resize pass (a future enhancement could detect animation and skip).
- **WebP / AVIF sources** decode to RGBA and re-encode as PNG. The result is typically larger than the WebP/AVIF source but only when the resize threshold is also crossed; otherwise the source bytes pass through.

### Render-rect inference

Per consumer of each URL, the resize pass computes a target rect:

| Consumer field | Target W | Target H |
|---|---|---|
| `el.imageSrc` (any `<img>`, `<input type=image>`) | `el.width` | `el.height` |
| `el.pseudoImages[].url` (`::before` / `::after` `content: url(...)`) | pseudo-element's `width` / `height` from capture | same |
| `styles.backgroundImage` `url(...)` | the consumer element's `width` / `height` | same |
| `styles.maskImage` `url(...)` | consumer element's `width` / `height` | same |
| `styles.borderImageSource` `url(...)` | consumer element's full border box | same |
| `styles.listStyleImage` `url(...)` | em-box at the element's `font-size` (square) | same |

Each target is multiplied by `hiDPIFactor`. The result is **rounded up** (`Math.ceil`) so the resized output never under-resolves the target box.

For URLs referenced from CSS (`backgroundImage`, etc.) the same URL may appear on many elements at many sizes. The pass enumerates **all consumer rects per URL**, computes the resized bytes for each unique target size, and produces one cache entry per `(URL, outputW, outputH)` tuple. This is the *dedup-after-resizing* behavior: identical target sizes share one PNG, distinct target sizes get distinct PNGs. The `_dataUriCache` is therefore re-keyed from `URL → string` to `URL → Map<sizeKey, string>` (where `sizeKey = "${w}x${h}"`).

`embedAsDataUri(url)` no longer has the consumer rect on hand at call time, so the renderer side gains a sibling helper `embedResizedDataUri(url, targetW, targetH)` that the image-emitting paths use when resize is enabled. When resize is disabled (the default), the existing `embedAsDataUri` path is unchanged. See *Renderer integration* below.

### Resize library

`sharp` is the resize backend. Justification:

- libvips is the fastest mainstream image-resize implementation and produces the highest-quality bicubic / Lanczos output.
- Native decode for JPEG / PNG / WebP / AVIF / GIF — no per-format JS shim to maintain.
- Domotion already ships native dependencies via Playwright (Chromium binaries per OS/arch); adding sharp doesn't change the platform-support story.
- Prebuilt binaries cover `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `linux-musl-x64`, `linux-musl-arm64`, `win32-x64` — full coverage of the platforms Domotion targets (DM-258 / DM-260).

`sharp(buf).resize(w, h, { fit: "inside", withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer()` is the call shape. `withoutEnlargement: true` is a defense-in-depth guard — the resize-threshold check above already prevents upscale, but if the threshold logic is ever wrong, sharp won't blow the source up to fit.

## Renderer integration

The renderer paths that emit `<image href="..."/>` need to know whether to consult `_dataUriCache` (legacy) or `_resizedDataUriCache` (DM-526). Two cases:

1. **`<img>`-style emission** — the renderer already knows the element rect, so it can compute the resize key directly:
   ```ts
   const targetW = Math.ceil(el.width * hiDPIFactor);
   const targetH = Math.ceil(el.height * hiDPIFactor);
   const href = embedResizedDataUri(el.imageSrc, targetW, targetH);
   ```
2. **CSS `url(...)` emission** (background / mask / border-image / list-style) — the renderer is already iterating through the CSS string and knows the consumer's rect, so the same lookup pattern applies.

If `embedRemoteImagesResize` is disabled, `embedResizedDataUri` falls back to the source-resolution `embedAsDataUri` path so renderer code is uniform.

## Cost

- **Capture-time CPU**: one decode + resize + encode per `(URL, outputW, outputH)` tuple. NYT homepage capture: ~30 unique URLs × ~1.5 distinct sizes per URL ≈ 45 sharp invocations, ~50 ms each on M2 = ~2 s additional capture time. Parallelisable; the implementation runs sharp invocations through `Promise.all` like the fetch pre-pass.
- **Capture-time memory**: peak working set is ~2× the largest source image (libvips streams). NYT-class images are sub-MB; not a concern.
- **Output-size win**: targeted 50–80 % SVG size reduction on news-site captures.

## Validation plan

DM-526 lands when the following are true:

1. `npm run demos:test` passes with no new regressions.
2. Capture nytimes.com / apple.com / stripe.com with `embedRemoteImagesResize: true` and verify visual diffs against the same captures with the flag off (`tests/real-world.tsx`). Diff threshold target: ≤ 0.5 % per tile (tolerable given lossless PNG output).
3. SVG size ratio: NYT homepage **≥ 50 % smaller**, ideally 60–80 %.

A new test fixture `src/resize-embedded-images.test.ts` covers:

- Resize threshold respected (`sourceW > targetW × hiDPI` triggers resize; same-size source passes through).
- Per-consumer rect inference for `<img>`, `pseudoImages[]`, and CSS `url(...)` token paths.
- Dedup across consumers with identical target sizes (one PNG, two references).
- Distinct cache entries for distinct target sizes against the same source URL.
- HiDPI factor honored (`hiDPIFactor: 1` produces smaller output than `hiDPIFactor: 2` for the same inputs).
- Disabled flag is a no-op (`_dataUriCache` unchanged, source bytes preserved verbatim).

## Out of scope

- **Image format conversion to WebP / AVIF**. PNG is the only output format. If a future ticket revisits this for size-critical use cases, it should land as an additional `embedRemoteImagesFormat: "png" | "webp"` option.
- **Animated GIF preservation**. The first frame is what gets emitted today.
- **CSS `image-set()`** — not currently parsed by the capture; if it lands later, the largest-dpr entry should feed into the same resize pipeline.

## Follow-ups

- **Animated-GIF detection** to skip resize for animated sources (preserve animation).
- **Smarter format selection** — opt-in WebP for photo-heavy captures where PNG bloat outweighs render-fidelity gains.
- **Consumer-rect cache refactor** — generalize `_dataUriCache` to a shared `(URL, outputW, outputH)` keyed structure so `embedAsDataUri` and `embedResizedDataUri` can share machinery.
- **Per-image budget** (`maxBytes`) — fall back to source URL if the resized PNG still exceeds a threshold.
- **Worker pool** — for captures with hundreds of URLs, sharp invocations can saturate the event loop. A worker_threads pool would parallelise without blocking.
