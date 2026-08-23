import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fontkit from "fontkit";

import { hbSubsetRetainGids } from "../src/render/hb-subset.js";
import type { PathsRasterRow } from "./paths-native-raster-gate.js";

export const PATHS_NATIVE_RASTER_SOURCE = {
  repository: "https://github.com/harfbuzz/harfbuzz",
  revision: "4de187dd0a915d13c976fa8bd474c084229f3aab",
} as const;

export const PATHS_NATIVE_RASTER_SKIA_SOURCE = "62efacd37737505732dbe3d8daa62abd679626a1";
export const PATHS_NATIVE_RASTER_METRIC_ALGORITHM = "opaque-rgba-ink-edge-v2";
export const PATHS_NATIVE_RASTER_FEATURES = ["-kern", "-liga", "-clig"] as const;
export const PATHS_NATIVE_RASTER_VIEWPORT = { width: 320, height: 160 } as const;
export const PATHS_NATIVE_RASTER_ORIGIN = { x: 48, baselineY: 92 } as const;

export type PathsRasterTechnology = PathsRasterRow["dimensions"]["fontTechnology"];

export interface PathsRasterFixture {
  technology: PathsRasterTechnology;
  upstreamPath: string;
  upstreamSha256: string;
  text: string;
  requiredTables: string[];
  forbiddenTables?: string[];
  /** A deterministic, source-owned derivation applied before either arm. */
  derive?: "drop-glyf-hinting";
  derivedSha256?: string;
}

/**
 * Pinned, tiny HarfBuzz test fonts keep the raster question independent of the
 * host's mutable font inventory. The unhinted glyf face is derived from the
 * hinted Open Sans bytes with the repository's pinned hb-subset build; both
 * browser and path arms receive the resulting bytes.
 */
export const PATHS_NATIVE_RASTER_FIXTURES: readonly PathsRasterFixture[] = [
  {
    technology: "glyf-hinted",
    upstreamPath: "OpenSans-Regular.ttf",
    upstreamSha256: "e64e508b2aa2880f907e470c4550980ec4c0694d103a43f36150ac3f93189bee",
    text: "ABC",
    requiredTables: ["glyf", "cvt ", "fpgm", "prep"],
  },
  {
    technology: "glyf-unhinted",
    upstreamPath: "OpenSans-Regular.ttf",
    upstreamSha256: "e64e508b2aa2880f907e470c4550980ec4c0694d103a43f36150ac3f93189bee",
    text: "ABC",
    requiredTables: ["glyf"],
    forbiddenTables: ["cvt ", "fpgm", "prep"],
    derive: "drop-glyf-hinting",
    derivedSha256: "07fbf77e59c09ff807da12fc388ce41ecb0f73e5525729d11e4708227bf5dbd1",
  },
  {
    technology: "cff",
    upstreamPath: "SourceSansPro-Regular.abc.otf",
    upstreamSha256: "9e9416319ede3baf80daeae4b73a7a1166c57700c9d63d6464e784637c2d2962",
    text: "abc",
    requiredTables: ["CFF "],
    forbiddenTables: ["CFF2", "fvar"],
  },
  {
    technology: "cff2",
    upstreamPath: "AdobeVFPrototype.abc.static.otf",
    upstreamSha256: "ff8028ae325d56c22338f4d0e402cc16495f9dabe515ead85185dc6409aefbad",
    text: "abc",
    requiredTables: ["CFF2"],
    forbiddenTables: ["fvar"],
  },
  {
    technology: "variable-glyf",
    upstreamPath: "Roboto-Variable.abc.ttf",
    upstreamSha256: "9e9b01977873b3cff6658ab33da98135bd1a2abc8cc5aa9781ada2af906955f2",
    text: "abc",
    requiredTables: ["glyf", "fvar", "gvar"],
  },
  {
    technology: "variable-cff2",
    upstreamPath: "TestCFF2VF.otf",
    upstreamSha256: "a58194bee12e6ab4a0d43c6019c1e5c22970d495a12ea0d2576a9a2ce1db5540",
    text: "ATA",
    requiredTables: ["CFF2", "fvar"],
  },
] as const;

interface MatrixState {
  label: string;
  transform: PathsRasterRow["dimensions"]["transform"];
  fontSizePx: number;
  weight: number;
  phaseX: number;
  phaseY: number;
  matrix: PathsRasterRow["expectedLogical"]["matrix"];
}

/**
 * Source-owned union matrix. Each technology independently exercises size,
 * weight, every quarter-pixel x/y phase, every transform family, and DPR1/2.
 * The hinted glyf anchor additionally crosses all phases with rotate+affine,
 * because that is where a diagonal covering array used to hide interactions.
 * This is a finite 348-cell declaration, not an adjustable raster-fit corpus.
 */
