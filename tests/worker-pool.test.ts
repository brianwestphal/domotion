import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultWorkerCount, detectCoreCount, resolveWorkerCount } from "./worker-pool.js";

const ORIGINAL_ARGV = process.argv;
const ORIGINAL_ENV_WORKERS = process.env["DOMOTION_TEST_WORKERS"];

beforeEach(() => {
  process.argv = ["node", "script"];
  delete process.env["DOMOTION_TEST_WORKERS"];
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  if (ORIGINAL_ENV_WORKERS == null) delete process.env["DOMOTION_TEST_WORKERS"];
  else process.env["DOMOTION_TEST_WORKERS"] = ORIGINAL_ENV_WORKERS;
});

describe("detectCoreCount", () => {
  it("returns a positive finite integer", () => {
    const n = detectCoreCount();
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe("defaultWorkerCount (DM-459)", () => {
  it("leaves one core free on multi-core hosts", () => {
    expect(defaultWorkerCount(8)).toBe(7);
    expect(defaultWorkerCount(4)).toBe(3);
    expect(defaultWorkerCount(2)).toBe(1);
  });

  it("returns 1 on a single-core host", () => {
    expect(defaultWorkerCount(1)).toBe(1);
  });

  it("never exceeds the core count for any reasonable size", () => {
    for (let cores = 1; cores <= 64; cores++) {
      expect(defaultWorkerCount(cores)).toBeLessThanOrEqual(cores);
      expect(defaultWorkerCount(cores)).toBeGreaterThanOrEqual(1);
    }
  });

  it("at runtime, leaves at least one core free on this host (regression guard)", () => {
    // Catches accidental hardcoded defaults (`defaultWorkers: number = 6`)
    // slipping back in. CI hosts are typically multi-core so the < cores
    // assertion holds; on a hypothetical 1-core box both sides are 1.
    const cores = detectCoreCount();
    const workers = defaultWorkerCount();
    if (cores > 1) {
      expect(workers).toBeLessThan(cores);
      expect(workers).toBeGreaterThanOrEqual(1);
    } else {
      expect(workers).toBe(1);
    }
  });
});

describe("resolveWorkerCount", () => {
  it("uses the cpus-minus-one default when no override is supplied", () => {
    // Pin the default explicitly so the test is host-independent.
    expect(resolveWorkerCount(7)).toBe(7);
  });

  it("honours --workers N", () => {
    process.argv = ["node", "script", "--workers", "3"];
    expect(resolveWorkerCount(7)).toBe(3);
  });

  it("honours --workers=N", () => {
    process.argv = ["node", "script", "--workers=4"];
    expect(resolveWorkerCount(7)).toBe(4);
  });

  it("honours DOMOTION_TEST_WORKERS env var", () => {
    process.env["DOMOTION_TEST_WORKERS"] = "5";
    expect(resolveWorkerCount(7)).toBe(5);
  });

  it("CLI flag wins over env var when both are set", () => {
    process.argv = ["node", "script", "--workers=2"];
    process.env["DOMOTION_TEST_WORKERS"] = "8";
    expect(resolveWorkerCount(7)).toBe(2);
  });

  it("clamps explicit overrides above 32 down to 32", () => {
    process.argv = ["node", "script", "--workers=999"];
    expect(resolveWorkerCount(7)).toBe(32);
  });

  it("clamps the default down to 32 (e.g. 64-core boxes)", () => {
    expect(resolveWorkerCount(63)).toBe(32);
  });

  it("falls back to the default when the override is non-numeric", () => {
    process.env["DOMOTION_TEST_WORKERS"] = "abc";
    expect(resolveWorkerCount(7)).toBe(7);
  });

  it("falls back to the default when the override is zero or negative", () => {
    process.argv = ["node", "script", "--workers=0"];
    expect(resolveWorkerCount(7)).toBe(7);
  });
});
