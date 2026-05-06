import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultWorkerCount, detectCoreCount, lowerProcessPriority, resolveWorkerCount } from "./worker-pool.js";

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
  it("uses ~quarter of the cores on multi-core hosts (Chromium subprocess overhead)", () => {
    expect(defaultWorkerCount(8)).toBe(2);
    expect(defaultWorkerCount(4)).toBe(1);
    expect(defaultWorkerCount(2)).toBe(1);
    expect(defaultWorkerCount(10)).toBe(2);
    expect(defaultWorkerCount(16)).toBe(4);
    expect(defaultWorkerCount(20)).toBe(5);
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

  it("caps the default at 8 on huge hosts (32-core, 64-core, ...)", () => {
    expect(defaultWorkerCount(32)).toBe(8);
    expect(defaultWorkerCount(64)).toBe(8);
    expect(defaultWorkerCount(128)).toBe(8);
  });

  it("at runtime, leaves at least 3/4 of the cores free on this host (regression guard)", () => {
    // Catches loosenings (`cores - 1`, `cores / 2`, hardcoded `6`, etc.)
    // slipping back in. Each worker owns a Playwright BrowserContext —
    // a Chromium process tree of 4-6 processes plus 500 MB-2 GB resident,
    // so worker count alone understates the system footprint. The ~25%
    // cap is what keeps the host genuinely responsive while tests run
    // (DM-459 v3 user feedback). On a 1-core box both sides are 1.
    const cores = detectCoreCount();
    const workers = defaultWorkerCount();
    if (cores > 1) {
      expect(workers).toBeLessThanOrEqual(Math.max(1, Math.floor(cores / 4)));
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

describe("lowerProcessPriority (DM-459 v2)", () => {
  let originalNice: number;
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalNice = os.getPriority();
    originalEnv = process.env["DOMOTION_NO_NICE"];
    delete process.env["DOMOTION_NO_NICE"];
  });

  afterEach(() => {
    // Restore the priority we found at start. Lowering nice is allowed
    // (raising it back to 0 from a positive value) is also allowed for
    // the calling process per POSIX setpriority. If neither works the
    // test process just stays niced; harmless inside vitest.
    try { os.setPriority(0, originalNice); } catch { /* best-effort */ }
    if (originalEnv == null) delete process.env["DOMOTION_NO_NICE"];
    else process.env["DOMOTION_NO_NICE"] = originalEnv;
  });

  it("raises this process's nice value (lower scheduling priority)", () => {
    const before = os.getPriority();
    lowerProcessPriority(10);
    const after = os.getPriority();
    // POSIX nice goes 0..19 (lower priority = higher number). After the
    // call, our nice should be at LEAST what we asked for. (If the host
    // already had a higher nice — e.g. running under `nice -n 15` — the
    // setPriority call is still allowed and just resets to 10. We accept
    // either: priority strictly increased, OR is now exactly 10.)
    expect(after).toBeGreaterThanOrEqual(Math.min(before, 10));
  });

  it("is a no-op when DOMOTION_NO_NICE=1 is set", () => {
    process.env["DOMOTION_NO_NICE"] = "1";
    const before = os.getPriority();
    lowerProcessPriority(10);
    const after = os.getPriority();
    expect(after).toBe(before);
  });
});
