import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "..", ".github", "workflows", "release.yml");

describe("release.yml", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");

  it("pins the trusted-publishing npm instead of following the moving latest tag", () => {
    expect(yaml).toContain("npm install -g npm@11.6.2");
    expect(yaml).not.toMatch(/npm install -g npm@(latest|next)\b/);
  });

  it("can safely resume an existing release tag after an infrastructure failure", () => {
    expect(yaml).toMatch(/^ {2}workflow_dispatch:\n {4}inputs:\n {6}release_ref:/m);
    expect(yaml).toContain("RELEASE_REF: ${{ inputs.release_ref || github.ref_name }}");
    expect(yaml).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+(-beta\\.[0-9]+)?$");

    const checkoutCount = [...yaml.matchAll(/uses: actions\/checkout@v4/g)].length;
    const releaseRefCheckoutCount = [...yaml.matchAll(/with: \{ ref: '\$\{\{ env\.RELEASE_REF \}\}' \}/g)].length;
    expect(releaseRefCheckoutCount, "every checkout must read the requested release tag").toBe(checkoutCount);
  });

  it("provisions the complete headless primary-host test contract", () => {
    const testJob = /\n  test:\n([\s\S]*?)\n  typecheck:/.exec(yaml)?.[1] ?? "";
    expect(testJob).toContain("runs-on: macos-latest");
    expect(testJob).toContain("node scripts/materialize-source-authorities.mjs");
    expect(testJob).toContain("raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GITHUB_SHA}");
    expect(testJob).toContain("npx playwright install chromium");
    expect(testJob).toContain('SWIFT_ARCH="$(uname -m)"');
    expect(testJob).toContain('swift build -c release --arch "$SWIFT_ARCH"');
    expect(testJob.indexOf("npx playwright install chromium")).toBeLessThan(testJob.indexOf("npm test"));
    expect(yaml).toContain("DOMOTION_NO_OPEN: '1'");
  });

  it("creates the release before invoking retained helper publication", () => {
    expect(yaml).toMatch(/\n  release-helpers:\n    needs: create-release\n    uses: \.\/\.github\/workflows\/release-helpers\.yml/);
    expect(yaml).toContain("tag: ${{ inputs.release_ref || github.ref_name }}");
    expect(yaml).toContain("secrets: inherit");
    expect(yaml).toContain("needs: [create-release, detect, release-helpers]");
  });
});
