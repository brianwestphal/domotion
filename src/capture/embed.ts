/**
 * Image-embed pipeline: turn `<img src>`, `background-image: url(...)`,
 * `mask-image: url(...)`, `border-image-source: url(...)`, and
 * `list-style-image: url(...)` URLs into self-contained data URIs the renderer
 * can inline into the SVG output. Three pieces:
 *
 *  1. `embedAsDataUri` / `_dataUriCache` — synchronous local-file / cached
 *     data-URI lookup used by the renderer at emit time.
 *  2. `embedResizedDataUri` / `_resizedDataUriCache` / `_activeHiDPIFactor` —
 *     DM-540 size-tagged variant: returns a pre-resized data URI when the
 *     resize pre-pass (`resizeEmbeddedImages`) populated the cache for the
 *     consumer's CSS box, falling back to the source-resolution URI otherwise.
 *  3. `embedRemoteImages` — async pre-pass that fetches every http(s) URL
 *     referenced by the captured tree and stashes the bytes in
 *     `_dataUriCache`. Yields a self-contained SVG that renders in image
 *     viewers (Preview, QuickLook, etc.) that block remote resources from
 *     local files.
 */

import { readFileSync, existsSync } from "node:fs";
import type { CapturedElement, CaptureWarning } from "./types.js";
import { getLastCaptureWarnings } from "./warnings.js";

/** True for an absolute http(s) URL — the ones `embedRemoteImages` fetches and
 *  the data-URI pass-through leaves untouched. */
function isRemoteUrl(u: string): boolean {
  return u.startsWith("http://") || u.startsWith("https://");
}

/**
 * @internal — exposed for `resize-embedded-images.ts` (DM-539). The resize
 * pre-pass reads source bytes from this cache (populated by `embedRemoteImages`)
 * and writes per-(URL, size) resized variants into `_resizedDataUriCache`.
 *
 * Lifecycle: process-global and keyed by source URL, so it dedupes re-fetches
 * within and across captures. It is NOT evicted — a long-lived process that
 * captures many distinct URLs grows it unbounded. That's fine for the CLI's
 * one-shot use; a long-running embedder should call `clearEmbeddedImageCaches()`
 * between unrelated jobs.
 */
export const _dataUriCache = new Map<string, string>();

/**
 * @internal — DM-539. Per-source-URL map of sizeKey → resized data URI. The
 * sizeKey is `${ceil(targetW * hiDPI)}x${ceil(targetH * hiDPI)}`. Populated by
 * `resizeEmbeddedImages` (only when `embedRemoteImagesResize: true`); read by
 * `embedResizedDataUri` (DM-540) when the renderer emits an `<image href>`.
 * Empty at module load — first capture with the resize flag fills it.
 */
export const _resizedDataUriCache = new Map<string, Map<string, string>>();

/**
 * Evict the process-global embedded-image caches (`_dataUriCache` +
 * `_resizedDataUriCache`). Unnecessary for the one-shot CLI, but a long-running
 * embedder that processes many unrelated documents can call this between jobs to
 * release memory (the caches are otherwise never evicted — see `_dataUriCache`).
 */
export function clearEmbeddedImageCaches(): void {
  _dataUriCache.clear();
  _resizedDataUriCache.clear();
}

function embedAsDataUri(url: string): string {
  if (url == null || url === "") return url;
  // Cache check FIRST: a prior `embedRemoteImages` call (DM-512) may have
  // pre-fetched http(s) URLs and stashed the resolved data: URI here. Falling
  // through to the data:/http(s) pass-through would discard that work.
  const cached = _dataUriCache.get(url);
  if (cached != null) return cached;
  if (url.startsWith("data:") || isRemoteUrl(url)) return url;
  let path = url;
  if (path.startsWith("file://")) path = decodeURIComponent(path.slice("file://".length));
  if (!existsSync(path)) {
    _dataUriCache.set(url, url);
    return url;
  }
  try {
    const buf = readFileSync(path);
    const mime = mimeFromExtension(path) ?? "application/octet-stream";
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    _dataUriCache.set(url, dataUri);
    return dataUri;
  } catch {
    _dataUriCache.set(url, url);
    return url;
  }
}

