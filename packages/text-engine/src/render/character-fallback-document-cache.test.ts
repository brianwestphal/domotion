/**
 * DM-1949: the macOS per-character fallback cache for ideographs — Blink's
 * `character_fallback_cache_` (mac/font_cache_mac.mm:330-372, rev 7d859f27,
 * byte-identical at shipping tag 147.0.7727.15, runtime feature
 * `MacCharacterFallbackCache: status "stable"`), modeled as DOCUMENT-scoped
 * ordered state around `resolveSystemFallbackKeyForCp`.
 *
 * The property under test is ORDER, so these are transition tests, not
 * single-shot ones: the same codepoint must answer differently depending on
 * which ideograph asked first WITHIN a document, identically across documents
 * regardless of what a previous document asked, and identically to the
 * context-free answer when no document is open. Assertions are structural
 * (against the cache's own state and cmap coverage) rather than pinned to
 * PostScript names, because the host inventory decides which Songti cut
 * CoreText nominates and a dev Mac and the CI runner disagree on that.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __characterFallbackDocumentCacheForTest,
  __characterFallbackIdentityForTest,
  __resolveSystemFallbackKeyForCpForTest,
  beginCharacterFallbackDocument,
  clearFontResolutionCaches,
  clearCharacterFallbackRendererScopesForTest,
  createFontRendererSession,
  endCharacterFallbackDocument,
  getFontInstance,
  resolveFontKey,
  resolveFontSpec,
  selectCharacterFallbackRendererScope,
  withFontRendererSession,
} from "./font-resolution.js";
import { __fcFallbackRendererCacheForTest, isGlyphHelperAvailable } from "./glyph-helper.js";
import { isIdeographicCp } from "./unicode-classification.js";

const onDarwin = process.platform === "darwin" && isGlyphHelperAvailable();
const describeDarwin = onDarwin ? describe : describe.skip;

/** An Ext-A ideograph — covered by few cuts, so re-selection keeps the
 *  nominated face; the ticket's "first ideograph on a real CJK page". */
const EXT_A = 0x3400;
/** A common-Han ideograph most Songti cuts cover, including Black. */
const TARGET = 0x4e9f;

const glyphIdFor = (key: string, cp: number, weight: number): number => {
  const inst = getFontInstance(key, weight, 16, 0);
  return inst?.glyphForCodePoint?.(cp)?.id ?? 0;
};

const ask = (cp: number, weight = 800, primaryKey = resolveFontKey("serif")): string | null =>
  __resolveSystemFallbackKeyForCpForTest(cp, weight, 0, 16, primaryKey);

/** The document-cache key `characterFallbackDocKey` builds for serif at
 *  `weight` — the weight-matched base cut's PostScript name is part of it, so
 *  read it off the cache after a seeding ask rather than reconstructing it. */
function seededDocKey(): string {
  const cache = __characterFallbackDocumentCacheForTest();
  expect(cache).not.toBeNull();
  expect(cache!.size).toBe(1);
  return [...cache!.keys()][0];
}

afterEach(() => {
  // Close any scope a failing test left open; a leaked scope would make the
  // REMAINING tests order-dependent, which is the exact defect class under test.
  while (__characterFallbackDocumentCacheForTest() != null) endCharacterFallbackDocument();
  clearCharacterFallbackRendererScopesForTest();
});

describe("CharacterFallbackKey exact identity (DM-2401)", () => {
  const key = (weight = 400, slope = 0, orientation = 0, size = 16) =>
    __characterFallbackIdentityForTest("Times-Roman", weight, slope, orientation, size);

  it("uses Blink's quarter-unit raw weight and full raw slope", () => {
    expect(key()).toBe("Times-Roman|1600|0|0|16");
    expect(key(400, 14)).toBe("Times-Roman|1600|56|0|16");
    expect(key(400, 14.25)).toBe("Times-Roman|1600|57|0|16");
    expect(key(400, -12.5)).toBe("Times-Roman|1600|-50|0|16");
  });

  it("separates orientation, effective size, and weight independently", () => {
    const base = key();
    expect(key(400, 0, 3)).not.toBe(base);
    expect(key(400, 0, 0, 16.25)).not.toBe(base);
    expect(key(500)).not.toBe(base);
  });
});

