import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable, resolveInstalledFont } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const hasStandaloneSfPro =
  process.platform === "darwin" &&
  isGlyphHelperAvailable() &&
  resolveInstalledFont("SF Pro Text")?.postscriptName === "SFProText-Regular";

describe.runIf(hasStandaloneSfPro)("macOS standalone SF Pro PUA fallback", () => {
  it("keeps uncovered system-ui PUA on SFNS while preserving an explicitly named OTF primary", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-sf-pro-pua-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const ui = corpus.stacks[2];
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [ui, { ...ui, fontFamily: "SF Pro Text" }] }));
    expect(await main(["--stacks", stacksFile, "--range", "100000,100100", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(4);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: ".SFNS-Regular" }));
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "SFProText-Regular" }));
  }, 60_000);
});
