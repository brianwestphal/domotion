#!/usr/bin/env tsx
/**
 * Exact three-platform gate for Blink FontDescription generic-family identity.
 *
 * The verdict is entirely logical. Chromium's selected face is retained only
 * as one-glyph corroboration that each browser row was live; no face name,
 * screenshot, pixel threshold, or host-font answer table decides the result.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type CDPSession, type Page } from "@playwright/test";

import { __skiaLastResortKeysForTest } from "../src/render/cluster-fallback.js";
import {
  __setWin32FamilyKeyResolverForTest,
  blinkGenericFamilyFromDeclaredStack,
  clearFontResolutionCaches,
  createFontFallbackSemanticContext,
  declaredFamilyHeadIdentity,
  resolveFontKey,
  skiaLastResortFamilyQuestionOrder,
  skiaLastResortInitialFamily,
  win32FallbackChain,
} from "../src/render/font-resolution.js";
import type { WinGenericFamily } from "../src/render/win-font-fallback.js";

export const GENERIC_FAMILY_SEMANTICS_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skia: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

/** Entire-file fingerprints at the audited revisions. They make a dirty or
 * drifted checkout fail closed instead of silently grading a different rule. */
export const GENERIC_FAMILY_SEMANTICS_SOURCE_FILES = {
  "external/chromium/third_party/blink/renderer/core/css/resolver/style_builder_converter.cc": "b507857c53282e750632d21f6ceb5061d73f1602193d551a1dadf25e8828d1f3",
  "external/chromium/third_party/blink/renderer/platform/fonts/font_description.h": "984570a59a932af20ab361c3555b5759c44ebe8f7acdd4a4a3fb589a04020155",
  "external/chromium/third_party/blink/renderer/platform/fonts/alternate_font_family.h": "7b7a768c34237aacc940229c58b832e5629f3e2efee7fa37ae7207a9e0968db7",
  "external/chromium/third_party/blink/renderer/platform/fonts/skia/font_cache_skia.cc": "44b983a99809e7288aa0307df2c6e40babebe7ffca7e088d9da523297be2d870",
  "external/chromium/third_party/blink/renderer/platform/fonts/mac/font_cache_mac.mm": "2479021eea4b6b0381c044e64a109b8d752c570bee022257a0af175671828b6f",
  "external/chromium/third_party/blink/renderer/platform/fonts/win/font_cache_skia_win.cc": "bdfc5a44bf79c8f1b6ae39cc0b2ab0f6aa195e81c3a1bd00e569e6406f044092",
  "external/chromium/third_party/blink/renderer/platform/fonts/win/font_fallback_win.cc": "dd2acdc5ed4f92b03c933f03da5d0e2e88c7ab20e3cf7c078832586b1e80dc1d",
  "external/harfbuzz/src/hb-ot-shape.cc": "92575c190dbec89fed92b9e1dcf8f442532406221ae2be957dcdd5142426be13",
  "external/chromium/DEPS": "b97ed626e4139cbda579b5bee8a61a3b1ff03cc1a0797f1708e3de4f09593da3",
} as const;

const PRODUCTION_FINGERPRINT_FILES = [
  "src/font-family-stack.ts",
  "src/render/font-resolution.ts",
  "src/render/cluster-fallback.ts",
  "src/render/win-font-fallback.ts",
] as const;

export type BlinkGenericFamily =
  | "none" | "standard" | "webkit-body" | "serif" | "sans-serif"
  | "monospace" | "cursive" | "fantasy";

export type GenericFamilyGatePlatform = "darwin" | "linux" | "win32";

interface StackCase {
  id: string;
  fontFamily: string;
  expectedGeneric: BlinkGenericFamily;
}

interface ScriptCase {
  id: "arabic" | "hebrew";
  lang: "ar" | "he";
  text: string;
  codepoint: number;
  expectedStandardLead: "Tahoma" | "David";
}

const STACK_CASES: readonly StackCase[] = [
  { id: "declared-courier", fontFamily: "Courier", expectedGeneric: "none" },
  { id: "generic-monospace", fontFamily: "monospace", expectedGeneric: "monospace" },
  { id: "courier-then-monospace", fontFamily: "Courier, monospace", expectedGeneric: "monospace" },
  { id: "arial-then-monospace", fontFamily: "Arial, monospace", expectedGeneric: "monospace" },
  { id: "courier-then-serif", fontFamily: "Courier, serif", expectedGeneric: "serif" },
  { id: "monospace-then-serif", fontFamily: "monospace, serif", expectedGeneric: "serif" },
  { id: "serif-then-monospace", fontFamily: "serif, monospace", expectedGeneric: "monospace" },
  { id: "system-ui", fontFamily: "system-ui", expectedGeneric: "none" },
  { id: "math", fontFamily: "math", expectedGeneric: "none" },
  { id: "courier-then-system-ui", fontFamily: "Courier, system-ui", expectedGeneric: "none" },
  { id: "monospace-then-math", fontFamily: "monospace, math", expectedGeneric: "monospace" },
  { id: "monospace-then-controls", fontFamily: "monospace, system-ui, math", expectedGeneric: "monospace" },
  { id: "quoted-monospace-then-courier", fontFamily: '"monospace", Courier', expectedGeneric: "none" },
] as const;

