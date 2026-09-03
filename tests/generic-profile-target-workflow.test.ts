import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/generic-profile-target-parity.yml", "utf8");

describe("generic profile/target workflow", () => {
  it("runs the exact logical gate on all native platforms", () => {
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("Get-WindowsCapability -Online");
    expect(workflow).toContain("Language.Fonts.Deva*");
    expect(workflow).toContain("Add-WindowsCapability -Online -Name $capability.Name");
    expect(workflow).toContain("timeout-minutes: 30");
    // GitHub's native runner images already provide the system Chrome channel.
    // Reinstalling it deletes that known-good copy before making a network
    // download, which can turn transient CDN corruption into a red oracle.
    expect(workflow).not.toContain("npx playwright install chrome");
    expect(workflow).toContain("xvfb-run -a npm run fonts:generic-profile-target");
    expect(workflow.match(/--allow-headed-browser/g)).toHaveLength(2);
    expect(workflow).toContain("generic-profile-target.json");
    expect(workflow).not.toContain("continue-on-error");
    expect(workflow).not.toMatch(/screenshot|pixel|tolerance/i);
  });
});
