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

Per-URL fetch failures (network error, non-2xx, missing or non-image Content-Type) are swallowed: the URL stays as-is in the output, so the rest of the SVG isn't held hostage by one broken image. Failures don't currently surface via `getLastCaptureWarnings` — that's a follow-up if usage warrants.

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

The Domotion examples (`examples/showcase-rendering.ts`, `terminal-demo.ts`, `showcase-transitions.ts`) call `embedRemoteImages` unconditionally — distributed demo SVGs always load in Preview / QuickLook regardless of how they're ingested.

For end users who don't use `DemoRecorder` and want fine-grained control, the bare `embedRemoteImages(tree)` function is exported from the package root.

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

One `fetch()` per unique URL. For a typical news-site capture (~30-50 unique images), that's a handful of seconds of additional capture time at typical CDN latencies. The fetches run in parallel (`Promise.all`), so wall-clock cost scales with slowest-image latency rather than total-image latency.

A captured nytimes.com homepage: ~1.5 MB SVG with all images inline (vs. ~50 KB with URLs as references). The 30× size penalty is the cost of portability — for distribution / archival use cases that's worth it; for live web embedding where the SVG sits on a CDN and the host page's CSP allows remote refs, leaving the URLs as references stays cheaper.

## Test fixtures

`src/embed-remote-images.test.ts`: 5 unit tests using a `vi.fn()` `fetch` mock — covers `<img>` `imageSrc` inlining, CSS `background-image url(http://…)` inlining, dedup across consumers, fetch-failure pass-through, and short-circuit on `data:` / `file://` URLs.

## Follow-ups

- **Surface fetch failures via `getLastCaptureWarnings`** — currently swallowed. Useful for debugging why a particular image isn't inlining.
- **Configurable timeout per fetch** — `fetch()` doesn't time out by default; a stalled CDN host can hang the capture indefinitely. A 5-10s per-URL timeout via `AbortController` would be safer.
- **Retry on transient errors** — single fetch attempt today.
- **Data-URI size budget** — for captures with many high-resolution images the inlined SVG can balloon. Optional resize / re-encode would be a natural extension.
