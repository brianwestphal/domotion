import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVATION_KINDS, loadActivationLedger, validateActivationLedger } from "../tools/activation-coverage.js";

const ROOT = resolve(import.meta.dirname, "..");
describe("specialized-path activation ledger", () => {
  it("keeps every mechanism linked to live positive, negative, and mutation evidence", async () => {
    const ledger = await loadActivationLedger(resolve(ROOT, "tools/activation-coverage.json"));
    expect(await validateActivationLedger(ledger, ROOT)).toEqual([]);
    expect(new Set(ledger.mechanisms.map((entry) => entry.kind))).toEqual(new Set(ACTIVATION_KINDS));
  });

  it("rejects an inert or stale control", async () => {
    const ledger = await loadActivationLedger(resolve(ROOT, "tools/activation-coverage.json"));
    const invalid = structuredClone(ledger);
    invalid.mechanisms[0]!.mutation = "marker-that-does-not-exist";
    expect(await validateActivationLedger(invalid, ROOT)).toContain(`${invalid.mechanisms[0]!.id}: stale mutation marker: marker-that-does-not-exist`);
  });
});