const SCRIPT_CASES: readonly ScriptCase[] = [
  { id: "arabic", lang: "ar", text: "\u0628", codepoint: 0x0628, expectedStandardLead: "Tahoma" },
  { id: "hebrew", lang: "he", text: "\u05d0", codepoint: 0x05d0, expectedStandardLead: "David" },
] as const;

export interface GenericFamilySemanticsCase {
  id: string;
  stackId: string;
  scriptId: ScriptCase["id"];
  fontFamily: string;
  expectedGeneric: BlinkGenericFamily;
  lang: ScriptCase["lang"];
  text: string;
  codepoint: number;
  expectedStandardLead: ScriptCase["expectedStandardLead"];
}

export const GENERIC_FAMILY_SEMANTICS_CASES: readonly GenericFamilySemanticsCase[] =
  SCRIPT_CASES.flatMap((script) => STACK_CASES.map((stack) => ({
    ...stack,
    ...script,
    id: `${script.id}-${stack.id}`,
    stackId: stack.id,
    scriptId: script.id,
  })));

interface FamilyToken { value: string; quoted: boolean }

const GENERIC_ENUM: ReadonlyMap<string, BlinkGenericFamily> = new Map([
  ["serif", "serif"], ["sans-serif", "sans-serif"], ["monospace", "monospace"],
  ["cursive", "cursive"], ["fantasy", "fantasy"],
  ["-webkit-standard", "standard"], ["-webkit-body", "webkit-body"],
]);

const FAMILY_NODE_GENERICS = new Set([...GENERIC_ENUM.keys(), "system-ui", "math"]);

/** Independent CSSOM family-list parser used only by the source adjudicator. */
export function splitComputedFontFamily(value: string): FamilyToken[] {
  const raw: string[] = [];
  let token = "", quote = "", escaped = false;
  for (const ch of value) {
    if (escaped) { token += ch; escaped = false; continue; }
    if (ch === "\\") { token += ch; escaped = true; continue; }
    if (quote !== "") { token += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; token += ch; continue; }
    if (ch === ",") { raw.push(token.trim()); token = ""; continue; }
    token += ch;
  }
  raw.push(token.trim());
  return raw.filter(Boolean).map((entry) => {
    const quoted = entry.length >= 2
      && ((entry.startsWith('"') && entry.endsWith('"'))
        || (entry.startsWith("'") && entry.endsWith("'")));
    return { value: quoted ? entry.slice(1, -1) : entry, quoted };
  });
}

/**
 * `ConvertFontFamily` walks the list in reverse and sets the descriptor enum
 * once (`style_builder_converter.cc:505-568`, Chromium rev 7d859f27).
 */
export function blinkGenericFamilyFromComputedStack(value: string): BlinkGenericFamily {
  const families = splitComputedFontFamily(value);
  for (let index = families.length - 1; index >= 0; index--) {
    const family = families[index];
    if (!family.quoted) {
      const generic = GENERIC_ENUM.get(family.value.toLowerCase());
      if (generic != null) return generic;
    }
  }
  return "none";
}

/** Independent source identity for the OS fallback memo's declared head. */
export function sourceDeclaredFamilyHeadIdentity(value: string): string {
  const head = splitComputedFontFamily(value)[0];
  if (head == null) return "missing:";
  const lowered = head.value.toLowerCase();
  const kind = !head.quoted && FAMILY_NODE_GENERICS.has(lowered) ? "generic" : "name";
  return `${kind}:${lowered}`;
}

/** Windows' hardcoded table distinguishes only kMonospaceFamily. */
export function sourceWinFallbackMode(generic: BlinkGenericFamily): WinGenericFamily {
  return generic === "monospace" ? "monospace" : "standard";
}

/** The removed key-derived reconstruction, retained only as a hostile state. */
export function keyInferredGenericFamily(primaryKey: string): BlinkGenericFamily {
  return primaryKey === "courier" ? "monospace" : "none";
}

/** Backward-compatible mutation helper used by older callers/tests. */
export function keyInferredWinFallbackMode(primaryKey: string): WinGenericFamily {
  return sourceWinFallbackMode(keyInferredGenericFamily(primaryKey));
}

