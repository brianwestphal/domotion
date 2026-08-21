import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { getFontSourceInfo, type FontRun, type FontVariantEmojiOverride } from "./font-resolution.js";

export interface TextRunRequestDiagnostic {
  fontFamily: string;
  fontWeight: number;
  fontStyle?: string;
  fontStretch: number;
  fontSizePx: number;
  variationSettings?: Record<string, number>;
  features?: string[];
  language?: string;
  fontVariantEmoji?: FontVariantEmojiOverride;
  direction: "ltr" | "rtl";
  /** ISO 15924 script resolved before fallback and used for this shape. */
  script?: string;
}

export interface TextRunProvenanceDiagnostic {
  emitter: "paths" | "embedded-font";
  sourceText: string;
  sourceSpan: [number, number];
  /** Code-point coordinates for `sourceSpan`; unlike UTF-16 offsets these do
   * not split supplementary characters. */
  sourceCodepointSpan: [number, number];
  emittedText: string;
  mechanism: FontRun["routeMechanism"];
  request: TextRunRequestDiagnostic;
  selected: {
    fontKey: string;
    postscriptName: string | null;
    instantiatedPostscriptName: string | null;
    sourcePath: string | null;
    faceIndex: number | null;
    variationAxes: Record<string, number> | null;
    descriptorAxes?: Array<{ tag: string; value: number; min?: number; max?: number; def?: number }> | null;
    sourceFile?: { sha256: string; byteLength: number; mtimeMs: number } | null;
    shapesWithHarfbuzz: boolean;
  };
  glyphs: Array<{
    id: number;
    cluster: number;
    sourceSpan: [number, number];
    sourceCodepointSpan: [number, number];
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
    /** Identity of the exact source outline handed to the emitter. Empty
     * outlines (spaces, color-raster glyphs) are recorded as null. */
    sourceOutline: { sha256: string; commandCount: number } | null;
    rasterRepresentation?: string;
  }>;
  emittedIdentity: string;
  finalRepresentation: "svg-paths" | "embedded-font";
  shapeError?: string;
}

export interface TextEmitterTransitionDiagnostic {
  kind: "embedded-succeeded" | "embedded-declined-to-paths" | "paths-succeeded" | "paths-declined" | "source-owned-boundary";
  sourceText: string;
  /** Exact decline/boundary classification. Absent on ordinary success rows. */
  reason?: string;
  /** UTF-16 spans whose selected glyph had no source/helper outline. */
  degradedSpans?: Array<{ sourceSpan: [number, number]; glyphId: number; disposition: string }>;
}

export interface FixtureTextRunProvenance {
  schemaVersion: 1;
  fixture: string;
  sourceAuthority: {
    chromium: "7d859f271cbda744098ac69f44978d4edfa62be3";
    harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab";
    skia: "62efacd3";
  };
  runs: Array<TextRunProvenanceDiagnostic & { fixture: string; row: number }>;
  transitions: TextEmitterTransitionDiagnostic[];
}

let enabled = false;
let runs: TextRunProvenanceDiagnostic[] = [];
let transitions: TextEmitterTransitionDiagnostic[] = [];
const sourceFileEvidence = new Map<string, TextRunProvenanceDiagnostic["selected"]["sourceFile"]>();

function fileEvidence(path: string | null): TextRunProvenanceDiagnostic["selected"]["sourceFile"] {
  if (path == null) return null;
  const cached = sourceFileEvidence.get(path);
  if (cached !== undefined) return cached;
  try {
    const bytes = readFileSync(path);
    const stat = statSync(path);
    const value = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mtimeMs: stat.mtimeMs };
    sourceFileEvidence.set(path, value);
    return value;
  } catch {
    sourceFileEvidence.set(path, null);
    return null;
  }
}

function codepointIndexAtUtf16(text: string, utf16Index: number): number {
  return [...text.slice(0, Math.max(0, Math.min(text.length, utf16Index)))].length;
}

function clusterEnd(text: string, cluster: number, clusters: number[]): number {
  const later = clusters.filter((candidate) => candidate > cluster);
  return later.length === 0 ? text.length : Math.min(...later);
}

function outlineIdentity(commands: Array<{ command: string; args: number[] }>): { sha256: string; commandCount: number } | null {
  if (commands.length === 0) return null;
  return {
    sha256: createHash("sha256").update(JSON.stringify(commands)).digest("hex"),
    commandCount: commands.length,
  };
}

