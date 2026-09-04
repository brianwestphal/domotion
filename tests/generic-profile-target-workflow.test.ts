import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/generic-profile-target-parity.yml", "utf8");
const installer = readFileSync("scripts/install-windows-profile-fixture-fonts.ps1", "utf8");

describe("generic profile/target workflow", () => {
  it("runs the exact logical gate on all native platforms", () => {
    expect(workflow).toContain("macos-14");
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("install-windows-profile-fixture-fonts.ps1");
    expect(workflow).toContain("DomotionProfileDevanagari*.ttf");
    expect(workflow).not.toContain("Get-WindowsCapability -Online");
    expect(workflow).not.toContain("Add-WindowsCapability");
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

  it("registers the fixture faces as session-visible per-user Windows fonts", () => {
    expect(installer).toContain("Microsoft\\Windows\\Fonts");
    expect(installer).toContain("HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts");
    expect(installer).toContain("AddFontResourceExW(");
    expect(installer).toContain("$destination, 0, [IntPtr]::Zero");
    expect(installer).toContain("$fontChange = 0x001d");
    expect(installer).toContain("DomotionProfileDevanagariOne-Regular.ttf");
    expect(installer).toContain("DomotionProfileDevanagariTwo-Regular.ttf");
  });
});
