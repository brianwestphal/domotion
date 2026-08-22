/**
 * Pure adjudicator for the DM-2364 replaced/native ownership transition gate.
 *
 * The live producer intentionally lives in `replaced-geometry-oracle.ts`; this
 * module has no Playwright or image dependencies so every fail-closed release
 * rule can be mutation-tested without launching Chromium.
 */

export type ReplacedOwnership =
  | "vector-image"
  | "whole-host-raster"
  | "partial-decoration-raster"
  | "structural-vector"
  | "generated-pseudo-vector"
  | "replaced-snapshot"
  | "broken-image-hybrid"
  | "unpainted";

export type OwnershipPairMode = "ownership-transition" | "state-mutation" | "geometry-transition";

export interface ReplacedOwnershipTransitionRow {
  id: string;
  family: "object-geometry" | "image-decoding" | "dynamic-surface" | "native-control" | "generated-box";
  pairId: string;
  pairRole: string;
  pairMode: OwnershipPairMode;
  expectedOwner: ReplacedOwnership;
  actualOwner: ReplacedOwnership;
  source: string;
  facts: Record<string, unknown>;
  exactCapture: boolean;
  maxDevicePixelDelta?: number;
  mutationRequired?: boolean;
  mutationDiscriminated?: boolean;
  unexpectedWarnings?: string[];
}
export interface ReplacedPlatformFingerprint {
  chromiumVersion: string;
  playwrightVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  osRelease: string;
  deviceScaleFactor: number;
  colorScheme: "light" | "dark";
  forcedColors: "none" | "active";
  launchArgs: string[];
  sha256: string;
}

export interface ReplacedOwnershipRequirements {
  pairIds: readonly string[];
  families: readonly ReplacedOwnershipTransitionRow["family"][];
  toleranceDevicePixels: number;
}

export interface ReplacedOwnershipAdjudication {
  pass: boolean;
  errors: string[];
  passedRows: number;
  totalRows: number;
}

function fingerprintErrors(fingerprint: ReplacedPlatformFingerprint): string[] {
  const errors: string[] = [];
  if (fingerprint.chromiumVersion.trim() === "") errors.push("platform fingerprint omitted Chromium version");
  if (fingerprint.playwrightVersion.trim() === "") errors.push("platform fingerprint omitted Playwright version");
  if (fingerprint.osRelease.trim() === "") errors.push("platform fingerprint omitted OS release");
  if (!Number.isFinite(fingerprint.deviceScaleFactor) || fingerprint.deviceScaleFactor <= 0) {
    errors.push("platform fingerprint has invalid deviceScaleFactor");
  }
  if (!/^[0-9a-f]{64}$/.test(fingerprint.sha256)) errors.push("platform fingerprint omitted canonical SHA-256");
  return errors;
}

export function adjudicateReplacedOwnershipTransitions(
  rows: readonly ReplacedOwnershipTransitionRow[],
  fingerprint: ReplacedPlatformFingerprint,
  requirements: ReplacedOwnershipRequirements,
): ReplacedOwnershipAdjudication {
  const errors = fingerprintErrors(fingerprint);
  const ids = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) errors.push(`${row.id}: duplicate row id`);
    ids.add(row.id);
    if (row.expectedOwner !== row.actualOwner) {
      errors.push(`${row.id}: expected ${row.expectedOwner}, captured ${row.actualOwner}`);
    }
    if (!row.exactCapture) errors.push(`${row.id}: capture was partial or inferred`);
    if (row.source.trim() === "") errors.push(`${row.id}: missing source-owned rationale`);
    if (Object.keys(row.facts).length === 0) errors.push(`${row.id}: missing captured decision facts`);
    if (row.maxDevicePixelDelta != null && (
      !Number.isFinite(row.maxDevicePixelDelta)
      || row.maxDevicePixelDelta > requirements.toleranceDevicePixels
    )) {
      errors.push(`${row.id}: geometry delta ${row.maxDevicePixelDelta} exceeds ${requirements.toleranceDevicePixels} device px`);
    }
    if (row.mutationRequired === true && row.mutationDiscriminated !== true) {
      errors.push(`${row.id}: required mutation did not change the observed source fact`);
    }
    for (const warning of row.unexpectedWarnings ?? []) errors.push(`${row.id}: unexpected warning ${warning}`);
  }

  for (const family of requirements.families) {
    if (!rows.some((row) => row.family === family)) errors.push(`missing required family ${family}`);
  }
  for (const pairId of requirements.pairIds) {
    const pair = rows.filter((row) => row.pairId === pairId);
    if (pair.length < 2) {
      errors.push(`${pairId}: missing paired control`);
      continue;
    }
    if (new Set(pair.map((row) => row.pairRole)).size !== pair.length) {
      errors.push(`${pairId}: duplicate pair role`);
    }
    const modes = new Set(pair.map((row) => row.pairMode));
    if (modes.size !== 1) errors.push(`${pairId}: pair mode disagrees across rows`);
    if (pair[0]?.pairMode === "ownership-transition"
      && new Set(pair.map((row) => row.expectedOwner)).size < 2) {
      errors.push(`${pairId}: ownership control never crosses an ownership boundary`);
    }
    if (pair[0]?.pairMode === "state-mutation"
      && !pair.some((row) => row.mutationDiscriminated === true)) {
      errors.push(`${pairId}: state mutation is observationally inert`);
    }
  }

  const failedIds = new Set(errors.map((error) => error.split(":", 1)[0]));
  return {
    pass: errors.length === 0,
    errors,
    passedRows: rows.filter((row) => !failedIds.has(row.id)).length,
    totalRows: rows.length,
  };
}
