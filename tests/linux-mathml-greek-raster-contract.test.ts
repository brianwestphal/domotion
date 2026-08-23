import { describe, expect, it } from "vitest";

import {
  FREE_SANS_NOBLE_PACKAGE,
  LINUX_MATHML_GREEK_SUBSETS,
  LINUX_MATHML_GREEK_TOKENS,
  linuxMathmlGreekCellSha256,
  validateLinuxMathmlGreekPreterminalEvidence,
} from "../tools/linux-mathml-greek-raster-contract.js";
import { exactLinuxMathmlGreekPreterminal } from "./test-support/linux-mathml-greek-evidence.js";

describe("DM-2512 Linux MathML Greek source contract", () => {
  it("pins the independently authenticated Noble package, font, subsets, and cell", () => {
    expect(FREE_SANS_NOBLE_PACKAGE.version).toBe("20211204+svn4273-2");
    expect(FREE_SANS_NOBLE_PACKAGE.sha256).toBe("c8283ec9ca390e6ad8d2114cb0942182db62bb97f5142c2f955218fc5f2027b4");
    expect(FREE_SANS_NOBLE_PACKAGE.fontSha256).toBe("350badd6ab6a58e7fd7a0ea2ae0c10174941a08e1cd06b3c6010e10b3d5ae319");
    expect(LINUX_MATHML_GREEK_SUBSETS.hinted.sha256).not.toBe(LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256);
    expect(linuxMathmlGreekCellSha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts the exact pre-terminal seam without requiring paths provenance", () => {
    expect(validateLinuxMathmlGreekPreterminalEvidence(exactLinuxMathmlGreekPreterminal())).toEqual([]);
  });

  it.each([
    ["math-auto scalar", (value: any) => { value.tokens[0].transformed = "α"; }],
    ["selected face", (value: any) => { value.tokens[0].nativeFace.familyName = "Fallback Sans"; }],
    ["source gid", (value: any) => { value.tokens[0].glyph.gid++; }],
    ["source outline", (value: any) => { value.tokens[0].glyph.outlineSha256 = "f".repeat(64); }],
    ["capture-owned baseline", (value: any) => { value.tokens[0].geometry.baseline++; }],
    ["capture-owned matrix", (value: any) => { value.tokens[0].geometry.matrix[4] = 0.25; }],
    ["package bytes", (value: any) => { value.package.sha256 = "f".repeat(64); }],
    ["isolated inventory", (value: any) => { value.inventory.entries.push(value.inventory.entries[0]); }],
  ])("rejects hostile %s mutation", (_label, mutate) => {
    const value: any = structuredClone(exactLinuxMathmlGreekPreterminal()); mutate(value);
    expect(validateLinuxMathmlGreekPreterminalEvidence(value)).not.toEqual([]);
  });
});
