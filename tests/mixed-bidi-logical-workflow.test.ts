import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/mixed-bidi-logical-conformance.yml", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };

describe("mixed-script bidi logical conformance workflow", () => {
  it("runs the exact logical oracle on every native release OS", () => {
    expect(workflow).toContain("[macos-14, ubuntu-24.04, windows-2025]");
    expect(workflow).toContain("npm run fonts:mixed-bidi-logical");
    expect(workflow).toContain("src/render/mixed-bidi-logical.test.ts");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(pkg.scripts["fonts:mixed-bidi-logical"])
      .toBe("node --import tsx tools/mixed-bidi-logical-oracle.ts");
  });

  it("keeps this gate at the itemization/shaping/origin stage", () => {
    expect(workflow).not.toMatch(/tolerance|diffPct|pixel threshold/i);
    expect(workflow).toContain("DOMOTION_CHROMIUM_REVISION");
    expect(workflow).toContain("DOMOTION_HARFBUZZ_REVISION");
    expect(workflow).toContain("DOMOTION_SKIA_REVISION");
  });
});