/**
 * DM-540 — active hiDPI multiplier used by `embedResizedDataUri` lookups
 * during a single `elementTreeToSvg` invocation. `elementTreeToSvgInner` sets it
 * (via `setActiveHiDPIFactor`) as the FIRST thing it does on EVERY call, so each
 * render reads its own value and a stale value can't leak across renders — it's
 * only ever read (as the `embedResizedDataUri` default) inside the render that
 * just set it. Must match the value passed to `resizeEmbeddedImages` for the
 * same tree, otherwise the lookup misses and the renderer falls back to the
 * source-resolution data URI.
 *
 * Module-scoped because the resize lookup is buried in a dozen helper
 * functions (border-image, repeat-pattern, list marker, pseudo-image,
 * background-layer); threading the factor through every signature would
 * touch every call site and grow the renderer surface area for no
 * functional benefit. Captures run sequentially per Node event loop so
 * there's no concurrency hazard. (DM-1435: considered a save/restore scope
 * guard like `withRenderTextMode`, but set-at-entry already prevents the leak.)
 */
let _activeHiDPIFactor = 2;

export function setActiveHiDPIFactor(n: number): void {
  _activeHiDPIFactor = n;
}

/**
 * DM-540 — renderer-side lookup for the image-resize-on-embed pipeline.
 * Returns the resized PNG data URI for `(url, ceil(w * hiDPI), ceil(h * hiDPI))`
 * when the resize pre-pass populated `_resizedDataUriCache` for that key;
 * otherwise falls back to `embedAsDataUri(url)` so the renderer behaves
 * identically to today when resize is disabled (no entries in the resized
 * cache → source-resolution data URI returned).
 */
export function embedResizedDataUri(
  url: string,
  consumerW: number,
  consumerH: number,
  hiDPIFactor: number = _activeHiDPIFactor,
): string {
  if (url == null || url === "") return url;
  const sizeCache = _resizedDataUriCache.get(url);
  if (sizeCache != null && sizeCache.size > 0) {
    const hiDPI = Math.max(1, hiDPIFactor);
    const w = Math.max(1, Math.ceil(consumerW * hiDPI));
    const h = Math.max(1, Math.ceil(consumerH * hiDPI));
    const resized = sizeCache.get(`${w}x${h}`);
    if (resized != null) return resized;
  }
  return embedAsDataUri(url);
}

function mimeFromExtension(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  return null;
}

