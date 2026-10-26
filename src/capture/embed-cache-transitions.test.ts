import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapturedElement } from "./types.js";
import {
  _dataUriCache,
  _resizedDataUriCache,
  clearEmbeddedImageCaches,
  embedRemoteImages,
  embedResizedDataUri,
} from "./embed.js";
import { resetLastCaptureWarnings, getLastCaptureWarnings } from "./warnings.js";

const URL_A = "https://example.test/a.png";
const tree = (): CapturedElement[] =>
  [
    {
      tag: "img",
      text: "",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      imageSrc: URL_A,
      styles: {},
      children: [],
    },
  ] as unknown as CapturedElement[];

const okResponse = (): Response =>
  new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });

let fetchCalls = 0;
let nextResponse: () => Response | Promise<Response>;

beforeEach(() => {
  fetchCalls = 0;
  nextResponse = okResponse;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetchCalls++;
      return nextResponse();
    }),
  );
  clearEmbeddedImageCaches();
  resetLastCaptureWarnings([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbeddedImageCaches();
  resetLastCaptureWarnings([]);
});

describe("clearEmbeddedImageCaches", () => {
  it("empties BOTH caches", () => {
    _dataUriCache.set("u", "d");
    _resizedDataUriCache.set("u", new Map([["1x1", "r"]]));
    clearEmbeddedImageCaches();
    expect(_dataUriCache.size + _resizedDataUriCache.size).toBe(0);
  });
});

describe("embedRemoteImages cache transitions", () => {
  const opts = { retries: 0, retryBackoffMs: 0 };

  it("fetched → same tree again hits the cache → clear → re-fetches", async () => {
    await embedRemoteImages(tree(), opts);
    expect(fetchCalls).toBe(1);
    expect(_dataUriCache.get(URL_A)).toMatch(/^data:image\/png;base64,/);
    await embedRemoteImages(tree(), opts);
    expect(fetchCalls).toBe(1);
    clearEmbeddedImageCaches();
    await embedRemoteImages(tree(), opts);
    expect(fetchCalls).toBe(2);
  });

  it("a failed fetch is not cached: the next pass retries and can succeed", async () => {
    const warnings: { detail: string }[] = [];
    nextResponse = () => new Response("nope", { status: 404 });
    await embedRemoteImages(tree(), { ...opts, warnings: warnings as never });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].detail).toMatch(/HTTP 404/);
    expect(_dataUriCache.has(URL_A)).toBe(false);

    nextResponse = okResponse;
    await embedRemoteImages(tree(), opts);
    expect(fetchCalls).toBe(2);
    expect(_dataUriCache.has(URL_A)).toBe(true);
  });

  it("a warning pushed after a capture replaced the global buffer lands in the CURRENT buffer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    nextResponse = async () => {
      await gate;
      return new Response("nope", { status: 404 });
    };
    const pending = embedRemoteImages(tree(), opts);
    // A capture completes while the embed pass is still in flight and swaps the buffer.
    resetLastCaptureWarnings([]);
    release();
    await pending;
    expect(getLastCaptureWarnings().map((w) => w.feature)).toEqual(["remote-image"]);
  });
});

describe("authenticated remote images (DM-6K9F9M)", () => {
  const opts = { retries: 0, retryBackoffMs: 0 };

  it("passes static headers only to the image pre-pass", async () => {
    const headers = { Cookie: "session=one" };
    await embedRemoteImages(tree(), { ...opts, headers });
    expect(globalThis.fetch).toHaveBeenCalledWith(URL_A, { signal: expect.any(AbortSignal), headers });
    expect(_dataUriCache.has(URL_A)).toBe(true);
  });

  it("selects headers by URL and uses a caller fetch without changing global fetch", async () => {
    const urlB = "https://example.test/b.png";
    const images = [tree()[0], { ...tree()[0], imageSrc: urlB }];
    const headers = vi.fn((url: string) => ({ Authorization: `Bearer ${url.endsWith("a.png") ? "a" : "b"}` }));
    const customFetch = vi.fn(async () => okResponse()) as unknown as typeof globalThis.fetch;
    await embedRemoteImages(images, { ...opts, headers, fetch: customFetch });
    expect(headers).toHaveBeenCalledWith(URL_A);
    expect(headers).toHaveBeenCalledWith(urlB);
    expect(customFetch).toHaveBeenCalledWith(URL_A, {
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer a" },
    });
    expect(customFetch).toHaveBeenCalledWith(urlB, {
      signal: expect.any(AbortSignal),
      headers: { Authorization: "Bearer b" },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("re-fetches the same URL across credential contexts and drops stale bytes after failure", async () => {
    await embedRemoteImages(tree(), { ...opts, headers: { Cookie: "session=one" } });
    expect(_dataUriCache.get(URL_A)).toContain("AQID");
    nextResponse = () => new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "image/png" } });
    await embedRemoteImages(tree(), { ...opts, headers: { Cookie: "session=two" } });
    expect(fetchCalls).toBe(2);
    expect(_dataUriCache.get(URL_A)).toContain("BAUG");

    nextResponse = () => new Response("unauthorized", { status: 401 });
    await embedRemoteImages(tree(), { ...opts, warnings: [], headers: { Cookie: "session=expired" } });
    expect(_dataUriCache.has(URL_A)).toBe(false);
    expect(fetchCalls).toBe(3);
  });

  it("does not reuse custom-request bytes for a later default request", async () => {
    await embedRemoteImages(tree(), { ...opts, headers: { Cookie: "session=one" } });
    nextResponse = () => new Response("unauthorized", { status: 401 });
    await embedRemoteImages(tree(), { ...opts, warnings: [] });
    expect(fetchCalls).toBe(2);
    expect(_dataUriCache.has(URL_A)).toBe(false);
  });

  it("passes the abort signal and request headers on every custom fetch retry", async () => {
    const customFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(okResponse()) as unknown as typeof globalThis.fetch;
    await embedRemoteImages(tree(), {
      headers: { Authorization: "Bearer token" },
      fetch: customFetch,
      retries: 1,
      retryBackoffMs: 0,
    });
    expect(customFetch).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(customFetch).mock.calls) {
      expect(call[1]).toEqual({ signal: expect.any(AbortSignal), headers: { Authorization: "Bearer token" } });
    }
  });
});

describe("local file negative results are not pinned", () => {
  it("a file that appears after the first miss is embedded on the next lookup", () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-embed-"));
    try {
      const path = join(dir, "late.png");
      expect(embedResizedDataUri(path, 10, 10)).toBe(path);
      expect(_dataUriCache.has(path)).toBe(false);
      writeFileSync(path, Buffer.from([137, 80, 78, 71]));
      expect(embedResizedDataUri(path, 10, 10)).toMatch(/^data:image\/png;base64,/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
