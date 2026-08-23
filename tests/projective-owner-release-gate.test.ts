import { describe, expect, it } from "vitest";
import {
  adjudicateProjectiveOwnerRelease, PROJECTIVE_GATE_DPRS, PROJECTIVE_GATE_FAMILIES,
  PROJECTIVE_GATE_MUTATIONS, PROJECTIVE_GATE_PLATFORMS, PROJECTIVE_GATE_PROFILES,
  type ProjectiveOwnerReleaseReport,
} from "../tools/projective-owner-release-gate.js";

const digest = "a".repeat(64);
function report(platform: typeof PROJECTIVE_GATE_PLATFORMS[number]): ProjectiveOwnerReleaseReport {
  const environment = { platform, architecture: "x64", osRelease: "release", runnerImage: `${platform}-image`, runnerImageVersion: "1", chromiumVersion: "147", chromiumRevision: "pin", playwrightVersion: "1.59", launchArguments: ["--headless"] };
  const fingerprint = `${platform}-x64-${platform}-image-1-pin`;
  return { schemaVersion: 2, environment, rows: PROJECTIVE_GATE_FAMILIES.flatMap((family) => PROJECTIVE_GATE_PROFILES.flatMap((profile) => PROJECTIVE_GATE_DPRS.map((dpr) => ({
    family, profile, dpr, expectedOwnerIds: family.includes("negative") ? [] : ["owner"], actualOwnerIds: family.includes("negative") ? [] : ["owner"],
    rasterCount: family.includes("negative") ? 0 : 1, directImageApplications: family.includes("negative") ? 0 : 1,
    nestedDuplicateCount: 0, sampledApproximationCount: 0, vectorSentinelExact: true, sentinelBakedIntoRaster: false,
    restorationExact: true, warnings: [], maxFinalPixelDelta: 4, artifacts: [{ role: "source", path: `${fingerprint}/${family}-${profile}-${dpr}.png`, sha256: digest, pngWidth: 10, pngHeight: 10, deviceRect: { x: 0, y: 0, width: 10, height: 10 }, sourceFrameDeviceRect: { x: 0, y: 0, width: 20, height: 20 } }], pass: true,
  })))), mutations: PROJECTIVE_GATE_MUTATIONS.map((id) => ({ id, killed: true })) };
}
const complete = () => PROJECTIVE_GATE_PLATFORMS.map(report);

describe("DM-2493 projective owner release adjudicator", () => {
  it("accepts only the complete exact three-platform Cartesian corpus", () => expect(adjudicateProjectiveOwnerRelease(complete())).toEqual({ ready: true, blockers: [] }));
  it("rejects missing rows, warnings, restoration, owner, duplicate, sentinel, crop and pixel drift", () => {
    const reports = complete(); const row = reports[0].rows.shift()!; const bad = reports[0].rows[0];
    bad.warnings.push("partial"); bad.restorationExact = false; bad.actualOwnerIds = ["wrong"]; bad.nestedDuplicateCount = 1;
    bad.vectorSentinelExact = false; bad.sentinelBakedIntoRaster = true; bad.maxFinalPixelDelta = 5; bad.artifacts[0].deviceRect.x = 15;
    expect(adjudicateProjectiveOwnerRelease(reports).blockers.join("\n")).toMatch(/missing Cartesian|warnings forbidden|restoration drift|owner identity|duplicate or sampled|sentinel|four device|escapes/);
    expect(row).toBeDefined();
  });
  it("rejects stale animation/grouping and cross-platform fingerprint substitutions", () => {
    const reports = complete(); reports[0].mutations.find((m) => m.id === "stale-animated-owner")!.killed = false;
    reports[1].rows[0].artifacts[0].path = reports[0].rows[0].artifacts[0].path;
    expect(adjudicateProjectiveOwnerRelease(reports).blockers.join("\n")).toMatch(/stale-animated-owner|fingerprint mismatch/);
  });
  it("rejects missing platforms and schema-v1 observational reports", () => {
    expect(adjudicateProjectiveOwnerRelease([{ schemaVersion: 1 }]).blockers.join("\n")).toMatch(/schema v2 rejected|missing native platform/);
  });
});
