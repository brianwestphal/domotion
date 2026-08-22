import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/broken-image-fallback-parity.yml", "utf8");

describe("DM-2465 broken-image fallback workflow", () => {
  it("runs independent native producers on all supported desktop platforms", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
  });

  it("requests the full DPR and color-scheme Cartesian matrix", () => {
    expect(workflow).toContain("--dpr 1,2");
    expect(workflow).toContain("--scheme light,dark");
    expect(workflow).toContain("broken-image:parity-gate");
    expect(workflow).toContain("broken-image:hybrid-e2e");
  });

  it("is a hard PR/main gate and uploads fingerprinted evidence even on failure", () => {
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("broken-image-fallback-${{ runner.os }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).not.toContain("continue-on-error");
  });
});
