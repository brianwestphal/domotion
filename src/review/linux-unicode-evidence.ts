import type { EmbeddedFontBuildDiagnostic } from "../render/embedded-font-builder.js";
import type { FixtureTextRunProvenance } from "../render/text-run-provenance.js";

/** The 24 non-Vedic Linux failures persisted by visual run 32366223808. */
export const LINUX_UNICODE_RASTER_FLOOR_FIXTURES = [
  "0080-00FF-latin-1-supplement",
  "0100-017F-latin-extended-a",
  "0180-024F-latin-extended-b",
  "02B0-02FF-spacing-modifier-letters",
  "0400-04FF-cyrillic",
  "0870-089F-arabic-extended-b",
  "0900-097F-devanagari",
  "0D00-0D7F-malayalam",
  "1D00-1D7F-phonetic-extensions",
  "1D80-1DBF-phonetic-extensions-supplement",
  "1E00-1EFF-latin-extended-additional",
  "1F00-1FFF-greek-extended",
  "20A0-20CF-currency-symbols",
  "2150-218F-number-forms",
  "3400-4DBF-cjk-unified-ideographs-extension-a.25",
  "3400-4DBF-cjk-unified-ideographs-extension-a.9",
  "4E00-9FFF-cjk-unified-ideographs.15",
  "4E00-9FFF-cjk-unified-ideographs.30",
  "4E00-9FFF-cjk-unified-ideographs.62",
  "4E00-9FFF-cjk-unified-ideographs.78",
  "A720-A7FF-latin-extended-d",
  "AC00-D7AF-hangul-syllables.1",
  "AC00-D7AF-hangul-syllables.32",
  "FB50-FDFF-arabic-presentation-forms-a.2",
] as const;

export type LinuxUnicodeRasterFloorFixture = typeof LINUX_UNICODE_RASTER_FLOOR_FIXTURES[number];
const FIXTURES = new Set<string>(LINUX_UNICODE_RASTER_FLOOR_FIXTURES);

/** The structural Vedic row is adjudicated separately from the 24 accepted
 * native-raster-floor rows, but uses the same fixture-scoped production
 * provenance transport. */
export const LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE = "1CD0-1CFF-vedic-extensions" as const;

interface LinuxVedicDottedCircleRecord {
  codepoint: number;
  postscriptName: "FreeSans" | "FreeSerif";
  sourcePath: string;
  script: "Beng" | "Deva";
  glyphs: Array<{ id: number; cluster: 0; xAdvance: number; yAdvance: 0; xOffset: 0; yOffset: 0 }>;
}

/** Exact production records from the pinned Playwright Noble image. These are
 * oracle expectations only: neither the codepoints nor font names participate
 * in renderer routing. */
