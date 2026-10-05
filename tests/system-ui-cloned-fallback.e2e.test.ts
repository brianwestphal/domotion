import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("system-ui primary clone reaches CoreText fallback", () => {
  it("matches Chromium for the three Indic handles and AppleBraille in both author locations", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-ui-clone-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = JSON.parse(readFileSync("tools/font-conformance-stacks.darwin.json", "utf8"));
    const stacks = corpus.stacks.filter(
      (stack: { fontFamily: string; fontSize: number; fontVariationSettings: string }) =>
        stack.fontFamily === '"Inter Variable", system-ui, sans-serif' &&
        stack.fontSize === 26 &&
        stack.fontVariationSettings !== "normal",
    );
    expect(stacks).toHaveLength(2);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "0900,0C00,0D00,2800", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(8);
    expect(report.data.summary["agree-exact"]).toBe(8);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ face: ".SFDevanagari-Regular" }),
        expect.objectContaining({ face: ".SFTelugu-Regular" }),
        expect.objectContaining({ face: ".SFMalayalam-Regular" }),
        expect.objectContaining({ face: "AppleBraille-Outline6Dot" }),
      ]),
    );
  }, 60_000);
});
