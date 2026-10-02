import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

describeMac("macOS fallback handle state per cascade route", () => {
  it("keeps system-ui's SF Malayalam clone identity after serif reached the face first", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-darwin-handle-state-e2e-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stack = (family: string, weight: number) => {
      const found = corpus.stacks.find((s) => s.fontFamily === family && s.fontWeight === weight && s.fontSize === 16);
      expect(found).toBeDefined();
      return found!;
    };
    // Serif first: in one renderer and one resolver process, its handle (opsz
    // already at 17) is recorded before system-ui asks for the same face.
    const stacks = [stack("serif", 400), stack("system-ui", 400)];
    const bold = corpus.stacks.find((s) => s.fontFamily === "system-ui" && s.fontWeight === 700 && s.fontSize === 16);
    const boldSerif = corpus.stacks.find((s) => s.fontFamily === "serif" && s.fontWeight === 700 && s.fontSize === 16);
    if (bold != null && boldSerif != null) stacks.push(boldSerif, bold);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));
    expect(await main(["--stacks", stacksFile, "--range", "0D00", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(stacks.length);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(
      expect.objectContaining({ face: ".SFMalayalam-Regular_opsz110000_wght" }),
    );
  }, 90_000);
});
