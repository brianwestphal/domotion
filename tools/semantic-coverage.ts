import { access, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { FEATURES } from "../tests/feature-coverage.js";

export const SEMANTIC_COVERAGE_VALUES = ["exact", "partial", "unsupported"] as const;
export const SEMANTIC_PLATFORMS = ["darwin", "linux", "win32"] as const;

export type SemanticCoverage = typeof SEMANTIC_COVERAGE_VALUES[number];
export type SemanticPlatform = typeof SEMANTIC_PLATFORMS[number];

export interface SemanticTransition {
  id: string;
  parityAreas: string[];
  featureIds: string[];
  subjects: string[];
  states: string[];
  exactStates: string[];
  uncoveredStates: string[];
  upstreamSources: string[];
  productionOwners: string[];
  oracles: string[];
  metamorphicTests: string[];
  visualFixtures: string[];
  verifiedPlatforms: SemanticPlatform[];
  coverage: SemanticCoverage;
  boundary?: string;
}

export interface ExcludedFeatureTransition {
  featureId: string;
  reason: string;
}

export interface SemanticCoverageInventory {
  schemaVersion: number;
  contract: string;
  transitions: SemanticTransition[];
  excludedFeatureTransitions: ExcludedFeatureTransition[];
}

const transitionSchema = z.object({
  id: z.string(), parityAreas: z.array(z.string()), featureIds: z.array(z.string()),
  subjects: z.array(z.string()), states: z.array(z.string()), exactStates: z.array(z.string()),
  uncoveredStates: z.array(z.string()), upstreamSources: z.array(z.string()),
  productionOwners: z.array(z.string()), oracles: z.array(z.string()),
  metamorphicTests: z.array(z.string()), visualFixtures: z.array(z.string()),
  verifiedPlatforms: z.array(z.enum(SEMANTIC_PLATFORMS)), coverage: z.enum(SEMANTIC_COVERAGE_VALUES),
  boundary: z.string().optional(),
});
const inventorySchema = z.object({
  schemaVersion: z.number(), contract: z.string(), transitions: z.array(transitionSchema),
  excludedFeatureTransitions: z.array(z.object({ featureId: z.string(), reason: z.string() })),
});

export interface SemanticCoverageValidation {
  errors: string[];
  uncovered: SemanticTransition[];
}

const pathPart = (ref: string): string => ref.split("#", 1)[0];

export async function loadSemanticCoverage(path: string): Promise<SemanticCoverageInventory> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid semantic coverage JSON: ${String(error)}`);
  }
  const parsed = inventorySchema.safeParse(value);
  if (!parsed.success) throw new Error(`Invalid semantic coverage schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function validateSemanticCoverage(
  inventory: SemanticCoverageInventory,
  root: string,
): Promise<SemanticCoverageValidation> {
  const errors: string[] = [];
  const ids = new Set<string>();
  const coverageValues = new Set<string>(SEMANTIC_COVERAGE_VALUES);
  const platforms = new Set<string>(SEMANTIC_PLATFORMS);
  const featureIds = new Set(FEATURES.map((feature) => feature.id));
  let parityAreaIds = new Set<string>();
  let featureFixtureIds = new Set<string>();
  try {
    const parity = JSON.parse(await readFile(resolve(root, "tools/parity-program.json"), "utf8")) as {
      areas?: Array<{ id?: string }>;
    };
    parityAreaIds = new Set((parity.areas ?? []).flatMap((area) => area.id == null ? [] : [area.id]));
    const featureSource = await readFile(resolve(root, "tests/features.ts"), "utf8");
    featureFixtureIds = new Set([...featureSource.matchAll(/\bname:\s*["']([^"']+)["']/g)].map((match) => match[1]));
  } catch (error) {
    errors.push(`could not load parity/fixture registries: ${String(error)}`);
  }

  const requirePath = async (ref: string, label: string): Promise<void> => {
    const path = pathPart(ref);
    if (path === "") {
      errors.push(`${label}: empty path reference`);
      return;
    }
    const resolved = resolve(root, path);
    if (isAbsolute(path) || relative(root, resolved).startsWith("..")) {
      errors.push(`${label}: path escapes repository ${path}`);
      return;
    }
    try {
      await access(resolved);
    } catch {
      errors.push(`${label}: missing path ${path}`);
    }
  };

  if (inventory.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!inventory.contract?.trim()) errors.push("contract must be explicit");
  else await requirePath(inventory.contract, "contract");
  if (!Array.isArray(inventory.transitions) || inventory.transitions.length === 0) {
    errors.push("transitions must not be empty");
  }

  for (const row of inventory.transitions ?? []) {
    const label = row.id || "<empty>";
    if (!row.id?.trim() || ids.has(row.id)) errors.push(`duplicate or empty transition id: ${label}`);
    ids.add(row.id);
    if (!row.subjects?.length) errors.push(`${label}: subjects must not be empty`);
    if (!row.parityAreas?.length) errors.push(`${label}: parityAreas must not be empty`);
    for (const area of row.parityAreas ?? []) {
      if (!parityAreaIds.has(area)) errors.push(`${label}: unknown parity area ${area}`);
    }
    if (!row.featureIds?.length) errors.push(`${label}: featureIds must not be empty`);
    for (const featureId of row.featureIds ?? []) {
      if (!featureIds.has(featureId)) errors.push(`${label}: unknown feature id ${featureId}`);
    }
    if (!row.states?.length || row.states.some((state) => {
      const sides = state.split("->");
      return sides.length !== 2 || sides.some((side) => !side.trim());
    })) {
      errors.push(`${label}: every state must name exactly one nonempty transition with ->`);
    }
    const stateSet = new Set(row.states ?? []);
    const exactStateSet = new Set(row.exactStates ?? []);
    const uncoveredStateSet = new Set(row.uncoveredStates ?? []);
    if (stateSet.size !== (row.states ?? []).length) errors.push(`${label}: states must be unique`);
    for (const state of row.exactStates ?? []) {
      if (!stateSet.has(state)) errors.push(`${label}: exactStates contains unknown state ${state}`);
    }
    for (const state of row.uncoveredStates ?? []) {
      if (!stateSet.has(state)) errors.push(`${label}: uncoveredStates contains unknown state ${state}`);
      if (exactStateSet.has(state)) errors.push(`${label}: state appears in both exactStates and uncoveredStates: ${state}`);
    }
    for (const state of row.states ?? []) {
      if (!exactStateSet.has(state) && !uncoveredStateSet.has(state)) errors.push(`${label}: unclassified state ${state}`);
    }
    if (!coverageValues.has(row.coverage)) errors.push(`${label}: invalid coverage ${String(row.coverage)}`);
    if (!row.verifiedPlatforms?.length || row.verifiedPlatforms.some((platform) => !platforms.has(platform))) {
      errors.push(`${label}: invalid or empty verifiedPlatforms`);
    }
    if (row.coverage === "exact") {
      if (uncoveredStateSet.size !== 0 || exactStateSet.size !== stateSet.size) {
        errors.push(`${label}: exact row must classify every state as exact`);
      }
      const missingPlatforms = SEMANTIC_PLATFORMS.filter((platform) => !row.verifiedPlatforms.includes(platform));
      if (missingPlatforms.length) errors.push(`${label}: exact row misses ${missingPlatforms.join(", ")}`);
      if (!row.oracles?.length || !row.metamorphicTests?.length || !row.visualFixtures?.length) {
        errors.push(`${label}: exact row requires oracle, metamorphic, and visual evidence`);
      }
      if (row.boundary?.trim()) errors.push(`${label}: exact row must not declare an uncovered boundary`);
    } else {
      if (!row.boundary?.trim()) errors.push(`${label}: ${row.coverage} row must declare its boundary`);
      if (uncoveredStateSet.size === 0) errors.push(`${label}: ${row.coverage} row must name uncoveredStates`);
    }
    for (const fixture of row.visualFixtures ?? []) {
      const [path, fixtureId] = fixture.split("#", 2);
      if (path === "tests/features.ts" && (fixtureId == null || !featureFixtureIds.has(fixtureId))) {
        errors.push(`${label}: unknown tests/features.ts fixture ${fixtureId ?? "<missing>"}`);
      }
    }
    for (const ref of [
      ...(row.upstreamSources ?? []),
      ...(row.productionOwners ?? []),
      ...(row.oracles ?? []),
      ...(row.metamorphicTests ?? []),
      ...(row.visualFixtures ?? []),
    ]) await requirePath(ref, label);
  }

  const claimedParityAreas = new Set((inventory.transitions ?? []).flatMap((row) => row.parityAreas ?? []));
  for (const area of parityAreaIds) {
    if (!claimedParityAreas.has(area)) errors.push(`unclaimed parity area: ${area}`);
  }
  const linkedFeatureTransitions = new Set((inventory.transitions ?? []).flatMap((row) => row.featureIds ?? []));
  const excludedFeatureTransitions = new Set<string>();
  for (const exclusion of inventory.excludedFeatureTransitions ?? []) {
    if (!featureIds.has(exclusion.featureId)) errors.push(`unknown excluded feature id: ${exclusion.featureId}`);
    if (!exclusion.reason?.trim()) errors.push(`excluded feature ${exclusion.featureId} must include a reason`);
    if (excludedFeatureTransitions.has(exclusion.featureId)) errors.push(`duplicate excluded feature: ${exclusion.featureId}`);
    if (linkedFeatureTransitions.has(exclusion.featureId)) errors.push(`feature ${exclusion.featureId} is both linked and excluded`);
    excludedFeatureTransitions.add(exclusion.featureId);
  }
  for (const feature of FEATURES.filter((entry) => entry.transition != null)) {
    if (!linkedFeatureTransitions.has(feature.id) && !excludedFeatureTransitions.has(feature.id)) {
      errors.push(`transition-bearing feature is neither linked nor excluded: ${feature.id}`);
    }
  }

  return { errors, uncovered: (inventory.transitions ?? []).filter((row) => row.coverage !== "exact") };
}

export function semanticCoverageReport(inventory: SemanticCoverageInventory): string {
  const exact = inventory.transitions.filter((row) => row.coverage === "exact");
  const uncovered = inventory.transitions.filter((row) => row.coverage !== "exact");
  const exactStateCount = inventory.transitions.reduce((sum, row) => sum + row.exactStates.length, 0);
  const uncoveredStateCount = inventory.transitions.reduce((sum, row) => sum + row.uncoveredStates.length, 0);
  const lines = [
    `Semantic coverage — ${inventory.transitions.length} transition families`,
    `Exact: ${exact.length} · Uncovered: ${uncovered.length}`,
    `State transitions exact: ${exactStateCount} · uncovered: ${uncoveredStateCount}`,
  ];
  for (const row of uncovered) {
    lines.push(`- ${row.id} [${row.coverage}]: ${row.boundary ?? "missing boundary"}`);
    for (const state of row.uncoveredStates) lines.push(`  - ${state}`);
  }
  return lines.join("\n");
}
