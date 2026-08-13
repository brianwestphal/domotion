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
});
