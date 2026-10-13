import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

describeWindows("Windows italic Arabic fallback", () => {
  it("keeps generic italic serif, sans, and math on Chromium's Tahoma route", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-italic-arabic-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stacks = corpus.stacks.filter(
      (stack) =>
        ["serif", "sans-serif", "math"].includes(stack.fontFamily) &&
        stack.fontSize === 16 &&
        stack.fontWeight === 400 &&
        stack.fontStyle === "italic" &&
        stack.fontStretch === "100%" &&
        stack.lang == null,
    );
    expect(stacks).toHaveLength(3);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "0627,FE8D", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(6);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual({ face: "Tahoma", count: 6 });
  }, 120_000);

  // `system-ui` is the one generic Blink's standard-style retry does reach:
  // GetFontPlatformData maps the family to the system font, so italic Arabic
  // and Black-weight Georgian / Cyrillic stay in regular Segoe UI.
  it("retries system-ui at standard style before the hardcoded table", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-system-ui-retry-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const stacks = corpus.stacks.filter(
      (stack) =>
        stack.fontFamily === "system-ui" &&
        stack.fontSize === 16 &&
        ((stack.fontWeight === 400 && stack.fontStyle === "italic") ||
          (stack.fontWeight === 900 && stack.fontStyle === "normal")) &&
        stack.fontStretch === "100%" &&
        stack.lang == null,
    );
    expect(stacks).toHaveLength(2);
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "0627,10D0,A640,0966", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(8);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "SegoeUI" }));
  }, 120_000);
});
