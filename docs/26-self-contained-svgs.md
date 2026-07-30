# 26 — Self-contained SVGs (remote image inlining)

## Context

A captured SVG is **portable** when every resource it needs is embedded inline. Local file resources already round-trip via `embedAsDataUri` (read the bytes from disk, encode as `data:` URI). Remote URLs (`http://…`, `https://…`) did not — they were passed through verbatim into the output `<image href="…">`.

That works in browsers when the SVG is hosted on the same origin (or with permissive CORS), and at first glance it works even when opening the SVG file directly in a desktop browser — Chrome / Firefox happily fetch over the network. It does **not** work in:

- macOS Preview / QuickLook (the OS image viewers don't fetch remote resources from local files)
- Finder thumbnails
- Image renderers in chat clients, slide decks, or doc tools that ingest the SVG as a static asset
- Screen-reader / accessibility-pipeline ingestion that sandboxes the SVG

Symptom: most images appear as broken-image placeholders or just empty space. DM-512 (nytimes.com capture) was the canonical repro: 26 NYT image URLs in the captured SVG, none loaded by Preview.

## Today's behavior

Implemented in DM-512.

A new public function `embedRemoteImages(tree)` walks the captured tree, collects every http(s) URL referenced by `imageSrc`, `pseudoImages[].url`, or `url(...)` tokens inside `styles.backgroundImage` / `.maskImage` / `.borderImageSource` / `.listStyleImage`, and fetches each unique URL in parallel. The resolved bytes are stashed in the renderer's data-URI cache as `data:<mime>;base64,…`, so subsequent calls to `elementTreeToSvg` emit the inline form.

```ts
import { captureElementTree, embedRemoteImages, elementTreeToSvg } from "domotion-svg";

const tree = await captureElementTree(page, "body", viewport);
await embedRemoteImages(tree);                 // ← new pre-pass (DM-512)
const svg = elementTreeToSvg(tree, w, h);      // every URL is now inline
```

Per-URL fetch failures (network error, non-2xx, missing or non-image Content-Type) don't abort the capture: the URL stays as-is in the output so the rest of the SVG isn't held hostage by one broken image, AND the failure is surfaced as a `remote-image` warning via `getLastCaptureWarnings` (DM-528) so it's diagnosable. Each fetch also has a per-URL timeout (`timeoutMs`, default 10000 ms) so a stalled CDN host can't hang the capture, and transient failures (5xx / network / timeout) are retried (`retries`, default 1, with `retryBackoffMs`).

## CLI / API integration

`DemoRecorder` accepts a `selfContained` flag in `CaptureOptions`. When set, `captureCurrent` and `captureFullPage` automatically run `embedRemoteImages` after the DOM walk:

```ts
const rec = new DemoRecorder("https://www.nytimes.com", {
  width: 1280, height: 800, selfContained: true,
});
await rec.init({ width: 1280, height: 800 });
await rec.captureUrl("/");
const svg = await rec.captureCurrent();        // already self-contained
```

The distributed-demo Domotion examples (`examples/showcase-rendering.ts`, `showcase-transitions.ts`, `hero-product-demo.ts`, `domotion-word-demo.ts`, `transition-tour.ts`, `transition-mixed.ts`, `iframe-recursion.ts`) call `embedRemoteImages` unconditionally — distributed demo SVGs always load in Preview / QuickLook regardless of how they're ingested. (`terminal-demo.ts` has no remote images to embed, so it doesn't.)

For end users who don't use `DemoRecorder` and want fine-grained control, the bare `embedRemoteImages(tree)` function is exported from the package root.

### Which capture sites embed

Skipping the pass is not a cosmetic difference: the output keeps the literal origin URL, which renders as blank space wherever that origin is unreachable — silently, with no warning, looking correct until it is viewed somewhere else. So **every pipeline whose captured tree reaches output embeds**, and the pairing is available as one call rather than two so a new capture site can't quietly omit it:

```ts
import { captureElementTreeSelfContained } from "domotion-svg";
const tree = await captureElementTreeSelfContained(page, "body", { x: 0, y: 0, width, height });
```

That entry point (capture + embed) is what `animate`'s frame and compressed-run captures, the storyboard `capture` scene, the per-keystroke `typeResample` re-captures, the `jsReveal` rest/settled captures, and the scroll executor all use. `Capturer` / `DemoRecorder` runs the pass internally when `selfContained` is set, as before.

Two callers deliberately keep the two calls separate, because they need to control when the fetches happen or what happens to the warnings: `domotion capture --scroll` embeds the scroll segments *after* its viewBox-cull pass (so a culled element costs no fetch) and needs to honor `--no-embed-images`, and the real-world test harness supplies its own warning sink. Both pass `embedImages: false` to the scroll executor to suppress its default.

