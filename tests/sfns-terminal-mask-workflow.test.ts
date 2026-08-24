import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/sfns-terminal-mask-adjudication.yml", "utf8");
const adjudicator = readFileSync("tools/sfns-terminal-mask-adjudicator.ts", "utf8");
const packageJson = readFileSync("package.json", "utf8");

describe("optional SFNS terminal-mask CI adjudication", () => {
  it("is manual-only while the retained exact artifacts disagree", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s+(push|pull_request):/m);
    expect(workflow).toContain("fonts:sfns-terminal-mask:adjudicate");
    expect(workflow).toContain("dm2577-sfns-pinned-skia-proposal.json");
    expect(workflow).toContain("dm2575-sfns-pinned-chromium-validation.json");
    expect(packageJson).toContain('"fonts:sfns-terminal-mask:adjudicate"');
  });

  it("launches no browser and encodes exact byte equality without a threshold", () => {
    expect(adjudicator).not.toMatch(/chromium\.launch|headless:\s*false/);
    expect(adjudicator).toContain("exact-logical-fields-and-bytes-no-tolerance");
    expect(adjudicator).toContain("zero-only-process-local-four-byte-typeface-id");
    expect(adjudicator).toContain("mask.glyph.mask.bytes");
    expect(workflow).not.toMatch(/playwright|browser|tolerance|threshold/i);
  });
});
