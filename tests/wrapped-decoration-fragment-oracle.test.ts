import { describe, expect, it } from "vitest";
import { runOracle } from "../tools/wrapped-decoration-fragment-oracle.js";

describe("wrapped decoration fragment oracle", () => {
  it("keeps every DPR/axis row exact and detects all destructive controls", () => {
    const report = runOracle();
    expect(report.pass).toBe(true);
    expect(report.exactRows).toBe(8);
    expect(report.rows).toBe(8);
    expect(report.mutations).toHaveLength(6);
    expect(report.mutations.every((mutation) => mutation.detected)).toBe(true);
  });
});
