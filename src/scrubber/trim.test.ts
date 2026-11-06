import { describe, expect, it } from "vitest";
import { trimAnimatedSvg } from "./trim.js";

// Minimal SVG mixing a CSS multi-animation shorthand (period-spanning, like the
// htmx demo) and SMIL — a period-spanning cursor + a scheduled ripple.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<style>
@keyframes fv-0 { 0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } }
@keyframes fd-0 { 0%,49% { visibility: visible } 50%,to { visibility: hidden } }
.box { animation: fv-0 4s infinite, fd-0 4s infinite step-end; }
</style>
<rect class="box" width="10" height="10" fill="red"/>
<circle r="4"><animateTransform attributeName="transform" type="translate" values="0,0;40,0;80,0" keyTimes="0;0.5;1" dur="4s" repeatCount="indefinite"/></circle>
<circle r="2"><animate attributeName="opacity" values="0;1;0" dur="0.5s" begin="1.85s" fill="freeze"/></circle>
</svg>`;

describe("trimAnimatedSvg — window-slice + re-base (DM-1041)", () => {
  // Window [1000, 3000] of a 4000 period → f0=0.25, f1=0.75, win=2s.
  const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);

  it("classifies: period-spanning CSS + SMIL are SLICED, the ripple is re-based", () => {
    expect(r.slicedCss).toBe(1); // the one .box rule (both fv-0 + fd-0 period-spanning)
    expect(r.slicedSmil).toBe(1); // the cursor animateTransform
    expect(r.shiftedSmil).toBe(1); // the ripple
  });

  it("sets the sliced animation durations to the window length", () => {
    expect(r.svg).toMatch(/animation:\s*fv-0 2s infinite, fd-0 2s infinite step-end/);
  });

  it("slices the @keyframes to the window with synthesized boundary stops", () => {
    // fv-0 over [0.25,0.75]: at 0.25 → opacity 0.5 (lerp 0→1), 0.5→ remapped to
    // 50% (opacity 1), at 0.75 → opacity 0.5. opacity interpolates linearly.
    const fv = r.svg.match(/@keyframes fv-0 \{((?:[^{}]|\{[^{}]*\})*)\}/)![1];
    expect(fv).toContain("opacity: 0.5");
    expect(fv).toMatch(/50%\s*\{[^}]*opacity: 1/);
  });

  it("snaps discrete properties (step-end visibility) at the boundary", () => {
    // fd-0 visible 0..49%, hidden 50..100%. Window [25,75] → 0%:visible (snap),
    // the 50% flip remapped to 50%, 100%:hidden.
    const fd = r.svg.match(/@keyframes fd-0 \{((?:[^{}]|\{[^{}]*\})*)\}/)![1];
    expect(fd).toMatch(/0%\s*\{[^}]*visibility: visible/);
    expect(fd).toMatch(/100%\s*\{[^}]*visibility: hidden/);
    expect(fd).not.toContain("opacity"); // no spurious props
  });

  it("slices SMIL values/keyTimes to the window and sets dur to the window", () => {
    // cursor values 0,0;40,0;80,0 over keyTimes 0;0.5;1. Window [0.25,0.75] →
    // 20,0 (lerp at 0.25); 40,0 (the 0.5 stop → 50%); 60,0 (lerp at 0.75).
    expect(r.svg).toMatch(/values="20,0;40,0;60,0"/);
    expect(r.svg).toMatch(/keyTimes="0;0\.5;1"/);
    expect(r.svg).toMatch(/<animateTransform[^>]*\bdur="2s"/);
    expect(r.svg).toMatch(/<animateTransform[^>]*\bbegin="0s"/);
  });

  it("makes a scheduled ripple inside the window re-fire every loop, clipped", () => {
    // begin 1.85s, t0=1s → delta 0.85s (inside the 2s window). Self-syncbase
    // begin/end loop + fill:remove so it re-fires and clears each window.
    expect(r.svg).toMatch(/begin="0\.85s;\s*tw0\.begin\+2s"/);
    expect(r.svg).toMatch(/end="2s;\s*tw0\.end\+2s"/);
    expect(r.svg).toMatch(/<animate[^>]*\bfill="remove"/);
  });

  it("drops a scheduled animation that only fires after the window", () => {
    const svg = SVG.replace('begin="1.85s"', 'begin="3.5s"'); // delta 2.5 ≥ win 2 → never
    const out = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(out.svg).toMatch(/<animate[^>]*\bbegin="indefinite"/);
  });

  it("does NOT touch an event/syncbase begin", () => {
    const svg = SVG.replace('begin="1.85s"', 'begin="click"');
    const out = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(out.svg).toContain('begin="click"');
  });

  it("re-bases (not slices) a non-period CSS animation", () => {
    const svg = SVG.replace("animation: fv-0 4s infinite, fd-0 4s infinite step-end", "animation: fv-0 0.3s infinite"); // 0.3s ≠ 4s period → scheduled
    const out = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(out.shiftedCss).toBe(1);
    expect(out.slicedCss).toBe(0);
    expect(out.svg).toMatch(/animation-delay:-1s/);
    expect(out.svg).toMatch(/animation-fill-mode:both/);
  });

  it("is a no-op for the full range (in 0, out ≥ period)", () => {
    const out = trimAnimatedSvg(SVG, 0, 4000, 4000);
    expect(out.svg).toBe(SVG);
    expect(out.slicedCss + out.slicedSmil + out.shiftedCss + out.shiftedSmil).toBe(0);
  });
});

describe("trimAnimatedSvg — number formatting of synthesized values", () => {
  const smil = (values: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="4"><animateTransform attributeName="transform" type="translate" values="${values}" keyTimes="0;0.5;1" dur="4s" repeatCount="indefinite"/></circle></svg>`;

  it("writes a boundary value that rounds to zero as 0, never -0", () => {
    // The hand-rolled formatter this module used to carry turned -0.00001 into
    // "-0" (toFixed → "-0.0000" → trailing zeros stripped).
    const r = trimAnimatedSvg(smil("-0.00001,0;-0.00001,0;-0.00001,0"), 1000, 3000, 4000);
    expect(r.svg).toMatch(/values="0,0;/);
    expect(r.svg).not.toContain("-0,");
  });

  it("refuses to write a non-finite synthesized value instead of emitting NaN", () => {
    // 1e999 parses to Infinity; interpolating it yields NaN, which the old
    // formatter wrote straight into `values`.
    expect(() => trimAnimatedSvg(smil("1e999,0;1e999,0;1e999,0"), 1000, 3000, 4000)).toThrow(RangeError);
  });
});

// DM-NEV5JJ: the keyframe-stop parser used `/([^{}]+)\{([^{}]*)\}/g`, which
// backtracks quadratically through a long brace-free run inside a keyframes
// body that is not a stop's declaration block (40 KB took 5-6 s).
describe("trimAnimatedSvg keyframe parsing stays linear (DM-NEV5JJ)", () => {
  it("slices a keyframes body carrying a long brace-free run quickly", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>
@keyframes fv-0 { 0% { opacity: 0 } 100% { opacity: 1 } ${" ".repeat(400_000)}}
.box { animation: fv-0 4s infinite; }
</style><rect class="box" width="10" height="10"/></svg>`;
    const started = performance.now();
    const r = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(r.slicedCss).toBe(1);
    expect(r.svg.includes("@keyframes fv-0 {0% { opacity: 0.25 } 100% { opacity: 0.75 }}")).toBe(true);
  });
});
