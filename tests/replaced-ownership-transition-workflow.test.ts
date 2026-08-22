import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("DM-2364 all-platform ownership workflow", () => {
  const root = process.cwd();
  const workflow = readFileSync(`${root}/.github/workflows/replaced-ownership-transitions.yml`, "utf8");
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as { scripts: Record<string, string> };

  it("hard-gates both DPRs and keeps the focused DPR1 compatibility command", () => {
    expect(pkg.scripts["replaced:geometry-oracle"]).toContain("tools/replaced-geometry-oracle.ts");
    expect(pkg.scripts["replaced:ownership-gate"]).toContain("--dpr 1,2");
  });

  it("runs independently on macOS, Linux, and Windows and always uploads fingerprints", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("tests/output/replaced-ownership/${{ runner.os }}/runner-image.txt");
    expect(workflow).toContain("tests/output/replaced-ownership/${{ runner.os }}/report.json");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("runs the pure mutation gate before the live browser producer", () => {
    const mutation = workflow.indexOf("tests/replaced-ownership-transition-gate.test.ts");
    const live = workflow.indexOf("npm run replaced:ownership-gate");
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(live).toBeGreaterThan(mutation);
  });
});
