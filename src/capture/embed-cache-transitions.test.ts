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
  withEmbeddedImageScopes,
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
    const images = tree();
    await embedRemoteImages(images, { ...opts, headers });
    expect(globalThis.fetch).toHaveBeenCalledWith(URL_A, { signal: expect.any(AbortSignal), headers });
    expect(withEmbeddedImageScopes(images, () => embedResizedDataUri(URL_A, 10, 10))).toContain("AQID");
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

  it("re-fetches the same URL for every credentialed pass and keeps bytes out of the global cache", async () => {
    const first = tree();
    await embedRemoteImages(first, { ...opts, headers: { Cookie: "session=one" } });
    expect(withEmbeddedImageScopes(first, () => embedResizedDataUri(URL_A, 10, 10))).toContain("AQID");
    expect(_dataUriCache.has(URL_A)).toBe(false);

    nextResponse = () => new Response(new Uint8Array([4, 5, 6]), { headers: { "content-type": "image/png" } });
    const second = tree();
    await embedRemoteImages(second, { ...opts, headers: { Cookie: "session=two" } });
    expect(fetchCalls).toBe(2);
    expect(withEmbeddedImageScopes(second, () => embedResizedDataUri(URL_A, 10, 10))).toContain("BAUG");
    expect(withEmbeddedImageScopes(first, () => embedResizedDataUri(URL_A, 10, 10))).toContain("AQID");

    nextResponse = () => new Response("unauthorized", { status: 401 });
    await embedRemoteImages(first, { ...opts, warnings: [], headers: { Cookie: "session=expired" } });
    expect(fetchCalls).toBe(3);
    expect(withEmbeddedImageScopes(first, () => embedResizedDataUri(URL_A, 10, 10))).toBe(URL_A);
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

describe("concurrent credentialed embed sessions (DM-QT13J0)", () => {
  const opts = { retries: 0, retryBackoffMs: 0 };
  const bytesFor: Record<string, number[]> = { "session=one": [1, 1, 1], "session=two": [2, 2, 2] };
  const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => (release = resolve));
    return { promise, release };
  };
  const dataUriOf = (bytes: number[]): string => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

  it("overlapping calls for one URL keep each call's payload whichever fetch finishes last", async () => {
    for (const order of [
      ["session=one", "session=two"],
      ["session=two", "session=one"],
    ]) {
      clearEmbeddedImageCaches();
      const gates = new Map(order.map((cookie) => [cookie, deferred()]));
      const fetchFor = (cookie: string) =>
        vi.fn(async () => {
          await gates.get(cookie)!.promise;
          return new Response(new Uint8Array(bytesFor[cookie]), { headers: { "content-type": "image/png" } });
        }) as unknown as typeof globalThis.fetch;
      const one = tree();
      const two = tree();
      const pendingOne = embedRemoteImages(one, {
        ...opts,
        headers: { Cookie: "session=one" },
        fetch: fetchFor("session=one"),
      });
      const pendingTwo = embedRemoteImages(two, {
        ...opts,
        headers: { Cookie: "session=two" },
        fetch: fetchFor("session=two"),
      });
      for (const cookie of order) {
        gates.get(cookie)!.release();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await Promise.all([pendingOne, pendingTwo]);
      expect(withEmbeddedImageScopes(one, () => embedResizedDataUri(URL_A, 10, 10))).toBe(
        dataUriOf(bytesFor["session=one"]),
      );
      expect(withEmbeddedImageScopes(two, () => embedResizedDataUri(URL_A, 10, 10))).toBe(
        dataUriOf(bytesFor["session=two"]),
      );
      expect(_dataUriCache.has(URL_A)).toBe(false);
    }
  });

  it("a failed credentialed fetch renders the raw URL even while a default capture cached bytes", async () => {
    await embedRemoteImages(tree(), opts);
    expect(_dataUriCache.has(URL_A)).toBe(true);
    nextResponse = () => new Response("unauthorized", { status: 401 });
    const denied = tree();
    await embedRemoteImages(denied, { ...opts, warnings: [], headers: { Cookie: "session=expired" } });
    expect(withEmbeddedImageScopes(denied, () => embedResizedDataUri(URL_A, 10, 10))).toBe(URL_A);
    expect(embedResizedDataUri(URL_A, 10, 10)).toMatch(/^data:image\/png;base64,/);
  });

  it("a later default pass over the same tree releases its credentialed scope", async () => {
    const images = tree();
    await embedRemoteImages(images, { ...opts, headers: { Cookie: "session=one" } });
    nextResponse = () => new Response(new Uint8Array([9, 9, 9]), { headers: { "content-type": "image/png" } });
    await embedRemoteImages(images, opts);
    expect(withEmbeddedImageScopes(images, () => embedResizedDataUri(URL_A, 10, 10))).toBe(dataUriOf([9, 9, 9]));
  });

  it("one render over roots from conflicting credential contexts fails closed", async () => {
    const one = tree();
    await embedRemoteImages(one, { ...opts, headers: { Cookie: "session=one" } });
    nextResponse = () => new Response(new Uint8Array([2, 2, 2]), { headers: { "content-type": "image/png" } });
    const two = tree();
    await embedRemoteImages(two, { ...opts, headers: { Cookie: "session=two" } });
    expect(() => withEmbeddedImageScopes([...one, ...two], () => embedResizedDataUri(URL_A, 10, 10))).toThrow(
      /different request credentials/,
    );
    // Roots from one context — and a scope-less root — compose without conflict.
    expect(withEmbeddedImageScopes([...one, ...tree()], () => embedResizedDataUri(URL_A, 10, 10))).toContain("AQID");
  });

  it("restores the outer scope after a render throws", async () => {
    const images = tree();
    await embedRemoteImages(images, { ...opts, headers: { Cookie: "session=one" } });
    expect(() =>
      withEmbeddedImageScopes(images, () => {
        throw new Error("render failed");
      }),
    ).toThrow("render failed");
    expect(embedResizedDataUri(URL_A, 10, 10)).toBe(URL_A);
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
