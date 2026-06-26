import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DM-1409: the showcase transition mini-demos must show motion in BOTH directions
// — a regression where the incoming frame doesn't slide/fade IN (only the outgoing
// slides OUT) makes push-left look like a cut, scroll reveal empty space, and
// crossfade dip to black. Guard each committed demo for the keyframes that prove
// the incoming frame animates in.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demo = (name: string) => resolve(ROOT, `examples/output/transition-${name}.svg`);

describe("showcase transition mini-demos (DM-1409)", () => {
  it("all four demos exist", () => {
    for (const n of ["crossfade", "pushleft", "scroll", "magicmove"]) {
      expect(existsSync(demo(n)), `missing transition-${n}.svg`).toBe(true);
    }
  });

  it("push-left slides BOTH in (from the right) and out (to the left)", () => {
    const svg = readFileSync(demo("pushleft"), "utf8");
    expect(svg, "no slide-IN keyframe (incoming frame doesn't enter)").toContain("translateX(560px)");
    expect(svg, "no slide-OUT keyframe").toContain("translateX(-560px)");
  });

  it("scroll slides BOTH in (from below) and out (upward)", () => {
    const svg = readFileSync(demo("scroll"), "utf8");
    expect(svg, "no slide-IN keyframe (nothing rises from below)").toContain("translateY(340px)");
    expect(svg, "no slide-OUT keyframe").toContain("translateY(-340px)");
  });

  it("crossfade fades both in and out (opacity 0 ↔ 1)", () => {
    const svg = readFileSync(demo("crossfade"), "utf8");
    expect(svg).toContain("opacity:0");
    expect(svg).toContain("opacity:1");
  });
});