export function setTextRunProvenanceEnabled(value: boolean): void { enabled = value; }
export function textRunProvenanceEnabled(): boolean { return enabled; }
export function resetTextRunProvenance(): void { runs = []; transitions = []; }
export function getTextRunProvenance(): { runs: TextRunProvenanceDiagnostic[]; transitions: TextEmitterTransitionDiagnostic[] } {
  return { runs: structuredClone(runs), transitions: structuredClone(transitions) };
}

/** Persist production evidence with fixture identity on every row. */
export function getFixtureTextRunProvenance(fixture: string): FixtureTextRunProvenance {
  const snapshot = getTextRunProvenance();
  return {
    schemaVersion: 1,
    fixture,
    sourceAuthority: {
      chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
      harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
      skia: "62efacd3",
    },
    runs: snapshot.runs.map((run, row) => ({ ...run, fixture, row })),
    transitions: snapshot.transitions,
  };
}

export function recordTextEmitterTransition(value: TextEmitterTransitionDiagnostic): void {
  if (enabled) transitions.push(value);
}

export function recordSelectedFontRuns(
  emitter: TextRunProvenanceDiagnostic["emitter"],
  sourceText: string,
  request: TextRunRequestDiagnostic,
  selectedRuns: FontRun[],
): void {
  if (!enabled) return;
  for (const run of selectedRuns) {
    const source = getFontSourceInfo(run.font);
    let glyphs: TextRunProvenanceDiagnostic["glyphs"] = [];
    let shapeError: string | undefined;
    try {
      const shaped = run.font.layout(run.text, request.features, run.shapingScript, request.language, request.direction);
      const clusters = shaped.clusters ?? shaped.glyphs.map((_, index) => Math.min(index, run.text.length));
      glyphs = shaped.glyphs.map((glyph, index) => {
        const position = shaped.positions[index] ?? { xAdvance: glyph.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 };
        const cluster = clusters[index] ?? 0;
        const relativeEnd = clusterEnd(run.text, cluster, clusters);
        const sourceSpan: [number, number] = [run.startIdx + cluster, run.startIdx + relativeEnd];
        return {
          id: glyph.id,
          cluster,
          sourceSpan,
          sourceCodepointSpan: [codepointIndexAtUtf16(sourceText, sourceSpan[0]), codepointIndexAtUtf16(sourceText, sourceSpan[1])],
          ...position,
          sourceOutline: outlineIdentity(glyph.path.commands),
          ...(glyph.rasterRepresentation == null ? {} : { rasterRepresentation: glyph.rasterRepresentation }),
        };
      });
    } catch (error) {
      shapeError = String(error);
    }
    const ids = glyphs.map((glyph) => glyph.id).join(",");
    runs.push({
      emitter,
      sourceText,
      sourceSpan: [run.startIdx, run.endIdx],
      sourceCodepointSpan: [codepointIndexAtUtf16(sourceText, run.startIdx), codepointIndexAtUtf16(sourceText, run.endIdx)],
      emittedText: run.text,
      mechanism: run.routeMechanism,
      request: { ...request, script: run.shapingScript, variationSettings: request.variationSettings == null ? undefined : { ...request.variationSettings }, features: request.features == null ? undefined : [...request.features] },
      selected: {
        fontKey: run.fontKey,
        postscriptName: run.font.postscriptName ?? source?.postscriptName
          ?? (run.fontKey.startsWith("sysfb:") ? run.fontKey.slice("sysfb:".length) : null),
        instantiatedPostscriptName: run.font.instantiatedPostscriptName ?? null,
        sourcePath: source?.path ?? null,
        faceIndex: source?.faceIndex ?? null,
        variationAxes: source?.variationAxes == null ? null : { ...source.variationAxes },
        descriptorAxes: source?.descriptorAxes == null ? null : source.descriptorAxes.map((axis) => ({ ...axis })),
        sourceFile: fileEvidence(source?.path ?? null),
        shapesWithHarfbuzz: run.font.shapesWithHarfbuzz === true,
      },
      glyphs,
      emittedIdentity: `${emitter}:${run.fontKey}:${ids}`,
      finalRepresentation: emitter === "paths" ? "svg-paths" : "embedded-font",
      ...(shapeError == null ? {} : { shapeError }),
    });
  }
}
