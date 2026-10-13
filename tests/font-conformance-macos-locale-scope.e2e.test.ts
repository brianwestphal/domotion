import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { main } from "../tools/font-conformance.js";
import { syntheticCorpus } from "../tools/font-conformance-synthetic-stacks.js";

const describeMac = process.platform === "darwin" && isGlyphHelperAvailable() ? describe : describe.skip;

// In one shared renderer, a Japanese serif stack followed by an English serif
// stack makes Chrome paint the English stack's space and Latin A in Hiragino
// Mincho; alone, the English stack is Times. The hosted exhaustive macOS
// cohort lost whole stacks to that leak (~93% of their codepoints), so the
// oracle gives each locale its own renderer.
describeMac("macOS synthetic oracle locale scopes", () => {
  it("keeps an English serif primary independent of a preceding Japanese stack", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-macos-locale-oracle-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    const pick = (lang: string | undefined, fontStretch: string) => {
      const stack = corpus.stacks.find(
        (candidate) =>
          candidate.fontFamily === "serif" &&
          candidate.lang === lang &&
          candidate.fontSize === 16 &&
          candidate.fontWeight === 400 &&
          candidate.fontStyle === "normal" &&
          candidate.fontStretch === fontStretch,
      );
      if (stack == null) throw new Error(`missing synthetic serif stack ${lang ?? "default"} ${fontStretch}`);
      return stack;
    };
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [pick("ja", "100%"), pick(undefined, "150%")] }));

    expect(await main(["--stacks", stacksFile, "--range", "0020,0041", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.meta.oracleIsolation).toBe("renderer-per-locale-fresh-stack-document-repaired-prefs");
    expect(report.data.meta.stackPrimaries.map((row: { chromePrimary: string | null }) => row.chromePrimary)).toEqual([
      "HiraMinProN-W3",
      "Times-Roman",
    ]);
    expect(report.data.summary.comparisons).toBe(4);
    expect(report.data.summary.mismatchTotal).toBe(0);
  }, 120_000);
});