describe("isIdeographicCp mirrors [:Ideographic=Yes:]", () => {
  it("accepts Han, Ext-A, compatibility ideographs, and the ideographic zero", () => {
    for (const cp of [0x3007, 0x4e00, 0x3400, 0x9fff, 0xf900, 0x20000]) {
      expect(isIdeographicCp(cp)).toBe(true);
    }
  });
  it("rejects kana, Hangul, Latin, and CJK punctuation that is not Ideographic", () => {
    for (const cp of [0x3042, 0xac00, 0x0041, 0x3001, 0x30fb]) {
      expect(isIdeographicCp(cp)).toBe(false);
    }
  });
});

describe("document scope lifecycle", () => {
  it("is closed by default and end() at depth zero is a safe no-op", () => {
    expect(__characterFallbackDocumentCacheForTest()).toBeNull();
    endCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()).toBeNull();
  });

  it("nests: inner begin/end pairs share the outermost map", () => {
    beginCharacterFallbackDocument();
    const outer = __characterFallbackDocumentCacheForTest();
    expect(outer).not.toBeNull();
    beginCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()).toBe(outer);
    endCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()).toBe(outer);
    endCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()).toBeNull();
  });

  it("each top-level scope starts empty — no state survives a document", () => {
    beginCharacterFallbackDocument();
    __characterFallbackDocumentCacheForTest()!.set("sentinel", "helvetica");
    endCharacterFallbackDocument();
    beginCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()!.size).toBe(0);
    endCharacterFallbackDocument();
  });

  it("reuses state only within the same owned renderer session", () => {
    const a = createFontRendererSession();
    const b = createFontRendererSession();
    withFontRendererSession(a, () => {
      beginCharacterFallbackDocument();
      __characterFallbackDocumentCacheForTest()!.set("sentinel", "pingfang-sc");
      endCharacterFallbackDocument();
    });
    withFontRendererSession(a, () => {
      beginCharacterFallbackDocument();
      expect(__characterFallbackDocumentCacheForTest()!.get("sentinel")).toBe("pingfang-sc");
      endCharacterFallbackDocument();
    });
    withFontRendererSession(b, () => {
      beginCharacterFallbackDocument();
      expect(__characterFallbackDocumentCacheForTest()!.has("sentinel")).toBe(false);
      endCharacterFallbackDocument();
    });
  });

  it("restores the previous selection so unrelated default renders stay isolated", () => {
    const session = createFontRendererSession();
    withFontRendererSession(session, () => {
      beginCharacterFallbackDocument();
      __characterFallbackDocumentCacheForTest()!.set("sentinel", "pingfang-sc");
      endCharacterFallbackDocument();
    });
    beginCharacterFallbackDocument();
    expect(__characterFallbackDocumentCacheForTest()!.has("sentinel")).toBe(false);
    endCharacterFallbackDocument();
  });
});

describe("Linux renderer fallback cache lifecycle", () => {
  it("is codepoint-only, survives memory trim, and isolates oracle renderer scopes", () => {
    beginCharacterFallbackDocument();
    selectCharacterFallbackRendererScope("en");
    const en = __fcFallbackRendererCacheForTest()!;
    en.set(0x4e00, null);
    // Locale is deliberately absent from this map's identity: within one
    // renderer, the first locale to ask owns this codepoint's answer.
    expect([...en.keys()]).toEqual([0x4e00]);
    clearFontResolutionCaches();
    expect(__fcFallbackRendererCacheForTest()!.has(0x4e00)).toBe(true);

    selectCharacterFallbackRendererScope("ja");
    expect(__fcFallbackRendererCacheForTest()!.has(0x4e00)).toBe(false);
    selectCharacterFallbackRendererScope("en");
    expect(__fcFallbackRendererCacheForTest()!.has(0x4e00)).toBe(true);
    endCharacterFallbackDocument();
    expect(__fcFallbackRendererCacheForTest()).toBeNull();
  });
});

