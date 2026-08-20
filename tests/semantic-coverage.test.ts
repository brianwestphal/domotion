import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FEATURES } from "./feature-coverage.js";
import {
  loadSemanticCoverage,
  semanticCoverageReport,
  validateSemanticCoverage,
  type SemanticCoverageInventory,
} from "../tools/semantic-coverage.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INVENTORY = resolve(ROOT, "tools/semantic-coverage.json");
const EXCLUDED_TRANSITIONS = FEATURES.filter((feature) => feature.transition != null).map((feature) => ({
  featureId: feature.id,
  reason: "Excluded in malformed-inventory validation fixture.",
}));

describe("semantic coverage inventory", () => {
  it("keeps every checked-in transition structurally valid and source-linked", async () => {
    const inventory = await loadSemanticCoverage(INVENTORY);
    const result = await validateSemanticCoverage(inventory, ROOT);
    expect(result.errors).toEqual([]);
    expect(inventory.transitions.length).toBeGreaterThanOrEqual(15);
    expect(result.uncovered.length).toBeGreaterThan(0);
  });

  it("rejects silent gaps, non-transition states, stale paths, and false exact claims", async () => {
    const invalid: SemanticCoverageInventory = {
      schemaVersion: 1,
      contract: "package.json",
      excludedFeatureTransitions: EXCLUDED_TRANSITIONS,
      transitions: [{
        id: "bad",
        parityAreas: ["missing-area"],
        featureIds: ["missing-feature"],
        subjects: ["display"],
        states: ["block"],
        exactStates: [],
        uncoveredStates: [],
        upstreamSources: ["missing-upstream"],
        productionOwners: ["package.json"],
        oracles: [],
        metamorphicTests: [],
        visualFixtures: [],
        verifiedPlatforms: ["darwin"],
        coverage: "exact",
      }],
    };
    const result = await validateSemanticCoverage(invalid, ROOT);
    expect(result.errors).toContain("bad: every state must name exactly one nonempty transition with ->");
    expect(result.errors).toContain("bad: unknown parity area missing-area");
    expect(result.errors).toContain("bad: unknown feature id missing-feature");
    expect(result.errors).toContain("bad: exact row misses linux, win32");
    expect(result.errors).toContain("bad: exact row requires oracle, metamorphic, and visual evidence");
    expect(result.errors).toContain("bad: missing path missing-upstream");
  });

  it("rejects repository-escaping evidence references", async () => {
    const inventory = await loadSemanticCoverage(INVENTORY);
    const invalid = structuredClone(inventory);
    invalid.transitions[0]!.oracles = ["../outside.ts"];
    const result = await validateSemanticCoverage(invalid, ROOT);
    expect(result.errors).toContain(`${invalid.transitions[0]!.id}: path escapes repository ../outside.ts`);
  });

  it("reports acknowledged state-level boundaries", async () => {
    const inventory = await loadSemanticCoverage(INVENTORY);
    const report = semanticCoverageReport(inventory);
    expect(report).toContain("Uncovered:");
    expect(report).not.toContain("text.emoji-presentation [partial]");
    expect(report).toContain("generic family -> browser preference");
  });
});
