import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2345 cross-platform decoration evidence", () => {
  it("runs exact fingerprinted Windows lanes at DPR 1 and 4", () => {
    const workflow = readFileSync(".github/workflows/windows-fidelity.yml", "utf8");
    const job = workflow.slice(workflow.indexOf("  decoration-geometry:"), workflow.indexOf("\n  family-match:"));
    expect(job).toContain("runs-on: windows-latest");
    expect(job).toContain("./tools/win32-glyph-extractor/build.ps1");
    expect(job).toMatch(/decoration-oracle\.ts[\s\S]*--device-scale-factor 1[\s\S]*decoration-windows-dpr1\.json/);
    expect(job).toMatch(/decoration-oracle\.ts[\s\S]*--device-scale-factor 4[\s\S]*decoration-windows-dpr4\.json/);
    expect(job).not.toMatch(/--no-gate|--tolerance/);
    expect(job).toContain("decoration-geometry-windows");
    expect(job).toContain("steps.decoration_dpr1.outcome");
    expect(job).toContain("steps.decoration_dpr4.outcome");
    expect(job).toContain("throw 'One or more exact decoration geometry lanes failed");
  });

  it("carries the selected DirectWrite face's OS/2 typo metrics into decoration geometry", () => {
    const helper = readFileSync("tools/win32-glyph-extractor/src/main.cpp", "utf8");
    const adapter = readFileSync("src/render/glyph-helper.ts", "utf8");
    expect(helper).toContain("TryGetFontTable");
    expect(helper).toContain("readI16BE(68)");
    expect(helper).toContain("readI16BE(70)");
    expect(helper).toContain("\\\"typoAscender\\\"");
    expect(adapter).toContain("typoAscender: metaResp.typoAscender");
    expect(adapter).toContain("typoDescender: metaResp.typoDescender");
  });
});