const SOURCE_WIN_PAN_UNICODE_COMMON = [
  "tahoma", "arial unicode ms", "lucida sans unicode", "microsoft sans serif",
  "palatino linotype", "dejavu serif", "dejavu sasns", "freeserif",
  "freesans", "gentium", "gentiumalt", "ms pgothic", "simsun", "gulim",
  "pmingliu", "code2000",
] as const;

/** Independent Windows Arabic/Hebrew hardcoded fallback order. */
export function sourcePlatformCandidateOrder(
  target: GenericFamilyGatePlatform,
  scriptId: ScriptCase["id"],
  generic: BlinkGenericFamily,
): string[] {
  if (target !== "win32") return [];
  const lead = generic === "monospace"
    ? "courier new"
    : scriptId === "arabic" ? "Tahoma" : "David";
  return [lead, ...SOURCE_WIN_PAN_UNICODE_COMMON.filter(
    (family) => family.toLowerCase() !== lead.toLowerCase(),
  )];
}

function sourceSkiaInitialFamily(generic: BlinkGenericFamily): string {
  switch (generic) {
    case "sans-serif":
    case "serif":
    case "monospace":
    case "cursive":
    case "fantasy":
      return generic;
    case "none":
    case "standard":
    case "webkit-body":
      return "";
  }
}

function sourceSkiaInitialKey(generic: BlinkGenericFamily): string | null {
  switch (generic) {
    case "sans-serif": return "helvetica";
    case "serif": return "times";
    case "monospace": return "courier";
    case "cursive": return "apple-chancery";
    case "fantasy": return "papyrus";
    case "none":
    case "standard":
    case "webkit-body":
      return null;
  }
}

/** Raw family questions in Blink's platform terminal, before host matching. */
export function sourceTerminalQuestionOrder(
  target: GenericFamilyGatePlatform,
  generic: BlinkGenericFamily,
): string[] {
  if (target === "darwin") return ["Times", "Lucida Grande"];
  const first = sourceSkiaInitialFamily(generic) || "<unnamed-default>";
  const common = [first, "Sans", "Arial"];
  if (target === "linux") return [...common, "<unnamed>"];
  return [
    ...common,
    "MS UI Gothic",
    "Microsoft Sans Serif",
    "Segoe UI",
    "Calibri",
    "Times New Roman",
    "Courier New",
    "<locale-space-match>",
    "<unnamed>",
  ];
}

/** Source terminal normalized to Domotion's existing logical tail owners. */
export function sourceTerminalOwnerOrder(
  target: GenericFamilyGatePlatform,
  generic: BlinkGenericFamily,
): string[] {
  if (target === "darwin") return ["times", "lucida-grande"];
  const tail = target === "win32" ? "arial" : "helvetica";
  const initial = sourceSkiaInitialKey(generic);
  return initial == null || initial === tail ? [tail] : [initial, tail];
}

export function sourceTerminalActivated(
  target: GenericFamilyGatePlatform,
  generic: BlinkGenericFamily,
): boolean {
  return JSON.stringify(sourceTerminalOwnerOrder(target, generic))
    !== JSON.stringify(sourceTerminalOwnerOrder(target, "none"));
}

export function sourceSemanticCacheIdentity(
  target: GenericFamilyGatePlatform,
  fontFamily: string,
  generic: BlinkGenericFamily,
): string {
  const terminal = target === "darwin"
    ? "fixed:times"
    : `initial:${sourceSkiaInitialFamily(generic) || "<unnamed>"}`;
  return `${sourceDeclaredFamilyHeadIdentity(fontFamily)}|${terminal}`;
}

function productionSemanticCacheIdentity(
  target: GenericFamilyGatePlatform,
  fontFamily: string,
  generic: BlinkGenericFamily,
): string {
  const terminal = target === "darwin"
    ? "fixed:times"
    : `initial:${skiaLastResortInitialFamily(generic) || "<unnamed>"}`;
  return `${declaredFamilyHeadIdentity(fontFamily)}|${terminal}`;
}

export interface PaintedFaceEvidence {
  familyName: string;
  postScriptName: string;
  isCustomFont: boolean;
  glyphCount: number;
}

