import { describe, expect, it } from "vitest";
import { trimAnimatedSvg } from "./trim.js";

// A minimal animated SVG mirroring `domotion animate` output: one @keyframes
// driving opacity + transform, applied with the `animation` shorthand.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<style>
@keyframes fade { 0% { opacity: 0; transform: translateX(0px) } 50% { opacity: 1; transform: translateX(20px) } 100% { opacity: 0; transform: translateX(40px) } }
.box { animation: fade 4s linear infinite; }
</style>
<rect class="box" width="10" height="10" fill="red"/>
</svg>`;

describe("trimAnimatedSvg (DM-1040)", () => {
  it("rewrites the @keyframes and reports the animation name", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000); // window [25%, 75%] of a 4s loop
    expect(r.rewrittenAnimations).toEqual(["fade"]);
    expect(r.svg).toContain("@keyframes fade");
    expect(r.svg).toMatch(/0%\s*\{/);
    expect(r.svg).toMatch(/100%\s*\{/);
  });

  it("sets the animation duration to the window length", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000); // 2s window
    // The `animation` shorthand's first <time> becomes the window length.
    expect(r.svg).toMatch(/animation:\s*fade\s+2s/);
  });

  it("synthesises a boundary stop at the in-point with interpolated values", () => {
    // f0 = 0.25 → between 0% (opacity 0, tx 0) and 50% (opacity 1, tx 20):
    // halfway → opacity 0.5, translateX(10px).
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    const kf = r.svg.match(/@keyframes fade \{([\s\S]*?)\n\}/)![1];
    const firstStop = kf.trim().split("\n")[0];
    expect(firstStop).toMatch(/^\s*0%/);
    expect(firstStop).toContain("opacity: 0.5");
    expect(firstStop).toContain("translateX(10px)");
  });

  it("synthesises a boundary stop at the out-point", () => {
    // f1 = 0.75 → between 50% (opacity 1, tx 20) and 100% (opacity 0, tx 40):
    // halfway → opacity 0.5, translateX(30px).
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    const kf = r.svg.match(/@keyframes fade \{([\s\S]*?)\n\}/)![1];
    const lastStop = kf.trim().split("\n").pop()!;
    expect(lastStop).toMatch(/100%/);
    expect(lastStop).toContain("opacity: 0.5");
    expect(lastStop).toContain("translateX(30px)");
  });

  it("remaps an interior stop into the window", () => {
    // The original 50% stop sits at 0.5; window [0.25, 0.75] → (0.5-0.25)/0.5 = 50%.
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    const kf = r.svg.match(/@keyframes fade \{([\s\S]*?)\n\}/)![1];
    expect(kf).toMatch(/50%\s*\{[^}]*translateX\(20px\)/);
  });

  it("is a no-op when the period is unknown (0)", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 0);
    expect(r.svg).toBe(SVG);
    expect(r.rewrittenAnimations).toEqual([]);
  });

  it("handles explicit animation-duration / -delay longhands", () => {
    const svg = SVG.replace(".box { animation: fade 4s linear infinite; }",
      ".box { animation-name: fade; animation-duration: 4s; animation-delay: 1s; animation-iteration-count: infinite; }");
    const r = trimAnimatedSvg(svg, 0, 2000, 4000);
    expect(r.svg).toMatch(/animation-duration:\s*2s/);
    expect(r.svg).toMatch(/animation-delay:\s*0s/);
  });

  it("zeroes the delay in the shorthand form too", () => {
    const svg = SVG.replace("animation: fade 4s linear infinite;", "animation: fade 4s linear 0.5s infinite;");
    const r = trimAnimatedSvg(svg, 0, 2000, 4000);
    // duration → 2s, the 0.5s delay → 0s
    expect(r.svg).toMatch(/animation:\s*fade\s+2s\s+linear\s+0s\s+infinite/);
  });
});
