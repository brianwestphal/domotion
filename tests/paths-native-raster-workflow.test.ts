import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/paths-native-raster-floor.yml", "utf8");
describe("paths/native raster workflow", () => {
  it("produces lossless evidence on all three native runner OSes", () => {
    expect(workflow).toContain("macos-latest, ubuntu-latest, windows-latest");
    expect(workflow).toContain("compression-level: 0");
    expect(workflow).toContain("fonts:paths-raster:produce");
  });
  it("aggregates only after every producer and uses the reviewed envelope file", () => {
    expect(workflow).toMatch(/adjudicate:\n\s+needs: produce/);
    expect(workflow).toContain("tools/paths-native-raster-envelopes.json");
    expect(workflow).toContain("fonts:paths-raster:aggregate");
  });
});
