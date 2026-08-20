import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateParityRelease, loadParityReleaseEvidence } from "../tools/parity-release-gate.js";

const ROOT = resolve(import.meta.dirname, "..");
describe("near-complete Chromium parity release gate", () => {
  it("reports the repository's acknowledged blockers instead of a confidence percentage", async () => {
    const evidence = await loadParityReleaseEvidence(resolve(ROOT, "tools/parity-release-evidence.json"));
    const result = await evaluateParityRelease(ROOT, evidence);
    expect(result.ready).toBe(false);
    expect(result.summary).toMatch(/^NOT READY: \d+ blocker/);
    expect(result.blockers).toContain("partial semantic family: text.family-fallback");
    expect(result.blockers).toContain("missing reviewed visual evidence: darwin");
    expect(result.blockers).toContain("source audit incomplete: borders-outlines (partial)");
  });

  it("rejects unexplained and logical residuals independently of pixel percentages", async () => {
    const evidence = await loadParityReleaseEvidence(resolve(ROOT, "tools/parity-release-evidence.json"));
    evidence.platforms.push({ platform: "darwin", environmentFingerprint: "x", comparableGroup: "g", reviewedAt: new Date().toISOString(), suites: ["features", "showcase", "html", "unicode", "real-world"], residuals: [
      { fixture: "a", classification: "logical", explained: true, reason: "known divergence" },
      { fixture: "b", classification: "rasterization-only", explained: false, reason: "not reviewed" },
    ] });
    const result = await evaluateParityRelease(ROOT, evidence);
    expect(result.blockers).toContain("logical residual remains: darwin/a");
    expect(result.blockers).toContain("unexplained residual: darwin/b");
  });
});
