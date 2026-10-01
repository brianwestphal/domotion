import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("macOS warmed system-ui fallback base", () => {
  it("uses the UI cascade after canonical system-ui warms a quoted case variant", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-warmed-system-ui-e2e-"));
    const freshStacksFile = join(root, "fresh-stacks.json");
    const freshOutput = join(root, "fresh-out");
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    writeFileSync(freshStacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[73]] }));
    expect(await main(["--stacks", freshStacksFile, "--range", "0041,3000", "--out", freshOutput])).toBe(0);
    const fresh = JSON.parse(readFileSync(join(freshOutput, "report.json"), "utf8"));
    expect(fresh.data.summary.comparisons).toBe(2);
    expect(fresh.data.summary.mismatchTotal).toBe(0);
    expect(fresh.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "Menlo-Regular" }));

    // One browser page/renderer: the first request warms Blink's platform-font
    // cache, then the case-variant literal reuses its SFNS primary. U+3000
    // distinguishes the private PingFang UI cascade from the public face.
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[2], corpus.stacks[73]] }));
    expect(await main(["--stacks", stacksFile, "--range", "0041,3000", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(4);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: ".PingFangUITextSC-Regular" }));
  }, 60_000);
});
