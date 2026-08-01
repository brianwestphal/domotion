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

  // Known divergence, filed separately. `it.fails` asserts it STILL diverges, so
  // this starts failing — loudly — the moment it is fixed, rather than quietly
  // enshrining the wrong answer as expected.
  it.fails("13px / 700 → the TEXT bold cut (we answer DISPLAY — known gap)", () => {
    expect(resolvedFace(13, 700)).toBe("sysfb:.PingFangUITextSC-Bold");
  });
});
