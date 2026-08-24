import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  adjudicateFragmentedCollapsedTableRelease,
  FRAGMENTED_TABLE_PLATFORMS,
} from "../tools/fragmented-collapsed-table-release-gate.js";

const screen = (os: string) => ({
  schemaVersion: 3, pass: true, currentProtocolExact: true,
  verdict: "screen-section-fragment-record-authenticated",
  environment: { os }, print: { pixelsRead: false },
  discriminators: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`d${i}`, true])),
  mutations: Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, moved: true })),
});
const paged = (os: string) => ({
  schemaVersion: 1, pass: true,
  verdict: "public-print-fragment-transport-unavailable-fail-closed",
  environment: { os }, requiredMatrix: Array.from({ length: 8 }, (_, i) => `p${i}`),
  discriminators: { exact: true, pixelsRead: false },
  mutations: Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, moved: true })),
});
const ink = (platform: string) => ({
  schemaVersion: 1, platform, verdict: "ratified-source-exact",
  artifactSetSha256: "a".repeat(64), ratifiedRows: 1152, unratifiedRows: 0,
  unratifiedFamilies: [], findings: [],
  scenarios: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, pass: true })),
});

describe("fragmented collapsed-table release gate", () => {
  it("requires all three independent logical/print/ink legs", () => {
    const result = adjudicateFragmentedCollapsedTableRelease(
      FRAGMENTED_TABLE_PLATFORMS.map(screen),
      FRAGMENTED_TABLE_PLATFORMS.map(paged),
      FRAGMENTED_TABLE_PLATFORMS.map(ink),
    );
    expect(result).toEqual({ ready: true, blockers: [], summary: "READY: 0 fragmented-table release blocker(s)" });
  });

  it("does not let native ink excuse logical or print ownership drift", () => {
    const badScreen = FRAGMENTED_TABLE_PLATFORMS.map(screen);
    badScreen[0].mutations[0].moved = false;
    const badPaged = FRAGMENTED_TABLE_PLATFORMS.map(paged);
    badPaged[1].verdict = "paged-print-boundary-incomplete";
    const result = adjudicateFragmentedCollapsedTableRelease(
      badScreen, badPaged, FRAGMENTED_TABLE_PLATFORMS.map(ink),
    );
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("screen/darwin: destructive mutation matrix incomplete");
    expect(result.blockers).toContain("paged/linux: public print boundary did not fail closed exactly");
  });

  it("pins a headless three-platform retained-artifact workflow", () => {
    const workflow = readFileSync(".github/workflows/fragmented-collapsed-table-release.yml", "utf8");
    expect(workflow).toContain("macos-latest");
    expect(workflow).toContain("ubuntu-latest");
    expect(workflow).toContain("windows-latest");
    expect(workflow).toContain("headless");
    expect(workflow).toContain("borders:collapsed-fragmentation-audit");
    expect(workflow).toContain("borders:paged-collapsed-ownership-audit");
    expect(workflow).toContain("borders:phase-ratify");
    expect(workflow).toContain("borders:fragmented-release-gate");
    expect(workflow).toContain("fragmented-collapsed-table-release-evidence");
    expect(workflow).not.toContain("continue-on-error");
  });
});
