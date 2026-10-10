import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { describe, expect, it } from "vitest";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

describeWindows("Windows synthetic oracle locale scopes", () => {
  it("keeps an English serif primary independent of the preceding Japanese stack", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-windows-locale-oracle-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[13], corpus.stacks[29]] }));

    expect(await main(["--stacks", stacksFile, "--range", "0041", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.meta.oracleIsolation).toBe("renderer-per-locale-fresh-stack-document");
    expect(report.data.meta.stackPrimaries.map((row: { chromePrimary: string | null }) => row.chromePrimary)).toEqual([
      "YuGothic-Regular",
      "TimesNewRomanPSMT",
    ]);
    expect(report.data.summary.comparisons).toBe(2);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 60_000);

  it("keeps Chinese compatibility ideographs in Microsoft YaHei after normalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-windows-cjk-normalization-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const families = ["sans-serif", "system-ui", "ui-sans-serif"];
    const stacks = families.map((fontFamily) => {
      const stack = corpus.stacks.find(
        (candidate) => candidate.fontFamily === fontFamily && candidate.lang === "zh-Hans",
      );
      if (stack == null) throw new Error(`missing synthetic stack ${fontFamily}/zh-Hans`);
      return stack;
    });
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "F900,F91D,F9FF", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(9);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "MicrosoftYaHei" }));
  }, 60_000);
});
