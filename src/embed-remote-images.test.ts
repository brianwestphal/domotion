import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  embedRemoteImages,
  elementTreeToSvgInner,
  getLastCaptureWarnings,
} from "./render/element-tree-to-svg.js";
import type { CapturedElement, CaptureWarning } from "./capture/types.js";

/**
 * DM-512: regression tests for `embedRemoteImages` — verifies that http(s)
 * image URLs in the captured tree are fetched and the resulting `data:` URIs
 * propagate into the rendered SVG, so SVGs load in offline image viewers
 * (Preview / QuickLook) instead of breaking on remote-resource lookups from
 * local files.
 */

// Tiny 1x1 transparent PNG. Used as the mock fetch payload across all tests.
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const ONE_PX_PNG_DATA_URI = `data:image/png;base64,${ONE_PX_PNG.toString("base64")}`;

function makeElement(overrides: Partial<CapturedElement> = {}): CapturedElement {
  return {
    tag: "div",
    text: "",
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    ...overrides,
    styles: {
      backgroundColor: "rgba(0,0,0,0)",
      borderColor: "rgb(0,0,0)",
      borderWidth: "0",
      borderRadius: "0",
      borderTopLeftRadius: "0",
      borderTopRightRadius: "0",
      borderBottomRightRadius: "0",
      borderBottomLeftRadius: "0",
      borderTopWidth: "0",
      borderRightWidth: "0",
      borderBottomWidth: "0",
      borderLeftWidth: "0",
      borderTopColor: "rgb(0,0,0)",
      borderRightColor: "rgb(0,0,0)",
      borderBottomColor: "rgb(0,0,0)",
      borderLeftColor: "rgb(0,0,0)",
      borderTopStyle: "none",
      borderRightStyle: "none",
      borderBottomStyle: "none",
      borderLeftStyle: "none",
      color: "rgb(0,0,0)",
      fontSize: "16px",
      fontFamily: "sans-serif",
      fontWeight: "400",
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "left",
      textTransform: "none",
      textDecoration: "none",
      textDecorationLine: "none",
      textDecorationStyle: "solid",
      textDecorationColor: "rgb(0,0,0)",
      whiteSpace: "normal",
      wordSpacing: "0",
      verticalAlign: "baseline",
      direction: "ltr",
      writingMode: "horizontal-tb",
      textOverflow: "clip",
      cursor: "auto",
      caretColor: "auto",
      outlineColor: "rgb(0,0,0)",
      outlineWidth: "0",
      outlineStyle: "none",
      outlineOffset: "0",
      boxShadow: "none",
      opacity: "1",
      transform: "none",
      transformOrigin: "50% 50%",
      visibility: "visible",
      borderCollapse: "separate",
      overflowX: "visible",
      overflowY: "visible",
      scrollbarGutter: "auto",
      scrollWidth: 100,
      scrollHeight: 100,
      clientWidth: 100,
      clientHeight: 100,
      scrollTop: 0,
      scrollLeft: 0,
      objectFit: "fill",
      objectPosition: "50% 50%",
      filter: "none",
      backdropFilter: "none",
      mixBlendMode: "normal",
      clipPath: "none",
      mask: "none",
      maskImage: "none",
      maskMode: "match-source",
      maskSize: "auto",
      maskPosition: "0% 0%",
      maskRepeat: "repeat",
      maskComposite: "add",
      listStyleType: "disc",
      listStyleImage: "none",
      display: "block",
      listStylePosition: "outside",
      backgroundImage: "none",
      backgroundSize: "auto",
      backgroundPosition: "0% 0%",
      backgroundRepeat: "repeat",
      backgroundClip: "border-box",
      backgroundOrigin: "padding-box",
      backgroundAttachment: "scroll",
      paddingTop: "0",
      paddingRight: "0",
      paddingBottom: "0",
      paddingLeft: "0",
      borderImageSource: "none",
      borderImageSlice: "100%",
      borderImageWidth: "1",
      borderImageOutset: "0",
      borderImageRepeat: "stretch",
      zIndex: "auto",
      position: "static",
      float: "none",
      ...(overrides.styles ?? {}),
    } as CapturedElement["styles"],
  };
}

