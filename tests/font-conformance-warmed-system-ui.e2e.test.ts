import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isGlyphHelperAvailable } from "@domotion/text-engine/testing";
import { buildUniverse, ChromeOracle, main } from "../tools/font-conformance.js";
import { withBrowser } from "../tools/lib/browser.js";
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

  it("keeps a broad quoted-family lookup warm in one document and makes the GC boundary repeatable", async () => {
    const corpus = syntheticCorpus();
    const seed = corpus.stacks[2];
    const quoted = corpus.stacks[73];
    const byte00 = buildUniverse({ includePua: true, ranges: null, sampleByte: 0 });
    expect(byte00.length).toBeGreaterThan(1_000);

    await withBrowser(async (browser) => {
      const routeAfterSeed = async (newStackDocument: boolean): Promise<string | null> => {
        const oracle = await ChromeOracle.create(browser, 128, "en");
        try {
          expect(await oracle.resolvedPrimary(seed)).toBe(".SFNS-Regular");
          await oracle.facesFor(byte00, seed);
          if (newStackDocument) await oracle.clearWeakShapeResultsForNextStack();
          return await oracle.resolvedPrimary(quoted);
        } finally {
          await oracle.close();
        }
      };

      expect(await routeAfterSeed(false)).toBe(".SFNS-Regular");
      // Blink may retain the UI alias or expire it after document teardown +
      // GC depending on which font data the host's inventory keeps live. Both
      // routes occur on real macOS images; a repeated protocol must agree on
      // the same host. A Menlo result is the local 1,179-glyph reproduction.
      const first = await routeAfterSeed(true);
      expect([".SFNS-Regular", "Menlo-Regular"]).toContain(first);
      expect(await routeAfterSeed(true)).toBe(first);
    });
  }, 60_000);

  it("matches the quoted-family primary and fallback routes after a byte-00 cache eviction opportunity", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-warmed-system-ui-byte00-"));
    const stacksFile = join(root, "stacks.json");
    const output = join(root, "out");
    const corpus = syntheticCorpus();
    writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [corpus.stacks[2], corpus.stacks[73]] }));
    expect(await main(["--stacks", stacksFile, "--sample-byte", "00", "--out", output])).toBe(0);
    const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
    expect(report.data.summary.mismatchTotal).toBe(0);
    expect(report.data.meta.oracleIsolation).toBe("shared-renderer-fresh-stack-document-repaired-prefs");
  }, 120_000);

  it("keeps quoted aliases separate across font descriptions in Chromium and the renderer", async () => {
    const corpus = syntheticCorpus();
    const regular = {
      ...corpus.stacks[2],
      fontFamily: "system-ui",
      fontSize: 16,
      fontWeight: 400,
      fontStyle: "normal",
      fontStretch: "100%",
    };
    const pairs = [
      {
        name: "regular to bold",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', fontWeight: 700 },
        expected: "Menlo-Bold",
      },
      {
        name: "bold to regular",
        warm: { ...regular, fontWeight: 700 },
        query: { ...regular, fontFamily: '"System-ui", Menlo' },
        expected: "Menlo-Regular",
      },
      {
        name: "regular to large",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', fontSize: 32 },
        expected: "Menlo-Regular",
      },
      {
        name: "regular to italic",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', fontStyle: "italic" },
        expected: "Menlo-Italic",
      },
      {
        name: "regular to condensed",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', fontStretch: "75%" },
        expected: "Menlo-Regular",
      },
      {
        name: "regular to varied",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', fontVariationSettings: '"wght" 500' },
        expected: "Menlo-Regular",
      },
      {
        name: "en to ja",
        warm: regular,
        query: { ...regular, fontFamily: '"System-ui", Menlo', lang: "ja" },
        expected: ".SFNS-Regular",
      },
    ];

    await withBrowser(async (browser) => {
      for (const { name, warm, query, expected } of pairs) {
        const oracle = await ChromeOracle.create(browser, 32, "en");
        try {
          expect(await oracle.resolvedPrimary(warm), name).toMatch(/^\.SFNS/);
          expect(await oracle.resolvedPrimary(query), name).toBe(expected);
          await oracle.clearWeakShapeResultsForNextStack();
          expect(await oracle.resolvedPrimary(query), `${name} after document GC`).toBe(expected);
        } finally {
          await oracle.close();
        }
      }
    });

    for (const { name, warm, query, expected } of pairs) {
      const root = mkdtempSync(join(tmpdir(), "domotion-system-ui-description-"));
      const stacksFile = join(root, "stacks.json");
      const output = join(root, "out");
      writeFileSync(stacksFile, JSON.stringify({ ...corpus, stacks: [warm, query] }));
      expect(await main(["--stacks", stacksFile, "--range", "0041", "--out", output]), name).toBe(0);
      const report = JSON.parse(readFileSync(join(output, "report.json"), "utf8"));
      expect(report.data.summary.mismatchTotal, name).toBe(0);
      expect(report.data.meta.stackPrimaries[1].chromePrimary, name).toBe(expected);
    }

    const variedRoot = mkdtempSync(join(tmpdir(), "domotion-system-ui-matching-variation-"));
    const variedStacks = join(variedRoot, "stacks.json");
    const variedOutput = join(variedRoot, "out");
    const variation = { fontVariationSettings: '"wght" 500' };
    writeFileSync(
      variedStacks,
      JSON.stringify({
        ...corpus,
        stacks: [
          { ...regular, ...variation },
          { ...regular, ...variation, fontFamily: '"System-ui", Menlo' },
        ],
      }),
    );
    expect(await main(["--stacks", variedStacks, "--range", "0041", "--out", variedOutput])).toBe(0);
    const variedReport = JSON.parse(readFileSync(join(variedOutput, "report.json"), "utf8"));
    expect(variedReport.data.summary.mismatchTotal).toBe(0);
    expect(variedReport.data.meta.stackPrimaries[1].chromePrimary).toMatch(/^\.SFNS/);
  }, 180_000);
});
