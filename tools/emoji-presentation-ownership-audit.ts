#!/usr/bin/env tsx
/**
 * DM-2502 investigation oracle: Blink SymbolsIterator ownership versus the
 * current script-only shaping itemizer.
 *
 * This intentionally diagnoses the known gap; it is not the production fix.
 * A successful strict Linux arm64 run means the source-owned discriminator was
 * reproduced: a preceding text-presentation miss can make bare U+2757 inherit
 * an ordinary fallback face, while reversing the two symbols reaches the color
 * emoji priority face. No pixel threshold participates in the verdict.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { scanEmojiPresentation } from "../src/capture/script/emoji-detect.js";
import {
  _clusterFallbackCounters,
  splitTextIntoFontRunsShaped,
} from "../src/render/cluster-fallback.js";
import {
  fontHasSupportedColorTable,
  getFontSourceInfo,
  resolveFont,
  resolveFontKey,
  resolveFontKeyChain,
  stackPrimaryIsSystemUi,
  type FontRun,
  type FontVariantEmojiOverride,
} from "../src/render/font-resolution.js";
import { isGlyphHelperAvailable } from "../src/render/glyph-helper.js";
import { ICU_BINARY, icuCodepointProperties, isIcuHelperAvailable } from "../src/render/icu-helper.js";
import { bidiLevelsFor, segmentForShaping } from "../src/render/script-segmentation.js";
import { selectedGlyphRasterSpans } from "../src/render/text-to-path.js";

export const EMOJI_OWNERSHIP_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skiaPinnedByChromium: "62efacd37737505732dbe3d8daa62abd679626a1",
  icu: "d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738",
} as const;

export const EMOJI_OWNERSHIP_HELPER_DIGESTS = {
  glyph: "68546de5c29a60efbe1bdb86e61d14d9ba10f00020c5b50583f5bc336718c250",
  icuExecutable: "dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf",
  icuData: "9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe",
} as const;

export const EMOJI_OWNERSHIP_FIXTURE = "Status: done ✓ and flagged ✗ with emphasis ❗ nearby.";
export const EMOJI_OWNERSHIP_TARGET = "❗";

type ScannerCategory =
  | "keycap" | "keycap-mark" | "circle-backslash" | "zwj" | "vs15" | "vs16"
  | "tag-base" | "tag-sequence" | "tag-term" | "modifier-base" | "modifier"
  | "regional-indicator" | "emoji-default" | "text-default" | "other";

export type SourceFallbackPriority = "text" | "emoji" | "text-vs" | "emoji-vs";

export interface SourcePriorityItem {
  start: number;
  end: number;
  text: string;
  priority: SourceFallbackPriority;
}

/** ICU-backed category input for the same pinned scanner grammar as Blink. */
function pinnedCategory(cp: number): ScannerCategory {
  if (cp <= 0x7f) return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39) ? "keycap" : "other";
  if (cp === 0x20e3) return "keycap-mark";
  if (cp === 0x20e0) return "circle-backslash";
  if (cp === 0x200d) return "zwj";
  if (cp === 0xfe0e) return "vs15";
  if (cp === 0xfe0f) return "vs16";
  if (cp === 0x1f3f4) return "tag-base";
  if (cp >= 0xe0020 && cp <= 0xe007e) return "tag-sequence";
  if (cp === 0xe007f) return "tag-term";
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "regional-indicator";
  const row = icuCodepointProperties(cp);
  if (row == null) {
    const ch = String.fromCodePoint(cp);
    if (/\p{Emoji_Modifier_Base}/u.test(ch)) return "modifier-base";
    if (/\p{Emoji_Modifier}/u.test(ch)) return "modifier";
    if (/\p{Emoji_Presentation}/u.test(ch)) return "emoji-default";
    return /\p{Emoji}/u.test(ch) ? "text-default" : "other";
  }
  const bits = row.binaryProperties;
  if ((bits & ICU_BINARY.EMOJI_MODIFIER_BASE) !== 0) return "modifier-base";
  if ((bits & ICU_BINARY.V2) !== 0 && (bits & ICU_BINARY.EMOJI_MODIFIER) !== 0) return "modifier";
  if ((bits & ICU_BINARY.V2) === 0 && /\p{Emoji_Modifier}/u.test(String.fromCodePoint(cp))) return "modifier";
  if ((bits & ICU_BINARY.EMOJI_PRESENTATION) !== 0) return "emoji-default";
  if ((bits & ICU_BINARY.EMOJI) !== 0) return "text-default";
  if (row.generalCategory === 0 && (bits & ICU_BINARY.EXTENDED_PICTOGRAPHIC) !== 0) return "text-default";
  return "other";
}

