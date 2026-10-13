import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeWindows = process.platform === "win32" && isGlyphHelperAvailable() ? describe : describe.skip;

// At weight 200 Blink's hardcoded Hangul stage opens Malgun Gothic Semilight,
// which lacks archaic jamo (U+11FA, U+A960, U+D7B0), so those cells fall to
// DirectWrite, whose answer Blink reopens at the typeface's own (regular)
// style. A Korean stack first registers Malgun Gothic as a declared family
// under the same `sysfb:` key; the later English fallback must still keep
// DirectWrite's exact regular face rather than re-matching it to Semilight.
describeWindows("Windows Malgun fallback cut", () => {
  it("keeps DirectWrite's regular Malgun Gothic for archaic Hangul at weight 200 after a Korean stack", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-win-malgun-cut-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const pick = (fontFamily: string, fontWeight: number, lang: string | undefined) => {
      const stack = corpus.stacks.find(
        (candidate) =>
          candidate.fontFamily === fontFamily &&
          candidate.fontSize === 16 &&
          candidate.fontWeight === fontWeight &&
          candidate.fontStyle === "normal" &&
          candidate.fontStretch === "100%" &&
          candidate.lang === lang,
      );
      if (stack == null) throw new Error(`missing synthetic stack ${fontFamily}/${fontWeight}/${lang ?? "default"}`);
      return stack;
    };
    const stacks = [pick("ui-serif", 400, "ko"), pick("ui-serif", 200, undefined), pick("cursive", 200, undefined)];
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks }));

    expect(await main(["--stacks", stacksFile, "--range", "11FA,A960,D7B0,AC00", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.comparisons).toBe(12);
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.chromeFaces).toContainEqual(expect.objectContaining({ face: "MalgunGothic" }));
  }, 180_000);
});
