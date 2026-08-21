import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/linux-unicode-mutation-evidence.yml", "utf8");
const producer = readFileSync("tools/linux-unicode-mutation-matrix.ts", "utf8");

describe("Linux Unicode three-arm evidence workflow (DM-2438)", () => {
  it("runs the closed corpus in baseline, helper-off, and hinted-subset-off arms", () => {
    expect(workflow).toContain("linux-unicode-mutation-matrix.ts --print-fixtures");
    expect(workflow).toContain("mv tools/linux-glyph-extractor/domotion-glyph-paths /tmp/domotion-glyph-paths");
    expect(workflow).toMatch(/Hinted-subset-off arm[\s\S]*?DOMOTION_HINTED_SUBSET: '0'/);
    expect(workflow.match(/bash scripts\/ci-run-shard\.sh unicode/g)).toHaveLength(3);
  });

  it("always adjudicates and uploads the exact mutation artifacts", () => {
    expect(workflow).toMatch(/Adjudicate exact logical and raster mutations\n\s+if: always\(\)/);
    expect(workflow).toContain("linux-unicode-three-arm-evidence");
    expect(producer).toContain('verdict === "logical-mismatch"');
    expect(producer).toContain("-mutation-evidence.json");
    expect(producer).toContain("dm-2352-raster-floor-candidates.json");
  });
});