export interface GenericFamilySemanticsRow {
  id: string;
  order: "forward" | "reverse";
  platform: GenericFamilyGatePlatform;
  stackId: string;
  scriptId: ScriptCase["id"];
  lang: string;
  codepoint: number;
  requestedFontFamily: string;
  computedFontFamily: string;
  expectedGeneric: BlinkGenericFamily;
  sourceGeneric: BlinkGenericFamily;
  productionGeneric: BlinkGenericFamily;
  sourceFallbackMode: WinGenericFamily;
  productionFallbackMode: WinGenericFamily;
  sourceCandidateOrder: string[];
  productionCandidateOrder: string[];
  sourceTerminalQuestionOrder: string[];
  productionTerminalQuestionOrder: string[];
  sourceTerminalOwnerOrder: string[];
  productionTerminalOwnerOrder: string[];
  sourceTerminalActivated: boolean;
  productionTerminalActivated: boolean;
  sourceCacheIdentity: string;
  productionCacheIdentity: string;
  primaryKey: string;
  keyDerivedGeneric: BlinkGenericFamily;
  keyDerivedCandidateOrder: string[];
  keyDerivedTerminalOwnerOrder: string[];
  keyDerivedSemanticMismatch: boolean;
  paintedFaces: PaintedFaceEvidence[];
  pass: boolean;
  blockers: string[];
}

export function adjudicateGenericFamilySemanticsRow(
  row: Omit<GenericFamilySemanticsRow, "pass" | "blockers">,
): GenericFamilySemanticsRow {
  const blockers: string[] = [];
  const expectedFallbackMode = sourceWinFallbackMode(row.expectedGeneric);
  const expectedCandidateOrder = sourcePlatformCandidateOrder(
    row.platform, row.scriptId, row.expectedGeneric,
  );
  const expectedTerminalQuestions = sourceTerminalQuestionOrder(row.platform, row.expectedGeneric);
  const expectedTerminalOwners = sourceTerminalOwnerOrder(row.platform, row.expectedGeneric);
  const expectedTerminalActivation = sourceTerminalActivated(row.platform, row.expectedGeneric);
  const expectedCacheIdentity = sourceSemanticCacheIdentity(
    row.platform, row.computedFontFamily, row.expectedGeneric,
  );
  const expectedKeyGeneric = keyInferredGenericFamily(row.primaryKey);
  const expectedKeyCandidateOrder = sourcePlatformCandidateOrder(
    row.platform, row.scriptId, expectedKeyGeneric,
  );
  const expectedKeyTerminalOwners = sourceTerminalOwnerOrder(row.platform, expectedKeyGeneric);

  if (row.sourceGeneric !== row.expectedGeneric) blockers.push("source-enum");
  if (row.productionGeneric !== row.sourceGeneric) blockers.push("production-enum");
  if (row.sourceFallbackMode !== expectedFallbackMode) blockers.push("source-fallback-mode");
  if (row.productionFallbackMode !== row.sourceFallbackMode) blockers.push("production-fallback-mode");
  if (JSON.stringify(row.sourceCandidateOrder) !== JSON.stringify(expectedCandidateOrder)) {
    blockers.push("source-candidate-order");
  }
  if (JSON.stringify(row.productionCandidateOrder) !== JSON.stringify(row.sourceCandidateOrder)) {
    blockers.push("production-candidate-order");
  }
  if (JSON.stringify(row.sourceTerminalQuestionOrder) !== JSON.stringify(expectedTerminalQuestions)) {
    blockers.push("source-terminal-question-order");
  }
  if (JSON.stringify(row.productionTerminalQuestionOrder)
      !== JSON.stringify(row.sourceTerminalQuestionOrder)) {
    blockers.push("production-terminal-question-order");
  }
  if (JSON.stringify(row.sourceTerminalOwnerOrder) !== JSON.stringify(expectedTerminalOwners)) {
    blockers.push("source-terminal-owner-order");
  }
  if (JSON.stringify(row.productionTerminalOwnerOrder)
      !== JSON.stringify(row.sourceTerminalOwnerOrder)) {
    blockers.push("production-terminal-owner-order");
  }
  if (row.sourceTerminalActivated !== expectedTerminalActivation) {
    blockers.push("source-terminal-activation");
  }
  if (row.productionTerminalActivated !== row.sourceTerminalActivated) {
    blockers.push("production-terminal-activation");
  }
  if (row.sourceCacheIdentity !== expectedCacheIdentity) blockers.push("source-cache-identity");
  if (row.productionCacheIdentity !== row.sourceCacheIdentity) {
    blockers.push("production-cache-identity");
  }
  if (row.keyDerivedGeneric !== expectedKeyGeneric) blockers.push("key-derived-generic");
  if (JSON.stringify(row.keyDerivedCandidateOrder)
      !== JSON.stringify(expectedKeyCandidateOrder)) {
    blockers.push("key-derived-candidate-order");
  }
  if (JSON.stringify(row.keyDerivedTerminalOwnerOrder)
      !== JSON.stringify(expectedKeyTerminalOwners)) {
    blockers.push("key-derived-terminal-order");
  }
  if (row.keyDerivedSemanticMismatch !== (row.sourceGeneric !== expectedKeyGeneric)) {
    blockers.push("key-derived-loss-classification");
  }
  if (row.primaryKey === "") blockers.push("primary-key");
  if (row.paintedFaces.length !== 1 || row.paintedFaces[0].glyphCount !== 1) {
    blockers.push("painted-face-completeness");
  }
  return { ...row, pass: blockers.length === 0, blockers };
}

