import { describe, expect, it } from "vitest";
import {
  coverageCommandExitStatus,
  normalizeCoverageExitStatus,
} from "../tools/coverage-exit-status.mjs";

describe("merged coverage exit propagation", () => {
  it("passes only when every required suite and c8 pass", () => {
    expect(coverageCommandExitStatus([0, 0, 0, 0], 0)).toBe(0);
  });

  it.each([
    [[1, 0, 0], 0],
    [[0, 2, 0], 0],
    [[0, 0, null], 0],
  ] as const)("fails when any constituent suite fails (%j)", (suiteStatuses, reportStatus) => {
    expect(coverageCommandExitStatus([...suiteStatuses], reportStatus)).toBe(1);
  });

  it("preserves a nonzero c8 report status when the suites passed", () => {
    expect(coverageCommandExitStatus([0, 0], 3)).toBe(3);
  });

  it("maps a signal or spawn failure without an exit status to 1", () => {
    expect(normalizeCoverageExitStatus(null)).toBe(1);
    expect(normalizeCoverageExitStatus(undefined)).toBe(1);
  });
});