### Repeated payloads are serialized once

The `<image>` emit is per-element, so the same asset used in six places — or a static plate held across every frame of an animation — used to be re-encoded once per occurrence. `hoistDuplicateImagePayloads` (applied automatically by `wrapSvg`, `generateAnimatedSvg`, and the scroll composer) emits each distinct payload once into a top-level `<defs>` as `<image id="dmiN">` and references it from each occurrence with `<use href="#dmiN">` — the same sharing fonts (one `@font-face` block) and paths-mode glyphs (one `<path id="gN">`) already get.

Measured on three plates held across 26 frames: **137.3 KB → 47.5 KB** raw. Compressed, the duplication was always cheap (10.8 → 10.1 KB gzip, 7.9 → 7.8 KB brotli), so the win is in raw size, parse time, and viewer memory rather than transfer.

The dedupe key is `payload + width + height + preserveAspectRatio`, not the payload alone: `width`/`height` on a `<use>` do **not** override an `<image>` referent (they only apply to `<symbol>` / `<svg>` referents), so one payload shown at two sizes correctly gets one def per size. Payloads below 256 characters are left inline — a `<use>` costs ~35 bytes of its own.

## What gets fetched

`embedRemoteImages` collects URLs from the following fields on every captured element:

- `imageSrc` — `<img>` and `<input type="image">` sources.
- `pseudoImages[].url` — `::before` / `::after` `content: url(...)` images.
- `styles.backgroundImage` — every `url(...)` token (handles single-quoted, double-quoted, and bare).
- `styles.maskImage` — same.
- `styles.borderImageSource` — same.
- `styles.listStyleImage` — same.

Only URLs starting with `http://` or `https://` are fetched. `data:` URIs are already inline; `file://` and bare local paths are handled by the existing `embedAsDataUri` synchronous path.

## MIME type resolution

The HTTP response's `Content-Type` header is preferred when present and starts with `image/`. NYT-style URLs with `?format=pjpg&quality=75&...` query suffixes can't be sniffed from extension alone — the `Content-Type` header is the source of truth. Falls back to extension sniffing when `Content-Type` is missing, then to `application/octet-stream` as a last-resort default.

## Cost

Up to `retries + 1` `fetch()` attempts per unique URL (default: one attempt, one retry on a transient failure). For a typical news-site capture (~30-50 unique images), that's a handful of seconds of additional capture time at typical CDN latencies. The fetches run in parallel (`Promise.all`), so wall-clock cost scales with slowest-image latency rather than total-image latency.

A captured nytimes.com homepage: ~1.5 MB SVG with all images inline (vs. ~50 KB with URLs as references). The 30× size penalty is the cost of portability — for distribution / archival use cases that's worth it; for live web embedding where the SVG sits on a CDN and the host page's CSP allows remote refs, leaving the URLs as references stays cheaper.

## Test fixtures

`src/embed-remote-images.test.ts`: 5 unit tests using a `vi.fn()` `fetch` mock — covers `<img>` `imageSrc` inlining, CSS `background-image url(http://…)` inlining, dedup across consumers, fetch-failure pass-through, and short-circuit on `data:` / `file://` URLs.

`tests/animate-embed-images.e2e.test.ts`: serves an `<img>` from a real local http server and drives each pipeline that captures its own trees — an `animate` run, a scroll frame, a `typeResample` frame, a `jsReveal` frame, a storyboard `capture` scene. Every case asserts the PAIR (bytes present AND origin absent), because checking only one would pass on an SVG that simply dropped the image, and every case uses more than one frame so embedding frame 0 alone fails. It also asserts the one-copy-not-one-per-frame property and the one-def-per-size property.

`src/post-processing/hoist-image-payloads.test.ts` covers the rewrite's structure and its refusals; `tests/hoist-image-payloads.e2e.test.ts` rasterizes documents before and after the rewrite in real Chromium and requires byte-identical paint — including the cases that prove the rejected shortcuts (sizes on the `<use>`, clip left on the translated `<use>`) really do paint wrong.

## Follow-ups

- ✅ **Surface fetch failures via `getLastCaptureWarnings`** — done (DM-528): each failed fetch pushes a `remote-image` warning.
- ✅ **Configurable timeout per fetch** — done (DM-528): a per-URL `timeoutMs` (default 10000 ms) via `AbortController` so a stalled host can't hang the capture.
- ✅ **Retry on transient errors** — done (DM-529): `retries` (default 1) with `retryBackoffMs`, retrying 5xx / network / timeout failures (`embed.ts`).
- **Data-URI size budget** — for captures with many high-resolution images the inlined SVG can balloon. Optional resize / re-encode would be a natural extension.
