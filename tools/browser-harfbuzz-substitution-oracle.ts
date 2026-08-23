#!/usr/bin/env tsx
/**
 * Exact browser HarfBuzz substitution-stream ownership (DM-2532).
 *
 * CDP authenticates the custom face that Blink sent to paint and reports its
 * shaped glyph count, but it intentionally does not expose ShapeResultRun's
 * glyph ids, clusters, advances, or offsets.  Those fields are therefore
 * joined source-first:
 *
 *   exact checked-in bytes
 *     -> Playwright Chromium custom-face observation
 *     -> Chromium-configured vendored HarfBuzz logical stream
 *     -> production renderTextAsPath provenance over the same bytes
 *
 * Raster output and tolerance grading are deliberately absent.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { BufferFlag, ClusterLevel, versionString } from "../vendor/harfbuzzjs/dist/index.mjs";
import {
  clearWebfonts,
  registerWebfont,
} from "../src/render/font-resolution.js";
import {
  harfbuzzShapeRun,
  registerHbBufferSource,
  type ShapeResult,
} from "../src/render/harfbuzz-shaper.js";
import {
  clearEmbeddedFonts,
  clearGlyphDefs,
  getTextRunProvenance,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";
import {
  embeddedVariableFontBytes,
  sfntTableTags,
} from "./exact-shaping-control-fixtures.js";

export const CHROMIUM_REVISION = "7d859f271cbda744098ac69f44978d4edfa62be3";
export const HARFBUZZ_REVISION = "4de187dd0a915d13c976fa8bd474c084229f3aab";
export const SKIA_REVISION = "62efacd37737505732dbe3d8daa62abd679626a1";
export const OPEN_SANS_SHA256 = "c8886233e48f9757d48028f9517bcbe97603e685c31a49eb3a596461621f4a5a";
export const ARABIC_RLIG_SHA256 = "9d9e6025284c0833926775248918ec1fa9b2417fde90abaa663cc9b625e3bdb1";
export const ARABIC_MARK_SHA256 = "6aeee1f0d98fe4b6b5a7eb99324a2a27549133b2f0ee64a53357c391217767d9";
export const LOCL_SHA256 = "8440df3446a0724e2498ba62980d55ad0b0ad5e568cdc0ad4efd85c7f8d4b455";

const FIXTURE_ROOT = "tests/fixtures/exact-shaping";
const REQUIRED_OSES = ["Linux", "macOS", "Windows"] as const;
const REQUIRED_EVIDENCE = ["proposal", "validation"] as const;
const REQUIRED_MUTATIONS = [
  "disable-liga", "omit-variation-axes", "disable-required-ligature",
  "wrong-script", "wrong-direction", "wrong-cluster-level", "wrong-language-system",
  "wrong-source-fingerprint", "wrong-gid", "wrong-cluster",
  "wrong-source-span", "wrong-advance", "zero-mark-offset",
] as const;

export interface ExactSubstitutionGlyph {
  id: number;
  cluster: number;
  sourceSpan: [number, number];
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}

export interface SubstitutionInput {
  text: string;
  direction: "ltr" | "rtl";
  fontSizePx: number;
  script: string;
  language: string;
  features: string[];
  axes: Record<string, number> | null;
  bufferFlags: number;
  clusterLevel: number;
}

export interface FixtureEvidence {
  id: string;
  family: string;
  familyName: string;
  postscriptName: string | null;
  path: string;
  sha256: string;
  byteLength: number;
  tables: string[];
  requiredTables: string[];
  upstream: {
    repository: string;
    revision: string;
    path: string;
    blob: string;
    license: string;
  };
}

interface LoadedFixture {
  evidence: FixtureEvidence;
  bytes: Buffer;
  registerDescriptors?: {
    stretch?: string;
    weight?: string;
  };
}

export interface SubstitutionCaseSpec {
  id: string;
  fixture: "open-sans-vf" | "arabic-rlig" | "arabic-mark" | "locl-language";
  claims: string[];
  input: SubstitutionInput;
}

export interface BrowserFontObservation {
  familyName: string;
  postScriptName: string;
  glyphCount: number;
  isCustomFont: boolean;
}

export interface BrowserOrigin {
  utf16Span: [number, number];
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BrowserOwnership {
  fonts: BrowserFontObservation[];
  origins: BrowserOrigin[];
  expectedPostscriptName: string | null;
  expectedFamilyName: string;
  customFaceAgreement: boolean;
  exactGlyphCountAgreement: boolean;
  glyphIds: {
    status: "not-exposed-by-cdp";
    owner: "Blink ShapeResultRun / HarfBuzzRunGlyphData";
  };
}

export interface ProductionOwnership {
  sourceOwnership: {
    kind: "registered-webfont-buffer";
    sha256: string;
    byteLength: number;
  };
  selected: {
    fontKey: string;
    postscriptName: string | null;
    shapesWithHarfbuzz: boolean;
  };
  request: {
    direction: "ltr" | "rtl";
    fontSizePx: number;
    script?: string;
    language?: string;
    features?: string[];
    variationSettings?: Record<string, number>;
  };
  glyphs: ExactSubstitutionGlyph[];
}

export interface SubstitutionCaseEvidence {
  id: string;
  fixture: string;
  claims: string[];
  input: SubstitutionInput;
  source: Pick<FixtureEvidence, "sha256" | "byteLength" | "familyName" | "postscriptName">;
  harfbuzz: {
    revision: string;
    logicalSha256: string;
    glyphs: ExactSubstitutionGlyph[];
  };
  production: ProductionOwnership;
  browser: BrowserOwnership | null;
  exactProductionAgreement: boolean;
}

export interface MutationEvidence {
  id: string;
  kind: "input" | "record";
  caseId: string;
  changedFields: string[];
  rejected: boolean;
}

export interface BrowserHarfBuzzSubstitutionReport {
  schemaVersion: 1;
  ticket: "DM-2532";
  stage: "browser-harfbuzz-substitution-streams";
  evidence: "proposal" | "validation";
  runner: {
    os: string;
    nodePlatform: string;
    nodeVersion: string;
    browserVersion: string | null;
    playwrightVersion: string;
    playwrightChromiumRevision: string;
    harfbuzzVersion: string;
  };
  sourceAuthority: {
    chromium: string;
    harfbuzz: string;
    skia: string;
  };
  boundary: string;
  rasterization: "blocked-until-exact-logical-agreement";
  fixtures: FixtureEvidence[];
  cases: SubstitutionCaseEvidence[];
  mutations: MutationEvidence[];
  mutationCoverage: {
    required: string[];
    rejected: string[];
    complete: boolean;
  };
  corpusSha256: string;
  logicalSha256: string;
  verdict: "exact-logical-agreement" | "verdict-withheld";
}

export interface SubstitutionAggregateReport {
  schemaVersion: 1;
  ticket: "DM-2532";
  stage: "browser-harfbuzz-substitution-streams-aggregate";
  required: {
    operatingSystems: readonly string[];
    evidence: readonly string[];
  };
  artifactKeys: string[];
  corpusSha256: string | null;
  logicalSha256: string | null;
  rasterization: "not-started";
  verdict: "proposal-validation-agreement" | "verdict-withheld";
  failures: string[];
}

export const SUBSTITUTION_CASES: readonly SubstitutionCaseSpec[] = [
  {
    id: "latin-liga-variable-axis",
    fixture: "open-sans-vf",
    claims: ["GSUB liga", "variation axes", "gid/cluster/span/advance"],
    input: {
      text: "fi",
      direction: "ltr",
      fontSizePx: 48,
      script: "Latn",
      language: "en",
      features: ["liga=1"],
      axes: { wght: 800, wdth: 100 },
      bufferFlags: BufferFlag.DEFAULT,
      clusterLevel: ClusterLevel.MONOTONE_GRAPHEMES,
    },
  },
  {
    id: "arabic-required-ligature",
    fixture: "arabic-rlig",
    claims: ["GSUB rlig", "required contextual ligature", "gid/cluster/source span"],
    input: {
      text: "لله",
      direction: "rtl",
      fontSizePx: 32,
      script: "Arab",
      language: "ar",
      features: ["rlig=1"],
      axes: null,
      bufferFlags: BufferFlag.DEFAULT,
      clusterLevel: ClusterLevel.MONOTONE_GRAPHEMES,
    },
  },
  {
    id: "arabic-contextual-mark-positioning",
    fixture: "arabic-mark",
    claims: ["GSUB contextual forms", "GPOS mark attachment", "cluster/source spans"],
    input: {
      text: "بَبَ",
      direction: "rtl",
      fontSizePx: 32,
      script: "Arab",
      language: "ar",
      features: ["rlig=1"],
      axes: null,
      bufferFlags: BufferFlag.DEFAULT,
      clusterLevel: ClusterLevel.MONOTONE_GRAPHEMES,
    },
  },
  {
    id: "language-system-locl",
    fixture: "locl-language",
    claims: ["GSUB locl", "script/language feature selection", "gid identity"],
    input: {
      text: "J",
      direction: "ltr",
      fontSizePx: 32,
      script: "Latn",
      language: "zh-Hant-HK",
      features: ["locl=1"],
      axes: null,
      bufferFlags: BufferFlag.DEFAULT,
      clusterLevel: ClusterLevel.MONOTONE_GRAPHEMES,
    },
  },
] as const;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeFontName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function exactCustomFaceAgreement(
  fonts: BrowserFontObservation[],
  fixture: FixtureEvidence,
): boolean {
  if (fonts.length !== 1) return false;
  const custom = fonts.filter((font) => font.isCustomFont);
  if (custom.length !== 1) return false;
  if (fixture.postscriptName == null) {
    return normalizeFontName(custom[0].familyName) === normalizeFontName(fixture.familyName);
  }
  if (custom[0].postScriptName === fixture.postscriptName) return true;
  // A variable instance can expose an instance-specific PostScript name even
  // though the sole custom CSS face still comes from the authenticated bytes.
  return fixture.tables.includes("fvar")
    && normalizeFontName(custom[0].familyName) === normalizeFontName(fixture.familyName);
}

function assertConfiguredSourcePins(): void {
  const configured = [
    ["DOMOTION_CHROMIUM_REVISION", CHROMIUM_REVISION],
    ["DOMOTION_HARFBUZZ_REVISION", HARFBUZZ_REVISION],
    ["DOMOTION_SKIA_REVISION", SKIA_REVISION],
  ] as const;
  for (const [name, expected] of configured) {
    const actual = process.env[name];
    if (actual != null && actual !== "" && actual !== expected) {
      throw new Error(`${name} ${actual} != pinned ${expected}`);
    }
  }
}

function encodedFixtureBytes(path: string): Buffer {
  return Buffer.from(readFileSync(resolve(path), "utf8").replace(/\s+/g, ""), "base64");
}

function requireFixture(
  fixture: Omit<LoadedFixture, "evidence"> & {
    evidence: Omit<FixtureEvidence, "byteLength" | "tables">;
  },
): LoadedFixture {
  const actualSha = sha256(fixture.bytes);
  if (actualSha !== fixture.evidence.sha256) {
    throw new Error(`${fixture.evidence.id}: source SHA-256 ${actualSha} != ${fixture.evidence.sha256}`);
  }
  const tables = sfntTableTags(fixture.bytes);
  const missing = fixture.evidence.requiredTables.filter((tag) => !tables.includes(tag));
  if (missing.length > 0) {
    throw new Error(`${fixture.evidence.id}: missing required tables ${missing.join(", ")}`);
  }
  return {
    ...fixture,
    evidence: {
      ...fixture.evidence,
      byteLength: fixture.bytes.length,
      tables,
    },
  };
}

export function loadSubstitutionFixtures(): Record<SubstitutionCaseSpec["fixture"], LoadedFixture> {
  const openSans = embeddedVariableFontBytes();
  return {
    "open-sans-vf": requireFixture({
      bytes: openSans,
      registerDescriptors: { stretch: "75% 100%", weight: "300 800" },
      evidence: {
        id: "open-sans-vf",
        family: "dm2532-open-sans-vf",
        familyName: "Open Sans",
        postscriptName: "OpenSans-Regular",
        path: "tests/fixtures/variable-axis/variable-axis.html#embedded-ttf",
        sha256: OPEN_SANS_SHA256,
        requiredTables: ["GSUB", "GPOS", "fvar"],
        upstream: {
          repository: "https://github.com/googlefonts/opensans",
          revision: "source-owned subset pinned by DM-2109",
          path: "tests/fixtures/variable-axis/variable-axis.html",
          blob: OPEN_SANS_SHA256,
          license: "SIL Open Font License 1.1",
        },
      },
    }),
    "arabic-rlig": requireFixture({
      bytes: encodedFixtureBytes(`${FIXTURE_ROOT}/ArabicRligTest.ttf.base64`),
      evidence: {
        id: "arabic-rlig",
        family: "dm2532-arabic-rlig",
        familyName: "IranNastaliq",
        postscriptName: null,
        path: `${FIXTURE_ROOT}/ArabicRligTest.ttf.base64`,
        sha256: ARABIC_RLIG_SHA256,
        requiredTables: ["GDEF", "GSUB", "GPOS"],
        upstream: {
          repository: "https://github.com/harfbuzz/harfbuzz",
          revision: HARFBUZZ_REVISION,
          path: "test/shape/data/in-house/fonts/a919b33197965846f21074b24e30250d67277bce.ttf",
          blob: "d2f116efa2606c2b55314df53a15223f0857f0f7",
          license: "HarfBuzz in-house test fixture; no embedded license string",
        },
      },
    }),
    "arabic-mark": requireFixture({
      bytes: encodedFixtureBytes(`${FIXTURE_ROOT}/ArabicMarkTest.ttf.base64`),
      evidence: {
        id: "arabic-mark",
        family: "dm2532-arabic-mark",
        familyName: "ProbeMid",
        postscriptName: null,
        path: `${FIXTURE_ROOT}/ArabicMarkTest.ttf.base64`,
        sha256: ARABIC_MARK_SHA256,
        requiredTables: ["GDEF", "GSUB", "GPOS"],
        upstream: {
          repository: "https://github.com/harfbuzz/harfbuzz",
          revision: HARFBUZZ_REVISION,
          path: "test/shape/data/in-house/fonts/1af868501dfcfd16184116b966f7fb2bd310623c.ttf",
          blob: "f450682fdf35bd9317a79a85867fd937361c1f57",
          license: "HarfBuzz in-house mark-attachment test fixture; no embedded copyright/license string",
        },
      },
    }),
    "locl-language": requireFixture({
      bytes: encodedFixtureBytes(`${FIXTURE_ROOT}/LOCLTest.ttf.base64`),
      evidence: {
        id: "locl-language",
        family: "dm2532-locl-language",
        familyName: "LOCLTest",
        postscriptName: "LOCLTest-Regular",
        path: `${FIXTURE_ROOT}/LOCLTest.ttf.base64`,
        sha256: LOCL_SHA256,
        requiredTables: ["GSUB"],
        upstream: {
          repository: "https://github.com/harfbuzz/harfbuzz",
          revision: HARFBUZZ_REVISION,
          path: "test/shape/data/in-house/fonts/6991b13ce889466be6de3f66e891de2bc0f117ee.ttf",
          blob: "d98496683c503a9ee00806af6ed47c4c06d7674b",
          license: "HarfBuzz in-house test fixture; embedded Adobe copyright, no license string",
        },
      },
    }),
  };
}

function sourceEnd(text: string, cluster: number, clusters: number[]): number {
  const later = clusters.filter((candidate) => candidate > cluster);
  return later.length === 0 ? text.length : Math.min(...later);
}

export function logicalGlyphs(result: ShapeResult, text: string): ExactSubstitutionGlyph[] {
  return result.glyphs.map((glyph, index) => {
    const cluster = result.clusters[index];
    return {
      id: glyph.id,
      cluster,
      sourceSpan: [cluster, sourceEnd(text, cluster, result.clusters)],
      xAdvance: result.positions[index].xAdvance,
      yAdvance: result.positions[index].yAdvance,
      xOffset: result.positions[index].xOffset,
      yOffset: result.positions[index].yOffset,
    };
  });
}

function shapeFixture(
  fixture: LoadedFixture,
  input: SubstitutionInput,
): ExactSubstitutionGlyph[] {
  const source = registerHbBufferSource(fixture.bytes);
  const result = harfbuzzShapeRun(
    source,
    0,
    input.text,
    input.direction,
    input.fontSizePx,
    input.axes,
    input.features,
    {
      script: input.script,
      language: input.language,
      bufferFlags: input.bufferFlags,
      clusterLevel: input.clusterLevel,
      verdictOnly: true,
    },
  );
  if (result == null) throw new Error(`${fixture.evidence.id}: HarfBuzz declined exact fixture bytes`);
  return logicalGlyphs(result, input.text);
}

function logicalDigest(glyphs: ExactSubstitutionGlyph[]): string {
  return sha256(JSON.stringify(glyphs));
}

function compareGlyphs(
  expected: ExactSubstitutionGlyph[],
  actual: ExactSubstitutionGlyph[],
): { equal: boolean; changedFields: string[] } {
  const changed = new Set<string>();
  if (expected.length !== actual.length) changed.add("glyphCount");
  const count = Math.min(expected.length, actual.length);
  const fields = [
    "id", "cluster", "sourceSpan", "xAdvance", "yAdvance", "xOffset", "yOffset",
  ] as const;
  for (let index = 0; index < count; index++) {
    for (const field of fields) {
      if (JSON.stringify(expected[index][field]) !== JSON.stringify(actual[index][field])) {
        changed.add(field);
      }
    }
  }
  return { equal: changed.size === 0, changedFields: [...changed].sort() };
}

function productionShape(
  spec: SubstitutionCaseSpec,
  fixture: LoadedFixture,
): ProductionOwnership {
  clearWebfonts();
  clearEmbeddedFonts();
  clearGlyphDefs();
  resetTextRunProvenance();
  setRenderTextMode("paths");
  setTextRunProvenanceEnabled(true);
  try {
    registerWebfont(
      fixture.evidence.family,
      400,
      "normal",
      fixture.bytes,
      undefined,
      fixture.registerDescriptors?.stretch,
      fixture.registerDescriptors?.weight,
    );
    const markup = renderTextAsPath(spec.input.text, 0, spec.input.fontSizePx * 2, {
      fontSize: spec.input.fontSizePx,
      fontFamily: fixture.evidence.family,
      fontWeight: "400",
      fill: "#000",
      features: [...spec.input.features],
      lang: spec.input.language,
      variationSettings: spec.input.axes ?? undefined,
      bidiOverride: {
        direction: spec.input.direction,
        unicodeBidi: "normal",
      },
    });
    if (markup.includes("data-domotion-text-boundary")) {
      throw new Error(`${spec.id}: production renderer reached a source boundary`);
    }
    const provenance = getTextRunProvenance();
    if (provenance.runs.length !== 1) {
      throw new Error(`${spec.id}: expected one production run, got ${provenance.runs.length}`);
    }
    const run = provenance.runs[0];
    if (run.shapeError != null) throw new Error(`${spec.id}: ${run.shapeError}`);
    return {
      sourceOwnership: {
        kind: "registered-webfont-buffer",
        sha256: fixture.evidence.sha256,
        byteLength: fixture.evidence.byteLength,
      },
      selected: {
        fontKey: run.selected.fontKey,
        postscriptName: run.selected.postscriptName,
        shapesWithHarfbuzz: run.selected.shapesWithHarfbuzz,
      },
      request: {
        direction: run.request.direction,
        fontSizePx: run.request.fontSizePx,
        script: run.request.script,
        language: run.request.language,
        features: run.request.features,
        variationSettings: run.request.variationSettings,
      },
      glyphs: run.glyphs.map((glyph) => ({
        id: glyph.id,
        cluster: glyph.cluster,
        sourceSpan: glyph.sourceSpan,
        xAdvance: glyph.xAdvance,
        yAdvance: glyph.yAdvance,
        xOffset: glyph.xOffset,
        yOffset: glyph.yOffset,
      })),
    };
  } finally {
    setTextRunProvenanceEnabled(false);
    resetTextRunProvenance();
    clearWebfonts();
    clearEmbeddedFonts();
    clearGlyphDefs();
  }
}

function assertCorpusSemantics(cases: SubstitutionCaseEvidence[]): void {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const latin = byId.get("latin-liga-variable-axis")!;
  if (latin.harfbuzz.glyphs.length !== 1 || latin.harfbuzz.glyphs[0].sourceSpan[1] !== 2) {
    throw new Error("latin fixture did not form the required fi ligature");
  }
  const ligature = byId.get("arabic-required-ligature")!;
  if (ligature.harfbuzz.glyphs.length >= ligature.input.text.length) {
    throw new Error("Arabic fixture did not form the required ligature");
  }
  const contextual = byId.get("arabic-contextual-mark-positioning")!;
  if (new Set(contextual.harfbuzz.glyphs.map((glyph) => glyph.cluster)).size < 2) {
    throw new Error("Arabic contextual fixture did not retain multiple source clusters");
  }
  if (!contextual.harfbuzz.glyphs.some((glyph) => glyph.xOffset !== 0 || glyph.yOffset !== 0)) {
    throw new Error("Arabic contextual fixture did not retain GPOS mark offsets");
  }
  const locl = byId.get("language-system-locl")!;
  if (locl.harfbuzz.glyphs.length !== 1 || locl.harfbuzz.glyphs[0].id !== 6) {
    throw new Error("LOCL fixture did not select the zh-Hant-HK language-system glyph");
  }
}

function inputMutation(
  id: string,
  caseId: string,
  cases: SubstitutionCaseEvidence[],
  fixtures: ReturnType<typeof loadSubstitutionFixtures>,
  mutate: (input: SubstitutionInput) => SubstitutionInput,
): MutationEvidence {
  const baseline = cases.find((item) => item.id === caseId);
  const spec = SUBSTITUTION_CASES.find((item) => item.id === caseId);
  if (baseline == null || spec == null) throw new Error(`unknown mutation case ${caseId}`);
  const actual = shapeFixture(fixtures[spec.fixture], mutate(structuredClone(spec.input)));
  const comparison = compareGlyphs(baseline.harfbuzz.glyphs, actual);
  return {
    id,
    kind: "input",
    caseId,
    changedFields: comparison.changedFields,
    rejected: !comparison.equal,
  };
}

function recordMutation(
  id: string,
  caseId: string,
  cases: SubstitutionCaseEvidence[],
  mutate: (candidate: SubstitutionCaseEvidence) => void,
): MutationEvidence {
  const baseline = cases.find((item) => item.id === caseId);
  if (baseline == null) throw new Error(`unknown mutation case ${caseId}`);
  const candidate = structuredClone(baseline);
  mutate(candidate);
  const sourceChanged = candidate.source.sha256 !== baseline.source.sha256
    || candidate.source.byteLength !== baseline.source.byteLength
    || candidate.source.familyName !== baseline.source.familyName
    || candidate.source.postscriptName !== baseline.source.postscriptName;
  const comparison = compareGlyphs(baseline.harfbuzz.glyphs, candidate.harfbuzz.glyphs);
  return {
    id,
    kind: "record",
    caseId,
    changedFields: [
      ...(sourceChanged ? ["source"] : []),
      ...comparison.changedFields,
    ],
    rejected: sourceChanged || !comparison.equal,
  };
}

export function runHostileMutations(
  cases: SubstitutionCaseEvidence[],
  fixtures: ReturnType<typeof loadSubstitutionFixtures>,
): MutationEvidence[] {
  return [
    inputMutation("disable-liga", "latin-liga-variable-axis", cases, fixtures,
      (input) => ({ ...input, features: ["-liga"] })),
    inputMutation("omit-variation-axes", "latin-liga-variable-axis", cases, fixtures,
      (input) => ({ ...input, axes: null })),
    inputMutation("disable-required-ligature", "arabic-required-ligature", cases, fixtures,
      (input) => ({ ...input, features: ["-rlig"] })),
    inputMutation("wrong-script", "arabic-contextual-mark-positioning", cases, fixtures,
      (input) => ({ ...input, script: "Latn" })),
    inputMutation("wrong-direction", "arabic-contextual-mark-positioning", cases, fixtures,
      (input) => ({ ...input, direction: "ltr" })),
    inputMutation("wrong-cluster-level", "arabic-contextual-mark-positioning", cases, fixtures,
      (input) => ({ ...input, clusterLevel: ClusterLevel.MONOTONE_CHARACTERS })),
    inputMutation("wrong-language-system", "language-system-locl", cases, fixtures,
      (input) => ({ ...input, language: "zh" })),
    recordMutation("wrong-source-fingerprint", "language-system-locl", cases,
      (candidate) => { candidate.source.sha256 = "0".repeat(64); }),
    recordMutation("wrong-gid", "language-system-locl", cases,
      (candidate) => { candidate.harfbuzz.glyphs[0].id += 1; }),
    recordMutation("wrong-cluster", "arabic-contextual-mark-positioning", cases,
      (candidate) => { candidate.harfbuzz.glyphs[0].cluster = 0; }),
    recordMutation("wrong-source-span", "arabic-contextual-mark-positioning", cases,
      (candidate) => { candidate.harfbuzz.glyphs[0].sourceSpan = [0, 1]; }),
    recordMutation("wrong-advance", "latin-liga-variable-axis", cases,
      (candidate) => { candidate.harfbuzz.glyphs[0].xAdvance += 1; }),
    recordMutation("zero-mark-offset", "arabic-contextual-mark-positioning", cases,
      (candidate) => {
        const glyph = candidate.harfbuzz.glyphs.find((item) => item.xOffset !== 0 || item.yOffset !== 0);
        if (glyph == null) throw new Error("mark-offset mutation had no target");
        glyph.xOffset = 0;
        glyph.yOffset = 0;
      }),
  ];
}

function runnerOs(): string {
  const override = process.env.DM2532_RUNNER_OS;
  if (override != null && override !== "") return override;
  return platform() === "darwin" ? "macOS" : platform() === "win32" ? "Windows" : "Linux";
}

function installedPlaywrightIdentity(): {
  playwrightVersion: string;
  playwrightChromiumRevision: string;
} {
  const packageMetadata = JSON.parse(readFileSync(
    resolve("node_modules/playwright-core/package.json"),
    "utf8",
  )) as { version?: string };
  const browserMetadata = JSON.parse(readFileSync(
    resolve("node_modules/playwright-core/browsers.json"),
    "utf8",
  )) as { browsers?: { name?: string; revision?: string }[] };
  const chromiumMetadata = browserMetadata.browsers?.find((item) => item.name === "chromium");
  if (packageMetadata.version == null || chromiumMetadata?.revision == null) {
    throw new Error("installed Playwright Chromium identity is incomplete");
  }
  return {
    playwrightVersion: packageMetadata.version,
    playwrightChromiumRevision: chromiumMetadata.revision,
  };
}

function corpusDigest(fixtures: Record<string, LoadedFixture>): string {
  return sha256(JSON.stringify(Object.values(fixtures)
    .map((fixture) => [fixture.evidence.id, fixture.evidence.sha256, fixture.evidence.byteLength])
    .sort(([a], [b]) => String(a).localeCompare(String(b)))));
}

function caseLogicalDigest(cases: SubstitutionCaseEvidence[]): string {
  return sha256(JSON.stringify(cases.map((item) => ({
    id: item.id,
    fixture: item.fixture,
    input: item.input,
    source: item.source,
    glyphs: item.harfbuzz.glyphs,
  }))));
}

export function buildLogicalSubstitutionEvidence(): {
  fixtures: ReturnType<typeof loadSubstitutionFixtures>;
  cases: SubstitutionCaseEvidence[];
  mutations: MutationEvidence[];
} {
  const fixtures = loadSubstitutionFixtures();
  const cases = SUBSTITUTION_CASES.map((spec): SubstitutionCaseEvidence => {
    const fixture = fixtures[spec.fixture];
    const glyphs = shapeFixture(fixture, spec.input);
    const production = productionShape(spec, fixture);
    const comparison = compareGlyphs(glyphs, production.glyphs);
    const requestMatches = production.request.direction === spec.input.direction
      && production.request.fontSizePx === spec.input.fontSizePx
      && production.request.script === spec.input.script
      && production.request.language === spec.input.language
      && JSON.stringify(production.request.features) === JSON.stringify(spec.input.features)
      && JSON.stringify(production.request.variationSettings ?? null) === JSON.stringify(spec.input.axes);
    const sourceMatches = production.sourceOwnership.sha256 === fixture.evidence.sha256
      && production.selected.fontKey === `webfont:${fixture.evidence.family}`
      && (fixture.evidence.postscriptName == null
        || production.selected.postscriptName === fixture.evidence.postscriptName)
      && production.selected.shapesWithHarfbuzz;
    return {
      id: spec.id,
      fixture: spec.fixture,
      claims: [...spec.claims],
      input: structuredClone(spec.input),
      source: {
        sha256: fixture.evidence.sha256,
        byteLength: fixture.evidence.byteLength,
        familyName: fixture.evidence.familyName,
        postscriptName: fixture.evidence.postscriptName,
      },
      harfbuzz: {
        revision: HARFBUZZ_REVISION,
        logicalSha256: logicalDigest(glyphs),
        glyphs,
      },
      production,
      browser: null,
      exactProductionAgreement: comparison.equal && requestMatches && sourceMatches,
    };
  });
  assertCorpusSemantics(cases);
  const mutations = runHostileMutations(cases, fixtures);
  return { fixtures, cases, mutations };
}

async function cdpNodeId(
  context: BrowserContext,
  page: Page,
  selector: string,
): Promise<{ nodeId: number; session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> }> {
  const session = await context.newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (nodeId === 0) throw new Error(`browser node not found: ${selector}`);
  return { nodeId, session };
}

export async function collectBrowserOwnership(
  cases: SubstitutionCaseEvidence[],
  fixtures: ReturnType<typeof loadSubstitutionFixtures>,
  browser?: Browser,
): Promise<{ cases: SubstitutionCaseEvidence[]; browserVersion: string }> {
  const ownedBrowser = browser ?? await chromium.launch({ headless: true });
  try {
    const context = await ownedBrowser.newContext({
      viewport: { width: 1200, height: 800 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const fixtureList = Object.values(fixtures);
    const faceCss = fixtureList.map((fixture) =>
      `@font-face{font-family:"${fixture.evidence.family}";src:url(data:font/ttf;base64,${fixture.bytes.toString("base64")}) format("truetype");font-style:normal;font-weight:400}`,
    ).join("\n");
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      ${faceCss}
      body{margin:0}.probe{position:relative;display:block;white-space:pre;margin:8px}
    </style><main id="root"></main>`, { waitUntil: "load" });
    await page.locator("#root").evaluate((root, values) => {
      for (const value of values) {
        const span = document.createElement("span");
        span.id = `dm2532-${value.id}`;
        span.className = "probe";
        span.textContent = value.input.text;
        span.lang = value.input.language;
        span.dir = value.input.direction;
        span.style.fontFamily = `"${value.family}"`;
        span.style.fontSize = `${value.input.fontSizePx}px`;
        span.style.fontFeatureSettings = value.input.features
          .map((feature) => {
            const match = /^([+-]?)([A-Za-z0-9]{4})(?:=(\d+))?$/.exec(feature);
            if (match == null) throw new Error(`unsupported fixture feature ${feature}`);
            const setting = match[3] ?? (match[1] === "-" ? "0" : "1");
            return `"${match[2]}" ${setting}`;
          })
          .join(", ");
        span.style.fontVariationSettings = value.input.axes == null
          ? "normal"
          : Object.entries(value.input.axes).map(([tag, axis]) => `"${tag}" ${axis}`).join(", ");
        root.append(span);
      }
    }, cases.map((item) => ({
      id: item.id,
      family: fixtures[item.fixture as SubstitutionCaseSpec["fixture"]].evidence.family,
      input: item.input,
    })));
    await page.evaluate(() => document.fonts.ready);

    const joined: SubstitutionCaseEvidence[] = [];
    for (const item of cases) {
      const fixture = fixtures[item.fixture as SubstitutionCaseSpec["fixture"]];
      const selector = `#dm2532-${item.id}`;
      await page.locator(selector).evaluate((element) => element.getBoundingClientRect().toJSON());
      const { nodeId, session } = await cdpNodeId(context, page, selector);
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      await session.detach();
      const browserFonts: BrowserFontObservation[] = fonts.map((font) => ({
        familyName: font.familyName,
        postScriptName: font.postScriptName,
        glyphCount: font.glyphCount,
        isCustomFont: font.isCustomFont,
      }));
      const origins = await page.locator(selector).evaluate((span): BrowserOrigin[] => {
        const text = span.firstChild;
        if (text == null) return [];
        const value = span.textContent ?? "";
        const result: BrowserOrigin[] = [];
        let start = 0;
        for (const scalar of value) {
          const end = start + scalar.length;
          const range = document.createRange();
          range.setStart(text, start);
          range.setEnd(text, end);
          const rect = range.getBoundingClientRect();
          result.push({
            utf16Span: [start, end],
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
          });
          start = end;
        }
        return result;
      });
      const custom = browserFonts.filter((font) => font.isCustomFont);
      const faceAgreement = exactCustomFaceAgreement(browserFonts, fixture.evidence);
      const glyphCountAgreement = custom.length === 1
        && custom[0].glyphCount === item.harfbuzz.glyphs.length;
      joined.push({
        ...item,
        browser: {
          fonts: browserFonts,
          origins,
          expectedPostscriptName: fixture.evidence.postscriptName,
          expectedFamilyName: fixture.evidence.familyName,
          customFaceAgreement: faceAgreement,
          exactGlyphCountAgreement: glyphCountAgreement,
          glyphIds: {
            status: "not-exposed-by-cdp",
            owner: "Blink ShapeResultRun / HarfBuzzRunGlyphData",
          },
        },
      });
    }
    await context.close();
    return { cases: joined, browserVersion: ownedBrowser.version() };
  } finally {
    if (browser == null) await ownedBrowser.close();
  }
}

export async function buildBrowserHarfBuzzSubstitutionReport(options: {
  evidence?: "proposal" | "validation";
  includeBrowser?: boolean;
  browser?: Browser;
} = {}): Promise<BrowserHarfBuzzSubstitutionReport> {
  assertConfiguredSourcePins();
  const evidence = options.evidence ?? "proposal";
  const logical = buildLogicalSubstitutionEvidence();
  const browserResult = options.includeBrowser === false
    ? { cases: logical.cases, browserVersion: null }
    : await collectBrowserOwnership(logical.cases, logical.fixtures, options.browser);
  const rejected = logical.mutations.filter((mutation) => mutation.rejected).map((mutation) => mutation.id);
  const browserComplete = options.includeBrowser === false
    || browserResult.cases.every((item) => item.browser != null
      && item.browser.customFaceAgreement
      && item.browser.exactGlyphCountAgreement
      && item.browser.origins.length === [...item.input.text].length);
  const logicalComplete = browserResult.cases.every((item) => item.exactProductionAgreement)
    && REQUIRED_MUTATIONS.every((id) => rejected.includes(id));
  const report: BrowserHarfBuzzSubstitutionReport = {
    schemaVersion: 1,
    ticket: "DM-2532",
    stage: "browser-harfbuzz-substitution-streams",
    evidence,
    runner: {
      os: runnerOs(),
      nodePlatform: process.platform,
      nodeVersion: process.version,
      browserVersion: browserResult.browserVersion,
      ...installedPlaywrightIdentity(),
      harfbuzzVersion: versionString(),
    },
    sourceAuthority: {
      chromium: CHROMIUM_REVISION,
      harfbuzz: HARFBUZZ_REVISION,
      skia: SKIA_REVISION,
    },
    boundary: "CDP authenticates the exact custom face and shaped glyph count; gid/cluster/span/advance/offset are owned by Blink ShapeResultRun and joined from the same bytes through pinned Chromium-configured HarfBuzz and production provenance.",
    rasterization: "blocked-until-exact-logical-agreement",
    fixtures: Object.values(logical.fixtures).map((fixture) => fixture.evidence),
    cases: browserResult.cases,
    mutations: logical.mutations,
    mutationCoverage: {
      required: [...REQUIRED_MUTATIONS],
      rejected,
      complete: REQUIRED_MUTATIONS.every((id) => rejected.includes(id)),
    },
    corpusSha256: corpusDigest(logical.fixtures),
    logicalSha256: caseLogicalDigest(browserResult.cases),
    verdict: logicalComplete && browserComplete ? "exact-logical-agreement" : "verdict-withheld",
  };
  return report;
}

function artifactJsonPaths(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return path.endsWith(".json") ? [path] : [];
  return readdirSync(path).flatMap((name) => artifactJsonPaths(resolve(path, name)));
}

export function validateSubstitutionArtifacts(
  reports: BrowserHarfBuzzSubstitutionReport[],
): SubstitutionAggregateReport {
  const failures: string[] = [];
  const byKey = new Map<string, BrowserHarfBuzzSubstitutionReport>();
  const local = buildLogicalSubstitutionEvidence();
  const expectedFixtures = new Map(Object.values(local.fixtures)
    .map((fixture) => [fixture.evidence.id, fixture.evidence]));
  const expectedMutations = new Map(local.mutations.map((mutation) => [mutation.id, mutation]));
  const expectedPlaywright = installedPlaywrightIdentity();
  const expectedCorpusSha256 = corpusDigest(local.fixtures);
  const expectedLogicalSha256 = caseLogicalDigest(local.cases);
  for (const report of reports) {
    const key = `${report.runner.os}/${report.evidence}`;
    if (byKey.has(key)) failures.push(`duplicate artifact ${key}`);
    byKey.set(key, report);
    if (report.schemaVersion !== 1 || report.stage !== "browser-harfbuzz-substitution-streams") {
      failures.push(`${key}: wrong schema/stage`);
    }
    if (report.verdict !== "exact-logical-agreement") failures.push(`${key}: logical verdict withheld`);
    if (!REQUIRED_OSES.includes(report.runner.os as typeof REQUIRED_OSES[number])
      || !REQUIRED_EVIDENCE.includes(report.evidence)) {
      failures.push(`${key}: undeclared OS/evidence arm`);
    }
    if (report.runner.browserVersion == null || report.runner.browserVersion === "") {
      failures.push(`${key}: browser version missing`);
    }
    const expectedNodePlatform = report.runner.os === "macOS"
      ? "darwin"
      : report.runner.os === "Windows" ? "win32" : "linux";
    if (report.runner.nodePlatform !== expectedNodePlatform
      || report.runner.harfbuzzVersion !== versionString()
      || report.runner.playwrightVersion !== expectedPlaywright.playwrightVersion
      || report.runner.playwrightChromiumRevision
        !== expectedPlaywright.playwrightChromiumRevision) {
      failures.push(`${key}: runner/toolchain identity drift`);
    }
    if (report.rasterization !== "blocked-until-exact-logical-agreement") {
      failures.push(`${key}: raster stage was not blocked`);
    }
    if (report.sourceAuthority.chromium !== CHROMIUM_REVISION
      || report.sourceAuthority.harfbuzz !== HARFBUZZ_REVISION
      || report.sourceAuthority.skia !== SKIA_REVISION) {
      failures.push(`${key}: source authority drift`);
    }
    if (report.corpusSha256 !== expectedCorpusSha256) failures.push(`${key}: corpus digest drift`);
    if (report.logicalSha256 !== expectedLogicalSha256
      || report.logicalSha256 !== caseLogicalDigest(report.cases)) {
      failures.push(`${key}: logical digest drift`);
    }

    const fixtureIds = new Set(report.fixtures.map((fixture) => fixture.id));
    if (fixtureIds.size !== expectedFixtures.size || report.fixtures.length !== expectedFixtures.size) {
      failures.push(`${key}: incomplete or duplicate fixture corpus`);
    }
    for (const fixture of report.fixtures) {
      const expected = expectedFixtures.get(fixture.id);
      if (expected == null || JSON.stringify(fixture) !== JSON.stringify(expected)) {
        failures.push(`${key}: fixture ${fixture.id} identity/table drift`);
      }
    }

    const requiredMutationSet = new Set(REQUIRED_MUTATIONS);
    const mutationIds = new Set(report.mutations.map((mutation) => mutation.id));
    const requiredIds = new Set(report.mutationCoverage.required);
    const rejectedIds = new Set(report.mutationCoverage.rejected);
    if (!report.mutationCoverage.complete
      || mutationIds.size !== REQUIRED_MUTATIONS.length
      || requiredIds.size !== REQUIRED_MUTATIONS.length
      || rejectedIds.size !== REQUIRED_MUTATIONS.length
      || [...requiredMutationSet].some((id) => !mutationIds.has(id)
        || !requiredIds.has(id) || !rejectedIds.has(id))
      || report.mutations.some((mutation) => {
        const expected = expectedMutations.get(mutation.id);
        return !mutation.rejected || mutation.changedFields.length === 0
          || expected == null || JSON.stringify(mutation) !== JSON.stringify(expected);
      })) {
      failures.push(`${key}: mutation coverage incomplete`);
    }

    const caseIds = new Set(report.cases.map((item) => item.id));
    if (caseIds.size !== SUBSTITUTION_CASES.length
      || report.cases.length !== SUBSTITUTION_CASES.length) {
      failures.push(`${key}: incomplete or duplicate case corpus`);
    }
    for (const spec of SUBSTITUTION_CASES) {
      const item = report.cases.find((candidate) => candidate.id === spec.id);
      const fixture = local.fixtures[spec.fixture].evidence;
      if (item == null) continue;
      const productionComparison = compareGlyphs(item.harfbuzz.glyphs, item.production.glyphs);
      const exactRequest = item.production.request.direction === spec.input.direction
        && item.production.request.fontSizePx === spec.input.fontSizePx
        && item.production.request.script === spec.input.script
        && item.production.request.language === spec.input.language
        && JSON.stringify(item.production.request.features) === JSON.stringify(spec.input.features)
        && JSON.stringify(item.production.request.variationSettings ?? null) === JSON.stringify(spec.input.axes);
      const exactSource = item.fixture === spec.fixture
        && JSON.stringify(item.claims) === JSON.stringify(spec.claims)
        && JSON.stringify(item.input) === JSON.stringify(spec.input)
        && item.source.sha256 === fixture.sha256
        && item.source.byteLength === fixture.byteLength
        && item.source.familyName === fixture.familyName
        && item.source.postscriptName === fixture.postscriptName
        && item.harfbuzz.revision === HARFBUZZ_REVISION
        && item.harfbuzz.logicalSha256 === logicalDigest(item.harfbuzz.glyphs)
        && item.production.sourceOwnership.sha256 === fixture.sha256
        && item.production.sourceOwnership.byteLength === fixture.byteLength
        && item.production.selected.fontKey === `webfont:${fixture.family}`
        && item.production.selected.shapesWithHarfbuzz
        && (fixture.postscriptName == null
          || item.production.selected.postscriptName === fixture.postscriptName);
      const browser = item.browser;
      const expectedOriginSpans: [number, number][] = [];
      let utf16Start = 0;
      for (const scalar of item.input.text) {
        const utf16End = utf16Start + scalar.length;
        expectedOriginSpans.push([utf16Start, utf16End]);
        utf16Start = utf16End;
      }
      const browserCustomFace = browser != null
        && exactCustomFaceAgreement(browser.fonts, fixture)
        && browser.customFaceAgreement
        && browser.exactGlyphCountAgreement
        && browser.expectedPostscriptName === fixture.postscriptName
        && browser.expectedFamilyName === fixture.familyName
        && browser.fonts.filter((font) => font.isCustomFont)[0]?.glyphCount
          === item.harfbuzz.glyphs.length
        && browser.glyphIds.status === "not-exposed-by-cdp"
        && browser.glyphIds.owner === "Blink ShapeResultRun / HarfBuzzRunGlyphData"
        && JSON.stringify(browser.origins.map((origin) => origin.utf16Span))
          === JSON.stringify(expectedOriginSpans)
        && browser.origins.every((origin) => [origin.left, origin.top, origin.right, origin.bottom]
          .every(Number.isFinite));
      if (!item.exactProductionAgreement || !productionComparison.equal
        || !exactRequest || !exactSource || !browserCustomFace) {
        failures.push(`${key}: ${spec.id} exact browser/production join incomplete`);
      }
    }
  }
  for (const os of REQUIRED_OSES) {
    for (const evidence of REQUIRED_EVIDENCE) {
      const key = `${os}/${evidence}`;
      if (!byKey.has(key)) failures.push(`missing artifact ${key}`);
    }
  }
  const corpus = new Set(reports.map((report) => report.corpusSha256));
  const logical = new Set(reports.map((report) => report.logicalSha256));
  const browserVersions = new Set(reports.map((report) => report.runner.browserVersion));
  const nodeVersions = new Set(reports.map((report) => report.runner.nodeVersion));
  if (corpus.size !== 1) failures.push("portable corpus SHA-256 differs across artifacts");
  if (logical.size !== 1) failures.push("exact logical streams differ across proposal/validation or OS");
  if (browserVersions.size !== 1) failures.push("browser version differs across proposal/validation or OS");
  if (nodeVersions.size !== 1) failures.push("Node version differs across proposal/validation or OS");
  return {
    schemaVersion: 1,
    ticket: "DM-2532",
    stage: "browser-harfbuzz-substitution-streams-aggregate",
    required: {
      operatingSystems: REQUIRED_OSES,
      evidence: REQUIRED_EVIDENCE,
    },
    artifactKeys: [...byKey.keys()].sort(),
    corpusSha256: corpus.size === 1 ? [...corpus][0] : null,
    logicalSha256: logical.size === 1 ? [...logical][0] : null,
    rasterization: "not-started",
    verdict: failures.length === 0 ? "proposal-validation-agreement" : "verdict-withheld",
    failures,
  };
}

function valueAfter(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const aggregateInput = valueAfter("--aggregate");
  const output = valueAfter("--json");
  if (aggregateInput != null) {
    const reports = artifactJsonPaths(resolve(aggregateInput)).map((path) =>
      JSON.parse(readFileSync(path, "utf8")) as BrowserHarfBuzzSubstitutionReport);
    const aggregate = validateSubstitutionArtifacts(reports);
    if (output != null) {
      writeFileSync(resolve(output), JSON.stringify(aggregate, null, 2));
    }
    console.log(`DM-2532 aggregate: ${aggregate.verdict}; artifacts=${aggregate.artifactKeys.length}`);
    if (aggregate.failures.length > 0) console.error(aggregate.failures.join("\n"));
    return aggregate.verdict === "proposal-validation-agreement" ? 0 : 1;
  }

  const evidence = process.argv.includes("--validation") ? "validation" : "proposal";
  const report = await buildBrowserHarfBuzzSubstitutionReport({
    evidence,
    includeBrowser: !process.argv.includes("--logic-only"),
  });
  if (output != null) {
    const target = resolve(output);
    if (!existsSync(dirname(target))) {
      throw new Error(`output directory does not exist: ${dirname(target)}`);
    }
    writeFileSync(target, JSON.stringify(report, null, 2));
  }
  console.log(`DM-2532 ${evidence}: ${report.verdict}; cases=${report.cases.length}; hostile mutations=${report.mutationCoverage.rejected.length}`);
  return report.verdict === "exact-logical-agreement" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
}
