import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(workflow).toContain("./tools/win32-glyph-extractor/build.ps1");
    expect(workflow).not.toContain("observation_bundle_base_url");
  });
  it("acquires the exact source-owned corpus instead of downloading preauthored observations", () => {
    expect(workflow).toContain("repository: harfbuzz/harfbuzz");
    expect(workflow).toContain("ref: 4de187dd0a915d13c976fa8bd474c084229f3aab");
    expect(workflow).toContain("OpenSans-Regular.ttf");
    expect(workflow).toContain("TestCFF2VF.otf");
    expect(workflow).toContain("Reauthenticate PNGs and recompute residuals");
  });
  it("aggregates only after every producer and uses the reviewed envelope file", () => {
    expect(workflow).toMatch(/adjudicate:\n\s+needs: produce/);
    expect(workflow).toContain("tools/paths-native-raster-envelopes.json");
    expect(workflow).toContain("fonts:paths-raster:aggregate");
  });
  it("executes both CLIs through platform-normalized file URLs", () => {
    for (const source of [collector, producer]) {
      expect(source).toContain("pathToFileURL(resolve(process.argv[1])).href");
      expect(source).not.toContain("`file://${process.argv[1]}`");
    }
  });
});
