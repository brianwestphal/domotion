import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "release-helpers.yml");

describe("release-helpers.yml", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");

  it("is reusable/manual and always builds the explicitly requested tag", () => {
    expect(yaml).toMatch(/^ {2}workflow_call:\n {4}inputs:\n {6}tag:/m);
    expect(yaml).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:/m);
    expect(yaml).not.toMatch(/^ {2}push:/m);
    expect(yaml).not.toContain("github.ref_name");
    expect(yaml).not.toContain("github.event.inputs");

    const checkoutCount = [...yaml.matchAll(/uses: actions\/checkout@v4/g)].length;
    const tagCheckoutCount = [...yaml.matchAll(/with: \{ ref: '\$\{\{ inputs\.tag \}\}' \}/g)].length;
    expect(checkoutCount).toBe(5);
    expect(tagCheckoutCount).toBe(checkoutCount);
  });

  it("retains all five build products before one fan-in upload", () => {
    expect([...yaml.matchAll(/uses: actions\/upload-artifact@v4/g)]).toHaveLength(5);
    expect([...yaml.matchAll(/uses: actions\/download-artifact@v4/g)]).toHaveLength(1);
    expect([...yaml.matchAll(/gh release upload/g)]).toHaveLength(1);
    expect(yaml).toContain("pattern: release-helper-*");
    expect(yaml).toContain("retention-days: 7");
    expect(yaml).toContain("merge-multiple: true");
    for (const asset of [
      "domotion-glyph-paths-darwin-universal",
      "domotion-glyph-paths-linux-x64",
      "domotion-glyph-paths-linux-arm64",
      "domotion-glyph-paths-win32-x64.exe",
      "domotion-glyph-paths-win32-arm64.exe",
    ]) expect(yaml).toContain(asset);
  });

  it("fails fast if the caller did not create the release and never polls", () => {
    expect(yaml).toContain('gh release view "$TAG" >/dev/null');
    expect(yaml).not.toMatch(/for i in|sleep 10|seq 1 30/);
    expect(yaml).toMatch(/attach-binaries:\n    needs:\n(?:      - .+\n){5}/);
  });
});