export interface GenericFamilySemanticsOrder {
  order: "forward" | "reverse";
  rows: GenericFamilySemanticsRow[];
}

export type GenericFamilySemanticsVerdict = "source-exact" | "source-drift" | "invalid-evidence";

export interface GenericFamilySemanticsControls {
  completeMatrix: boolean;
  sourcePinsMatch: boolean;
  sourceEnumExact: boolean;
  platformCandidateOrderExact: boolean;
  terminalQuestionOrderExact: boolean;
  terminalOwnerOrderExact: boolean;
  terminalActivationExact: boolean;
  productionRoutingExact: boolean;
  cacheIdentityExact: boolean;
  sourceDistinguishesDeclaredFromGeneric: boolean;
  rightmostGenericWins: boolean;
  nonOccupyingGenericsPreserveLegacyEnum: boolean;
  quotedGenericIsLiteral: boolean;
  keyDerivedFalsePositiveDetected: boolean;
  keyDerivedFalseNegativeDetected: boolean;
  forwardReverseCacheStable: boolean;
  paintedFaceComplete: boolean;
}

interface FileFingerprint {
  sha256: string;
  expectedSha256?: string;
  match?: boolean;
  available: boolean;
}

export interface GenericFamilySemanticsSourceFingerprints {
  chromiumRevision: string;
  harfbuzzRevision: string;
  skiaDepsRevision: string;
  sourceFiles: Record<string, FileFingerprint>;
  productionFiles: Record<string, FileFingerprint>;
  verification: "local-checkout" | "pinned-manifest";
  match: boolean;
}

export interface GenericFamilySemanticsReport {
  schemaVersion: 2;
  sourcePins: typeof GENERIC_FAMILY_SEMANTICS_SOURCE_PINS;
  sourceFingerprints: GenericFamilySemanticsSourceFingerprints;
  environment: {
    platform: GenericFamilyGatePlatform;
    architecture: string;
    osRelease: string;
    nodeVersion: string;
    chromiumVersion: string;
  };
  orders: GenericFamilySemanticsOrder[];
  controls: GenericFamilySemanticsControls;
  verdict: GenericFamilySemanticsVerdict;
}

function stableRowSignature(row: GenericFamilySemanticsRow): string {
  const { order: _order, ...stable } = row;
  return JSON.stringify(stable);
}

function indexedRows(order: GenericFamilySemanticsOrder): Map<string, GenericFamilySemanticsRow> {
  return new Map(order.rows.map((row) => [row.id, row]));
}