describeDarwin("ideograph fallback answers (darwin, live helper)", () => {
  it("context-free asks are order-independent", () => {
    clearFontResolutionCaches();
    const a1 = ask(EXT_A);
    const t1 = ask(TARGET);
    clearFontResolutionCaches();
    const t2 = ask(TARGET);
    const a2 = ask(EXT_A);
    expect(t2).toBe(t1);
    expect(a2).toBe(a1);
  });

  it("within a document, the first ideograph's face answers every later one it covers", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    const first = ask(EXT_A);
    expect(first).not.toBeNull();
    const key = seededDocKey();
    const cache = __characterFallbackDocumentCacheForTest()!;
    expect(cache.get(key)).toBe(first);
    const second = ask(TARGET);
    if (glyphIdFor(first!, TARGET, 800) !== 0) {
      // Cached face covers it → the cached answer, NOT the context-free one.
      expect(second).toBe(first);
    }
    endCharacterFallbackDocument();
  });

  it("a later non-covered ideograph re-asks and NEVER overwrites (first writer wins)", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    // Seed the document's entry with a face that has NO CJK coverage at all.
    // Ask once to learn the real key, then plant the counterfeit.
    ask(EXT_A);
    const key = seededDocKey();
    const cache = __characterFallbackDocumentCacheForTest()!;
    cache.set(key, "helvetica");
    expect(glyphIdFor("helvetica", TARGET, 800)).toBe(0);
    const answer = ask(TARGET);
    // Coverage check failed → the raw (context-free) ask answered instead...
    clearFontResolutionCaches();
    endCharacterFallbackDocument();
    expect(answer).toBe(ask(TARGET));
    // ...and the entry was not replaced: WTF HashMap::insert "does nothing if
    // key is already present" (wtf/hash_map.h:184-188, tag 147.0.7727.15).
    expect(cache.get(key)).toBe("helvetica");
  });

  it("a planted covering face IS adopted on hit — the cache, not the cascade, answers", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    ask(EXT_A);
    const key = seededDocKey();
    const cache = __characterFallbackDocumentCacheForTest()!;
    cache.set(key, "pingfang-sc");
    expect(glyphIdFor("pingfang-sc", TARGET, 800)).not.toBe(0);
    expect(ask(TARGET)).toBe("pingfang-sc");
    endCharacterFallbackDocument();
  });

  it("documents are isolated: a fresh document re-derives from ITS OWN first ask", () => {
    clearFontResolutionCaches();
    const solo = ask(TARGET);
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    ask(EXT_A); // doc 1 seeds from Ext-A
    endCharacterFallbackDocument();
    beginCharacterFallbackDocument();
    // Doc 2 asks TARGET first — its answer must be the solo answer, untouched
    // by doc 1's seed (this is sweep-order independence across documents).
    expect(ask(TARGET)).toBe(solo);
    endCharacterFallbackDocument();
  });

  it("survives clearFontResolutionCaches(): modeled state is not a memo", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    const first = ask(EXT_A);
    const key = seededDocKey();
    clearFontResolutionCaches(); // the oracle's periodic memory trim
    const cache = __characterFallbackDocumentCacheForTest()!;
    expect(cache.get(key)).toBe(first);
    if (first != null && glyphIdFor(first, TARGET, 800) !== 0) {
      expect(ask(TARGET)).toBe(first);
    }
    endCharacterFallbackDocument();
  });

  it("non-ideographic codepoints never touch the document cache", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    ask(0x0634); // ARABIC LETTER SHEEN — reaches system fallback, not cached
    ask(0x3042); // HIRAGANA A — CJK block but Ideographic=No
    expect(__characterFallbackDocumentCacheForTest()!.size).toBe(0);
    endCharacterFallbackDocument();
  });

  it("a system-ui base is never cached (no CharacterFallbackKey for the UI font)", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    __resolveSystemFallbackKeyForCpForTest(TARGET, 400, 0, 16, resolveFontKey("system-ui"), true);
    expect(__characterFallbackDocumentCacheForTest()!.size).toBe(0);
    endCharacterFallbackDocument();
  });

  it("the cache key carries the weight-matched base cut, per CharacterFallbackKey::Make", () => {
    clearFontResolutionCaches();
    beginCharacterFallbackDocument();
    ask(EXT_A, 800);
    const key = seededDocKey();
    const spec = resolveFontSpec(resolveFontKey("serif"));
    // At 800 the base is the BOLD cut of the primary, not the family's base
    // entry — Blink keys on `platform_data.CtFont()`'s PostScript name, the
    // face MatchFontFamily selected at the CSS weight.
    expect(key).toContain("|3200|"); // FontSelectionValue::RawValue() = CSS weight × 4
    expect(key.split("|")[0]).not.toBe("");
    const boldCutPs = getFontInstance(resolveFontKey("serif"), 800, 16, 0)?.postscriptName;
    if (boldCutPs != null && boldCutPs !== spec?.postscriptName) {
      expect(key.split("|")[0]).toBe(boldCutPs);
    }
    endCharacterFallbackDocument();
  });
});
