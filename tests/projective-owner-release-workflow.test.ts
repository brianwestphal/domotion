import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const workflow = readFileSync(".github/workflows/projective-owner-release.yml", "utf8");
describe("DM-2493 three-platform workflow", () => {
  it("collects native macOS/Linux/Windows reports and strictly aggregates them", () => {
    for (const os of ["macos-latest", "ubuntu-latest", "windows-latest"]) expect(workflow).toContain(os);
    expect(workflow).toContain("fail-fast: false"); expect(workflow).toContain("actions/download-artifact@v4");
    expect(workflow).toContain("transform:projective-owner-release"); expect(workflow).not.toContain("continue-on-error");
  });
  it("always uploads lossless evidence and runs on relevant changes", () => {
    expect(workflow).toContain("if-no-files-found: error"); expect(workflow).toContain("--artifacts");
    expect(workflow).toMatch(/pull_request:/); expect(workflow).toMatch(/push:/);
  });
});
