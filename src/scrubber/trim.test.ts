import { describe, expect, it } from "vitest";
import { trimAnimatedSvg } from "./trim.js";

// Minimal SVG mixing a CSS multi-animation shorthand (like `domotion animate` /
// the htmx demo) and SMIL — both must re-base to the in-point.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<style>
@keyframes fv-0 { 0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } }
@keyframes fd-0 { 0%,49% { visibility: visible } 50%,to { visibility: hidden } }
.box { animation: fv-0 4s infinite, fd-0 4s infinite step-end; }
</style>
<rect class="box" width="10" height="10" fill="red"/>
<circle r="4"><animateTransform attributeName="transform" type="translate" values="0,0;40,0" dur="4s" repeatCount="indefinite"/></circle>
<circle r="2"><animate attributeName="opacity" values="0;1;0" dur="0.5s" begin="1.85s" fill="freeze"/></circle>
</svg>`;

describe("trimAnimatedSvg — negative-time-shift re-basing (DM-1045)", () => {
  it("re-bases CSS by appending a negative animation-delay + fill:both AFTER the shorthand", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000); // in-point at 1s
    expect(r.svg).toMatch(/animation:\s*fv-0 4s infinite, fd-0 4s infinite step-end;animation-delay:-1s;animation-fill-mode:both/);
    expect(r.shiftedCss).toBe(1);
  });

  it("leaves the @keyframes byte-for-byte intact (no fragile keyframe surgery)", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    expect(r.svg).toContain("@keyframes fv-0 { 0% { opacity: 0 } 50% { opacity: 1 } 100% { opacity: 0 } }");
    expect(r.svg).toContain("@keyframes fd-0 { 0%,49% { visibility: visible } 50%,to { visibility: hidden } }");
  });

  it("shifts a SMIL begin by -t0", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000); // 1.85s - 1s = 0.85s
    expect(r.svg).toMatch(/begin="0\.85s"/);
    expect(r.shiftedSmil).toBe(2);
  });

  it("gives a SMIL element with no begin an explicit negative begin", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    // the animateTransform had no begin → default 0 → -1s
    expect(r.svg).toMatch(/<animateTransform[^>]*\bbegin="-1s"/);
  });

  it("leaves SMIL dur / values untouched", () => {
    const r = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    expect(r.svg).toContain(`values="0,0;40,0"`);
    expect(r.svg).toContain(`dur="4s"`);
    expect(r.svg).toContain(`dur="0.5s"`);
  });

  it("does NOT shift an event/syncbase begin", () => {
    const svg = SVG.replace('begin="1.85s"', 'begin="click"');
    const r = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(r.svg).toContain('begin="click"');
  });

  it("is a no-op when the in-point is 0", () => {
    const r = trimAnimatedSvg(SVG, 0, 2000, 4000);
    expect(r.svg).toBe(SVG);
    expect(r.shiftedCss).toBe(0);
    expect(r.shiftedSmil).toBe(0);
  });

  it("normalizes the in-point to min(start, end)", () => {
    const a = trimAnimatedSvg(SVG, 3000, 1000, 4000);
    const b = trimAnimatedSvg(SVG, 1000, 3000, 4000);
    expect(a.svg).toBe(b.svg); // both re-base to 1s
  });

  it("handles ms units in a SMIL begin", () => {
    const svg = SVG.replace('begin="1.85s"', 'begin="1850ms"');
    const r = trimAnimatedSvg(svg, 1000, 3000, 4000);
    expect(r.svg).toMatch(/begin="0\.85s"/); // 1850ms - 1000ms = 850ms
  });
});