const TRANSFORM_MATRICES = {
  none: [1, 0, 0, 1, 0, 0],
  translate: [1, 0, 0, 1, 5.5, -2.25],
  scale: [1.125, 0, 0, 0.875, 0, 0],
  rotate: [0.992546151641322, 0.121869343405147, -0.121869343405147, 0.992546151641322, 0, 0],
  affine: [1.04, 0.13, -0.09, 0.96, 2.75, -1.5],
} as const satisfies Record<PathsRasterRow["dimensions"]["transform"], PathsRasterRow["expectedLogical"]["matrix"]>;

const state = (
  label: string,
  transform: MatrixState["transform"],
  fontSizePx: number,
  weight: number,
  phaseX: number,
  phaseY: number,
): MatrixState => ({
  label, transform, fontSizePx, weight, phaseX, phaseY,
  matrix: [...TRANSFORM_MATRICES[transform]] as MatrixState["matrix"],
});

const QUARTER_PHASES = [0, 0.25, 0.5, 0.75] as const;

export const PATHS_NATIVE_RASTER_STATES: readonly MatrixState[] = [
  state("size-12", "none", 12, 400, 0, 0),
  state("size-20", "none", 20, 400, 0, 0),
  state("size-32", "none", 32, 400, 0, 0),
  state("weight-600", "none", 20, 600, 0, 0),
  state("weight-800", "none", 20, 800, 0, 0),
  ...QUARTER_PHASES.flatMap((phaseX) => QUARTER_PHASES
    .filter((phaseY) => phaseX !== 0 || phaseY !== 0)
    .map((phaseY) => state(`phase-${phaseX}-${phaseY}`, "none", 20, 400, phaseX, phaseY))),
  state("transform-translate", "translate", 20, 400, 0, 0),
  state("transform-scale", "scale", 20, 400, 0, 0),
  state("transform-rotate", "rotate", 20, 400, 0, 0),
  state("transform-affine", "affine", 20, 400, 0, 0),
];

const HINTED_INTERACTION_STATES: readonly MatrixState[] = ["rotate", "affine"].flatMap((transform) =>
  QUARTER_PHASES.flatMap((phaseX) => QUARTER_PHASES
    .filter((phaseY) => phaseX !== 0 || phaseY !== 0)
    .map((phaseY) => state(`interaction-${transform}-${phaseX}-${phaseY}`, transform as "rotate" | "affine", 20, 400, phaseX, phaseY))),
);

export interface PathsRasterMatrixCell {
  id: string;
  fixture: PathsRasterFixture;
  dimensions: PathsRasterRow["dimensions"];
  matrix: PathsRasterRow["expectedLogical"]["matrix"];
  variationAxes: Record<string, number>;
}

function axesFor(technology: PathsRasterTechnology, weight: number): Record<string, number> {
  if (technology === "variable-glyf") return { wdth: 90, wght: weight };
  if (technology === "variable-cff2") return { wght: weight };
  return {};
}

export function pathsNativeRasterMatrix(): PathsRasterMatrixCell[] {
  return [1, 2].flatMap((deviceScaleFactor) =>
    PATHS_NATIVE_RASTER_FIXTURES.flatMap((fixture) =>
      [...PATHS_NATIVE_RASTER_STATES, ...(fixture.technology === "glyf-hinted" ? HINTED_INTERACTION_STATES : [])].map((state) => ({
        id: `${fixture.technology}-${state.label}-dpr${deviceScaleFactor}`,
        fixture,
        dimensions: {
          fontTechnology: fixture.technology,
          fontSizePx: state.fontSizePx,
          weight: state.weight,
          phaseX: state.phaseX,
          phaseY: state.phaseY,
          transform: state.transform,
          deviceScaleFactor: deviceScaleFactor as 1 | 2,
        },
        matrix: [
          state.matrix[0], state.matrix[1], state.matrix[2], state.matrix[3],
          state.matrix[4] + state.phaseX, state.matrix[5] + state.phaseY,
        ],
        variationAxes: axesFor(fixture.technology, state.weight),
      }))),
  );
}

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value != null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
    : value;

