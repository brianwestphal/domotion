import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/linux-mathml-greek-raster-floor.yml", "utf8");
const collector = readFileSync("tools/linux-mathml-greek-raster-collector.ts", "utf8");
const contract = readFileSync("tools/linux-mathml-greek-raster-contract.ts", "utf8");
const gate = readFileSync("tools/linux-mathml-greek-raster-gate.ts", "utf8");
const coreCorpus = readFileSync("tools/paths-native-raster-corpus.ts", "utf8");
const coreWorkflow = readFileSync(".github/workflows/paths-native-raster-floor.yml", "utf8");

describe("DM-2512 isolated Linux MathML raster workflow", () => {
  it("runs independent proposal and validation on a pinned Linux image", () => {
    expect(workflow).toContain("evidence: [proposal, validation]");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("--run-label ${{ matrix.evidence }}");
    expect(workflow).toContain("needs: collect");
    expect(workflow).toContain("--allow-unratified");
    expect(gate).toContain("proposal/validation were not collected on independent Linux machines");
  });

  it("downloads and verifies the exact Noble package and extracted font before Chromium", () => {
    expect(workflow).toContain("fonts-freefont-ttf_20211204%2Bsvn4273-2_all.deb");
    expect(workflow).toContain("c8283ec9ca390e6ad8d2114cb0942182db62bb97f5142c2f955218fc5f2027b4");
    expect(workflow).toContain("350badd6ab6a58e7fd7a0ea2ae0c10174941a08e1cd06b3c6010e10b3d5ae319");
    expect(workflow).toContain("dpkg-deb --extract");
    expect(collector).toContain("isolated Fontconfig inventory has");
    expect(collector).toContain("FONTCONFIG_FILE");
  });

  it("proves real MathML selection and keeps the hinting-off control causal", () => {
    expect(collector).toContain("<mi id=");
    expect(collector).toContain('textTransform: dom[expected.id].textTransform as "math-auto"');
    expect(collector).toContain("CSS.getPlatformFontsForNode");
    expect(contract).toContain("isCustomFont: z.literal(false)");
    expect(collector).toContain("hbSubsetRetainGids(fontBytes");
    expect(gate).toContain("hinting-off negative control is inert");
    expect(workflow).toContain("*-hinting-off.png");
  });

  it("does not alter the ratified 348-cell core or its three-platform workflow", () => {
    expect(coreCorpus).toContain("This is a finite 348-cell declaration");
    expect(coreWorkflow).toContain("os: [macos-latest, ubuntu-latest, windows-latest]");
    expect(workflow).not.toContain("paths-native-raster-envelopes.json");
    expect(workflow).not.toContain("pathsNativeRasterMatrix");
    expect(workflow).not.toContain("macos-latest");
    expect(workflow).not.toContain("windows-latest");
  });
});
