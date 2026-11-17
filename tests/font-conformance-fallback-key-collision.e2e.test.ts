import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("macOS declared-family and CoreText fallback face collision", () => {
  it("keeps Songti Regular after a Chinese serif primary precedes a cursive 800 fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-exact-fallback-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    // The real synthetic order first opens Songti as a Chinese serif primary
    // (stack 15), then later asks CoreText for the same PostScript face as a
    // cursive fallback (stack 115). U+1800 isolates the state change in a
    // short real-browser run. DM-C4Q4RA: the 15 unrelated stacks before it
    // cost ~3 s each and pushed the run past 60 s on hosted macOS; without
    // them the run still reports the mismatch when exactSystemFallbackKey is
    // disabled.
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[15], corpus.stacks[115]] }));
    expect(await main(["--stacks", stacksFile, "--range", "1800", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(2);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "STSongti-SC-Regular" }));
  }, 60_000);
});
