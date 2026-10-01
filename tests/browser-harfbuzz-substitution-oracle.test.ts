import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BufferFlag, ClusterLevel } from "../packages/text-engine/vendor/harfbuzzjs/dist/index.mjs";

import {
  ARABIC_MARK_SHA256,
  ARABIC_RLIG_SHA256,
  LOCL_SHA256,
  OPEN_SANS_SHA256,
  buildBrowserHarfBuzzSubstitutionReport,
  buildLogicalSubstitutionEvidence,
  loadSubstitutionFixtures,
  readBrowserSubstitutionReport,
  validateSubstitutionArtifacts,
  writeBrowserSubstitutionAggregate,
  writeBrowserSubstitutionReport,
  type BrowserHarfBuzzSubstitutionReport,
} from "../tools/browser-harfbuzz-substitution-oracle.js";

function completeBrowserRows(report: BrowserHarfBuzzSubstitutionReport): BrowserHarfBuzzSubstitutionReport {
  const copy = structuredClone(report);
  copy.runner.browserVersion = "fixture-chromium";
  for (const item of copy.cases) {
    item.browser = {
      fonts: [
        {
          familyName: item.source.familyName,
          postScriptName: item.source.postscriptName ?? "",
          glyphCount: item.harfbuzz.glyphs.length,
          isCustomFont: true,
        },
      ],
      origins: [...item.input.text].map((scalar, index) => ({
        utf16Span: [index, index + scalar.length],
        left: index,
        top: 0,
        right: index + 1,
        bottom: 1,
      })),
      expectedPostscriptName: item.source.postscriptName,
      expectedFamilyName: item.source.familyName,
      customFaceAgreement: true,
      exactGlyphCountAgreement: true,
      glyphIds: {
        status: "not-exposed-by-cdp",
        owner: "Blink ShapeResultRun / HarfBuzzRunGlyphData",
      },
    };
  }
  return copy;
}

function nodePlatformForOs(os: string): string {
  return os === "macOS" ? "darwin" : os === "Windows" ? "win32" : "linux";
}