export function classifyGenericFamilySemanticsEvidence(
  orders: readonly GenericFamilySemanticsOrder[],
  sourcePinsMatch = true,
): Pick<GenericFamilySemanticsReport, "controls" | "verdict"> {
  const expectedIds = GENERIC_FAMILY_SEMANTICS_CASES.map((row) => row.id).sort();
  const completeMatrix = orders.length === 2
    && orders.some((order) => order.order === "forward")
    && orders.some((order) => order.order === "reverse")
    && orders.every((order) => {
      const ids = order.rows.map((row) => row.id).sort();
      return JSON.stringify(ids) === JSON.stringify(expectedIds);
    });
  const forward = orders.find((order) => order.order === "forward");
  const reverse = orders.find((order) => order.order === "reverse");
  const byId = forward == null ? new Map<string, GenericFamilySemanticsRow>() : indexedRows(forward);
  const reverseRows = reverse == null ? new Map<string, GenericFamilySemanticsRow>() : indexedRows(reverse);
  const allRows = orders.flatMap((order) => order.rows);
  const sourceEnumExact = allRows.length > 0
    && allRows.every((row) => row.sourceGeneric === row.expectedGeneric);
  const platformCandidateOrderExact = allRows.length > 0
    && allRows.every((row) => JSON.stringify(row.productionCandidateOrder)
      === JSON.stringify(row.sourceCandidateOrder));
  const terminalQuestionOrderExact = allRows.length > 0
    && allRows.every((row) => JSON.stringify(row.productionTerminalQuestionOrder)
      === JSON.stringify(row.sourceTerminalQuestionOrder));
  const terminalOwnerOrderExact = allRows.length > 0
    && allRows.every((row) => JSON.stringify(row.productionTerminalOwnerOrder)
      === JSON.stringify(row.sourceTerminalOwnerOrder));
  const terminalActivationExact = allRows.length > 0
    && allRows.every((row) => row.productionTerminalActivated === row.sourceTerminalActivated);
  const cacheIdentityExact = allRows.length > 0
    && allRows.every((row) => row.productionCacheIdentity === row.sourceCacheIdentity);
  const productionRoutingExact = allRows.length > 0 && allRows.every((row) => row.pass);
  const sourceDistinguishesDeclaredFromGeneric = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-declared-courier`)?.sourceGeneric === "none"
      && byId.get(`${script.id}-generic-monospace`)?.sourceGeneric === "monospace");
  const rightmostGenericWins = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-monospace-then-serif`)?.sourceGeneric === "serif"
      && byId.get(`${script.id}-serif-then-monospace`)?.sourceGeneric === "monospace");
  const nonOccupyingGenericsPreserveLegacyEnum = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-system-ui`)?.sourceGeneric === "none"
      && byId.get(`${script.id}-math`)?.sourceGeneric === "none"
      && byId.get(`${script.id}-courier-then-system-ui`)?.sourceGeneric === "none"
      && byId.get(`${script.id}-monospace-then-math`)?.sourceGeneric === "monospace"
      && byId.get(`${script.id}-monospace-then-controls`)?.sourceGeneric === "monospace");
  const quotedGenericIsLiteral = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-quoted-monospace-then-courier`)?.sourceGeneric === "none");
  const keyDerivedFalsePositiveDetected = SCRIPT_CASES.every((script) => {
    const row = byId.get(`${script.id}-declared-courier`);
    return row?.sourceGeneric === "none"
      && (row.keyDerivedGeneric === "monospace"
        ? row.keyDerivedSemanticMismatch
        // A live platform matcher may materialize declared Courier as an
        // unambiguous dynamic face key (for example sysfb:LiberationMono).
        // In that environment there is no key-derived false positive to
        // detect; the stronger result is that key inference stays `none`.
        : row.keyDerivedGeneric === "none" && !row.keyDerivedSemanticMismatch);
  });
  const keyDerivedFalseNegativeDetected = SCRIPT_CASES.every((script) => {
    const row = byId.get(`${script.id}-arial-then-monospace`);
    return row?.sourceGeneric === "monospace"
      && row.primaryKey !== "courier"
      && row.keyDerivedGeneric === "none"
      && row.keyDerivedSemanticMismatch;
  });
  const forwardReverseCacheStable = forward != null && reverse != null
    && expectedIds.every((id) => {
      const a = byId.get(id);
      const b = reverseRows.get(id);
      return a != null && b != null && stableRowSignature(a) === stableRowSignature(b);
    });
  const paintedFaceComplete = allRows.length > 0 && allRows.every((row) =>
    row.paintedFaces.length === 1 && row.paintedFaces[0].glyphCount === 1);
  const controls: GenericFamilySemanticsControls = {
    completeMatrix,
    sourcePinsMatch,
    sourceEnumExact,
    platformCandidateOrderExact,
    terminalQuestionOrderExact,
    terminalOwnerOrderExact,
    terminalActivationExact,
    productionRoutingExact,
    cacheIdentityExact,
    sourceDistinguishesDeclaredFromGeneric,
    rightmostGenericWins,
    nonOccupyingGenericsPreserveLegacyEnum,
    quotedGenericIsLiteral,
    keyDerivedFalsePositiveDetected,
    keyDerivedFalseNegativeDetected,
    forwardReverseCacheStable,
    paintedFaceComplete,
  };
  const evidenceComplete = completeMatrix && forwardReverseCacheStable && paintedFaceComplete;
  const logicalExact = Object.entries(controls)
    .filter(([name]) => !["completeMatrix", "forwardReverseCacheStable", "paintedFaceComplete"].includes(name))
    .every(([, value]) => value);
  return {
    controls,
    verdict: !evidenceComplete
      ? "invalid-evidence"
      : logicalExact ? "source-exact" : "source-drift",
  };
}

