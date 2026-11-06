// The root renderer owns three process-global scopes of its own — nested-SVG
// flattening, the embedded-image credential scopes and the resize-lookup hiDPI
// factor. They share the text-engine synchronous-scope contract: a scope cannot
// stay active across an `await`, so a Promise-like callback result is rejected
// with a TypeError and the prior value is restored before any continuation
// runs. These tests walk each scope through return, throw, async, thenable,
// nested and repeated sequences.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CapturedElement } from "../capture/types.js";
import {
  _resizedDataUriCache,
  clearEmbeddedImageCaches,
  embedRemoteImages,
  embedResizedDataUri,
  withActiveHiDPIFactor,
  withEmbeddedImageScopes,
} from "../capture/embed.js";
import { resetLastCaptureWarnings } from "../capture/warnings.js";
import { getFlattenNestedSvg, setFlattenNestedSvg, withFlattenNestedSvg } from "./svg-inline.js";

const ASYNC_ERROR = (scope: string): RegExp =>
  new RegExp(`${scope} callback must be synchronous; Promise-like results`);
const thenable = (): PromiseLike<number> => ({ then: () => thenable() as never });

afterEach(() => {
  setFlattenNestedSvg(false);
  _resizedDataUriCache.clear();
});

describe("withFlattenNestedSvg synchronous contract", () => {
  it("rejects an async callback and restores before its continuation", async () => {
    let seenAfterAwait: boolean | null = null;
    expect(() =>
      withFlattenNestedSvg(true, (async () => {
        expect(getFlattenNestedSvg()).toBe(true);
        await Promise.resolve();
        seenAfterAwait = getFlattenNestedSvg();
      }) as unknown as () => void),
    ).toThrow(TypeError);
    expect(getFlattenNestedSvg()).toBe(false);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(false);
  });

  it("rejects a custom thenable and restores the prior value, including an enabled outer scope", () => {
    expect(() => withFlattenNestedSvg(true, thenable as unknown as () => number)).toThrow(
      ASYNC_ERROR("withFlattenNestedSvg"),
    );
    expect(getFlattenNestedSvg()).toBe(false);
    withFlattenNestedSvg(true, () => {
      expect(() => withFlattenNestedSvg(false, (() => Promise.resolve(1)) as unknown as () => number)).toThrow(
        ASYNC_ERROR("withFlattenNestedSvg"),
      );
      expect(getFlattenNestedSvg()).toBe(true);
    });
    expect(getFlattenNestedSvg()).toBe(false);
  });

  it("still accepts repeated synchronous scopes after a rejection", () => {
    expect(() => withFlattenNestedSvg(true, (() => Promise.resolve()) as unknown as () => void)).toThrow(TypeError);
    expect(withFlattenNestedSvg(true, () => getFlattenNestedSvg())).toBe(true);
    expect(withFlattenNestedSvg(true, () => 7)).toBe(7);
    expect(getFlattenNestedSvg()).toBe(false);
  });

  it("rejects async callbacks at compile time", () => {
    const typeOnly = (): void => {
      // @ts-expect-error -- a Promise-returning callback cannot keep the flag scoped.
      withFlattenNestedSvg(true, async () => 1);
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("withActiveHiDPIFactor synchronous contract", () => {
  const SOURCE = "data:image/png;base64,source";
  beforeEach(() => {
    _resizedDataUriCache.set(
      SOURCE,
      new Map([
        ["20x20", "factor-2"],
        ["30x30", "factor-3"],
        ["40x40", "factor-4"],
      ]),
    );
  });

  it("rejects an async callback and restores the factor before its continuation", async () => {
    let seenAfterAwait: string | null = null;
    expect(() =>
      withActiveHiDPIFactor(3, (async () => {
        expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-3");
        await Promise.resolve();
        seenAfterAwait = embedResizedDataUri(SOURCE, 10, 10);
      }) as unknown as () => void),
    ).toThrow(ASYNC_ERROR("withActiveHiDPIFactor"));
    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
    await Promise.resolve();
    expect(seenAfterAwait).toBe("factor-2");
  });

  it("rejects a thenable inside a nested scope and restores the outer factor", () => {
    withActiveHiDPIFactor(3, () => {
      expect(() => withActiveHiDPIFactor(4, thenable as unknown as () => number)).toThrow(TypeError);
      expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-3");
    });
    expect(embedResizedDataUri(SOURCE, 10, 10)).toBe("factor-2");
    expect(withActiveHiDPIFactor(4, () => embedResizedDataUri(SOURCE, 10, 10))).toBe("factor-4");
  });

  it("rejects async callbacks at compile time", () => {
    const typeOnly = (): void => {
      // @ts-expect-error -- a Promise-returning callback cannot keep the factor scoped.
      withActiveHiDPIFactor(3, async () => 1);
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("withEmbeddedImageScopes synchronous contract", () => {
  const URL_A = "https://example.test/a.png";
  const tree = (): CapturedElement[] =>
    [
      { tag: "img", text: "", x: 0, y: 0, width: 10, height: 10, imageSrc: URL_A, styles: {}, children: [] },
    ] as unknown as CapturedElement[];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
      ),
    );
    clearEmbeddedImageCaches();
    resetLastCaptureWarnings([]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearEmbeddedImageCaches();
    resetLastCaptureWarnings([]);
  });

  it("rejects an async callback and deactivates the credential scope before its continuation", async () => {
    const images = tree();
    // Headers make the fetched bytes scope-owned rather than process-global.
    await embedRemoteImages(images, { headers: { Cookie: "s=1" }, retries: 0, retryBackoffMs: 0 });
    let seenAfterAwait: string | null = null;
    expect(() =>
      withEmbeddedImageScopes(images, (async () => {
        expect(embedResizedDataUri(URL_A, 10, 10)).toContain("AQID");
        await Promise.resolve();
        seenAfterAwait = embedResizedDataUri(URL_A, 10, 10);
      }) as unknown as () => void),
    ).toThrow(ASYNC_ERROR("withEmbeddedImageScopes"));
    expect(embedResizedDataUri(URL_A, 10, 10)).toBe(URL_A);
    await Promise.resolve();
    expect(seenAfterAwait).toBe(URL_A);
    // The scope is still usable synchronously afterward.
    expect(withEmbeddedImageScopes(images, () => embedResizedDataUri(URL_A, 10, 10))).toContain("AQID");
  });

  it("restores an enclosing scope after a rejected nested thenable", async () => {
    const images = tree();
    await embedRemoteImages(images, { headers: { Cookie: "s=1" }, retries: 0, retryBackoffMs: 0 });
    withEmbeddedImageScopes(images, () => {
      expect(() => withEmbeddedImageScopes([], thenable as unknown as () => number)).toThrow(TypeError);
      expect(embedResizedDataUri(URL_A, 10, 10)).toContain("AQID");
    });
    expect(embedResizedDataUri(URL_A, 10, 10)).toBe(URL_A);
  });

  it("rejects async callbacks at compile time", () => {
    const typeOnly = (): void => {
      // @ts-expect-error -- a Promise-returning callback cannot keep the scopes active.
      withEmbeddedImageScopes([], async () => 1);
    };
    expect(typeof typeOnly).toBe("function");
  });
});