describe("embedRemoteImages — DM-512", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => ONE_PX_PNG.buffer.slice(
        ONE_PX_PNG.byteOffset, ONE_PX_PNG.byteOffset + ONE_PX_PNG.byteLength,
      ),
      headers: { get: (name: string) => name.toLowerCase() === "content-type" ? "image/png" : null },
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("inlines an <img>'s http(s) src as a data: URI in the rendered SVG", async () => {
    const url = "https://example.com/dm-512-img-test.png";
    const tree = [makeElement({
      tag: "img",
      x: 0, y: 0, width: 50, height: 50,
      imageSrc: url,
    })];
    await embedRemoteImages(tree);
    const svg = elementTreeToSvgInner(tree, 100, 100);
    expect(svg).toContain(ONE_PX_PNG_DATA_URI);
    expect(svg).not.toContain(url);
  });

  it("inlines a CSS background-image url(http://…) source", async () => {
    const url = "https://example.com/dm-512-bg-test.png";
    const tree = [makeElement({
      x: 0, y: 0, width: 100, height: 100,
      styles: { ...makeElement().styles, backgroundImage: `url("${url}")`, backgroundIntrinsic: [{ w: 50, h: 50 }] } as CapturedElement["styles"],
    })];
    await embedRemoteImages(tree);
    const svg = elementTreeToSvgInner(tree, 100, 100);
    expect(svg).toContain(ONE_PX_PNG_DATA_URI);
    expect(svg).not.toContain(url);
  });

  it("dedupes by URL — multiple consumers share one fetch", async () => {
    const url = "https://example.com/dm-512-shared.png";
    const tree = [
      makeElement({ tag: "img", imageSrc: url }),
      makeElement({ tag: "img", imageSrc: url }),
    ];
    await embedRemoteImages(tree);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // DM-528: fetch now receives an init bag with an AbortSignal alongside the URL.
    expect(fetchMock.mock.calls[0][0]).toBe(url);
  });

  it("leaves the URL unchanged when fetch fails (non-ok response)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    } as unknown as Response);
    const url = "https://example.com/dm-512-missing.png";
    const tree = [makeElement({ tag: "img", imageSrc: url })];
    // 404 is a 4xx — the retry path doesn't touch it (DM-529).
    await embedRemoteImages(tree);
    const svg = elementTreeToSvgInner(tree, 100, 100);
    // URL passes through verbatim — the SVG still references the remote
    // image (broken in offline viewers, but renders the same as before
    // the embedRemoteImages pre-pass for the failed URL).
    expect(svg).toContain(url);
    expect(svg).not.toContain(ONE_PX_PNG_DATA_URI);
  });

  it("leaves data: and file:// URLs untouched (no fetch attempted)", async () => {
    const tree = [
      makeElement({ tag: "img", imageSrc: "data:image/png;base64,iVBOR" }),
      makeElement({ tag: "img", imageSrc: "file:///tmp/local.png" }),
    ];
    await embedRemoteImages(tree);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // DM-527: failed fetches must surface via the capture-warnings pipeline so
  // consumers can identify which images didn't inline. Without this, a
  // produced SVG that looks broken in Preview gives no signal about which
  // CDN URL silently failed.
  describe("DM-527 — surfaces fetch failures as warnings", () => {
    it("emits a remote-image warning with URL + HTTP status on non-ok response", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-527-503.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].feature).toBe("remote-image");
      expect(warnings[0].detail).toContain(url);
      expect(warnings[0].detail).toContain("503");
      expect(warnings[0].selector).toBe("img");
    });

    it("emits a remote-image warning when fetch throws (DNS / network error)", async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND host"), { name: "TypeError" }));
      const url = "https://nope.invalid/dm-527-dns.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(warnings).toHaveLength(1);
      expect(warnings[0].detail).toContain(url);
      expect(warnings[0].detail).toContain("TypeError");
      expect(warnings[0].detail).toContain("ENOTFOUND");
    });

    it("includes a selector path identifying the originating element", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-527-selector.png";
      const tree = [
        makeElement({
          tag: "body",
          children: [
            makeElement({
              tag: "section",
              children: [makeElement({ tag: "img", imageSrc: url })],
            }),
          ],
        }),
      ];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings });
      expect(warnings[0].selector).toBe("body > section > img");
    });

    it("falls back to getLastCaptureWarnings() when no array is provided", async () => {
      // Reset the module global by running embedRemoteImages once with an
      // empty tree (no-op) and snapshotting the array — we then mutate the
      // same array, so all earlier warnings remain in front.
      const before = getLastCaptureWarnings().length;
      fetchMock.mockResolvedValue({
        ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-527-global.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      await embedRemoteImages(tree, { retryBackoffMs: 0 });
      const after = getLastCaptureWarnings();
      expect(after.length).toBe(before + 1);
      expect(after[after.length - 1].detail).toContain(url);
    });

    it("does NOT emit a warning when the fetch succeeds", async () => {
      const url = "https://example.com/dm-527-ok.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings });
      expect(warnings).toHaveLength(0);
    });
  });

  // DM-528: a stalled CDN host can't hang the capture indefinitely. Each
  // fetch is bounded by a per-URL AbortController; timed-out fetches surface
  // as `RemoteImageTimeoutError` warnings.
  describe("DM-528 — per-fetch timeout", () => {
    it("aborts a stalled fetch after timeoutMs and emits a timeout warning", async () => {
      // Mock fetch to never resolve unless aborted via the passed signal.
      // Use mockImplementation (not …Once) so the DM-529 retry attempt also
      // sees a stalled fetch — we want both attempts to time out so the
      // warning surfaces.
      fetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal == null) return; // never resolves
          if (signal.aborted) {
            const e = new Error("aborted") as Error & { name: string };
            e.name = "AbortError";
            reject(e);
            return;
          }
          signal.addEventListener("abort", () => {
            const e = new Error("aborted") as Error & { name: string };
            e.name = "AbortError";
            reject(e);
          });
        });
      });
      const url = "https://example.com/dm-528-stalled.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      const t0 = Date.now();
      await embedRemoteImages(tree, { warnings, timeoutMs: 50, retryBackoffMs: 0 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(2000); // we should NOT have hung
      expect(warnings).toHaveLength(1);
      expect(warnings[0].feature).toBe("remote-image");
      expect(warnings[0].detail).toContain(url);
      expect(warnings[0].detail).toContain("RemoteImageTimeoutError");
      expect(warnings[0].detail).toContain("50ms");
      // URL stays as-is — the SVG still references the remote image.
      const svg = elementTreeToSvgInner(tree, 100, 100);
      expect(svg).toContain(url);
    });

    it("passes an AbortSignal to fetch", async () => {
      const url = "https://example.com/dm-528-signal-check.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      await embedRemoteImages(tree);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      const init = call[1] as { signal?: AbortSignal } | undefined;
      expect(init?.signal).toBeDefined();
      expect(init!.signal).toBeInstanceOf(AbortSignal);
    });
  });

  // DM-529: retry once on transient failures (5xx, network error, timeout).
  // Success on retry replaces the URL with the inlined data URI; failure on
  // retry behaves the same as today (URL stays as-is, warning surfaces).
  describe("DM-529 — retry transient failures", () => {
    it("retries on a 5xx response and inlines on the second attempt's success", async () => {
      const okResponse = {
        ok: true,
        status: 200,
        arrayBuffer: async () => ONE_PX_PNG.buffer.slice(
          ONE_PX_PNG.byteOffset, ONE_PX_PNG.byteOffset + ONE_PX_PNG.byteLength,
        ),
        headers: { get: (n: string) => n.toLowerCase() === "content-type" ? "image/png" : null },
      } as unknown as Response;
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce(okResponse);
      const url = "https://example.com/dm-529-503-then-200.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const svg = elementTreeToSvgInner(tree, 100, 100);
      expect(svg).toContain(ONE_PX_PNG_DATA_URI);
      expect(svg).not.toContain(url);
      expect(warnings).toHaveLength(0); // success on retry → no warning
    });

    it("retries on a thrown network error and inlines on success", async () => {
      const okResponse = {
        ok: true,
        status: 200,
        arrayBuffer: async () => ONE_PX_PNG.buffer.slice(
          ONE_PX_PNG.byteOffset, ONE_PX_PNG.byteOffset + ONE_PX_PNG.byteLength,
        ),
        headers: { get: (n: string) => n.toLowerCase() === "content-type" ? "image/png" : null },
      } as unknown as Response;
      fetchMock.mockRejectedValueOnce(new TypeError("ECONNRESET"));
      fetchMock.mockResolvedValueOnce(okResponse);
      const url = "https://example.com/dm-529-reset-then-200.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(0);
    });

    it("emits a warning describing the FINAL failure when the retry also fails", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-529-double-fail.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(1);
      // The most recent failure (502) is what we report.
      expect(warnings[0].detail).toContain("502");
    });

    it("does NOT retry on 4xx (deterministic client errors)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-529-404.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retryBackoffMs: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1); // no retry
      expect(warnings[0].detail).toContain("404");
    });

    it("respects retries: 0 (no retry attempts)", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-529-no-retry.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retries: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnings).toHaveLength(1);
    });

    it("respects retries > 1 (e.g. retries: 2 → up to 3 attempts)", async () => {
      fetchMock.mockResolvedValue({
        ok: false, status: 503, arrayBuffer: async () => new ArrayBuffer(0),
        headers: { get: () => null },
      } as unknown as Response);
      const url = "https://example.com/dm-529-three-attempts.png";
      const tree = [makeElement({ tag: "img", imageSrc: url })];
      const warnings: CaptureWarning[] = [];
      await embedRemoteImages(tree, { warnings, retries: 2, retryBackoffMs: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(warnings).toHaveLength(1);
    });
  });
});