describe("browser HarfBuzz substitution-stream oracle", () => {
  it("round-trips nested versioned files and validates legacy per-run artifacts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "domotion-harfbuzz-report-"));
    try {
      const report = await buildBrowserHarfBuzzSubstitutionReport({ includeBrowser: false });
      const path = join(dir, "nested", "run.json");
      writeBrowserSubstitutionReport(path, report);
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw).toMatchObject({ schemaVersion: 1, tool: "browser-harfbuzz-substitution-oracle" });
      expect(raw.data.outcome).toBe(report.verdict === "exact-logical-agreement" ? "pass" : "fail");
      expect(raw.env).toMatchObject(report.runner);
      expect(readBrowserSubstitutionReport(path).logicalSha256).toBe(report.logicalSha256);
      const failedPath = join(dir, "nested", "failed.json");
      writeBrowserSubstitutionReport(failedPath, { ...report, verdict: "verdict-withheld" });
      expect(JSON.parse(readFileSync(failedPath, "utf8")).data.outcome).toBe("fail");

      const legacy = join(dir, "legacy.json");
      writeFileSync(legacy, JSON.stringify(report));
      expect(readBrowserSubstitutionReport(legacy).logicalSha256).toBe(report.logicalSha256);
      writeFileSync(legacy, JSON.stringify({ ...report, schemaVersion: 2 }));
      expect(() => readBrowserSubstitutionReport(legacy)).toThrow(/unsupported legacy/);
      writeFileSync(legacy, JSON.stringify({ ...raw, tool: "another-tool" }));
      expect(() => readBrowserSubstitutionReport(legacy)).toThrow();

      const aggregate = validateSubstitutionArtifacts([]);
      const aggregatePath = join(dir, "nested", "aggregate", "report.json");
      writeBrowserSubstitutionAggregate(aggregatePath, aggregate);
      expect(JSON.parse(readFileSync(aggregatePath, "utf8"))).toMatchObject({
        tool: "browser-harfbuzz-substitution-aggregate",
        data: { outcome: "fail", verdict: "verdict-withheld" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("pins portable OpenType fixtures with the required source tables", () => {
    const fixtures = loadSubstitutionFixtures();
    expect(Object.fromEntries(Object.entries(fixtures).map(([id, fixture]) => [id, fixture.evidence.sha256]))).toEqual({
      "open-sans-vf": OPEN_SANS_SHA256,
      "arabic-rlig": ARABIC_RLIG_SHA256,
      "arabic-mark": ARABIC_MARK_SHA256,
      "locl-language": LOCL_SHA256,
    });
    expect(fixtures["open-sans-vf"].evidence.tables).toEqual(expect.arrayContaining(["GSUB", "GPOS", "fvar"]));
    expect(fixtures["arabic-rlig"].evidence.tables).toEqual(expect.arrayContaining(["GDEF", "GSUB", "GPOS"]));
    expect(fixtures["arabic-mark"].evidence.tables).toEqual(expect.arrayContaining(["GDEF", "GSUB", "GPOS"]));
    expect(fixtures["locl-language"].evidence.tables).toContain("GSUB");
  });

  it("joins exact pinned-HarfBuzz streams to production provenance before raster", () => {
    const result = buildLogicalSubstitutionEvidence();
    expect(result.cases).toHaveLength(4);
    expect(result.cases.every((item) => item.exactProductionAgreement)).toBe(true);
    expect(result.cases.every((item) => item.production.selected.shapesWithHarfbuzz)).toBe(true);
    expect(result.cases.every((item) => item.input.bufferFlags === BufferFlag.DEFAULT)).toBe(true);
    expect(result.cases.every((item) => item.input.clusterLevel === ClusterLevel.MONOTONE_GRAPHEMES)).toBe(true);

    const latin = result.cases.find((item) => item.id === "latin-liga-variable-axis")!;
    expect(latin.harfbuzz.glyphs).toHaveLength(1);
    expect(latin.harfbuzz.glyphs[0].sourceSpan).toEqual([0, 2]);

    const required = result.cases.find((item) => item.id === "arabic-required-ligature")!;
    expect(required.harfbuzz.glyphs).toHaveLength(1);
    expect(required.harfbuzz.glyphs[0].sourceSpan).toEqual([0, 3]);

    const mark = result.cases.find((item) => item.id === "arabic-contextual-mark-positioning")!;
    expect(new Set(mark.harfbuzz.glyphs.map((glyph) => glyph.cluster)).size).toBeGreaterThan(1);
    expect(mark.harfbuzz.glyphs.some((glyph) => glyph.xOffset !== 0 || glyph.yOffset !== 0)).toBe(true);

    const language = result.cases.find((item) => item.id === "language-system-locl")!;
    expect(language.harfbuzz.glyphs.map((glyph) => glyph.id)).toEqual([6]);
  });

  it("kills every required hostile source/input/logical-record mutation", () => {
    const result = buildLogicalSubstitutionEvidence();
    expect(result.mutations.map((mutation) => mutation.id)).toEqual(
      expect.arrayContaining([
        "disable-liga",
        "omit-variation-axes",
        "disable-required-ligature",
        "wrong-script",
        "wrong-direction",
        "wrong-cluster-level",
        "wrong-language-system",
        "wrong-source-fingerprint",
        "wrong-gid",
        "wrong-cluster",
        "wrong-source-span",
        "wrong-advance",
        "zero-mark-offset",
      ]),
    );
    expect(result.mutations.every((mutation) => mutation.rejected)).toBe(true);
    expect(result.mutations.find((mutation) => mutation.id === "zero-mark-offset")?.changedFields).toEqual(
      expect.arrayContaining(["xOffset", "yOffset"]),
    );
  });

  it("ratifies only a complete three-OS proposal/validation artifact set", async () => {
    const base = completeBrowserRows(await buildBrowserHarfBuzzSubstitutionReport({ includeBrowser: false }));
    const reports = ["Linux", "macOS", "Windows"].flatMap((os) =>
      (["proposal", "validation"] as const).map((evidence) => ({
        ...structuredClone(base),
        evidence,
        runner: { ...base.runner, os, nodePlatform: nodePlatformForOs(os) },
      })),
    );
    const aggregate = validateSubstitutionArtifacts(reports);
    expect(aggregate.verdict).toBe("proposal-validation-agreement");
    expect(aggregate.artifactKeys).toHaveLength(6);
    expect(aggregate.rasterization).toBe("not-started");

    reports[5].logicalSha256 = "0".repeat(64);
    const rejected = validateSubstitutionArtifacts(reports);
    expect(rejected.verdict).toBe("verdict-withheld");
    expect(rejected.failures).toContain("exact logical streams differ across proposal/validation or OS");
  });

  it("reopens logical records instead of trusting report booleans", async () => {
    const base = completeBrowserRows(await buildBrowserHarfBuzzSubstitutionReport({ includeBrowser: false }));
    const reports = ["Linux", "macOS", "Windows"].flatMap((os) =>
      (["proposal", "validation"] as const).map((evidence) => ({
        ...structuredClone(base),
        evidence,
        runner: { ...base.runner, os, nodePlatform: nodePlatformForOs(os) },
      })),
    );
    reports[0].cases[0].production.glyphs[0].xAdvance += 1;
    reports[0].cases[0].exactProductionAgreement = true;
    const rejected = validateSubstitutionArtifacts(reports);
    expect(rejected.verdict).toBe("verdict-withheld");
    expect(rejected.failures).toContain(
      "Linux/proposal: latin-liga-variable-axis exact browser/production join incomplete",
    );
  });
});