/**
 * Maximal SymbolsIterator source states. Ordinary gaps around scanner tokens
 * are text; adjacent identical states coalesce. CSS font-variant-emoji is not
 * an input because Blink applies it after these source boundaries are fixed.
 */
export function sourcePriorityItems(text: string): SourcePriorityItem[] {
  if (text.length === 0) return [];
  const tokens = scanEmojiPresentation(text, pinnedCategory)
    .map((span) => ({
      ...span,
      priority: span.hasVs
        ? (span.presentation === "emoji" ? "emoji-vs" : "text-vs")
        : (span.presentation === "emoji" ? "emoji" : "text"),
    }))
    .sort((a, b) => a.start - b.start);
  const raw: Array<{ start: number; end: number; priority: SourceFallbackPriority }> = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) raw.push({ start: cursor, end: token.start, priority: "text" });
    raw.push({ start: token.start, end: token.end, priority: token.priority });
    cursor = Math.max(cursor, token.end);
  }
  if (cursor < text.length) raw.push({ start: cursor, end: text.length, priority: "text" });
  const merged: typeof raw = [];
  for (const item of raw) {
    const previous = merged[merged.length - 1];
    if (previous != null && previous.end === item.start && previous.priority === item.priority) previous.end = item.end;
    else merged.push({ ...item });
  }
  return merged.map((item) => ({ ...item, text: text.slice(item.start, item.end) }));
}

export interface StructuralOwnershipEvidence {
  sourcePriorityItems: SourcePriorityItem[];
  currentSegments: ReturnType<typeof segmentForShaping>;
  missingSourceBoundaries: number[];
  rootCausePresent: boolean;
}

export function structuralOwnershipEvidence(text = EMOJI_OWNERSHIP_FIXTURE): StructuralOwnershipEvidence {
  const sourceItems = sourcePriorityItems(text);
  const currentSegments = segmentForShaping(text, bidiLevelsFor(text));
  const currentBoundaries = new Set(currentSegments.flatMap((segment) => [segment.start, segment.end]));
  const missingSourceBoundaries = sourceItems
    .flatMap((item) => [item.start, item.end])
    .filter((boundary, index, all) => boundary > 0 && boundary < text.length
      && all.indexOf(boundary) === index && !currentBoundaries.has(boundary));
  const target = text.indexOf(EMOJI_OWNERSHIP_TARGET);
  const targetItem = sourceItems.find((item) => item.start === target);
  return {
    sourcePriorityItems: sourceItems,
    currentSegments,
    missingSourceBoundaries,
    rootCausePresent: targetItem?.priority === "emoji"
      && missingSourceBoundaries.includes(target)
      && missingSourceBoundaries.includes(target + EMOJI_OWNERSHIP_TARGET.length),
  };
}

export interface RouteEvidence {
  id: string;
  text: string;
  targetStart: number;
  targetEnd: number;
  fontFamily: string;
  fontVariantEmoji?: FontVariantEmojiOverride;
  targetFontKey: string | null;
  targetPostscriptName: string | null;
  targetPath: string | null;
  routeMechanism: FontRun["routeMechanism"] | null;
  representation: "bitmap" | "sbix" | "colr" | "svg" | null;
  selectedFaceHasColorTables: boolean;
  priorityAsked: number;
  priorityAnswered: number;
  runs: Array<{ start: number; end: number; text: string; fontKey: string; routeMechanism: FontRun["routeMechanism"] }>;
}

interface RouteCase {
  id: string;
  text: string;
  target: string;
  fontFamily?: string;
  fontVariantEmoji?: FontVariantEmojiOverride;
}

export const EMOJI_OWNERSHIP_ROUTE_CASES: readonly RouteCase[] = [
  { id: "fixture-order", text: EMOJI_OWNERSHIP_FIXTURE, target: EMOJI_OWNERSHIP_TARGET },
  { id: "text-before-emoji", text: "✗ ❗", target: EMOJI_OWNERSHIP_TARGET },
  { id: "emoji-before-text", text: "❗ ✗", target: EMOJI_OWNERSHIP_TARGET },
  { id: "explicit-vs16", text: "✗ ❗\ufe0f", target: "❗\ufe0f" },
  { id: "explicit-vs15", text: "✗ ❗\ufe0e", target: "❗\ufe0e" },
  { id: "text-negative", text: "✗", target: "✗" },
  { id: "css-text-negative", text: "❗", target: "❗", fontVariantEmoji: "text" },
  { id: "declared-face-precedes-priority", text: "❗", target: "❗", fontFamily: "FreeSans" },
  { id: "declared-face-css-emoji", text: "❗", target: "❗", fontFamily: "FreeSans", fontVariantEmoji: "emoji" },
] as const;

