/**
 * The primary font gets its DECOMPOSITION checks whether or not it also appears
 * in the declared family chain.
 *
 * `resolveFontForCodepointInner` tests the primary for literal cmap coverage in
 * its own fast path, but the two decomposition checks — the canonical NFD
 * singleton, and the base+mark decomposition shaped through HarfBuzz — used to
 * live ONLY in the chain walk. So a font received them only if it also appeared
 * in `fontKeyChain`, and the primary is absent from that chain exactly when the
 * chain is empty: `resolveFontKey` returns the first family name that matches
 * while `resolveFontKeyChain` collects every name that matches, so if any name
 * matched at all the resolved key is in the chain. The primary sits outside it
 * only when nothing matched and `resolveFontKey`'s standard-font terminal
 * supplied the answer — a terminal `resolveFontKeyChain` deliberately omits
 * ("callers append their own").
 *
 * Blink has no analogue of "decomposition applies only to chain members". It
 * consults each family through the same machinery however that family entered
 * the list, and HarfBuzz's normalizer decides per FONT, with no notion of how
 * that font was reached: `decompose_current_character`
 * (`external/harfbuzz/src/hb-ot-shape-normalize.cc:150-201`, rev `4de187d`)
 * takes the composed glyph when the current font has one and otherwise calls
 * `decompose`, whose branches are all gated on that same per-font lookup of the
 * decomposed PIECES (`:108-147`). The asymmetry was ours.
 *
 * The discriminating case is U+2249 ≉ NOT ALMOST EQUAL TO and its four siblings
 * U+226E/226F/2270/2271, under a bare `math` stack — no installed family
 * matches `math`, so the chain is empty and the key comes from the terminal.
 * Times has no precomposed ≉ but covers both NFD pieces (U+2248 ≈ + U+0338
 * combining long solidus overlay), and Chrome paints them as two Times glyphs.
 * Before the fix we skipped that check and dropped to CoreText's answer, Apple
 * Symbols — a different family, and five rows of the darwin conformance corpus.
 *
 * Asserting mere EQUALITY between the two arms would not have caught the defect
 * and would not catch its return: a regression that broke both arms identically
 * still reads as "same". So each case pins the expected face as well.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearFontResolutionCaches,
  getFontInstance,
  resolveFontForCodepoint,
  resolveFontKey,
} from "./font-resolution.js";

// Needs the real host font — the assertion is about Times' actual coverage.
const timesKey = resolveFontKey("Times");
const haveTimes = timesKey != null && getFontInstance(timesKey, 400, 16, 0) != null;

(haveTimes ? describe : describe.skip)("primary decomposition without a declared chain", () => {
  beforeEach(() => clearFontResolutionCaches());

  const resolve = (cp: number, chain: string[]) => {
    // A fresh instance per arm: the resolver may attach an override to the one
    // it is handed, so sharing would let the first arm colour the second.
    const inst = getFontInstance(timesKey!, 400, 16, 0)!;
    const r = resolveFontForCodepoint(cp, inst, timesKey!, 400, 16, 0, undefined, undefined, chain);
    return { key: r.key, decomposed: r.decomposed, covered: r.covered };
  };

  // Chrome's answer for all five, under a bare `math` stack, is Times-Roman
  // with glyphCount 2 — the base relation plus the combining solidus.
  const NEGATED_RELATIONS: Array<[number, string]> = [
    [0x2249, "≉ NOT ALMOST EQUAL TO"],
    [0x226e, "≮ NOT LESS-THAN"],
    [0x226f, "≯ NOT GREATER-THAN"],
    [0x2270, "≰ NEITHER LESS-THAN NOR EQUAL TO"],
    [0x2271, "≱ NEITHER GREATER-THAN NOR EQUAL TO"],
  ];

  for (const [cp, label] of NEGATED_RELATIONS) {
    it(`${label} decomposes within the primary with an empty chain`, () => {
      const withChain = resolve(cp, [timesKey!]);
      const noChain = resolve(cp, []);

      // The invariant: chain membership of the primary must not change the answer.
      expect(noChain).toEqual(withChain);

      // …and the answer itself, so a shared regression cannot pass as agreement.
      expect(noChain.key).toBe(timesKey);
      expect(noChain.decomposed).toBe(true);
      expect(noChain.covered).toBe(true);
    });
  }

  it("leaves a codepoint the primary cannot reach even by decomposition alone", () => {
    // U+21AE ↮ decomposes to U+2194 ↔ + U+0338, and macOS Times covers neither
    // piece — so the new block must fall through to the cascade exactly as the
    // chain walk does, rather than claiming coverage it does not have.
    const withChain = resolve(0x21ae, [timesKey!]);
    const noChain = resolve(0x21ae, []);
    expect(noChain).toEqual(withChain);
    expect(noChain.key).not.toBe(timesKey);
    expect(noChain.decomposed).toBe(false);
  });

  it("does not disturb a codepoint the primary covers literally", () => {
    // The step-0 fast path answers before the new block is reached; asserted so
    // a future edit that moves the block ahead of it shows up here.
    for (const cp of [0x0041, 0x00e9, 0x2248]) {
      const withChain = resolve(cp, [timesKey!]);
      const noChain = resolve(cp, []);
      expect(noChain).toEqual(withChain);
      expect(noChain.key).toBe(timesKey);
      expect(noChain.decomposed).toBe(false);
    }
  });
});

/**
 * The other decomposition path — the canonical NFD SINGLETON — needs a
 * different primary. macOS Times covers every singleton-decomposable codepoint
 * literally, so under `times` the step-0 fast path always answers first and the
 * singleton branch is unreachable; a test written on Times would have asserted
 * nothing about it. Courier is stock on every macOS install (so this does not
 * depend on the developer machine's font inventory, which is ~7× the CI
 * runner's) and lacks the Greek polytonic accents while covering their
 * single-codepoint decompositions.
 */
const courierKey = resolveFontKey("Courier");
const haveCourier = courierKey != null && getFontInstance(courierKey, 400, 16, 0) != null;

(haveCourier ? describe : describe.skip)("primary NFD singleton without a declared chain", () => {
  beforeEach(() => clearFontResolutionCaches());

  const resolve = (cp: number, chain: string[]) => {
    const inst = getFontInstance(courierKey!, 400, 16, 0)!;
    const r = resolveFontForCodepoint(cp, inst, courierKey!, 400, 16, 0, undefined, undefined, chain);
    return { key: r.key, decomposed: r.decomposed, covered: r.covered, emitCh: r.emitCh };
  };

  const SINGLETONS: Array<[number, number, string]> = [
    [0x1fef, 0x0060, "ὲ GREEK VARIA → GRAVE ACCENT"],
    [0x1ffd, 0x00b4, "´ GREEK OXIA → ACUTE ACCENT"],
    [0x0374, 0x02b9, "ʹ GREEK NUMERAL SIGN → MODIFIER LETTER PRIME"],
  ];

  for (const [cp, decomposed, label] of SINGLETONS) {
    it(`${label} decomposes within the primary with an empty chain`, () => {
      const withChain = resolve(cp, [courierKey!]);
      const noChain = resolve(cp, []);

      expect(noChain).toEqual(withChain);
      expect(noChain.key).toBe(courierKey);
      expect(noChain.decomposed).toBe(true);
      expect(noChain.covered).toBe(true);
      // The singleton path substitutes the emitted character, unlike the
      // base+mark path which keeps the source char and lets HarfBuzz decompose.
      expect(noChain.emitCh).toBe(String.fromCodePoint(decomposed));
    });
  }
});
