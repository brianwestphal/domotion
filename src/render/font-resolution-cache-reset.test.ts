import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  __primaryCutCacheSizesForTest,
  __seedPrimaryCutCachesForTest,
  clearFontResolutionCaches,
  clearWebfonts,
  getFontInstance,
  registerWebfont,
  resolveFontForCodepoint,
  resolveFontKey,
  resolveFontSpec,
} from "./font-resolution.js";

/**
 * `clearFontResolutionCaches()` exists so a long sweep over a large codepoint
 * space stays inside a bounded heap (DM-1860: the conformance oracle exhausted
 * a default Node heap partway through a full-universe run, which made it report
 * a PREFIX of the universe as though it were the whole answer).
 *
 * The property that makes it safe is that every cleared entry is a pure
 * function of its key, so a cold lookup re-derives the identical answer. These
 * tests pin exactly that — and pin the boundary: registries that hold
 * caller-supplied state must SURVIVE, because dropping those would change
 * behavior rather than just cost.
 */
describe("clearFontResolutionCaches (DM-1860)", () => {
  const KEY = "helvetica";

  afterEach(() => {
    clearWebfonts();
  });

  it("re-derives the same font spec after a clear", () => {
    const before = resolveFontSpec(KEY);
    clearFontResolutionCaches();
    const after = resolveFontSpec(KEY);
    expect(after).toEqual(before);
  });

  it("re-derives an equivalent font instance after a clear", () => {
    const before = getFontInstance(KEY, 400, 16, 0);
    expect(before).not.toBeNull();
    clearFontResolutionCaches();
    const after = getFontInstance(KEY, 400, 16, 0);
    expect(after).not.toBeNull();
    // A NEW object (the cache really was dropped) describing the SAME face.
    expect(after).not.toBe(before);
    expect(after!.postscriptName ?? null).toBe(before!.postscriptName ?? null);
    expect(after!.unitsPerEm).toBe(before!.unitsPerEm);
  });

  it("resolves a codepoint to the same key cold as it did warm", () => {
    // Latin, Cyrillic, CJK, and one that no primary covers — the last is the
    // interesting one, since it is the case that reaches the per-codepoint
    // fallback path whose memo this clears.
    const cps = [0x41, 0x419, 0x4e00, 0x2603];
    const primaryKey = resolveFontKey("Helvetica");

    const warm = cps.map((cp) => {
      const primary = getFontInstance(primaryKey, 400, 16, 0)!;
      return resolveFontForCodepoint(cp, primary, primaryKey, 400, 16, 0, undefined, undefined, [primaryKey]).key;
    });

    clearFontResolutionCaches();

    const cold = cps.map((cp) => {
      const primary = getFontInstance(primaryKey, 400, 16, 0)!;
      return resolveFontForCodepoint(cp, primary, primaryKey, 400, 16, 0, undefined, undefined, [primaryKey]).key;
    });

    expect(cold).toEqual(warm);
  });

  it("is idempotent and safe to call before anything has been resolved", () => {
    expect(() => {
      clearFontResolutionCaches();
      clearFontResolutionCaches();
    }).not.toThrow();
    // Still functional afterwards.
    expect(getFontInstance(KEY, 400, 16, 0)).not.toBeNull();
  });

  it("drops every platform's primary-cut memo symmetrically", () => {
    // A host naturally warms only its own platform arm. The assertion is on
    // the complete postcondition so adding a new platform memo to the reset
    // cannot silently leave one of the other first-class platforms stale.
    clearFontResolutionCaches();
    __seedPrimaryCutCachesForTest();
    expect(__primaryCutCacheSizesForTest()).toEqual({ darwin: 1, linux: 1, win32: 1 });
    clearFontResolutionCaches();
    expect(__primaryCutCacheSizesForTest()).toEqual({ darwin: 0, linux: 0, win32: 0 });
  });

  it("does NOT drop the webfont registry — that is caller state, not a memo", () => {
    // The whole safety argument for clearing is "every entry is a pure function
    // of its key". A registry is not: it holds fonts the caller handed us, and
    // dropping it would make a registered family stop resolving. `registerWebfont`
    // parses via fontkit and silently skips a bad buffer, so use a real face.
    const buf = fs.existsSync("/System/Library/Fonts/Helvetica.ttc")
      ? fs.readFileSync("/System/Library/Fonts/Helvetica.ttc")
      : null;
    if (buf == null) return; // no system font fixture on this host

    clearWebfonts();
    registerWebfont("dm1860-probe-family", 400, "normal", buf);
    const registeredKey = resolveFontKey("dm1860-probe-family");

    clearFontResolutionCaches();

    expect(resolveFontKey("dm1860-probe-family")).toBe(registeredKey);
    expect(getFontInstance(registeredKey, 400, 16, 0)).not.toBeNull();
  });

  it("survives repeated clear/resolve cycles without drifting", () => {
    const primaryKey = resolveFontKey("Helvetica");
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      clearFontResolutionCaches();
      const primary = getFontInstance(primaryKey, 400, 16, 0)!;
      seen.add(resolveFontForCodepoint(0x4e00, primary, primaryKey, 400, 16, 0, undefined, undefined, [primaryKey]).key);
    }
    // Every cycle agreed — a clear does not walk the answer somewhere new.
    expect(seen.size).toBe(1);
  });
});
