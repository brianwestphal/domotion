import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/generic-profile-target-parity.yml", "utf8");

describe("generic profile/target workflow", () => {
  it("runs the exact logical gate on all native platforms", () => {
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("npx playwright install chrome");
    expect(workflow).toContain("xvfb-run -a npm run fonts:generic-profile-target");
    expect(workflow).not.toContain("continue-on-error");
  });
});
