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
import { _resetLastCaptureWarnings, getLastCaptureWarnings } from "./warnings.js";

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
  _resetLastCaptureWarnings([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEmbeddedImageCaches();
  _resetLastCaptureWarnings([]);
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
    _resetLastCaptureWarnings([]);
    release();
    await pending;
    expect(getLastCaptureWarnings().map((w) => w.feature)).toEqual(["remote-image"]);
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