export interface EmbedRemoteImagesOptions {
  /**
   * DM-527: append per-URL fetch failures here as `CaptureWarning` entries.
   * If omitted, warnings push to the module-global `lastCaptureWarnings`
   * (visible via `getLastCaptureWarnings` / `logCaptureWarnings`). Concurrent
   * captures should pass an explicit array to avoid racing on the global.
   */
  warnings?: CaptureWarning[];
  /**
   * DM-528: per-URL fetch timeout in ms. A stalled CDN host (slow DNS, slow
   * first-byte, unresponsive origin) would otherwise hang the capture
   * indefinitely — the parallel `Promise.all` won't resolve until every
   * fetch settles. With this timeout the slowest fetch caps total pre-pass
   * time at ~`timeoutMs * (retries + 1) + retryBackoffMs * retries` (since
   * fetches run in parallel). Timed-out fetches produce a `remote-image`
   * warning and the URL stays as-is in the SVG. Default 10000.
   */
  timeoutMs?: number;
  /**
   * DM-529: number of retry attempts for transient failures (5xx response,
   * network error, or timeout). 4xx responses are not retried — those are
   * deterministic and a retry would just consume time. The originating
   * fetch + retries together can take up to
   * `(retries + 1) * timeoutMs + retries * retryBackoffMs` per URL, so keep
   * this small. Default 1.
   */
  retries?: number;
  /**
   * DM-529: delay (ms) between attempts when retrying a transient failure.
   * Default 500.
   */
  retryBackoffMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_RETRIES = 1;
const DEFAULT_FETCH_RETRY_BACKOFF_MS = 500;

/**
 * DM-512: fetch every http(s) image URL referenced by the captured tree and
 * stash the resolved bytes as a data: URI in the renderer's data-URI cache.
 * Subsequent calls to `embedAsDataUri` for those URLs return the cached data
 * URI instead of passing the URL through verbatim — yielding a self-contained
 * SVG that loads correctly in image viewers (Preview, Finder QuickLook, etc.)
 * that don't fetch remote resources from local files.
 *
 * Walks the captured tree once collecting URLs from: `imageSrc` (for `<img>`),
 * `pseudoImages[].url` (for `::before`/`::after` content: url(...)), and CSS
 * `url(...)` tokens inside `styles.backgroundImage` / `.maskImage` /
 * `.borderImageSource` / `.listStyleImage`. Dedupes per call.
 *
 * Per-URL fetch failures (network error, non-2xx, missing Content-Type) leave
 * the URL in the tree as-is, so the SVG still references it. DM-527: each
 * failure is surfaced as a `CaptureWarning` (feature: `remote-image`) carrying
 * the URL and the HTTP status / error class, so callers can trace which images
 * didn't inline. The warning is appended to `options.warnings` if supplied,
 * otherwise to `getLastCaptureWarnings()`.
 */
export async function embedRemoteImages(
  tree: CapturedElement[],
  options: EmbedRemoteImagesOptions = {},
): Promise<void> {
  const warnings = options.warnings ?? getLastCaptureWarnings();
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_FETCH_RETRIES;
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_FETCH_RETRY_BACKOFF_MS;
  // Map URL -> best-effort selector of the first element that referenced it.
  // The selector is a path of captured tag names ("body > div > img"); not
  // unique, but enough for a developer to locate the offending element.
  const refs = new Map<string, string>();
  const collectFromCss = (cssVal: string | undefined, selector: string): void => {
    if (cssVal == null || cssVal === "" || cssVal === "none") return;
    const re = /url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssVal)) != null) {
      const u = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (isRemoteUrl(u) && !refs.has(u)) {
        refs.set(u, selector);
      }
    }
  };
  const walk = (els: CapturedElement[], parentPath: string): void => {
    for (const el of els) {
      const sel = parentPath === "" ? el.tag : `${parentPath} > ${el.tag}`;
      if (el.imageSrc != null && isRemoteUrl(el.imageSrc)) {
        if (!refs.has(el.imageSrc)) refs.set(el.imageSrc, sel);
      }
      if (el.pseudoImages != null) {
        for (const pi of el.pseudoImages) {
          if (pi.url != null && isRemoteUrl(pi.url)) {
            if (!refs.has(pi.url)) refs.set(pi.url, sel);
          }
        }
      }
      collectFromCss(el.styles.backgroundImage, sel);
      collectFromCss(el.styles.maskImage, sel);
      collectFromCss(el.styles.borderImageSource, sel);
      collectFromCss(el.styles.listStyleImage, sel);
      if (el.children.length > 0) walk(el.children, sel);
    }
  };
  walk(tree, "");
  if (refs.size === 0) return;
  // Fetch all unique URLs in parallel. Fetch failures don't reject the
  // overall pass — a single broken image shouldn't fail the whole capture.
  const tasks = Array.from(refs, async ([url, selector]) => {
    if (_dataUriCache.has(url)) return;
    // DM-529: retry transient failures (5xx, network error, timeout). Track
    // the most recent failure so the surfaced warning describes the FINAL
    // outcome rather than the first attempt.
    let lastFailure: { kind: "status"; status: number } | { kind: "error"; err: unknown } | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await delay(retryBackoffMs);
      try {
        const res = await fetchWithTimeout(url, timeoutMs);
        if (!res.ok) {
          // 4xx is deterministic — retrying won't help, so bail immediately.
          if (res.status < 500) {
            lastFailure = { kind: "status", status: res.status };
            break;
          }
          lastFailure = { kind: "status", status: res.status };
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        // Prefer Content-Type, fall back to URL-suffix sniff. NYT-style URLs
        // often carry a `?format=pjpg&...` suffix that would defeat extension
        // sniffing on its own.
        const ctype = res.headers.get("content-type");
        const mime = (ctype != null && ctype.startsWith("image/"))
          ? ctype.split(";")[0].trim()
          : (mimeFromExtension(url.split("?")[0]) ?? "application/octet-stream");
        _dataUriCache.set(url, `data:${mime};base64,${buf.toString("base64")}`);
        return;
      } catch (err) {
        lastFailure = { kind: "error", err };
      }
    }
    if (lastFailure != null) {
      const detail = lastFailure.kind === "status"
        ? `failed to fetch ${url} — HTTP ${lastFailure.status}`
        : `failed to fetch ${url} — ${describeFetchError(lastFailure.err)}`;
      warnings.push({ selector, feature: "remote-image", detail });
    }
  });
  await Promise.all(tasks);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * DM-528: wrap `fetch` with `AbortController` so a stalled host can't hang
 * the capture indefinitely. AbortError thrown on timeout is normalized to a
 * named `RemoteImageTimeoutError` so the warning detail tells consumers
 * "this URL didn't respond in time" rather than the generic AbortError.
 */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      const e = new Error(`timed out after ${timeoutMs}ms`);
      e.name = "RemoteImageTimeoutError";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name !== "" ? err.name : err.constructor.name;
    return err.message !== "" ? `${name}: ${err.message}` : name;
  }
  return String(err);
}
