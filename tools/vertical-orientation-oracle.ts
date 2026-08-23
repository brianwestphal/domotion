#!/usr/bin/env tsx
/**
 * DM-2525 exact logical oracle for Blink vertical-orientation ownership.
 *
 * Expected properties come from the pinned ICU companion consumed by the
 * pinned Chromium checkout. The gate compares every generated range
 * transition plus a representative script/locale corpus. It contains no
 * screenshot, raster metric, tolerance, or pixel-fitting verdict.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  GRAPHEME_EXTEND_RANGES,
  MIXED_VERTICAL_UPRIGHT_RANGES,
  VERTICAL_ORIENTATION_SOURCE_SHA256,
  VERTICAL_ORIENTATION_UNICODE_VERSION,
} from "../src/capture/script/vertical-orientation.generated.js";
import {
  blinkUsesTextCombine,
  blinkVerticalOrientationRuns,
  isBlinkGraphemeExtend,
  isMixedVerticalUpright,
  type VerticalGlyphOrientation,
  type VerticalOrientationRun,
} from "../src/vertical-orientation.js";
import {
  ICU_BINARY,
  isIcuHelperAvailable,
  queryIcuCodepoints,
  type IcuCodepointProperties,
} from "../src/render/icu-helper.js";

export const VERTICAL_ORIENTATION_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  icu: "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  decisionOwner: "Blink/ICU; HarfBuzz consumes the itemized run downstream",
  unicode: "17.0.0",
  ppucdSha256: "bccc5a5ca1baea3de767e8266d59ffa13ff99595bea37ca82415851386f57dbd",
  orientationIterator: "third_party/blink/renderer/platform/fonts/orientation_iterator.cc",
  character: "third_party/blink/renderer/platform/text/character.cc",
  textCombine: "third_party/blink/renderer/core/layout/layout_text_combine.h",
  writingMode: "third_party/blink/renderer/platform/text/writing_mode.h",
} as const;

interface CorpusCase {
  id: string;
  text: string;
  locale: string;
  textOrientation: "mixed" | "upright" | "sideways";
}

export const VERTICAL_ORIENTATION_CORPUS: readonly CorpusCase[] = [
  { id: "r-latin", text: "A", locale: "en", textOrientation: "mixed" },
  { id: "u-han-supplementary", text: "漢\u{30000}", locale: "zh", textOrientation: "mixed" },
  { id: "tu-punctuation", text: "、", locale: "ja", textOrientation: "mixed" },
  { id: "tr-quote", text: "‘", locale: "en", textOrientation: "mixed" },
  { id: "symbols-stale-range", text: "§🂡", locale: "en", textOrientation: "mixed" },
  { id: "latin-upright-extend", text: "A\u20dd", locale: "en", textOrientation: "mixed" },
  { id: "han-rotated-ivs", text: "漢\u{e0101}", locale: "ja", textOrientation: "mixed" },
  { id: "leading-extend", text: "\u20dd\u0300ABC\u20dd", locale: "en", textOrientation: "mixed" },
  { id: "arabic-mark", text: "ب\u0651漢", locale: "ar", textOrientation: "mixed" },
  { id: "hangul-latin", text: "한A", locale: "ko", textOrientation: "mixed" },
  { id: "locale-en", text: "A\u20dd§漢\u{e0101}", locale: "en", textOrientation: "mixed" },
  { id: "locale-ja", text: "A\u20dd§漢\u{e0101}", locale: "ja", textOrientation: "mixed" },
  { id: "locale-ko", text: "A\u20dd§漢\u{e0101}", locale: "ko", textOrientation: "mixed" },
  { id: "locale-ar", text: "A\u20dd§漢\u{e0101}", locale: "ar", textOrientation: "mixed" },
  { id: "upright-override", text: "Aب漢🂡", locale: "ar", textOrientation: "upright" },
  { id: "sideways-override", text: "Aب漢🂡", locale: "ja", textOrientation: "sideways" },
] as const;

interface ScalarMismatch {
  cp: number;
  expectedUpright: boolean;
  actualUpright: boolean;
  expectedGraphemeExtend: boolean;
  actualGraphemeExtend: boolean;
}

interface SourcePropertyMismatch {
  cp: number;
  property: "Vertical_Orientation" | "Grapheme_Extend";
  source: boolean;
  production: boolean;
}

function parsePinnedSource(text: string): { upright: Uint8Array; graphemeExtend: Uint8Array } {
  const upright = new Uint8Array(0x110000);
  const graphemeExtend = new Uint8Array(0x110000);
  const vertical = (fields: string[], inherited: boolean): boolean => {
    const property = fields.find((field) => field.startsWith("vo="));
    return property == null ? inherited : property !== "vo=R";
  };
  const binary = (fields: string[], inherited: boolean): boolean =>
    fields.includes("Gr_Ext") ? true : fields.includes("-Gr_Ext") ? false : inherited;
  for (const raw of text.split(/\r?\n/)) {
    const fields = raw.split(";");
    if (fields[0] === "block" || fields[0] === "unassigned") {
      const [loText, hiText = loText] = fields[1].split("..");
      const lo = Number.parseInt(loText, 16);
      const hi = Number.parseInt(hiText, 16);
      upright.fill(vertical(fields, false) ? 1 : 0, lo, hi + 1);
      graphemeExtend.fill(binary(fields, false) ? 1 : 0, lo, hi + 1);
    } else if (fields[0] === "cp") {
      const cp = Number.parseInt(fields[1], 16);
      upright[cp] = vertical(fields, upright[cp] === 1) ? 1 : 0;
      graphemeExtend[cp] = binary(fields, graphemeExtend[cp] === 1) ? 1 : 0;
    }
  }
  return { upright, graphemeExtend };
}

function transitionProbes(): number[] {
  const result = new Set<number>();
  for (const ranges of [MIXED_VERTICAL_UPRIGHT_RANGES, GRAPHEME_EXTEND_RANGES]) {
    for (const [lo, hi] of ranges) {
      for (const cp of [lo - 1, lo, lo + Math.floor((hi - lo) / 2), hi, hi + 1]) {
        if (cp >= 0 && cp <= 0x10ffff) result.add(cp);
      }
    }
  }
  for (const row of VERTICAL_ORIENTATION_CORPUS) {
    for (const scalar of row.text) result.add(scalar.codePointAt(0)!);
  }
  return [...result].sort((left, right) => left - right);
}

function sourceOrientation(row: IcuCodepointProperties): VerticalGlyphOrientation {
  // Character::IsUprightInMixedVertical returns true for U/Tu/Tr and false
  // only for ICU's U_VO_ROTATED enum value (zero).
  return row.verticalOrientation === 0 ? "rotated" : "upright";
}

function sourceRuns(
  text: string,
  textOrientation: CorpusCase["textOrientation"],
  properties: Map<number, IcuCodepointProperties>,
): VerticalOrientationRun[] {
  if (text === "") return [];
  if (textOrientation !== "mixed") {
    return [{
      start: 0,
      end: text.length,
      orientation: textOrientation === "upright" ? "upright" : "rotated",
    }];
  }
  const runs: VerticalOrientationRun[] = [];
  let current: VerticalGlyphOrientation | undefined;
  let runStart = 0;
  for (let offset = 0; offset < text.length;) {
    const cp = text.codePointAt(offset)!;
    const length = cp > 0xffff ? 2 : 1;
    const row = properties.get(cp);
    if (row == null) throw new Error(`ICU companion omitted U+${cp.toString(16).toUpperCase()}`);
    const extend = (row.binaryProperties & ICU_BINARY.GRAPHEME_EXTEND) !== 0;
    const next = current == null || !extend ? sourceOrientation(row) : current;
    if (current != null && next !== current) {
      runs.push({ start: runStart, end: offset, orientation: current });
      runStart = offset;
    }
    current = next;
    offset += length;
  }
  runs.push({ start: runStart, end: text.length, orientation: current! });
  return runs;
}

function same(value: unknown, expected: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function oldHandwrittenUpright(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x11ff)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0x1f200 && cp <= 0x1f2ff)
    || cp >= 0x20000;
}

function perScalarMutation(
  text: string,
  properties: Map<number, IcuCodepointProperties>,
): VerticalOrientationRun[] {
  const runs: VerticalOrientationRun[] = [];
  for (let offset = 0; offset < text.length;) {
    const cp = text.codePointAt(offset)!;
    const length = cp > 0xffff ? 2 : 1;
    const orientation = sourceOrientation(properties.get(cp)!);
    const previous = runs.at(-1);
    if (previous?.orientation === orientation) previous.end = offset + length;
    else runs.push({ start: offset, end: offset + length, orientation });
    offset += length;
  }
  return runs;
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface VerticalOrientationOracleReport {
  schemaVersion: 1;
  ticket: "DM-2525";
  verdict: "exact-logical-match" | "mismatch";
  sourcePins: typeof VERTICAL_ORIENTATION_SOURCE_PINS;
  environment: { platform: NodeJS.Platform; architecture: string; node: string; icuHelperAvailable: boolean };
  sourceImage: { path: string; sha256: string | null; generatedSha256: string; unicodeVersion: string };
  sourceCodePointCount: number;
  sourceCodePointMismatchCount: number;
  sourceCodePointMismatches: SourcePropertyMismatch[];
  scalarProbeCount: number;
  scalarMismatches: ScalarMismatch[];
  corpus: Array<CorpusCase & { sourceRuns: VerticalOrientationRun[]; productionRuns: VerticalOrientationRun[]; matches: boolean }>;
  combine: Array<{ writingMode: string; textCombine: string; source: boolean; production: boolean; matches: boolean }>;
  mutations: { staleRangesMoved: boolean; perScalarExtendMoved: boolean; wrongCombineOwnershipMoved: boolean; staleUnicodeVersionMoved: boolean };
  checks: Record<string, boolean>;
}

export function buildVerticalOrientationOracle(options: {
  sourcePath?: string;
  requireSource?: boolean;
} = {}): VerticalOrientationOracleReport {
  if (!isIcuHelperAvailable()) throw new Error("DM-2525 requires the pinned ICU companion");
  const sourcePath = resolve(options.sourcePath
    ?? "external/chromium/third_party/icu/source/data/unidata/ppucd.txt");
  const sourceSha256 = sha256File(sourcePath);
  if (options.requireSource && sourceSha256 == null) throw new Error(`pinned ppucd source missing: ${sourcePath}`);

  const sourceCodePointMismatches: SourcePropertyMismatch[] = [];
  let sourceCodePointMismatchCount = 0;
  if (sourceSha256 != null) {
    const sourceProperties = parsePinnedSource(readFileSync(sourcePath, "utf8"));
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const sourceUpright = sourceProperties.upright[cp] === 1;
      const productionUpright = isMixedVerticalUpright(cp);
      if (sourceUpright !== productionUpright) {
        sourceCodePointMismatchCount++;
        if (sourceCodePointMismatches.length < 20) {
          sourceCodePointMismatches.push({ cp, property: "Vertical_Orientation", source: sourceUpright, production: productionUpright });
        }
      }
      const sourceExtend = sourceProperties.graphemeExtend[cp] === 1;
      const productionExtend = isBlinkGraphemeExtend(cp);
      if (sourceExtend !== productionExtend) {
        sourceCodePointMismatchCount++;
        if (sourceCodePointMismatches.length < 20) {
          sourceCodePointMismatches.push({ cp, property: "Grapheme_Extend", source: sourceExtend, production: productionExtend });
        }
      }
    }
  }

  const probes = transitionProbes();
  const properties = queryIcuCodepoints(probes);
  if (properties.size !== probes.length) {
    throw new Error(`ICU companion returned ${properties.size}/${probes.length} transition probes`);
  }
  const scalarMismatches: ScalarMismatch[] = [];
  for (const cp of probes) {
    const row = properties.get(cp)!;
    const expectedUpright = row.verticalOrientation !== 0;
    const expectedGraphemeExtend = (row.binaryProperties & ICU_BINARY.GRAPHEME_EXTEND) !== 0;
    const actualUpright = isMixedVerticalUpright(cp);
    const actualGraphemeExtend = isBlinkGraphemeExtend(cp);
    if (expectedUpright !== actualUpright || expectedGraphemeExtend !== actualGraphemeExtend) {
      scalarMismatches.push({ cp, expectedUpright, actualUpright, expectedGraphemeExtend, actualGraphemeExtend });
    }
  }

  const corpus = VERTICAL_ORIENTATION_CORPUS.map((spec) => {
    const expected = sourceRuns(spec.text, spec.textOrientation, properties);
    const actual = blinkVerticalOrientationRuns(spec.text, spec.textOrientation);
    return { ...spec, sourceRuns: expected, productionRuns: actual, matches: same(actual, expected) };
  });
  const writingModes = ["horizontal-tb", "vertical-rl", "vertical-lr", "sideways-rl", "sideways-lr"];
  const combine = writingModes.flatMap((writingMode) => ["none", "all"].map((textCombine) => {
    const source = textCombine === "all" && (writingMode === "vertical-rl" || writingMode === "vertical-lr");
    const production = blinkUsesTextCombine(writingMode, textCombine);
    return { writingMode, textCombine, source, production, matches: source === production };
  }));
  const localeRuns = corpus.filter((row) => row.id.startsWith("locale-")).map((row) => row.productionRuns);
  const staleRangesMoved = [0x00a7, 0x2018, 0x1f0a1]
    .every((cp) => oldHandwrittenUpright(cp) !== isMixedVerticalUpright(cp));
  const perScalarExtendMoved = ["A\u20dd", "漢\u{e0101}"]
    .every((text) => !same(perScalarMutation(text, properties), sourceRuns(text, "mixed", properties)));
  const wrongCombineOwnershipMoved = blinkUsesTextCombine("sideways-rl", "all") !== true
    && blinkUsesTextCombine("sideways-lr", "all") !== true;
  const staleUnicodeVersionMoved = VERTICAL_ORIENTATION_UNICODE_VERSION !== "16.0.0";
  const mutations = { staleRangesMoved, perScalarExtendMoved, wrongCombineOwnershipMoved, staleUnicodeVersionMoved };
  const checks = {
    sourceImageExact: sourceSha256 === VERTICAL_ORIENTATION_SOURCE_PINS.ppucdSha256,
    generatedSourceIdentityExact: VERTICAL_ORIENTATION_SOURCE_SHA256 === VERTICAL_ORIENTATION_SOURCE_PINS.ppucdSha256,
    unicodeVersionExact: VERTICAL_ORIENTATION_UNICODE_VERSION === VERTICAL_ORIENTATION_SOURCE_PINS.unicode,
    exhaustiveSourceClassificationExact: sourceSha256 != null && sourceCodePointMismatchCount === 0,
    transitionPropertiesExact: scalarMismatches.length === 0,
    representativeCorpusExact: corpus.every((row) => row.matches),
    localeInvariant: localeRuns.length === 4 && localeRuns.every((runs) => same(runs, localeRuns[0])),
    textCombineOwnershipExact: combine.every((row) => row.matches),
    negativeMutationsActive: Object.values(mutations).every(Boolean),
  };
  const verdict = Object.values(checks).every(Boolean) ? "exact-logical-match" : "mismatch";
  return {
    schemaVersion: 1,
    ticket: "DM-2525",
    verdict,
    sourcePins: VERTICAL_ORIENTATION_SOURCE_PINS,
    environment: { platform: process.platform, architecture: process.arch, node: process.version, icuHelperAvailable: true },
    sourceImage: { path: sourcePath, sha256: sourceSha256, generatedSha256: VERTICAL_ORIENTATION_SOURCE_SHA256, unicodeVersion: VERTICAL_ORIENTATION_UNICODE_VERSION },
    sourceCodePointCount: 0x110000,
    sourceCodePointMismatchCount,
    sourceCodePointMismatches,
    scalarProbeCount: probes.length,
    scalarMismatches,
    corpus,
    combine,
    mutations,
    checks,
  };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const report = buildVerticalOrientationOracle({
    sourcePath: argument("--source"),
    requireSource: process.argv.includes("--require-source"),
  });
  const output = argument("--json");
  if (output != null) {
    const path = resolve(output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== "exact-logical-match") process.exitCode = 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
