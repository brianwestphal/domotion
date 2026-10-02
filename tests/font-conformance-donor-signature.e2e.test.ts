import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

describe("font conformance oracle donor artifacts", () => {
  it("records one initial six-face signature per renderer scope", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-oracle-donors-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[0], corpus.stacks[13]] }));
    expect([0, 1]).toContain(await main(["--stacks", stacksFile, "--range", "0041", "--out", output]));
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(2);
    const signatures = report.data.meta.oracleDonorSignatures;
    expect(signatures).toHaveLength(process.platform === "linux" ? 2 : 1);
    expect(signatures.map((entry: { scope: string }) => entry.scope)).toEqual(
      process.platform === "linux" ? ["en", "ja"] : ["shared"],
    );
    for (const entry of signatures) {
      expect(entry.faces).toHaveLength(6);
      expect(entry.faces).toEqual([
        expect.stringMatching(/^serif=/),
        expect.stringMatching(/^sans-serif=/),
        expect.stringMatching(/^monospace=/),
        expect.stringMatching(/^cursive=/),
        expect.stringMatching(/^fantasy=/),
        expect.stringMatching(/^math=/),
      ]);
    }
  }, 60_000);
});
