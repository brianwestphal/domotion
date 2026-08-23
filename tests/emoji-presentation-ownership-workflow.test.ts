import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/emoji-presentation-ownership-audit.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };

describe("DM-2507 native arm64 source-priority workflow", () => {
  it("runs the exact logical discriminator in the pinned noble image", () => {
    expect(workflow).toContain("runs-on: ubuntu-22.04-arm");
    expect(workflow).toContain("mcr.microsoft.com/playwright:v1.59.1-noble");
    expect(workflow).toContain("tools/linux-arm64-release-evidence.ts acquire");
    expect(workflow).toContain("src/render/emoji-presentation-priority.ts");
    expect(workflow).toContain("src/render/emoji-presentation-priority.test.ts");
    expect(workflow).toContain("Validate source-priority intersection and exact arm64 face ownership");
    expect(workflow).toContain("--require-linux-arm64");
    expect(workflow).toContain("emoji-presentation-ownership.json");
    expect(workflow).not.toContain("continue-on-error");
    expect(packageJson.scripts?.["fonts:emoji-presentation-ownership-audit"])
      .toBe("node --import tsx tools/emoji-presentation-ownership-audit.ts");
  });

  it("does not encode or relax any raster tolerance", () => {
    expect(workflow).not.toMatch(/tolerance|threshold|pixel/i);
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
