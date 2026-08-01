/**
 * DM-1879: the `system-ui` per-codepoint cascade, pinned by ASSERTING THE FACE
 * rather than by diffing pixels.
 *
 * The ticket asked for a visual fixture, on the reasoning that CJK is "where
 * Apple's UI optical cuts diverge most visibly". That reasoning is wrong on the
 * axis that a pixel diff can see. CJK ideographs are full-width, so every
 * optical cut of PingFang gives an advance of essentially 1 em:
 *
 *     .PingFangUITextSC-Regular      advance 1020.01 / upem 1028
 *     .PingFangUIDisplaySC-Regular   advance 1018.99 / upem 1064
 *
 * A wrong cut therefore produces **no layout shift at all** — only a small
 * stroke-weight difference, which is exactly what the suite's antialiasing
 * tolerance is built to absorb. Measured: the `text-system-ui-cjk-fallback`
 * fixture scores 0 regions / 0.00% both with and without the two fixes that
 * this cascade motivated (the macOS `opsz` application and the optically
 * size-dependent face handling), and it also passes while resolving one of the
 * five cases to the wrong cut.
 *
 * So the fixture is worth keeping as a gross-breakage guard (tofu, a missing
 * face, a collapsed cascade) but it is NOT a regression guard for cut
 * selection. This file is. Each expectation is Chrome's own answer, read from
 * `CSS.getPlatformFontsForNode` via CDP on macOS 26.5.2 with a `system-ui`
 * stack painting U+4E2D.
 */
import { describe, expect, it } from "vitest";

import { getFontInstance, resolveFontForCodepoint, resolveFontKey } from "./font-resolution.js";

const onDarwin = process.platform === "darwin";
const describeDarwin = onDarwin ? describe : describe.skip;

/** The face our cascade picks for U+4E2D under a `system-ui` primary. */
function resolvedFace(size: number, weight: number, slant = 0): string | undefined {
  const primaryKey = resolveFontKey("system-ui");
  const primary = getFontInstance(primaryKey, weight, size, slant);
  if (primary == null) return undefined;
  const r = resolveFontForCodepoint(
    0x4e2d, primary, primaryKey, weight, size, slant, undefined, undefined, [],
    true, // the run's primary is the `system-ui` KEYWORD — the UI-font base
  );
  return r?.key;
}

describeDarwin("system-ui CJK cascade picks Chrome's optical cut (DM-1879)", () => {
  it("resolves system-ui to sf-pro, which does NOT cover the codepoint", () => {
    // The precondition the rest of the file depends on. If the primary ever
    // covered U+4E2D, per-codepoint fallback would not run and every
    // expectation below would pass vacuously.
    const key = resolveFontKey("system-ui");
    expect(key).toBe("sf-pro");
    expect(getFontInstance(key, 400, 13, 0)?.glyphForCodePoint?.(0x4e2d)?.id).toBe(0);
  });

  it("13px / 400 → the TEXT cut", () => {
    expect(resolvedFace(13, 400)).toBe("sysfb:.PingFangUITextSC-Regular");
  });

  it("20px / 400 → the DISPLAY cut", () => {
    // The size threshold: same weight, different optical cut. A cascade that
    // ignored size would answer Text here.
    expect(resolvedFace(20, 400)).toBe("sysfb:.PingFangUIDisplaySC-Regular");
  });

  it("20px / 700 → the DISPLAY bold cut", () => {
    expect(resolvedFace(20, 700)).toBe("sysfb:.PingFangUIDisplaySC-Bold");
  });

  it("13px / 400 italic → DISPLAY, because PingFang has no italic", () => {
    // Chrome jumps Text→Display here. Worth pinning precisely because it looks
    // like a bug until you check it against Chrome.
    expect(resolvedFace(13, 400, 1)).toBe("sysfb:.PingFangUIDisplaySC-Regular");
  });

  it("13px / 700 → the TEXT bold cut", () => {
    // Was the one wrong answer of the five, and the reason was not weight
    // mapping but a CACHE KEY: the helper keyed its base font on
    // (postscriptName, path, size, variations) and omitted the `system-ui` CSS
    // parameters, which are what `matchSystemUIFont` derives the bold/italic
    // traits and the `wght` variation from. See the order test below.
    expect(resolvedFace(13, 700)).toBe("sysfb:.PingFangUITextSC-Bold");
  });

  // The defect was ORDER-DEPENDENT, so a per-case assertion cannot pin it: each
  // of the five cases above passes on its own in a fresh process, because the
  // first ask at a given size is always correct. It is the SECOND ask at the
  // same size that got the first one's face. Measured before the fix:
  //
  //     regular first:  13/400 -> Text-Regular  OK    13/700 -> Display-Bold   WRONG
  //     bold first:     13/700 -> Text-Bold     OK    13/400 -> Display-Regular WRONG
  //
  // This is the transition-matrix case the project's testing philosophy calls
  // out: 100% line coverage from single-operation tests is structurally blind to
  // it, because every line still runs.
  it("gives the same answers whichever WEIGHT is asked first at a size", () => {
    // Ascending then descending, interleaved across two sizes, so a cache keyed
    // on too little has every chance to leak between them.
    const ascending = [
      resolvedFace(13, 400), resolvedFace(13, 700),
      resolvedFace(20, 400), resolvedFace(20, 700),
    ];
    const descending = [
      resolvedFace(20, 700), resolvedFace(20, 400),
      resolvedFace(13, 700), resolvedFace(13, 400),
    ].reverse();
    expect(ascending).toEqual(descending);
    expect(ascending).toEqual([
      "sysfb:.PingFangUITextSC-Regular",
      "sysfb:.PingFangUITextSC-Bold",
      "sysfb:.PingFangUIDisplaySC-Regular",
      "sysfb:.PingFangUIDisplaySC-Bold",
    ]);
  });

  // DM-1902: `slant` is the third parameter the base is built from, and it has
  // TWO sources on the helper side — an explicit `cssSlant`, or the older
  // boolean `italic`. Keying on the raw fields would have to know that; the
  // helper now keys on the RESOLVED value, from the same function that builds
  // the face, so the key cannot drift from the derivation again.
  //
  // Asserted in both orders for the same reason as the weight case: the first
  // ask at a given key is always correct, so a one-directional test proves
  // nothing about a cache.
  it("does not leak slant in either direction", () => {
    const italicThenUpright = [resolvedFace(13, 400, 1), resolvedFace(13, 400, 0)];
    const uprightThenItalic = [resolvedFace(13, 400, 0), resolvedFace(13, 400, 1)].reverse();
    expect(italicThenUpright).toEqual(uprightThenItalic);
    expect(italicThenUpright).toEqual([
      "sysfb:.PingFangUIDisplaySC-Regular",   // PingFang has no italic → Display
      "sysfb:.PingFangUITextSC-Regular",
    ]);
  });
});
