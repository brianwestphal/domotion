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
    // The real synthetic order first opens Songti as a Chinese serif primary,
    // then later asks CoreText for the same PostScript face as a cursive
    // fallback. U+1800 isolates the state change in a short real-browser run.
    writeFileSync(
      stacksFile,
      JSON.stringify({ ...corpus, stacks: [...corpus.stacks.slice(0, 16), corpus.stacks[115]] }),
    );
    expect(await main(["--stacks", stacksFile, "--range", "1800", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(17);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "STSongti-SC-Regular" }));
  }, 60_000);
});
