import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/border-phase-oracle.yml", "utf8");

describe("DM-2355 border phase ratification workflow", () => {
  it("is a hard pull-request/main gate on every supported desktop platform", () => {
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toMatch(/\n\s*pull_request:/);
    expect(workflow).toMatch(/\n\s*push:/);
    expect(workflow).toContain("branches: [main]");
    expect(workflow).not.toContain("continue-on-error");
  });

  it("runs the complete scale matrix and the separate strict adjudicator", () => {
    expect(workflow).toContain("--dsf 1,2,4");
    expect(workflow).toContain("--zoom 0.8,1,1.25");
    expect(workflow).toContain("borders:phase-oracle");
    expect(workflow).toContain("borders:phase-ratify");
    expect(workflow).toContain("border-phase-envelopes.json");
  });

  it("captures Linux in bounded tiles and preserves all evidence on failure", () => {
    expect(workflow).toContain("playwright install --with-deps chromium");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("adjudication.json");
    expect(workflow).toContain("artifacts");
    expect(workflow).toContain("if-no-files-found: error");
  });
});
