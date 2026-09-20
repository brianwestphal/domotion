import { describe, expect, it } from "vitest";
import {
  E2E_ALL_FILES,
  E2E_BASE_EXCLUDES,
  E2E_HEAVY_FILES,
  e2eLaneConfig,
  resolveE2ELane,
} from "./e2e-lanes.js";

describe("browser E2E lane partition", () => {
  it("defaults direct config use to every E2E file at one worker", () => {
    expect(resolveE2ELane(undefined)).toBe("all");
    expect(e2eLaneConfig("all")).toEqual({
      include: [...E2E_ALL_FILES],
      exclude: [...E2E_BASE_EXCLUDES],
      maxWorkers: 1,
    });
  });

  it("runs ordinary files with bounded concurrency and excludes each heavy file", () => {
    expect(e2eLaneConfig("regular")).toEqual({
      include: [...E2E_ALL_FILES],
      exclude: [...E2E_BASE_EXCLUDES, ...E2E_HEAVY_FILES],
      maxWorkers: 2,
    });
  });

  it("serializes only the measured heavy files", () => {
    expect(e2eLaneConfig("heavy")).toEqual({
      include: [...E2E_HEAVY_FILES],
      exclude: [...E2E_BASE_EXCLUDES],
      maxWorkers: 1,
    });
  });

  it("rejects an unknown lane instead of silently skipping files", () => {
    expect(() => resolveE2ELane("slow")).toThrow(/all, regular, or heavy/);
  });
});
