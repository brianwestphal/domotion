import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeLinux = process.platform === "linux" && isGlyphHelperAvailable() ? describe : describe.skip;

describeLinux("Linux exhaustive synthetic route residuals", () => {
  it("agrees with Chromium on every formerly mismatching scalar across the 351-stack cohort", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-linux-residuals-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: corpus.stacks.slice(0, 351) }));

    const scalars = [
      "037E",
      "1F71",
      "1F73",
      "1F75",
      "1F77",
      "1F79",
      "1F7B",
      "1F7D",
      "1FBB",
      "1FBE",
      "1FC9",
      "1FCB",
      "1FD3",
      "1FDB",
      "1FE3",
      "1FEB",
      "1FEE",
      "1FEF",
      "1FF9",
      "1FFB",
      "1FFD",
      "2329",
      "232A",
      "2011",
      "2028",
      "2029",
      "212A",
      "1F6D8",
      "1FA8A",
      "1FA8E",
      "1FAC8",
      "1FACD",
      "1FAEA",
      "1FAEF",
    ];
    expect(await main(["--stacks", stacksFile, "--range", scalars.join(","), "--out", output])).toBe(0);

    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(34 * 351);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 120_000);
});