function runRouteCase(spec: RouteCase): RouteEvidence {
  const fontFamily = spec.fontFamily ?? "sans-serif";
  const fontSize = 16;
  const weight = 400;
  const slant = 0;
  const stretch = 100;
  const lang = "en";
  const primary = resolveFont(fontFamily, weight, fontSize, slant, undefined, stretch, lang);
  if (primary == null) throw new Error(`cannot resolve audit primary: ${fontFamily}`);
  const primaryKey = resolveFontKey(fontFamily, lang);
  const targetStart = spec.text.indexOf(spec.target);
  if (targetStart < 0) throw new Error(`audit target missing in ${spec.id}`);
  const targetEnd = targetStart + spec.target.length;
  const before = _clusterFallbackCounters();
  const runs = splitTextIntoFontRunsShaped(
    spec.text, primary, primaryKey, weight, fontSize, slant, undefined, lang,
    resolveFontKeyChain(fontFamily, lang), stackPrimaryIsSystemUi(fontFamily, lang),
    stretch, spec.fontVariantEmoji, fontFamily,
  );
  const after = _clusterFallbackCounters();
  const targetRun = runs.find((run) => targetStart >= run.startIdx && targetStart < run.endIdx) ?? null;
  const raster = selectedGlyphRasterSpans(spec.text, [{ start: targetStart, end: targetEnd }], {
    fontSize,
    fontFamily,
    fontWeight: weight,
    fontStyle: "normal",
    fontStretch: "100%",
    lang,
    fontVariantEmoji: spec.fontVariantEmoji,
  })[0];
  const source = getFontSourceInfo(targetRun?.font);
  return {
    id: spec.id,
    text: spec.text,
    targetStart,
    targetEnd,
    fontFamily,
    ...(spec.fontVariantEmoji != null ? { fontVariantEmoji: spec.fontVariantEmoji } : {}),
    targetFontKey: targetRun?.fontKey ?? null,
    targetPostscriptName: source?.postscriptName ?? targetRun?.font.postscriptName ?? null,
    targetPath: source?.path ?? null,
    routeMechanism: targetRun?.routeMechanism ?? null,
    representation: raster?.representation ?? null,
    selectedFaceHasColorTables: targetRun != null
      && fontHasSupportedColorTable(targetRun.font, targetRun.fontKey),
    priorityAsked: after.priorityAsked - before.priorityAsked,
    priorityAnswered: after.priorityAnswered - before.priorityAnswered,
    runs: runs.map((run) => ({
      start: run.startIdx,
      end: run.endIdx,
      text: run.text,
      fontKey: run.fontKey,
      routeMechanism: run.routeMechanism,
    })),
  };
}

