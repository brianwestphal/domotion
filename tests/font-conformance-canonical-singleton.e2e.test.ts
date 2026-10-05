import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;
const describeLinux = process.platform === "linux" && isGlyphHelperAvailable() ? describe : describe.skip;

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

describeLinux("Linux canonical singleton conformance", () => {
  it("keeps Japanese, Korean, and Chinese shape-first faces aligned with Chromium", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-canonical-singleton-linux-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const families = ["serif", "sans-serif", "system-ui"];
    const languages = ["ja", "ko", "zh-Hans", "zh-Hant"];
    const stacks = families.flatMap((fontFamily) =>
      languages.map((lang) => {
        const stack = corpus.stacks.find((candidate) => candidate.fontFamily === fontFamily && candidate.lang === lang);
        if (stack == null) throw new Error(`missing synthetic stack ${fontFamily}/${lang}`);
        return stack;
      }),
    );
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));
    expect(await main(["--stacks", stacksFile, "--range", "F900,FA00,2F800,2F900,2FA00", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(60);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 60_000);
});
