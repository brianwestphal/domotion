import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("macOS canonical singleton conformance", () => {
  it("uses the renderer's shaped family for Japanese compatibility ideographs", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-canonical-singleton-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    // These are the first Japanese serif, sans-serif, and system-ui requests
    // in the rule-derived corpus. The source scalars have no literal Hiragino
    // cmap entries; HarfBuzz shapes their singleton canonical forms there.
    writeFileSync(
      stacksFile,
      JSON.stringify({ ...corpus, stacks: [13, 39, 65, 66].map((index) => corpus.stacks[index]) }),
    );
    expect(await main(["--stacks", stacksFile, "--range", "F900,FA00,2F900", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(12);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "HiraKakuProN-W3" }));
  }, 60_000);
});
