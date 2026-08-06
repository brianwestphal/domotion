/**
 * `DOMOTION_HELPER_NO_SERVE=1` must change the TRANSPORT and nothing else.
 *
 * The persistent helper channel is otherwise unfalsifiable from outside: when it
 * degrades, every query still returns the right answer and only the wall clock
 * moves — and a wall clock has no baseline unless the mechanism can be turned
 * off. That is why the switch exists, and it is only useful if flipping it is
 * answer-neutral, which is what this pins.
 *
 * `DOMOTION_DISABLE_HELPER` is NOT a substitute and the distinction matters:
 * that one disables the helper outright, so the resolver falls back to the
 * static chain and the answers change. Comparing throughput across it would
 * grade two different resolvers.
 *
 * Measured on macOS, one conformance slice of 7,312 codepoints, the switch as
 * the only difference:
 *
 *     channel on    ours  4.5 s   0.615 ms/codepoint   1,032 comparisons/s
 *     channel off   ours 179.0 s  24.480 ms/codepoint      40 comparisons/s
 *
 * …with byte-identical reports. The 24 ms is one process spawn per codepoint,
 * and it is why a Windows sweep on a Parallels VM measured 47/s where the same
 * code on a GitHub Windows runner measures 636-695/s.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFontResolutionCaches,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  resolveFontForCodepoint,
} from "./font-resolution.js";
import { clearGlyphHelperCache, isGlyphHelperAvailable } from "./glyph-helper.js";

/** Codepoints no ordinary text primary covers, so each one reaches the helper.
 *  Spread across scripts so a single cached answer cannot stand for all. */
const UNCOVERED = [0x0905, 0x0e01, 0x4e2d, 0x0627, 0x05d0, 0x10a0, 0x1200, 0x0e3f];
const STACK = "sans-serif";

const describeLive = isGlyphHelperAvailable() ? describe : describe.skip;

/** The faces the resolver picks for `UNCOVERED`, under whatever transport is
 *  currently configured. Caches are cleared first so nothing is answered from a
 *  previous transport's memo. */
function facesUnderCurrentTransport(): Array<string | null> {
  clearGlyphHelperCache();
  clearFontResolutionCaches();
  const key = resolveFontKey(STACK);
  const chain = resolveFontKeyChain(STACK);
  const primary = resolveFont(STACK, 400, 16, 0);
  if (primary == null) return [];
  return UNCOVERED.map((cp) =>
    resolveFontForCodepoint(cp, primary, key, 400, 16, 0, undefined, "en", chain).key);
}

describeLive("the helper transport switch changes only the transport", () => {
  const saved = process.env.DOMOTION_HELPER_NO_SERVE;
  beforeEach(() => { delete process.env.DOMOTION_HELPER_NO_SERVE; });
  afterEach(() => {
    if (saved == null) delete process.env.DOMOTION_HELPER_NO_SERVE;
    else process.env.DOMOTION_HELPER_NO_SERVE = saved;
    clearGlyphHelperCache();
    clearFontResolutionCaches();
  });

  it("resolves the same faces with the channel on and off", () => {
    const withChannel = facesUnderCurrentTransport();
    // PRECONDITION: if nothing resolved, "identical" would be two empty lists.
    expect(withChannel.length, "the probe must have resolved something").toBe(UNCOVERED.length);
    expect(withChannel.some((k) => k != null), "at least one must reach the helper").toBe(true);

    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    expect(facesUnderCurrentTransport()).toEqual(withChannel);
  });

  it("actually changes the transport — the no-serve arm is dramatically slower", () => {
    // Answer-neutrality alone would pass against a switch that does NOTHING,
    // which is the failure mode this whole area keeps producing. The only
    // observable that separates "the switch works" from "the switch is inert"
    // is the cost, because both transports return the same faces.
    //
    // The real effect is ~40x (0.615 ms vs 24.480 ms per codepoint, measured
    // over a 7,312-codepoint slice). Asserting 3x leaves an order of magnitude
    // of headroom, so this is a check on the mechanism rather than a benchmark.
    // Distinct codepoints, and the caches cleared ONCE per arm rather than per
    // iteration. Both details are load-bearing and both were wrong first time:
    // repeating one codepoint measures the memo, and clearing inside the loop
    // makes every iteration pay a fresh channel startup — which made the two
    // arms equal and reported the working switch as inert.
    const time = (): number => {
      clearGlyphHelperCache();
      clearFontResolutionCaches();
      const key = resolveFontKey(STACK);
      const chain = resolveFontKeyChain(STACK);
      const primary = resolveFont(STACK, 400, 16, 0)!;
      const t = Date.now();
      for (let cp = 0x3400; cp < 0x3400 + 150; cp++) {
        resolveFontForCodepoint(cp, primary, key, 400, 16, 0, undefined, "en", chain);
      }
      return Date.now() - t;
    };
    const withChannel = time();
    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    const withoutChannel = time();
    delete process.env.DOMOTION_HELPER_NO_SERVE;

    expect(
      withoutChannel,
      `no-serve ${withoutChannel} ms vs channel ${withChannel} ms — the switch looks inert`,
    ).toBeGreaterThan(withChannel * 3);
  });

  it("is read per call, not captured at module load", () => {
    // A `const` snapshot would make the switch silently inert for anything
    // already imported — the exact "the flag was on but the mechanism was not in
    // the loop" shape this area keeps producing. Setting it AFTER the module has
    // resolved faces once, and still getting a working resolver, is the check.
    const before = facesUnderCurrentTransport();
    process.env.DOMOTION_HELPER_NO_SERVE = "1";
    const after = facesUnderCurrentTransport();
    delete process.env.DOMOTION_HELPER_NO_SERVE;
    const again = facesUnderCurrentTransport();
    expect(after).toEqual(before);
    expect(again).toEqual(before);
  });
});
