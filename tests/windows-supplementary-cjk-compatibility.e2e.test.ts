import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

// U+2F800–2FA1F are canonical singletons (U+2F800 → U+4E3D, U+2F8A6 → U+6148,
// U+2FA1D → U+2A600). No Windows face maps them literally except MingLiU-ExtB
// for a few; Chromium paints them from the locale's standard font (YaHei,
// JhengHei, Malgun, Yu Gothic) after HarfBuzz decomposes them in that face.
// The exhaustive cohort once disagreed on 5,101 of these comparisons.
describeWindows("Windows supplementary CJK compatibility ideographs", () => {
  it("agrees with Chromium across CJK and English locales for explicit, generic, and system-ui stacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-sup-cjk-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stacks = corpus.stacks.filter(
      (stack) =>
        ["fantasy", "system-ui", "serif", "sans-serif"].includes(stack.fontFamily) &&
        stack.fontSize === 16 &&
        stack.fontWeight === 400 &&
        stack.fontStyle === "normal" &&
        stack.fontStretch === "100%" &&
        [null, undefined, "zh-Hans", "zh-Hant", "ja", "ko"].includes(stack.lang),
    );
    expect(stacks.length).toBeGreaterThanOrEqual(16);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "2F800,2F801,2F8A6,2FA1D", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(stacks.length * 4);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 300_000);
});
