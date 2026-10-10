import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

describeWindows("Windows current-face normalization", () => {
  it("agrees with Chromium for canonical and layout scalars across four generics", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-current-face-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stacks = corpus.stacks.filter(
      (stack) =>
        ["monospace", "cursive", "fantasy", "system-ui"].includes(stack.fontFamily) &&
        stack.fontSize === 16 &&
        stack.fontWeight === 400 &&
        stack.fontStyle === "normal" &&
        stack.fontStretch === "100%" &&
        stack.lang == null,
    );
    expect(stacks).toHaveLength(4);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "2011,2028,2029,212A", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(16);
    expect(report.data.summary.mismatchTotal).toBe(0);
    for (const face of ["Consolas", "ComicSansMS", "Impact", "SegoeUI"]) {
      expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face }));
    }
  }, 120_000);
});
