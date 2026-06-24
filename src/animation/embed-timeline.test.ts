import { describe, it, expect } from "vitest";
import { offsetEmbeddedAnimatedSvgTimeline } from "./embed-timeline.js";

/** Minimal animated-SVG document mimicking a nested cast's `<style>`. */
function castDoc(periodS: number): string {
  const d = periodS.toFixed(3);
  return [
    "<svg>",
    "<style>",
    `.anim-ln0{animation:ln0o ${d}s step-end infinite}`,
    `.anim-ln1{animation:ln1o ${d}s step-end infinite,ln1t ${d}s linear infinite}`,
    `.tcur-b{animation:tcurb 1.06s step-end infinite}`,
    `@keyframes ln0o{0%{opacity:0}50%{opacity:1}100%{opacity:1}}`,
    `@keyframes ln1o{0%{opacity:0}25%{opacity:1}100%{opacity:1}}`,
    `@keyframes ln1t{0%{transform:translateY(0.00px)}75%{transform:translateY(-19.60px)}100%{transform:translateY(-19.60px)}}`,
    `@keyframes tcurb{0%{opacity:1}50%{opacity:0}100%{opacity:1}}`,
    "</style>",
    "<g class='content'></g>",
    "</svg>",
  ].join("\n");
}

describe("offsetEmbeddedAnimatedSvgTimeline", () => {
  it("retimes period-matched animations to the master period", () => {
    // Cast 4s, starting at 2s in a 10s master loop.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The line animations now run on the 10s master clock…
    expect(out).toContain("animation:ln0o 10s step-end infinite");
    expect(out).toContain("animation:ln1o 10s step-end infinite,ln1t 10s linear infinite");
    // …but the fixed cursor blink (1.06s) is left free-running, byte-for-byte.
    expect(out).toContain(".tcur-b{animation:tcurb 1.06s step-end infinite}");
  });

  it("remaps keyframe percentages into the [start, start+period] window", () => {
    // start 2s / master 10s → offset 20%; scale 4/10 = 0.4.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(4), { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    const ln0 = /@keyframes ln0o \{([^}]*\}[^@]*)\}/.exec(out)?.[0] ?? "";
    // Original 0% → 20%, 50% → 20% + 50*0.4 = 40%, 100% → 20% + 100*0.4 = 60%.
    expect(ln0).toContain("20%");
    expect(ln0).toContain("40%");
    expect(ln0).toContain("60%");
    // Plus a leading 0% hold (initial value) and a trailing 100% hold (final).
    expect(ln0).toMatch(/^@keyframes ln0o \{ 0% \{ opacity:0 \}/);
    expect(ln0).toMatch(/100% \{ opacity:1 \} \}$/);
  });

  it("leaves a keyframe's declaration percentages untouched (only stop selectors move)", () => {
    const doc = "<svg><style>.a{animation:k 4.000s linear infinite}@keyframes k{0%{width:10%}100%{width:90%}}</style></svg>";
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The declaration values (width:10% / width:90%) must survive verbatim.
    expect(out).toContain("width:10%");
    expect(out).toContain("width:90%");
  });

  it("is a no-op when the content already starts at the origin and fills the loop", () => {
    const doc = castDoc(10);
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 10000, startMs: 0, masterMs: 10000 });
    expect(out).toBe(doc);
  });

  it("clamps a cut-off cast (period longer than its visible window) to valid CSS", () => {
    // period 10s but only 4s of master remain from its 2s start → endPct would be
    // 20 + 100*1.0 = 120%; clamp to 100%.
    const out = offsetEmbeddedAnimatedSvgTimeline(castDoc(10), { periodMs: 10000, startMs: 2000, masterMs: 6000 });
    // No percentage selector should exceed 100%.
    const pcts = [...out.matchAll(/([\d.]+)% \{/g)].map((m) => parseFloat(m[1]));
    expect(Math.max(...pcts)).toBeLessThanOrEqual(100);
  });

  it("ignores documents with no embedded animation period match", () => {
    const doc = "<svg><style>.a{animation:k 1.06s linear infinite}@keyframes k{0%{opacity:0}100%{opacity:1}}</style></svg>";
    const out = offsetEmbeddedAnimatedSvgTimeline(doc, { periodMs: 4000, startMs: 2000, masterMs: 10000 });
    // The 1.06s animation doesn't match the 4s period — keyframe left intact.
    expect(out).toContain("@keyframes k{0%{opacity:0}100%{opacity:1}}");
  });
});
