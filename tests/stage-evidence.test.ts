import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { relevantStageEvidence } from "../src/review/stage-evidence.js";
import { classifyLinuxUnicodeFixtureEvidence } from "../src/review/linux-unicode-evidence.js";
import type { EmbeddedFontBuildDiagnostic } from "../src/render/embedded-font-builder.js";
import type { FixtureTextRunProvenance } from "../src/render/text-run-provenance.js";
import { buildStageEvidence } from "../tools/build-stage-evidence.js";
import { annotateStageReport, writeFontSelectionComposite } from "../tools/collect-stage-evidence.js";
import { writeReport } from "../tools/lib/report.js";
import type { SemanticCoverageInventory } from "../tools/semantic-coverage.js";

describe("demo-review stage evidence", () => {
  it("reads versioned reports, preserves oracle evidence, and rejects unknown versions", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-envelope-"));
    const path = join(dir, "paint.json");
    const semantic = { transitions: [] } as unknown as SemanticCoverageInventory;
    const areas = [{ id: "paint", oracle: "tools/paint-geometry-oracle.ts" }];
    writeReport(path, "paint-geometry-oracle", { outcome: "pass", rows: [{ pass: true }] }, { schemaVersion: 1 });
    annotateStageReport(path, areas[0].oracle, true);
    expect(buildStageEvidence(semantic, areas, dir, {}, "abc").reports[0]).toMatchObject({
      status: "passed",
      passedRows: 1,
      totalRows: 1,
    });
    const annotated = JSON.parse(readFileSync(path, "utf8"));
    expect(annotated.data.evidencePassed).toBe(true);
    expect(annotated.evidencePassed).toBeUndefined();
    annotated.data.outcome = "fail";
    writeFileSync(path, JSON.stringify(annotated));
    expect(buildStageEvidence(semantic, areas, dir, {}, "abc").reports[0]).toMatchObject({ status: "failed" });
    annotated.data.outcome = "pass";
    annotated.schemaVersion = 99;
    writeFileSync(path, JSON.stringify(annotated));
    expect(buildStageEvidence(semantic, areas, dir, {}, "abc").reports[0]).toMatchObject({ status: "failed" });
    writeFileSync(path, JSON.stringify({ schemaVersion: 99, rows: [{ pass: true }] }));
    expect(buildStageEvidence(semantic, areas, dir, {}, "abc").reports[0]).toMatchObject({ status: "failed" });
  });

  it("recognizes the collector's combined font-selection envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-font-selection-"));
    writeReport(
      join(dir, "font-selection.json"),
      "collect-stage-evidence",
      { outcome: "pass", evidencePassed: true, pairs: 2 },
      { schemaVersion: 1 },
    );
    const manifest = buildStageEvidence(
      { transitions: [] } as unknown as SemanticCoverageInventory,
      [{ id: "font-selection", oracle: "tools/font-conformance.ts" }],
      dir,
      {},
      "abc",
    );
    expect(manifest.reports[0]).toMatchObject({ status: "passed", totalRows: 2 });
  });

  it("requires both complete producer records before composing font-selection evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-font-composite-"));
    const unifiedPath = join(dir, "shaping-clusters-glyphs.json");
    const rendererPath = join(dir, "renderer-font-route.json");
    const unified = { outcome: "pass" as const, evidencePassed: true, pairs: 1, records: [{}] };
    const renderer = { outcome: "pass" as const, evidencePassed: true };
    writeReport(unifiedPath, "unified-shaping-oracle", unified, { schemaVersion: 1 });
    writeReport(rendererPath, "renderer-font-route-oracle", renderer, { schemaVersion: 1 });
    writeFontSelectionComposite(dir);
    expect(JSON.parse(readFileSync(join(dir, "font-selection.json"), "utf8")).data).toMatchObject({
      outcome: "pass",
      pairs: 1,
      records: [{}],
    });
    for (const missing of ["pairs", "records", "evidencePassed"] as const) {
      const malformed = { ...unified } as Record<string, unknown>;
      delete malformed[missing];
      writeReport(unifiedPath, "unified-shaping-oracle", malformed, { schemaVersion: 1 });
      expect(() => writeFontSelectionComposite(dir)).toThrow();
    }
    writeReport(unifiedPath, "unified-shaping-oracle", unified, { schemaVersion: 1 });
    writeReport(rendererPath, "renderer-font-route-oracle", { outcome: "pass" }, { schemaVersion: 1 });
    expect(() => writeFontSelectionComposite(dir)).toThrow();
  });

  it("maps fixtures through semantic links and never through pixel metrics", () => {
    const dir = mkdtempSync(join(tmpdir(), "stage-evidence-"));
    writeFileSync(join(dir, "paint.json"), JSON.stringify({ rows: [{ pass: true }] }));
    const semantic = {
      transitions: [
        {
          id: "box.paint",
          parityAreas: ["paint"],
          visualFixtures: ["tests/features.ts#box-demo"],
        },
      ],
    } as SemanticCoverageInventory;
    const manifest = buildStageEvidence(
      semantic,
      [{ id: "paint", oracle: "paint.ts" }],
      dir,
      { platform: "linux", image: "runner" },
      "abc",
    );
    const first = relevantStageEvidence(manifest, "features", "box-demo");
    const second = relevantStageEvidence(manifest, "features", "box-demo");
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      transitionIds: ["box.paint"],
      reports: [{ area: "paint", status: "passed", passedRows: 1, totalRows: 1 }],
    });
    expect(relevantStageEvidence(manifest, "features", "unlinked")).toBeUndefined();
  });

  it("keeps absent reports explicit instead of inventing evidence", () => {
    const semantic = {
      transitions: [
        {
          id: "text.layout",
          parityAreas: ["layout"],
          visualFixtures: ["tests/html-test-suite.tsx"],
        },
      ],
    } as SemanticCoverageInventory;
    const manifest = buildStageEvidence(
      semantic,
      [{ id: "layout", oracle: "layout.ts" }],
      tmpdir(),
      { platform: "darwin" },
      "abc",
    );
    expect(relevantStageEvidence(manifest, "html-test-unicode", "arbitrary")?.reports[0]?.status).toBe("missing");
  });

  it("lets exact Linux .30 evidence supersede global 0/686 failures only within the 1% hinted raster floor", () => {
    const fixture = "4E00-9FFF-cjk-unified-ideographs.30";
    const evidence = {
      schemaVersion: 1,
      fixture,
      sourceAuthority: {
        chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
        harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
        skia: "62efacd3",
      },
      transitions: [],
      runs: [
        {
          fixture,
          row: 0,
          emitter: "embedded-font",
          sourceText: "U+6C94",
          sourceSpan: [0, 6],
          sourceCodepointSpan: [0, 6],
          emittedText: "U+6C94",
          mechanism: "system-resolver",
          request: { fontFamily: "monospace", fontWeight: 400, fontStretch: 100, fontSizePx: 12, direction: "ltr" },
          selected: {
            fontKey: "sysfb:WenQuanYiZenHeiMono",
            postscriptName: "WenQuanYiZenHeiMono",
            instantiatedPostscriptName: null,
            sourcePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            faceIndex: 1,
            variationAxes: null,
            shapesWithHarfbuzz: true,
          },
          glyphs: [
            {
              id: 44634,
              cluster: 0,
              sourceSpan: [0, 1],
              sourceCodepointSpan: [0, 1],
              xAdvance: 512,
              yAdvance: 0,
              xOffset: 0,
              yOffset: 0,
              sourceOutline: { sha256: "outline", commandCount: 17 },
            },
          ],
          emittedIdentity: "embedded-font:mono:44634",
          finalRepresentation: "embedded-font",
        },
      ],
    } as FixtureTextRunProvenance;
    const builds = [
      {
        instanceKey: "mono#1",
        cssFamily: "dmf0",
        sourcePath: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        faceIndex: 1,
        variationAxes: null,
        selectedBuilder: "hb-subset",
        hintedSourceDisqualifiedReasons: [],
        retainedTableTags: ["glyf", "cvt "],
        retainedHintTableTags: ["cvt "],
        finalRepresentation: { kind: "embedded-sfnt", mime: "font/ttf", byteLength: 100, sha256: "hinted" },
        affectedGlyphCount: 1,
        affectedGlyphOccurrenceCount: 1,
        affectedRunCount: 1,
      },
    ] as EmbeddedFontBuildDiagnostic[];
    const manifest = {
      schemaVersion: 1,
      generatedAt: "2026-08-31T00:00:00Z",
      sourceRevision: "abc",
      platform: "linux",
      environmentFingerprint: {},
      reports: [
        { area: "text.font-selection", oracle: "font-selection", status: "failed", passedRows: 0, totalRows: 686 },
        { area: "text.shaping", oracle: "shaping", status: "failed", passedRows: 0, totalRows: 686 },
      ],
      rules: [
        {
          suites: ["html-test-unicode"],
          transitionIds: ["text.selection", "text.shape"],
          areas: ["text.font-selection", "text.shaping"],
        },
      ],
    } as const;
    const fixtureEvidence = classifyLinuxUnicodeFixtureEvidence({
      platform: "linux",
      suite: "html-test-unicode",
      fixture,
      diffPct: 0.595,
      textRunEvidence: evidence,
      embeddedFontBuilds: builds,
    });
    const relevant = relevantStageEvidence(manifest, "html-test-unicode", fixture, fixtureEvidence);
    expect(relevant).toMatchObject({
      scope: "fixture",
      reports: [{ area: "text.fixture-logical", status: "passed" }],
      supersededReports: [
        { area: "text.font-selection", status: "failed", passedRows: 0, totalRows: 686 },
        { area: "text.shaping", status: "failed", passedRows: 0, totalRows: 686 },
      ],
    });
    expect(
      classifyLinuxUnicodeFixtureEvidence({
        platform: "linux",
        suite: "html-test-unicode",
        fixture,
        diffPct: 1.001,
        textRunEvidence: evidence,
        embeddedFontBuilds: builds,
      }),
    ).toBeUndefined();
    evidence.runs[0].selected.faceIndex = 0;
    expect(
      classifyLinuxUnicodeFixtureEvidence({
        platform: "linux",
        suite: "html-test-unicode",
        fixture,
        diffPct: 0.595,
        textRunEvidence: evidence,
        embeddedFontBuilds: builds,
      }),
    ).toBeUndefined();
  });
});
