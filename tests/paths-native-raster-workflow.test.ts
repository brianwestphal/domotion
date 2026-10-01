import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main as aggregate } from "../tools/paths-native-raster-aggregate.js";

const workflow = readFileSync(".github/workflows/paths-native-raster-floor.yml", "utf8");
const collector = readFileSync("tools/paths-native-raster-collector.ts", "utf8");
const producer = readFileSync("tools/paths-native-raster-producer.ts", "utf8");
describe("paths/native raster workflow", () => {
  it("produces lossless evidence on all three native runner OSes", () => {
    expect(workflow).toContain("macos-latest, ubuntu-latest, windows-latest");
    expect(workflow).toContain("compression-level: 0");
    expect(workflow).toContain("fonts:paths-raster:collect");
    expect(workflow).toContain("fonts:paths-raster:produce");
    expect(workflow).toContain("evidence: [proposal, validation]");
    expect(workflow).toContain("--run-label ${{ matrix.evidence }}");
    expect(workflow).toContain("npx playwright install --with-deps chromium");
    expect(workflow).toContain("Build DirectWrite identity helper");
    expect(workflow).toContain("./packages/text-engine/tools/win32-glyph-extractor/build.ps1");
    expect(readFileSync("packages/text-engine/tools/win32-glyph-extractor/CMakeLists.txt", "utf8")).toMatch(
      /target_compile_options\([^\n]+\/Brepro\)[\s\S]*target_link_options\([^\n]+\/Brepro\)/,
    );
    expect(workflow).not.toContain("observation_bundle_base_url");
  });
  it("acquires the exact source-owned corpus instead of downloading preauthored observations", () => {
    expect(workflow).toContain("repository: harfbuzz/harfbuzz");
    expect(workflow).toContain("ref: 4de187dd0a915d13c976fa8bd474c084229f3aab");
    expect(workflow).toContain("OpenSans-Regular.ttf");
    expect(workflow).toContain("TestCFF2VF.otf");
    expect(workflow).toContain("Reauthenticate PNGs and recompute residuals");
  });
  it("fingerprints renderer and oracle inputs without a commit/envelope circularity", () => {
    const collector = readFileSync("tools/paths-native-raster-collector.ts", "utf8");
    expect(collector).toContain("rendererSourceSha256: sourceInputsSha256");
    expect(collector).toContain("oracleSourceSha256: sourceInputsSha256");
    expect(collector).not.toContain("GITHUB_SHA");
    expect(collector).not.toContain('"tools/paths-native-raster-envelopes.json"');
  });
  it("aggregates only after every producer and uses the reviewed envelope file", () => {
    expect(workflow).toMatch(/adjudicate:\n\s+needs: produce/);
    expect(workflow).toContain("tools/paths-native-raster-envelopes.json");
    expect(workflow).toContain("fonts:paths-raster:aggregate");
  });
  it("reads versioned producer artifacts before checking the complete platform matrix", async () => {
    const root = mkdtempSync(join(tmpdir(), "domotion-raster-aggregate-"));
    for (let index = 0; index < 6; index++) {
      const dir = join(root, String(index));
      mkdirSync(dir);
      writeFileSync(
        join(dir, "paths-native-raster-rows.json"),
        JSON.stringify({
          schemaVersion: 1,
          tool: "paths-native-raster-producer",
          generatedAt: new Date().toISOString(),
          env: {},
          data: { outcome: "skip", rows: [] },
        }),
      );
    }
    const envelopes = join(root, "envelopes.json");
    writeFileSync(envelopes, JSON.stringify({ schemaVersion: 2, ratified: false, envelopes: [] }));
    await expect(
      aggregate(["--artifacts", root, "--envelopes", envelopes, "--out", join(root, "report.json")]),
    ).rejects.toThrow(/incomplete paths\/native raster matrix/);
  });
  it("guards both CLI entry points through the shared main helper", () => {
    for (const source of [collector, producer]) {
      expect(source).toContain("if (isMain(import.meta.url)) await runMain(() => main());");
      expect(source).not.toContain("`file://${process.argv[1]}`");
    }
  });
});