export const LINUX_VEDIC_DOTTED_CIRCLE_RECORDS: readonly LinuxVedicDottedCircleRecord[] = [
  { codepoint: 0x1CD1, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3402, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CD4, postscriptName: "FreeSans", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", script: "Deva", glyphs: [{ id: 4573, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 2766, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CDB, postscriptName: "FreeSans", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", script: "Deva", glyphs: [{ id: 4573, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 2771, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CDE, postscriptName: "FreeSans", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", script: "Deva", glyphs: [{ id: 4573, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 2774, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CDF, postscriptName: "FreeSans", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", script: "Deva", glyphs: [{ id: 4573, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 2775, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE1, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Beng", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3418, cluster: 0, xAdvance: 488, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE2, postscriptName: "FreeSans", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSans.ttf", script: "Deva", glyphs: [{ id: 4573, cluster: 0, xAdvance: 800, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 2776, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE3, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3420, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE4, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3421, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE5, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3422, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE6, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3423, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE7, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3424, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CE8, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Deva", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3425, cluster: 0, xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
  { codepoint: 0x1CF7, postscriptName: "FreeSerif", sourcePath: "/usr/share/fonts/truetype/freefont/FreeSerif.ttf", script: "Beng", glyphs: [{ id: 5567, cluster: 0, xAdvance: 791, yAdvance: 0, xOffset: 0, yOffset: 0 }, { id: 3440, cluster: 0, xAdvance: 373, yAdvance: 0, xOffset: 0, yOffset: 0 }] },
] as const;

export const LINUX_UNICODE_THIN_OUTLINE_CONTROLS = [0x0964, 0x0965] as const;

export function isLinuxUnicodeRasterFloorFixture(fixture: string): fixture is LinuxUnicodeRasterFloorFixture {
  return FIXTURES.has(fixture);
}

export function shouldCollectLinuxUnicodeTextEvidence(fixture: string): boolean {
  return isLinuxUnicodeRasterFloorFixture(fixture) || fixture === LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE;
}

function compactGlyphs(run: FixtureTextRunProvenance["runs"][number]): LinuxVedicDottedCircleRecord["glyphs"] {
  return run.glyphs.map(({ id, cluster, xAdvance, yAdvance, xOffset, yOffset }) =>
    ({ id, cluster, xAdvance, yAdvance, xOffset, yOffset })) as LinuxVedicDottedCircleRecord["glyphs"];
}

/** Validate the exact selected-face HarfBuzz stream persisted by the targeted
 * Linux visual fixture, including the unaffected-cell negative set. */
export function validateLinuxVedicDottedCircleEvidence(evidence: FixtureTextRunProvenance, chromeFaces: string[]): string[] {
  const errors: string[] = [];
  if (evidence.fixture !== LINUX_VEDIC_DOTTED_CIRCLE_FIXTURE) errors.push(`fixture mismatch: ${evidence.fixture}`);
  for (const census of ["FreeSans:20", "FreeSerif:37"]) {
    if (!chromeFaces.includes(census)) errors.push(`Chromium face census lacks ${census}`);
  }
  const expectedCps = new Set(LINUX_VEDIC_DOTTED_CIRCLE_RECORDS.map((record) => record.codepoint));
  const vedicRuns = evidence.runs.filter((run) => [...run.sourceText].length === 1
    && (run.sourceText.codePointAt(0) ?? 0) >= 0x1CD0 && (run.sourceText.codePointAt(0) ?? 0) <= 0x1CFF);
  for (const expected of LINUX_VEDIC_DOTTED_CIRCLE_RECORDS) {
    const run = vedicRuns.find((candidate) => candidate.sourceText.codePointAt(0) === expected.codepoint);
    const label = `U+${expected.codepoint.toString(16).toUpperCase()}`;
    if (run == null) { errors.push(`${label} has no production row`); continue; }
    if (run.mechanism !== "system-resolver") errors.push(`${label} mechanism is ${run.mechanism ?? "missing"}`);
    if (run.request.script !== expected.script) errors.push(`${label} script is ${run.request.script ?? "missing"}`);
    if (run.selected.postscriptName !== expected.postscriptName || run.selected.sourcePath !== expected.sourcePath || run.selected.faceIndex !== 0) {
      errors.push(`${label} selected face differs`);
    }
    if (JSON.stringify(compactGlyphs(run)) !== JSON.stringify(expected.glyphs)) errors.push(`${label} glyph stream differs`);
  }
  for (const run of vedicRuns) {
    const cp = run.sourceText.codePointAt(0)!;
    if (expectedCps.has(cp)) continue;
    const circleGid = run.selected.postscriptName === "FreeSans" ? 4573 : run.selected.postscriptName === "FreeSerif" ? 5567 : -1;
    if (run.glyphs.some((glyph) => glyph.id === circleGid)) errors.push(`unrelated U+${cp.toString(16).toUpperCase()} contains U+25CC gid`);
  }
  return errors;
}

function selectedFaceSignature(run: FixtureTextRunProvenance["runs"][number]): string {
  return JSON.stringify([run.selected.fontKey, run.selected.postscriptName, run.selected.instantiatedPostscriptName,
    run.selected.sourcePath, run.selected.faceIndex, run.selected.variationAxes]);
}

export function logicalTextEvidenceSignature(evidence: FixtureTextRunProvenance): string {
  return JSON.stringify(evidence.runs.map((run) => ({
    fixture: run.fixture,
    row: run.row,
    sourceSpan: run.sourceSpan,
    sourceCodepointSpan: run.sourceCodepointSpan,
    selected: run.selected,
    glyphs: run.glyphs.map((glyph) => ({
      id: glyph.id,
      cluster: glyph.cluster,
      sourceSpan: glyph.sourceSpan,
      sourceCodepointSpan: glyph.sourceCodepointSpan,
      xAdvance: glyph.xAdvance,
      yAdvance: glyph.yAdvance,
      xOffset: glyph.xOffset,
      yOffset: glyph.yOffset,
      sourceOutline: glyph.sourceOutline,
    })),
  })));
}

export interface LinuxUnicodeMutationVerdict {
  selectedFaceRowsMoved: number;
  hintedLogicalRowsExact: boolean;
  hintedBuilderRowsMoved: number;
  retainedHintTablesRemoved: boolean;
  hintedRasterMoved: boolean;
  verdict: "raster-floor-candidate" | "logical-mismatch" | "mutation-inert";
}

/** Judge the two required row-scoped mutation arms. A raster-floor verdict is
 * impossible when the hinting mutation changes any logical record. */
export function compareLinuxUnicodeMutations(
  baseline: FixtureTextRunProvenance,
  fontconfigHelperOff: FixtureTextRunProvenance,
  hintedSubsetOff: FixtureTextRunProvenance,
  baselineBuilds: EmbeddedFontBuildDiagnostic[],
  hintedSubsetOffBuilds: EmbeddedFontBuildDiagnostic[],
  baselineRasterSha256: string,
  hintedSubsetOffRasterSha256: string,
): LinuxUnicodeMutationVerdict {
  const selectedFaceRowsMoved = baseline.runs.reduce((count, run, index) =>
    count + (fontconfigHelperOff.runs[index] == null || selectedFaceSignature(run) !== selectedFaceSignature(fontconfigHelperOff.runs[index]) ? 1 : 0), 0);
  const hintedLogicalRowsExact = logicalTextEvidenceSignature(baseline) === logicalTextEvidenceSignature(hintedSubsetOff);
  const hintedByKey = new Map(hintedSubsetOffBuilds.map((build) => [build.instanceKey, build]));
  let hintedBuilderRowsMoved = 0;
  let retainedHintTablesRemoved = true;
  for (const build of baselineBuilds.filter((candidate) => candidate.selectedBuilder === "hb-subset")) {
    const mutation = hintedByKey.get(build.instanceKey);
    if (mutation?.selectedBuilder !== build.selectedBuilder) hintedBuilderRowsMoved++;
    if (build.retainedHintTableTags.length > 0 && (mutation == null || mutation.retainedHintTableTags.length !== 0)) retainedHintTablesRemoved = false;
  }
  const hintedRasterMoved = baselineRasterSha256 !== hintedSubsetOffRasterSha256;
  const mutationActive = selectedFaceRowsMoved > 0 && hintedBuilderRowsMoved > 0 && retainedHintTablesRemoved && hintedRasterMoved;
  return {
    selectedFaceRowsMoved,
    hintedLogicalRowsExact,
    hintedBuilderRowsMoved,
    retainedHintTablesRemoved,
    hintedRasterMoved,
    verdict: !hintedLogicalRowsExact ? "logical-mismatch" : mutationActive ? "raster-floor-candidate" : "mutation-inert",
  };
}

export function validateFixtureTextEvidence(fixture: string, evidence: FixtureTextRunProvenance): string[] {
  const errors: string[] = [];
  if (!isLinuxUnicodeRasterFloorFixture(fixture)) errors.push(`fixture is outside the 24-row acceptance corpus: ${fixture}`);
  if (evidence.fixture !== fixture) errors.push(`top-level fixture mismatch: ${evidence.fixture}`);
  if (evidence.runs.length === 0) errors.push("no production text-run rows");
  for (const run of evidence.runs) {
    if (run.fixture !== fixture) errors.push(`row ${run.row} fixture mismatch`);
    if (run.sourceSpan.length !== 2 || run.sourceCodepointSpan.length !== 2) errors.push(`row ${run.row} lacks source spans`);
    for (const glyph of run.glyphs) {
      if (!Number.isFinite(glyph.id) || !Number.isFinite(glyph.cluster)) errors.push(`row ${run.row} has invalid glyph identity`);
      if (![glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset].every(Number.isFinite)) errors.push(`row ${run.row} has invalid glyph metrics`);
    }
  }
  return [...new Set(errors)];
}
