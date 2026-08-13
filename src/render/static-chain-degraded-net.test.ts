/**
 * The static fallback chain is a DEGRADED-MODE net on macOS/Linux, not a stage
 * Blink runs. `FontFallbackIterator::Next` walks kFontGroupFonts /
 * kSegmentedFace → (kFallbackPriorityFonts, one shot) → kSystemFonts →
 * kFirstCandidateForNotdefGlyph → kOutOfLuck
 * (`platform/fonts/shaping/font_fallback_iterator.cc:120-157`, Chromium rev
 * 7d859f27) — there is no per-Unicode-block table anywhere in that walk, so
 * whenever the live platform resolver is in the loop the chain must not
 * answer. Measured before the gate: over the darwin conformance corpus the
 * chain answered 6 of 916,119 system-stage decisions (0 of 779,964 on Linux),
 * every answer a variation selector routed to `u-noto-sans` — a divergence
 * from Chrome, not coverage.
 *
 * The chain is NOT deleted: a host without the glyph helper binary
 * (`DOMOTION_DISABLE_HELPER`, or an npm install with no prebuilt helper) or a
 * resolver flagged off (`DOMOTION_SYSTEM_FALLBACK=0`) has no live resolver,
 * and dropping the chain there would drop every fallback answer — the npm
 * package must still function on such a host. win32 is excluded from the gate
 * on purpose: there the hardcoded table IS Blink's mechanism, consulted
 * before DirectWrite (`win/font_cache_skia_win.cc:286-296`, rev 7d859f27).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  __resolveFontForCodepointForTest,
  darwinFallbackChain,
  fallbackFontChain,
  getFontInstance,
  getSystemFallbackResolution,
  withSystemFallbackResolution,
} from "./font-resolution.js";
import { isGlyphHelperAvailable } from "./glyph-helper.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "font-resolution.ts"), "utf-8");

/** U+0E01 THAI KO KAI — a fallback-only codepoint for a Helvetica /
 *  Liberation Sans primary on every calibrated platform, with a static-chain
 *  route (`thai`) on both darwin and linux. */
const THAI_KO_KAI = 0x0E01;

describe("static chain is a degraded-mode net — no such stage in FontFallbackIterator::Next (font_fallback_iterator.cc:120-157, rev 7d859f27)", () => {
  it("gates staticChain on helper absence / resolver-off, win32 excluded", () => {
    // Source pin, in the style of notdef-probe-question-parity.test.ts: the
    // gate is a predicate an integration test cannot vary (helper presence is
    // process-global and memoized), so pin the mechanism at the source level.
    const norm = SRC.replace(/\s+/g, " ");
    expect(norm).toContain(
      'const staticChainArmed = hostPlatform() === "win32" || !isGlyphHelperAvailable() || !_systemFallbackResolutionEnabled;',
    );
    expect(norm).toContain(
      "const staticChain = (): FontResolution | null => { if (!staticChainArmed) return null;",
    );
  });

  it.skipIf(getFontInstance("thai", 400, 16, 0) == null)("still answers from the static chain when the live resolver is out of the loop (the degraded net)", () => {
    // `withSystemFallbackResolution(false)` is the in-process analogue of
    // DOMOTION_SYSTEM_FALLBACK=0 / a helper-less host: the live resolver
    // declines everything, and the chain must catch what would otherwise drop
    // straight to tofu. Helvetica (darwin) / Liberation Sans (linux) lack
    // Thai; the calibrated chains route it.
    const off = withSystemFallbackResolution(false, () =>
      __resolveFontForCodepointForTest(THAI_KO_KAI, "Helvetica"));
    if (off == null) return; // host without the family; the source pin above still holds
    expect(off.covered).toBe(true);
    expect(off.key).toBe("thai");
  });

  it.runIf(isGlyphHelperAvailable() && getSystemFallbackResolution())(
    "the live resolver answers when it is in the loop, and the answer MOVES when it is disabled",
    () => {
      // The disable-and-require-movement check: a gate that silently disabled
      // everything would leave the two arms identical, exactly like a resolver
      // that was never in the loop. The arms must both answer and disagree.
      const on = __resolveFontForCodepointForTest(THAI_KO_KAI, "Helvetica");
      const off = withSystemFallbackResolution(false, () =>
        __resolveFontForCodepointForTest(THAI_KO_KAI, "Helvetica"));
      if (on == null || off == null) return; // host without the family
      expect(on.covered).toBe(true);
      expect(on.key.startsWith("sysfb:"), `live arm answered ${on.key}, not a live sysfb: face`).toBe(true);
      expect(off.key).toBe("thai");
      expect(on.key).not.toBe(off.key);
    },
  );

  it("routes no fallback face for a lone variation selector — hb_ot_hide_default_ignorables, hb-ot-shape.cc:824-846 (HarfBuzz rev 4de187d)", () => {
    // The shaper replaces default-ignorables with a zero-advance invisible
    // glyph (or deletes them) whatever the font's coverage says, so Chrome
    // never paints a substitute face for U+FE00-FE0F. The generated darwin
    // table's sampled `u-noto-sans` route for the block supplied the static
    // chain's only six system-stage answers on the darwin conformance corpus
    // — every one a divergence.
    for (const cp of [0xFE00, 0xFE05, 0xFE0E, 0xFE0F]) {
      expect(darwinFallbackChain(cp), `U+${cp.toString(16).toUpperCase()}`).toEqual([]);
    }
  });

  it("keeps fallbackFontChain itself ungated for its non-resolver consumers", () => {
    // Three call sites walk the chain outside the resolver's staticChain stage
    // (the uncovered-emoji terminal's advance pin, the dotted-circle U+25CC
    // advance candidates, the batch glyph-warm) and must keep receiving a
    // chain whatever the resolver's state — only the resolver's staticChain
    // STAGE is gated, never the chain function.
    const withResolver = fallbackFontChain(0x05D0);
    const withoutResolver = withSystemFallbackResolution(false, () => fallbackFontChain(0x05D0));
    expect(withResolver.length).toBeGreaterThan(0);
    expect(withResolver).toEqual(withoutResolver);
  });
});