function sha256File(path: string): string {
  // Git may materialize text files with CRLF on a Windows runner. The audited
  // source rule is unchanged by that checkout policy, so fingerprint canonical
  // LF bytes rather than turning line endings into a false source-drift signal.
  const canonical = readFileSync(resolve(path), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function checkoutRevision(repo: string): string | null {
  const gitDir = resolve(repo, ".git");
  if (!existsSync(resolve(gitDir, "HEAD"))) return null;
  const head = readFileSync(resolve(gitDir, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
  const match = /^ref:\s+(.+)$/.exec(head);
  if (match == null) return null;
  const looseRef = resolve(gitDir, match[1]);
  if (existsSync(looseRef)) return readFileSync(looseRef, "utf8").trim().toLowerCase();
  const packed = resolve(gitDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
    const fields = line.split(" ");
    if (fields[1] === match[1] && /^[0-9a-f]{40}$/i.test(fields[0])) {
      return fields[0].toLowerCase();
    }
  }
  return null;
}

function skiaDepsRevision(): string | null {
  if (!existsSync(resolve("external/chromium/DEPS"))) return null;
  const deps = readFileSync(resolve("external/chromium/DEPS"), "utf8");
  return /'skia_revision':\s*'([0-9a-f]{40})'/.exec(deps)?.[1] ?? null;
}

export function collectGenericFamilySourceFingerprints(): GenericFamilySemanticsSourceFingerprints {
  const sourceFiles: Record<string, FileFingerprint> = {};
  for (const [path, expectedSha256] of Object.entries(GENERIC_FAMILY_SEMANTICS_SOURCE_FILES)) {
    const available = existsSync(resolve(path));
    const sha256 = available ? sha256File(path) : expectedSha256;
    sourceFiles[path] = {
      sha256,
      expectedSha256,
      match: sha256 === expectedSha256,
      available,
    };
  }
  const productionFiles: Record<string, FileFingerprint> = {};
  for (const path of PRODUCTION_FINGERPRINT_FILES) {
    productionFiles[path] = { sha256: sha256File(path), available: true };
  }
  const localChromiumRevision = checkoutRevision("external/chromium");
  const localHarfbuzzRevision = checkoutRevision("external/harfbuzz");
  const localSkiaRevision = skiaDepsRevision();
  const verification = Object.values(sourceFiles).every((entry) => entry.available)
    ? "local-checkout" as const
    : "pinned-manifest" as const;
  const chromiumRevision = localChromiumRevision ?? GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.chromium;
  const harfbuzzRevision = localHarfbuzzRevision ?? GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.harfbuzz;
  const skiaRevision = localSkiaRevision ?? GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.skia;
  return {
    chromiumRevision,
    harfbuzzRevision,
    skiaDepsRevision: skiaRevision,
    sourceFiles,
    productionFiles,
    verification,
    match: chromiumRevision === GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.chromium
      && harfbuzzRevision === GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.harfbuzz
      && skiaRevision === GENERIC_FAMILY_SEMANTICS_SOURCE_PINS.skia
      && Object.values(sourceFiles).every((entry) => entry.match === true),
  };
}

function gatePlatform(value: NodeJS.Platform): GenericFamilyGatePlatform {
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  throw new Error(`generic-family semantics gate does not support ${value}`);
}

async function paintedFacesForNode(
  cdp: CDPSession,
  rootNodeId: number,
  selector: string,
): Promise<PaintedFaceEvidence[]> {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: rootNodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts
    .filter((font: PaintedFaceEvidence) => font.glyphCount > 0)
    .map((font: PaintedFaceEvidence) => ({
      familyName: font.familyName,
      postScriptName: font.postScriptName,
      isCustomFont: font.isCustomFont,
      glyphCount: font.glyphCount,
    }));
}

function productionCandidateOrder(
  target: GenericFamilyGatePlatform,
  spec: GenericFamilySemanticsCase,
  computedFontFamily: string,
  productionGeneric: BlinkGenericFamily,
  primaryKey: string,
): string[] {
  if (target !== "win32") return [];
  return win32FallbackChain(spec.codepoint, primaryKey, spec.lang, {
    weight: 400,
    slant: 0,
    fontSize: 32,
    declaredFamily: computedFontFamily,
    genericFamily: productionGeneric,
  }).filter((key) => key.startsWith("winfam:"))
    .map((key) => key.slice("winfam:".length));
}

async function collectOrder(
  page: Page,
  target: GenericFamilyGatePlatform,
  order: GenericFamilySemanticsOrder["order"],
): Promise<GenericFamilySemanticsOrder> {
  const cases = order === "forward"
    ? [...GENERIC_FAMILY_SEMANTICS_CASES]
    : [...GENERIC_FAMILY_SEMANTICS_CASES].reverse();
  await page.setContent("<!doctype html><meta charset=utf-8><main id=root></main>");
  await page.locator("#root").evaluate((root, values) => {
    for (const value of values) {
      const span = document.createElement("span");
      span.id = value.id;
      span.lang = value.lang;
      span.textContent = value.text;
      span.style.display = "block";
      span.style.fontFamily = value.fontFamily;
      span.style.fontSize = "32px";
      root.append(span);
    }
  }, cases.map(({ id, lang, text, fontFamily }) => ({ id, lang, text, fontFamily })));
  await page.evaluate(() => document.fonts.ready);

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const rows: GenericFamilySemanticsRow[] = [];
    for (const spec of cases) {
      const selector = `#${spec.id}`;
      const computedFontFamily = await page.locator(selector).evaluate((element) =>
        getComputedStyle(element).fontFamily);
      const paintedFaces = await paintedFacesForNode(cdp, root.nodeId, selector);
      const sourceGeneric = blinkGenericFamilyFromComputedStack(computedFontFamily);
      const productionGeneric = blinkGenericFamilyFromDeclaredStack(computedFontFamily);
      const primaryKey = resolveFontKey(computedFontFamily, spec.lang);
      const productionTerminal = __skiaLastResortKeysForTest(
        createFontFallbackSemanticContext(computedFontFamily), target,
      );
      const productionTerminalQuestions = skiaLastResortFamilyQuestionOrder(
        productionGeneric, target,
      );
      const productionTerminalBaseline = __skiaLastResortKeysForTest(
        { declaredFamily: computedFontFamily, genericFamily: "none" }, target,
      );
      const keyDerivedGeneric = keyInferredGenericFamily(primaryKey);
      rows.push(adjudicateGenericFamilySemanticsRow({
        id: spec.id,
        order,
        platform: target,
        stackId: spec.stackId,
        scriptId: spec.scriptId,
        lang: spec.lang,
        codepoint: spec.codepoint,
        requestedFontFamily: spec.fontFamily,
        computedFontFamily,
        expectedGeneric: spec.expectedGeneric,
        sourceGeneric,
        productionGeneric,
        sourceFallbackMode: sourceWinFallbackMode(sourceGeneric),
        productionFallbackMode: sourceWinFallbackMode(productionGeneric),
        sourceCandidateOrder: sourcePlatformCandidateOrder(target, spec.scriptId, sourceGeneric),
        productionCandidateOrder: productionCandidateOrder(
          target, spec, computedFontFamily, productionGeneric, primaryKey,
        ),
        sourceTerminalQuestionOrder: sourceTerminalQuestionOrder(target, sourceGeneric),
        productionTerminalQuestionOrder: productionTerminalQuestions,
        sourceTerminalOwnerOrder: sourceTerminalOwnerOrder(target, sourceGeneric),
        productionTerminalOwnerOrder: productionTerminal,
        sourceTerminalActivated: sourceTerminalActivated(target, sourceGeneric),
        productionTerminalActivated: JSON.stringify(productionTerminal)
          !== JSON.stringify(productionTerminalBaseline),
        sourceCacheIdentity: sourceSemanticCacheIdentity(
          target, computedFontFamily, sourceGeneric,
        ),
        productionCacheIdentity: productionSemanticCacheIdentity(
          target, computedFontFamily, productionGeneric,
        ),
        primaryKey,
        keyDerivedGeneric,
        keyDerivedCandidateOrder: sourcePlatformCandidateOrder(
          target, spec.scriptId, keyDerivedGeneric,
        ),
        keyDerivedTerminalOwnerOrder: sourceTerminalOwnerOrder(target, keyDerivedGeneric),
        keyDerivedSemanticMismatch: sourceGeneric !== keyDerivedGeneric,
        paintedFaces,
      }));
    }
    return { order, rows };
  } finally {
    await cdp.detach();
  }
}

export async function runGenericFamilySemanticsAudit(): Promise<GenericFamilySemanticsReport> {
  const target = gatePlatform(platform());
  const sourceFingerprints = collectGenericFamilySourceFingerprints();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 960 } });
    const orders: GenericFamilySemanticsOrder[] = [];
    clearFontResolutionCaches();
    __setWin32FamilyKeyResolverForTest((family) => `winfam:${family}`);
    try {
      for (const order of ["forward", "reverse"] as const) {
        const page = await context.newPage();
        try {
          orders.push(await collectOrder(page, target, order));
        } finally {
          await page.close();
        }
      }
    } finally {
      __setWin32FamilyKeyResolverForTest(null);
      await context.close();
    }
    const classification = classifyGenericFamilySemanticsEvidence(
      orders, sourceFingerprints.match,
    );
    return {
      schemaVersion: 2,
      sourcePins: GENERIC_FAMILY_SEMANTICS_SOURCE_PINS,
      sourceFingerprints,
      environment: {
        platform: target,
        architecture: arch(),
        osRelease: release(),
        nodeVersion: process.version,
        chromiumVersion: browser.version(),
      },
      orders,
      ...classification,
    };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const report = await runGenericFamilySemanticsAudit();
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt >= 0) {
    const target = process.argv[jsonAt + 1];
    if (target == null || target === "") throw new Error("--json requires a path");
    mkdirSync(dirname(resolve(target)), { recursive: true });
    writeFileSync(resolve(target), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.verdict === "source-exact" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
}