function sha256File(file: string | undefined): string | null {
  if (file == null || !existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface EmojiOwnershipAuditReport {
  schemaVersion: 1;
  ticket: "DM-2502";
  verdict: "confirmed-missing-symbols-item-boundary" | "source-gap-confirmed-native-inapplicable" | "discriminator-failed";
  sourcePins: typeof EMOJI_OWNERSHIP_SOURCE_PINS;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    node: string;
    glyphHelperAvailable: boolean;
    icuHelperAvailable: boolean;
    glyphHelperSha256: string | null;
    icuHelperSha256: string | null;
    icuDataSha256: string | null;
  };
  u2757: { found: boolean; binaryProperties: number | null; emoji: boolean; emojiPresentation: boolean };
  structural: StructuralOwnershipEvidence;
  routes: RouteEvidence[];
  checks: Record<string, boolean>;
}

export function buildEmojiOwnershipAudit(options: { requireLinuxArm64?: boolean } = {}): EmojiOwnershipAuditReport {
  const structural = structuralOwnershipEvidence();
  const nativeApplicable = process.platform === "linux" && process.arch === "arm64";
  if (options.requireLinuxArm64 && !nativeApplicable) {
    throw new Error(`DM-2502 native audit requires linux/arm64, got ${process.platform}/${process.arch}`);
  }
  const glyphHelperAvailable = isGlyphHelperAvailable();
  const icuHelperAvailable = isIcuHelperAvailable();
  const glyphHelperSha256 = sha256File(process.env.DOMOTION_HELPER_PATH);
  const icuHelperSha256 = sha256File(process.env.DOMOTION_ICU_HELPER_PATH);
  const icuDataSha256 = sha256File(process.env.DOMOTION_ICU_DATA);
  const row = icuCodepointProperties(0x2757);
  const u2757 = {
    found: row?.found === true,
    binaryProperties: row?.binaryProperties ?? null,
    emoji: row != null && (row.binaryProperties & ICU_BINARY.EMOJI) !== 0,
    emojiPresentation: row != null && (row.binaryProperties & ICU_BINARY.EMOJI_PRESENTATION) !== 0,
  };
  const routes = nativeApplicable ? EMOJI_OWNERSHIP_ROUTE_CASES.map(runRouteCase) : [];
  const byId = new Map(routes.map((route) => [route.id, route]));
  const isRaster = (id: string): boolean => byId.get(id)?.representation != null;
  const isEmojiFace = (id: string): boolean => {
    const route = byId.get(id);
    return `${route?.targetFontKey ?? ""}|${route?.targetPostscriptName ?? ""}`.toLowerCase().includes("emoji");
  };
  const checks = {
    sourceMarksU2757EmojiPresentation: u2757.emoji && u2757.emojiPresentation,
    currentItemizerMissesBothU2757Boundaries: structural.rootCausePresent,
    nativeEnvironmentExact: !nativeApplicable || (
      glyphHelperAvailable
      && icuHelperAvailable
      && glyphHelperSha256 === EMOJI_OWNERSHIP_HELPER_DIGESTS.glyph
      && icuHelperSha256 === EMOJI_OWNERSHIP_HELPER_DIGESTS.icuExecutable
      && icuDataSha256 === EMOJI_OWNERSHIP_HELPER_DIGESTS.icuData
    ),
    fixtureReproducesFreeSansOutline: !nativeApplicable || (
      (byId.get("fixture-order")?.targetPostscriptName ?? "").includes("FreeSans")
      && !isRaster("fixture-order")
      && byId.get("fixture-order")?.priorityAsked === 0
    ),
    orderMutationActivatesEmojiPriority: !nativeApplicable || (
      !isRaster("text-before-emoji")
      && isRaster("emoji-before-text")
      && isEmojiFace("emoji-before-text")
      && (byId.get("emoji-before-text")?.priorityAsked ?? 0) > 0
    ),
    explicitVs16StillColor: !nativeApplicable || (isRaster("explicit-vs16") && isEmojiFace("explicit-vs16")),
    explicitVs15StillText: !nativeApplicable || !isRaster("explicit-vs15"),
    textSymbolNegativeStillOutline: !nativeApplicable || !isRaster("text-negative"),
    cssTextNegativeStillOutline: !nativeApplicable || !isRaster("css-text-negative"),
    declaredFacePrecedesPriority: !nativeApplicable || (
      !isRaster("declared-face-precedes-priority")
      && (byId.get("declared-face-precedes-priority")?.targetPostscriptName ?? "").includes("FreeSans")
    ),
    declaredFaceCssEmojiRequeuesToColor: !nativeApplicable || (
      isRaster("declared-face-css-emoji") && isEmojiFace("declared-face-css-emoji")
    ),
  };
  const allChecksPass = Object.values(checks).every(Boolean);
  return {
    schemaVersion: 1,
    ticket: "DM-2502",
    verdict: allChecksPass
      ? (nativeApplicable ? "confirmed-missing-symbols-item-boundary" : "source-gap-confirmed-native-inapplicable")
      : "discriminator-failed",
    sourcePins: EMOJI_OWNERSHIP_SOURCE_PINS,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      glyphHelperAvailable,
      icuHelperAvailable,
      glyphHelperSha256,
      icuHelperSha256,
      icuDataSha256,
    },
    u2757,
    structural,
    routes,
    checks,
  };
}

function cliArgs(argv: string[]): { json?: string; requireLinuxArm64: boolean } {
  let json: string | undefined;
  let requireLinuxArm64 = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") json = argv[++i];
    else if (argv[i] === "--require-linux-arm64") requireLinuxArm64 = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { json, requireLinuxArm64 };
}

async function main(): Promise<void> {
  const args = cliArgs(process.argv.slice(2));
  const report = buildEmojiOwnershipAudit({ requireLinuxArm64: args.requireLinuxArm64 });
  const formatted = `${JSON.stringify(report, null, 2)}\n`;
  if (args.json != null) {
    const output = resolve(args.json);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, formatted);
  }
  process.stdout.write(formatted);
  if (report.verdict === "discriminator-failed") process.exitCode = 1;
}

const isCli = process.argv[1] != null
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) void main();
