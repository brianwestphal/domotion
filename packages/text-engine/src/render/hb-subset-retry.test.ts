// DM-4VJXSN: `hbSubsetRetainGids` retries exactly once, on a pristine WASM
// instance, after a failure that can be cached-instance lifecycle state
// (allocation, null objects, subset, output), and rethrows deterministic input
// failures (an unpinnable axis, an outline-less output) without retrying. These
// tests drive each branch through the fault-injection seam on real HarfBuzz
// exports and assert the per-attempt diagnostics.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setHbSubsetExportsDecoratorForTest,
  getHbSubsetAttemptDiagnostics,
  hbSubsetRetainGids,
  resetHbSubsetAttemptDiagnostics,
  resetHbSubsetWasmInstance,
  type HbSubsetExports,
} from "./hb-subset.js";
import { buildStaticHintedFont } from "./synth-test-fonts.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** A decorator whose first `failing` WASM instances return null from `malloc`
 *  (a transient, instance-scoped failure); later instances are the real ones. */
function failMallocOnFirstInstances(failing: number): (real: HbSubsetExports) => HbSubsetExports {
  let created = 0;
  return (real) => (created++ < failing ? { ...real, malloc: () => 0 } : real);
}

beforeEach(() => {
  __setHbSubsetExportsDecoratorForTest(null);
  resetHbSubsetAttemptDiagnostics();
});

afterEach(() => {
  __setHbSubsetExportsDecoratorForTest(null);
  resetHbSubsetAttemptDiagnostics();
});

describe("hbSubsetRetainGids transient retry (DM-4VJXSN)", () => {
  it("first-attempt success records one attempt and keeps the cached instance", () => {
    const source = buildStaticHintedFont();
    hbSubsetRetainGids(source, [1, 2]);
    hbSubsetRetainGids(source, [1]);
    const attempts = getHbSubsetAttemptDiagnostics();
    expect(attempts.map((a) => a.stage)).toEqual(["complete", "complete"]);
    expect(attempts[0].error).toBeUndefined();
    // No retry happened, so the instance was never reset between the calls.
    expect(attempts[1].wasmInstanceId).toBe(attempts[0].wasmInstanceId);
  });

  it("retries one transient failure on a fresh instance and returns the clean subset", () => {
    const source = buildStaticHintedFont();
    resetHbSubsetWasmInstance();
    const reference = hbSubsetRetainGids(source, [1, 2]);
    resetHbSubsetAttemptDiagnostics();

    __setHbSubsetExportsDecoratorForTest(failMallocOnFirstInstances(1));
    const out = hbSubsetRetainGids(source, [1, 2]);

    expect(sha(out)).toBe(sha(reference));
    const attempts = getHbSubsetAttemptDiagnostics();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(
      expect.objectContaining({ stage: "allocate-font", error: `malloc(${source.length}) returned null` }),
    );
    expect(attempts[0].output).toBeUndefined();
    expect(attempts[1]).toEqual(expect.objectContaining({ stage: "complete", output: expect.anything() }));
    expect(attempts[1].error).toBeUndefined();
    expect(attempts[1].output?.sha256).toBe(sha(reference));
    // The retry ran on a pristine heap, not the instance that failed.
    expect(attempts[1].wasmInstanceId).not.toBe(attempts[0].wasmInstanceId);
    expect(attempts[1].buildOrdinal).toBe(attempts[0].buildOrdinal + 1);
  });

  it("honors the retry bound: a persistent failure makes exactly two attempts, then throws", () => {
    const source = buildStaticHintedFont();
    __setHbSubsetExportsDecoratorForTest(failMallocOnFirstInstances(Number.POSITIVE_INFINITY));
    expect(() => hbSubsetRetainGids(source, [1])).toThrow(`malloc(${source.length}) returned null`);
    const attempts = getHbSubsetAttemptDiagnostics();
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      expect(attempt).toEqual(expect.objectContaining({ stage: "allocate-font", error: expect.any(String) }));
    }
    expect(attempts[1].wasmInstanceId).not.toBe(attempts[0].wasmInstanceId);
  });

  it("does not retry a deterministic axis-pinning failure", () => {
    // A static face reports no variation axes, so pinning cannot succeed on
    // any instance; a retry would only duplicate the attempt.
    const source = buildStaticHintedFont();
    hbSubsetRetainGids(source, [1]);
    const warmInstance = getHbSubsetAttemptDiagnostics()[0].wasmInstanceId;
    resetHbSubsetAttemptDiagnostics();

    expect(() => hbSubsetRetainGids(source, [1], 0, true, {})).toThrow(/pin_all_axes_to_default/);
    const attempts = getHbSubsetAttemptDiagnostics();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(expect.objectContaining({ stage: "configure-input", axes: {} }));
    // Rethrown before the reset, so the warm instance survives.
    expect(attempts[0].wasmInstanceId).toBe(warmInstance);
  });

  it("does not retry an outline-less output", () => {
    const source = buildStaticHintedFont();
    // An empty output blob has no outline table, which the consumer browser's
    // OTS sanitizer would reject; that verdict does not depend on the instance.
    __setHbSubsetExportsDecoratorForTest((real) => ({ ...real, hb_blob_get_length: () => 0 }));
    expect(() => hbSubsetRetainGids(source, [1])).toThrow(/no outline table/);
    const attempts = getHbSubsetAttemptDiagnostics();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual(expect.objectContaining({ stage: "validate-output" }));
  });
});
