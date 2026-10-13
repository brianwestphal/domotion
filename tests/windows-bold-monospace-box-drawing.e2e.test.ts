import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

// Consolas Bold (CONSOLAB.TTF) maps U+2500 but not the heavy box-drawing
// scalars; regular Consolas maps all of them. The exhaustive Windows cohort
// once reported Chromium on Lucida Sans Unicode at 700/800/900 for those
// heavy scalars while Domotion stayed on regular Consolas. Pin the bold
// weights together with 400 so either side regressing is caught.
describeWindows("Windows bold monospace box drawing", () => {
  it("agrees with Chromium for light and heavy box drawing at 400–900", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-box-drawing-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stacks = corpus.stacks.filter(
      (stack) =>
        stack.fontFamily === "monospace" &&
        stack.fontSize === 16 &&
        [400, 700, 800, 900].includes(stack.fontWeight) &&
        stack.fontStyle === "normal" &&
        stack.fontStretch === "100%" &&
        stack.lang == null,
    );
    expect(stacks).toHaveLength(4);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "2500,2501,250F,254B", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(16);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 300_000);
});
