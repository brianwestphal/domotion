import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { optimizeSvg } from "./optimize.js";
import { gzipSvg } from "./gzip.js";

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- comment that svgo strips -->
  <path d="M 10.123456 10.123456 L 20.123456 20.123456 L 30.123456 10.123456 Z" fill="red"/>
  <path d="M 10.987654 50.987654 L 90.987654 50.987654" stroke="blue" stroke-width="2"/>
</svg>`;

describe("optimizeSvg", () => {
  it("shortens path data and removes comments", () => {
    const out = optimizeSvg(SAMPLE_SVG);
    expect(out).not.toContain("comment that svgo strips");
    expect(out.length).toBeLessThan(SAMPLE_SVG.length);
    expect(out).toMatch(/<path\b/);
  });

  it("DM-1205: preserves a tiny non-zero width in CSS (does not round 0.01px to 0)", () => {
    // The typewriter reveal hides not-yet-typed lines with a sub-pixel clip
    // width to dodge WebKit's empty-clip-path bug. minifyStyles must keep it
    // non-zero — rounding it to `width:0` would reintroduce the Safari bug.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>@keyframes r{0%{width:0.01px}100%{width:50px}}</style><rect width="0.01px" height="10"/></svg>`;
    const out = optimizeSvg(svg);
    expect(out).not.toMatch(/width:\s*0\s*[;}]/);
    expect(out).toMatch(/width:\s*\.?0?\.0\d*px/);
  });
});

describe("gzipSvg", () => {
  it("returns a Buffer whose gunzipped payload is the original SVG", () => {
    const buf = gzipSvg(SAMPLE_SVG);
    expect(Buffer.isBuffer(buf)).toBe(true);
    const round = gunzipSync(buf).toString("utf8");
    expect(round).toBe(SAMPLE_SVG);
  });

  it("starts with the gzip magic bytes (1F 8B)", () => {
    const buf = gzipSvg(SAMPLE_SVG);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it("compresses to substantially fewer bytes than the source", () => {
    const buf = gzipSvg(SAMPLE_SVG);
    expect(buf.length).toBeLessThan(SAMPLE_SVG.length);
  });

  it("compresses an svgo'd SVG even smaller", () => {
    const optimized = optimizeSvg(SAMPLE_SVG);
    const rawGz = gzipSvg(SAMPLE_SVG).length;
    const optGz = gzipSvg(optimized).length;
    expect(optGz).toBeLessThanOrEqual(rawGz);
  });
});
