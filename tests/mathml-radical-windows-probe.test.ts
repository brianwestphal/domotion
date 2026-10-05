import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  expectedBarRows,
  paintedBarRows,
  parseRadicalBar,
  radicalProbeHtml,
  RADICAL_SIZES,
  RADICAL_STYLES,
} from "../tools/mathml-radical-windows-probe.js";

describe("DM-24GQD3 Windows radical probe", () => {
  it("asks the 14 native size/style questions and a direct math radical sign", () => {
    const html = radicalProbeHtml();
    for (const style of RADICAL_STYLES)
      for (const size of RADICAL_SIZES) expect(html).toContain(`id="radical-${style}-${size}"`);
    expect(html.match(/<msqrt/g)).toHaveLength(14);
    expect(html).toContain('id="math-radical-sign"');
  });

  it("distinguishes a snapped-away rect from a one- or two-row rule", () => {
    expect(parseRadicalBar('<g><use href="#g1"/></g>')).toBeNull();
    expect(expectedBarRows(null)).toEqual([]);
    expect(expectedBarRows(parseRadicalBar('<rect x="12" y="25" width="20" height="2" fill="black"/>'))).toEqual([
      25, 26,
    ]);
  });

  it("rejects sparse glyph ink below the bar while retaining a complete rule", () => {
    const width = 40;
    const height = 10;
    const rgb = new Uint8Array(width * height * 3).fill(255);
    for (let x = 20; x <= 35; x++) rgb.fill(0, (3 * width + x) * 3, (3 * width + x) * 3 + 3);
    for (let x = 33; x <= 35; x++) rgb.fill(0, (5 * width + x) * 3, (5 * width + x) * 3 + 3);
    expect(paintedBarRows(rgb, width, height, 37, 1, 8)).toEqual([3]);
  });

  it("uses the already registered manual Windows workflow with a probe-only route", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("radical_probe_only:");
    expect(workflow).toContain("mathml-radical-probe:");
    expect(workflow).toContain("tools/mathml-radical-windows-probe.ts");
    expect(workflow).toContain("mathml-radical-windows-rendered.png");
  });
});
