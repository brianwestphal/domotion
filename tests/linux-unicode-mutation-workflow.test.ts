import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/linux-unicode-mutation-evidence.yml", "utf8");
const producer = readFileSync("tools/linux-unicode-mutation-matrix.ts", "utf8");

describe("Linux Unicode three-arm evidence workflow (DM-2438)", () => {
  it("runs the closed corpus in baseline, helper-off, hinted-subset-off, and selection-reject arms", () => {
    expect(workflow).toContain("linux-unicode-mutation-matrix.ts --print-fixtures");
    expect(workflow).toContain(
      "mv packages/text-engine/tools/linux-glyph-extractor/domotion-glyph-paths /tmp/domotion-glyph-paths",
    );
    expect(workflow).toMatch(/Fontconfig helper-off arm[\s\S]*?DOMOTION_DISABLE_HELPER: ["']1["']/);
    expect(workflow).toMatch(/Hinted-subset-off arm[\s\S]*?DOMOTION_HINTED_SUBSET: ["']0["']/);
    expect(workflow).toMatch(
      /Fontconfig selection-reject arm[\s\S]*?FONTCONFIG_FILE=.*tests\/fontconfig\/reject-selected-unicode-faces\.conf/,
    );
    expect(workflow).toContain("--selection-reject tests/output/linux-unicode-mutation/selection-reject");
    expect(workflow.match(/bash scripts\/ci-run-shard\.sh unicode/g)).toHaveLength(4);
  });

  it("always adjudicates and uploads the exact mutation artifacts", () => {
    expect(workflow).toMatch(/Adjudicate exact logical and raster mutations\n\s+if: always\(\)/);
    expect(workflow).toContain("linux-unicode-three-arm-evidence");
    expect(producer).toContain('verdict === "logical-mismatch"');
    expect(producer).toContain("-mutation-evidence.json");
    expect(producer).toContain("dm-2352-raster-floor-candidates.json");
  });
});
