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
}

export interface TextRunProvenanceDiagnostic {
  emitter: "paths" | "embedded-font";
  sourceText: string;
  sourceSpan: [number, number];
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
    shapesWithHarfbuzz: boolean;
  };
  glyphs: Array<{
    id: number;
    cluster: number;
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }>;
  emittedIdentity: string;
  shapeError?: string;
}

export interface TextEmitterTransitionDiagnostic {
  kind: "embedded-succeeded" | "embedded-declined-to-paths" | "paths-succeeded" | "paths-declined";
  sourceText: string;
}

let enabled = false;
let runs: TextRunProvenanceDiagnostic[] = [];
let transitions: TextEmitterTransitionDiagnostic[] = [];

export function setTextRunProvenanceEnabled(value: boolean): void { enabled = value; }
export function textRunProvenanceEnabled(): boolean { return enabled; }
export function resetTextRunProvenance(): void { runs = []; transitions = []; }
export function getTextRunProvenance(): { runs: TextRunProvenanceDiagnostic[]; transitions: TextEmitterTransitionDiagnostic[] } {
  return { runs: structuredClone(runs), transitions: structuredClone(transitions) };
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
      const shaped = run.font.layout(run.text, request.features, undefined, request.language, request.direction);
      glyphs = shaped.glyphs.map((glyph, index) => {
        const position = shaped.positions[index] ?? { xAdvance: glyph.advanceWidth, yAdvance: 0, xOffset: 0, yOffset: 0 };
        return { id: glyph.id, cluster: shaped.clusters?.[index] ?? index, ...position };
      });
    } catch (error) {
      shapeError = String(error);
    }
    const ids = glyphs.map((glyph) => glyph.id).join(",");
    runs.push({
      emitter,
      sourceText,
      sourceSpan: [run.startIdx, run.endIdx],
      emittedText: run.text,
      mechanism: run.routeMechanism,
      request: { ...request, variationSettings: request.variationSettings == null ? undefined : { ...request.variationSettings }, features: request.features == null ? undefined : [...request.features] },
      selected: {
        fontKey: run.fontKey,
        postscriptName: run.font.postscriptName ?? source?.postscriptName
          ?? (run.fontKey.startsWith("sysfb:") ? run.fontKey.slice("sysfb:".length) : null),
        instantiatedPostscriptName: run.font.instantiatedPostscriptName ?? null,
        sourcePath: source?.path ?? null,
        faceIndex: source?.faceIndex ?? null,
        variationAxes: source?.variationAxes == null ? null : { ...source.variationAxes },
        shapesWithHarfbuzz: run.font.shapesWithHarfbuzz === true,
      },
      glyphs,
      emittedIdentity: `${emitter}:${run.fontKey}:${ids}`,
      ...(shapeError == null ? {} : { shapeError }),
    });
  }
}
