// The macOS helper's `familyMatch` query — Blink's declared-family style
// matcher, ported from `mac/font_matcher_mac.mm` (Chromium rev 7d859f27).
//
// These pin the cases that DISCRIMINATE between candidate mechanisms, not a
// broad sample. Three different approaches to this problem all scored 6/7 on
// PingFang SC, every one of them failing the same rung, so the value of a test
// here is entirely in covering that rung rather than the six that agree no
// matter what you do.
//
// macOS-gated: the query enumerates through AppKit and the expected answers are
// Chrome-on-macOS's, established over CDP.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The SHIPPED binary first — the same one `__helperBinaryForPlatform("darwin")`
// resolves, so this runs for anyone who has built the helper rather than only
// for whoever last ran `swift build`. The debug build is the fallback so the
// test is usable mid-iteration.
const SHIPPED = resolve(__dirname, "..", "tools", "macos-glyph-extractor", "domotion-glyph-paths");
const DEBUG = resolve(__dirname, "..", "tools", "macos-glyph-extractor", ".build", "debug", "DomotionGlyphPaths");
const BIN = existsSync(SHIPPED) ? SHIPPED : DEBUG;
const available = process.platform === "darwin" && existsSync(BIN);
const describeMac = available ? describe : describe.skip;

interface Candidate { name: string; weight: number; descriptorWeight: number; appKitWeight: number }

function familyMatch(family: string, cssWeight: number, opts: { italic?: boolean; bold?: boolean } = {}) {
  const out = execFileSync(BIN, {
    input: JSON.stringify({ fonts: [], queries: [{ type: "familyMatch", family, cssWeight, ...opts }] }),
    encoding: "utf-8",
  });
  return JSON.parse(out).results[0] as
    { found: boolean; postscriptName?: string; weight?: number; candidates?: Candidate[] };
}

describeMac("declared-family style matcher", () => {
  it("reproduces Chrome's PingFang SC ladder, including the rung that discriminates", () => {
    // w300 is the whole point. PingFang SC has both a Thin and a Light, and
    // whether you land on Thin decides which weight SOURCE you are using:
    // AppKit reports both as 3 (→ CSS 200, tie, first-scanned wins → Thin),
    // while the CoreText descriptor separates them (Thin 200, Light 300) and so
    // picks Light for an exact match. Chrome paints Thin.
    const ladder: Array<[number, string]> = [
      [100, "PingFangSC-Ultralight"],
      [200, "PingFangSC-Thin"],
      [300, "PingFangSC-Thin"],
      [400, "PingFangSC-Regular"],
      [500, "PingFangSC-Medium"],
      [600, "PingFangSC-Semibold"],
      [700, "PingFangSC-Semibold"],
      [900, "PingFangSC-Semibold"],
    ];
    for (const [w, expected] of ladder) {
      expect(familyMatch("PingFang SC", w).postscriptName, `weight ${w}`).toBe(expected);
    }
  });

  it("keeps the two weight sources visibly distinct rather than silently agreeing", () => {
    // The response reports both, so the drift between the local Chromium
    // checkout (which prefers the descriptor) and the shipping Chrome (which
    // does not) stays observable. If these ever became equal for PingFang the
    // test above would still pass while having stopped testing anything.
    const r = familyMatch("PingFang SC", 300);
    const byName = new Map((r.candidates ?? []).map((c) => [c.name, c]));
    const thin = byName.get("PingFangSC-Thin")!;
    const light = byName.get("PingFangSC-Light")!;
    expect(thin.appKitWeight).toBe(light.appKitWeight);      // AppKit collapses them
    expect(thin.descriptorWeight).not.toBe(light.descriptorWeight); // the descriptor does not
    expect(thin.weight).toBe(light.weight);                  // we use AppKit's, so they tie
  });

  it("reproduces Hiragino Sans's seven distinct cuts", () => {
    // A family with no ties anywhere, so it exercises the ordinary path — and a
    // seven-rung ladder is the case a two-slot key pair cannot represent at all,
    // which is what this matcher exists to replace.
    const ladder: Array<[number, string]> = [
      [100, "HiraginoSans-W0"], [300, "HiraginoSans-W3"], [400, "HiraginoSans-W4"],
      [500, "HiraginoSans-W5"], [600, "HiraginoSans-W6"], [700, "HiraginoSans-W7"],
      [900, "HiraginoSans-W9"],
    ];
    for (const [w, expected] of ladder) {
      expect(familyMatch("Hiragino Sans", w).postscriptName, `weight ${w}`).toBe(expected);
    }
  });

  it("prefers a non-italic face when none was asked for, and the italic when it was", () => {
    // `BetterChoiceCT`'s trait-precedence loop. Asserting both directions,
    // because "always picks the roman" would satisfy the first half alone.
    expect(familyMatch("Avenir Next", 400).postscriptName).toBe("AvenirNext-Regular");
    expect(familyMatch("Avenir Next", 400, { italic: true }).postscriptName).toBe("AvenirNext-Italic");
  });

  it("declines a family that is not installed", () => {
    // Must report rather than guess: a silently wrong face is the failure mode
    // this whole area is removing, and the caller keeps its existing selection.
    expect(familyMatch("No Such Family At All", 400).found).toBe(false);
  });
});