/** Canonical identity used by both observations and ratified envelopes. */
export function pathsRasterCellSha256(cell: PathsRasterMatrixCell): string {
  const sourceSha256 = cell.fixture.derivedSha256 ?? cell.fixture.upstreamSha256;
  return createHash("sha256").update(JSON.stringify(stable({
    schemaVersion: 2,
    metricAlgorithm: PATHS_NATIVE_RASTER_METRIC_ALGORITHM,
    id: cell.id,
    dimensions: cell.dimensions,
    text: cell.fixture.text,
    sourceSha256,
    faceIndex: 0,
    variationAxes: cell.variationAxes,
    features: PATHS_NATIVE_RASTER_FEATURES,
    viewport: PATHS_NATIVE_RASTER_VIEWPORT,
    origin: PATHS_NATIVE_RASTER_ORIGIN,
    paintColors: { foreground: "#000", background: "#fff" },
    matrix: cell.matrix,
    paintPlan: {
      syntheticBold: !cell.fixture.technology.startsWith("variable-") && cell.dimensions.weight >= 600,
      syntheticOblique: false,
    },
  }))).digest("hex");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tableTags(bytes: Buffer): string[] {
  const opened: any = fontkit.create(bytes);
  return Object.keys(opened.directory?.tables ?? {}).sort();
}

export interface LoadedPathsRasterFixture {
  fixture: PathsRasterFixture;
  bytes: Buffer;
  sha256: string;
  sourcePath: string;
  familyName: string;
  postscriptName: string | null;
  unitsPerEm: number;
  ascent: number;
  tables: string[];
}

export function loadPathsRasterFixtures(fontRoot: string): LoadedPathsRasterFixture[] {
  return PATHS_NATIVE_RASTER_FIXTURES.map((fixture) => {
    const sourcePath = join(fontRoot, fixture.upstreamPath);
    const upstream = readFileSync(sourcePath);
    const upstreamHash = sha256(upstream);
    if (upstreamHash !== fixture.upstreamSha256) {
      throw new Error(`${fixture.technology}: upstream fixture sha256 ${upstreamHash} != ${fixture.upstreamSha256}`);
    }
    let bytes = upstream;
    if (fixture.derive === "drop-glyf-hinting") {
      const opened: any = fontkit.create(upstream);
      const gids = [0, ...new Set([...fixture.text].map((character) => opened.glyphForCodePoint(character.codePointAt(0)!).id))];
      bytes = hbSubsetRetainGids(upstream, gids, 0, false);
      const derivedHash = sha256(bytes);
      if (derivedHash !== fixture.derivedSha256) {
        throw new Error(`${fixture.technology}: derived fixture sha256 ${derivedHash} != ${fixture.derivedSha256}`);
      }
    }
    const tables = tableTags(bytes);
    for (const tag of fixture.requiredTables) if (!tables.includes(tag)) throw new Error(`${fixture.technology}: required ${tag} table is absent`);
    for (const tag of fixture.forbiddenTables ?? []) if (tables.includes(tag)) throw new Error(`${fixture.technology}: forbidden ${tag} table is present`);
    const opened: any = fontkit.create(bytes);
    for (const character of fixture.text) {
      if (opened.glyphForCodePoint(character.codePointAt(0)!).id === 0) throw new Error(`${fixture.technology}: fixture does not cover ${JSON.stringify(character)}`);
    }
    return {
      fixture,
      bytes,
      sha256: sha256(bytes),
      sourcePath,
      familyName: opened.familyName,
      postscriptName: opened.postscriptName ?? null,
      unitsPerEm: opened.unitsPerEm,
      ascent: opened.ascent,
      tables,
    };
  });
}

export function pathsRasterFixtureInventorySha256(fixtures: readonly LoadedPathsRasterFixture[]): string {
  return createHash("sha256")
    .update(fixtures.map(({ fixture, sha256: hash }) => `${fixture.technology}:${hash}`).sort().join("\n"))
    .digest("hex");
}

export function requiredPathsRasterIds(): string[] {
  return pathsNativeRasterMatrix().map((cell) => cell.id).sort();
}

type DeclaredPathsRasterRow = Pick<PathsRasterRow, "id" | "dimensions" | "cellSha256">
  & Partial<Pick<PathsRasterRow, "expectedLogical">>;

/** Bind caller-supplied logical expectations back to the source-owned cell. */
export function assertPathsRasterRowDeclaration(row: DeclaredPathsRasterRow): void {
  const cell = pathsNativeRasterMatrix().find((candidate) => candidate.id === row.id);
  if (cell == null) throw new Error(`undeclared paths/native raster row id: ${row.id}`);
  if (JSON.stringify(cell.dimensions) !== JSON.stringify(row.dimensions)) throw new Error(`${row.id}: dimensions do not match the declared matrix`);
  if (pathsRasterCellSha256(cell) !== row.cellSha256) throw new Error(`${row.id}: cellSha256 does not match the declared corpus`);
  if (row.expectedLogical != null) {
    const sourceSha256 = cell.fixture.derivedSha256 ?? cell.fixture.upstreamSha256;
    if (row.expectedLogical.sourceSha256 !== sourceSha256) throw new Error(`${row.id}: expected sourceSha256 does not match the declared fixture`);
    if (row.expectedLogical.faceIndex !== 0) throw new Error(`${row.id}: expected faceIndex does not match the declared fixture`);
    if (JSON.stringify(stable(row.expectedLogical.variationAxes)) !== JSON.stringify(stable(cell.variationAxes))) {
      throw new Error(`${row.id}: expected variationAxes do not match the declared matrix`);
    }
  }
}

export function assertCompletePathsRasterMatrix(rows: readonly DeclaredPathsRasterRow[]): void {
  const expected = new Map(pathsNativeRasterMatrix().map((cell) => [cell.id, {
    dimensions: JSON.stringify(cell.dimensions),
    cellSha256: pathsRasterCellSha256(cell),
  }]));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`duplicate paths/native raster row id: ${row.id}`);
    seen.add(row.id);
    assertPathsRasterRowDeclaration(row);
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) throw new Error(`incomplete paths/native raster matrix: missing ${missing.join(", ")}`);
}
