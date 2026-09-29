import { afterEach, describe, expect, it } from "vitest";
import {
  clearGlyphDefs,
  ensureGlyphDef,
  getGlyphDefs,
  getGlyphDefsSince,
  glyphDefCount,
  truncateGlyphDefs,
} from "./font-resolution.js";
import {
  __fcFallbackRendererCacheForTest,
  beginFcFallbackRendererScope,
  endFcFallbackRendererScope,
  selectFcFallbackRendererScope,
} from "./glyph-helper.js";

const add = (glyphId: number): string =>
  ensureGlyphDef("cursor-test", 400, 16, 0, glyphId, [
    { command: "moveTo", args: [0, 0] },
    { command: "lineTo", args: [glyphId + 1, 0] },
    { command: "closePath", args: [] },
  ]);

afterEach(() => {
  clearGlyphDefs();
  while (__fcFallbackRendererCacheForTest() != null) endFcFallbackRendererScope();
});

describe("glyph-def cursor API (glyphDefCount / getGlyphDefsSince / truncateGlyphDefs)", () => {
  it("getGlyphDefsSince returns exactly the defs added after the cursor", () => {
    clearGlyphDefs();
    add(1);
    const cursor = glyphDefCount();
    add(2);
    add(3);
    const since = getGlyphDefsSince(cursor);
    expect(since).toContain('id="g1"');
    expect(since).toContain('id="g2"');
    expect(since).not.toContain('id="g0"');
    expect(getGlyphDefsSince(glyphDefCount())).toBe("");
  });

  it("truncate rolls back ids and keys so a re-add reuses the same id (byte-stable)", () => {
    clearGlyphDefs();
    add(1);
    const cursor = glyphDefCount();
    const id = add(2);
    const before = getGlyphDefs();
    truncateGlyphDefs(cursor);
    expect(glyphDefCount()).toBe(cursor);
    expect(getGlyphDefs()).not.toContain(`id="${id}"`);
    expect(add(2)).toBe(id);
    expect(getGlyphDefs()).toBe(before);
  });

  it("truncate at or past the current count is a no-op", () => {
    clearGlyphDefs();
    add(1);
    const snapshot = getGlyphDefs();
    truncateGlyphDefs(glyphDefCount());
    truncateGlyphDefs(glyphDefCount() + 5);
    expect(getGlyphDefs()).toBe(snapshot);
  });

  it("truncate to zero empties the registry and the next add starts at g0", () => {
    clearGlyphDefs();
    add(1);
    add(2);
    truncateGlyphDefs(0);
    expect(getGlyphDefs()).toBe("");
    expect(add(9)).toBe("g0");
  });
});

describe("nested Linux renderer fallback scopes", () => {
  it("an inner begin(keyB) … end restores keyA's cache and depth", () => {
    beginFcFallbackRendererScope("A");
    __fcFallbackRendererCacheForTest()!.set(0x4e00, null);
    beginFcFallbackRendererScope("B");
    expect(__fcFallbackRendererCacheForTest()!.has(0x4e00)).toBe(false);
    endFcFallbackRendererScope();
    expect(__fcFallbackRendererCacheForTest()!.has(0x4e00)).toBe(true);
    endFcFallbackRendererScope();
    expect(__fcFallbackRendererCacheForTest()).toBeNull();
  });

  it("a select inside a nested scope is undone by that scope's end", () => {
    beginFcFallbackRendererScope("A");
    __fcFallbackRendererCacheForTest()!.set(0x3400, null);
    beginFcFallbackRendererScope("A2");
    selectFcFallbackRendererScope("elsewhere");
    endFcFallbackRendererScope();
    expect(__fcFallbackRendererCacheForTest()!.has(0x3400)).toBe(true);
  });
});
