#!/usr/bin/env tsx
/**
 * Investigation-only oracle for Blink FontDescription generic-family identity.
 *
 * The browser's selected face is useful corroboration, but the verdict is
 * logical: Blink stores the CSS generic separately from the concrete family
 * name and passes that enum into Windows' hardcoded fallback stage. Domotion's
 * current adapter reconstructs it from a resolved key. No pixels, tolerances,
 * or renderer constants participate in this audit.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type CDPSession, type Page } from "@playwright/test";

import {
  clearFontResolutionCaches,
  resolveFontKey,
} from "../src/render/font-resolution.js";
import {
  blinkWinHardcodedFamilies,
  type WinGenericFamily,
} from "../src/render/win-font-fallback.js";

export const GENERIC_FAMILY_SEMANTICS_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  harfbuzz: "4de187dd0a915d13c976fa8bd474c084229f3aab",
  skia: "62efacd37737505732dbe3d8daa62abd679626a1",
} as const;

export type BlinkGenericFamily =
  | "none"
  | "standard"
  | "webkit-body"
  | "serif"
  | "sans-serif"
  | "monospace"
  | "cursive"
  | "fantasy";

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
  { id: "courier-then-system-ui", fontFamily: "Courier, system-ui", expectedGeneric: "none" },
  { id: "monospace-then-math", fontFamily: "monospace, math", expectedGeneric: "monospace" },
  { id: "quoted-monospace-then-courier", fontFamily: '\"monospace\", Courier', expectedGeneric: "none" },
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

const GENERIC_ENUM: ReadonlyMap<string, BlinkGenericFamily> = new Map([
  ["serif", "serif"],
  ["sans-serif", "sans-serif"],
  ["monospace", "monospace"],
  ["cursive", "cursive"],
  ["fantasy", "fantasy"],
  ["-webkit-standard", "standard"],
  ["-webkit-body", "webkit-body"],
]);

interface FamilyToken { value: string; quoted: boolean }

/** Split the small CSSOM font-family grammar needed by this audit. */
export function splitComputedFontFamily(value: string): FamilyToken[] {
  const raw: string[] = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const ch of value) {
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      token += ch;
      escaped = true;
      continue;
    }
    if (quote !== "") {
      token += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (ch === ",") {
      raw.push(token.trim());
      token = "";
      continue;
    }
    token += ch;
  }
  raw.push(token.trim());
  return raw.filter((entry) => entry !== "").map((entry) => {
    const quoted = entry.length >= 2
      && ((entry.startsWith('"') && entry.endsWith('"'))
        || (entry.startsWith("'") && entry.endsWith("'")));
    return { value: quoted ? entry.slice(1, -1) : entry, quoted };
  });
}

/**
 * Blink iterates the CSS family list in reverse and records the first generic
 * enum it encounters. That is the rightmost enum-bearing generic, not the
 * family that happened to resolve first. Named families and quoted generic
 * spellings contribute no enum.
 */
export function blinkGenericFamilyFromComputedStack(value: string): BlinkGenericFamily {
  const families = splitComputedFontFamily(value);
  for (let index = families.length - 1; index >= 0; index--) {
    const family = families[index];
    if (family.quoted) continue;
    const generic = GENERIC_ENUM.get(family.value.toLowerCase());
    if (generic != null) return generic;
  }
  return "none";
}

/** Windows' hardcoded table distinguishes only kMonospaceFamily. */
export function sourceWinFallbackMode(generic: BlinkGenericFamily): WinGenericFamily {
  return generic === "monospace" ? "monospace" : "standard";
}

/** Snapshot of the current production reconstruction at font-resolution.ts. */
export function keyInferredWinFallbackMode(primaryKey: string): WinGenericFamily {
  return primaryKey === "courier" ? "monospace" : "standard";
}

function candidateOrder(codepoint: number, generic: WinGenericFamily): string[] {
  return blinkWinHardcodedFamilies(
    codepoint,
    { generic, priority: "text" },
    () => true,
  );
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
  stackId: string;
  scriptId: ScriptCase["id"];
  lang: string;
  codepoint: number;
  requestedFontFamily: string;
  computedFontFamily: string;
  expectedGeneric: BlinkGenericFamily;
  sourceGeneric: BlinkGenericFamily;
  sourceFallbackMode: WinGenericFamily;
  primaryKey: string;
  keyInferredFallbackMode: WinGenericFamily;
  sourceCandidateOrder: string[];
  keyInferredCandidateOrder: string[];
  semanticLoss: boolean;
  paintedFaces: PaintedFaceEvidence[];
  pass: boolean;
  blockers: string[];
}

export function adjudicateGenericFamilySemanticsRow(
  row: Omit<GenericFamilySemanticsRow, "pass" | "blockers">,
): GenericFamilySemanticsRow {
  const blockers: string[] = [];
  const expectedMode = sourceWinFallbackMode(row.expectedGeneric);
  const expectedLead = row.scriptId === "arabic" ? "Tahoma" : "David";
  if (row.sourceGeneric !== row.expectedGeneric) blockers.push("generic-enum");
  if (row.sourceFallbackMode !== expectedMode) blockers.push("fallback-mode");
  if (row.sourceCandidateOrder[0] !== (expectedMode === "monospace" ? "courier new" : expectedLead)) {
    blockers.push("source-candidate-order");
  }
  if (row.keyInferredCandidateOrder[0]
      !== (row.keyInferredFallbackMode === "monospace" ? "courier new" : expectedLead)) {
    blockers.push("key-candidate-order");
  }
  if (row.semanticLoss !== (row.sourceFallbackMode !== row.keyInferredFallbackMode)) {
    blockers.push("loss-classification");
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

export type GenericFamilySemanticsVerdict =
  | "confirmed-information-loss"
  | "source-drift"
  | "invalid-evidence";

export interface GenericFamilySemanticsReport {
  schemaVersion: 1;
  sourcePins: typeof GENERIC_FAMILY_SEMANTICS_SOURCE_PINS;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    osRelease: string;
    chromiumVersion: string;
  };
  legacySeam: { present: boolean; sha256: string | null };
  orders: GenericFamilySemanticsOrder[];
  controls: {
    completeMatrix: boolean;
    sourceDistinguishesDeclaredFromGeneric: boolean;
    rightmostGenericWins: boolean;
    nonOccupyingGenericsPreserveLegacyEnum: boolean;
    quotedGenericIsLiteral: boolean;
    currentRoutingLosesDeclaredCourier: boolean;
    currentRoutingLosesNonCourierMonospace: boolean;
    forwardReverseStable: boolean;
  };
  verdict: GenericFamilySemanticsVerdict;
}

function stableRowSignature(row: GenericFamilySemanticsRow): string {
  return JSON.stringify({
    id: row.id,
    computedFontFamily: row.computedFontFamily,
    sourceGeneric: row.sourceGeneric,
    sourceFallbackMode: row.sourceFallbackMode,
    primaryKey: row.primaryKey,
    keyInferredFallbackMode: row.keyInferredFallbackMode,
    sourceCandidateOrder: row.sourceCandidateOrder,
    keyInferredCandidateOrder: row.keyInferredCandidateOrder,
    semanticLoss: row.semanticLoss,
    paintedFaces: row.paintedFaces,
    pass: row.pass,
    blockers: row.blockers,
  });
}

function indexedRows(order: GenericFamilySemanticsOrder): Map<string, GenericFamilySemanticsRow> {
  return new Map(order.rows.map((row) => [row.id, row]));
}

export function classifyGenericFamilySemanticsEvidence(
  orders: readonly GenericFamilySemanticsOrder[],
  legacySeamPresent: boolean,
): Pick<GenericFamilySemanticsReport, "controls" | "verdict"> {
  const expectedIds = GENERIC_FAMILY_SEMANTICS_CASES.map((row) => row.id).sort();
  const completeMatrix = orders.length === 2
    && orders.some((order) => order.order === "forward")
    && orders.some((order) => order.order === "reverse")
    && orders.every((order) => {
      const ids = order.rows.map((row) => row.id).sort();
      return JSON.stringify(ids) === JSON.stringify(expectedIds)
        && order.rows.every((row) => row.pass);
    });
  const forward = orders.find((order) => order.order === "forward");
  const reverse = orders.find((order) => order.order === "reverse");
  const byId = forward == null ? new Map<string, GenericFamilySemanticsRow>() : indexedRows(forward);
  const sourceDistinguishesDeclaredFromGeneric = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-declared-courier`)?.sourceFallbackMode === "standard"
      && byId.get(`${script.id}-generic-monospace`)?.sourceFallbackMode === "monospace");
  const rightmostGenericWins = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-monospace-then-serif`)?.sourceGeneric === "serif"
      && byId.get(`${script.id}-serif-then-monospace`)?.sourceGeneric === "monospace");
  const nonOccupyingGenericsPreserveLegacyEnum = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-courier-then-system-ui`)?.sourceGeneric === "none"
      && byId.get(`${script.id}-monospace-then-math`)?.sourceGeneric === "monospace");
  const quotedGenericIsLiteral = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-quoted-monospace-then-courier`)?.sourceGeneric === "none");
  const currentRoutingLosesDeclaredCourier = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-declared-courier`)?.semanticLoss === true);
  const currentRoutingLosesNonCourierMonospace = SCRIPT_CASES.every((script) =>
    byId.get(`${script.id}-arial-then-monospace`)?.semanticLoss === true);
  const reverseRows = reverse == null ? new Map<string, GenericFamilySemanticsRow>() : indexedRows(reverse);
  const forwardReverseStable = forward != null && reverse != null
    && expectedIds.every((id) => {
      const a = byId.get(id);
      const b = reverseRows.get(id);
      return a != null && b != null && stableRowSignature(a) === stableRowSignature(b);
    });
  const controls = {
    completeMatrix,
    sourceDistinguishesDeclaredFromGeneric,
    rightmostGenericWins,
    nonOccupyingGenericsPreserveLegacyEnum,
    quotedGenericIsLiteral,
    currentRoutingLosesDeclaredCourier,
    currentRoutingLosesNonCourierMonospace,
    forwardReverseStable,
  };
  const logicalComplete = Object.values(controls).every(Boolean);
  return {
    controls,
    verdict: !legacySeamPresent
      ? "source-drift"
      : logicalComplete
        ? "confirmed-information-loss"
        : "invalid-evidence",
  };
}

function legacySeamEvidence(): GenericFamilySemanticsReport["legacySeam"] {
  const source = readFileSync(resolve("src/render/font-resolution.ts"), "utf8");
  const match = source.match(/generic:\s*primaryKey === "courier" \? "monospace" : "standard"/);
  return {
    present: match != null,
    sha256: match == null ? null : createHash("sha256").update(match[0]).digest("hex"),
  };
}

async function paintedFacesForNode(
  page: Page,
  cdp: CDPSession,
  rootNodeId: number,
  selector: string,
): Promise<PaintedFaceEvidence[]> {
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: rootNodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.filter((font: PaintedFaceEvidence) => font.glyphCount > 0).map((font: PaintedFaceEvidence) => ({
    familyName: font.familyName,
    postScriptName: font.postScriptName,
    isCustomFont: font.isCustomFont,
    glyphCount: font.glyphCount,
  }));
}

async function collectOrder(
  page: Page,
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
      const paintedFaces = await paintedFacesForNode(page, cdp, root.nodeId, selector);
      const sourceGeneric = blinkGenericFamilyFromComputedStack(computedFontFamily);
      const sourceFallback = sourceWinFallbackMode(sourceGeneric);
      const primaryKey = resolveFontKey(computedFontFamily, spec.lang);
      const keyFallback = keyInferredWinFallbackMode(primaryKey);
      rows.push(adjudicateGenericFamilySemanticsRow({
        id: spec.id,
        order,
        stackId: spec.stackId,
        scriptId: spec.scriptId,
        lang: spec.lang,
        codepoint: spec.codepoint,
        requestedFontFamily: spec.fontFamily,
        computedFontFamily,
        expectedGeneric: spec.expectedGeneric,
        sourceGeneric,
        sourceFallbackMode: sourceFallback,
        primaryKey,
        keyInferredFallbackMode: keyFallback,
        sourceCandidateOrder: candidateOrder(spec.codepoint, sourceFallback),
        keyInferredCandidateOrder: candidateOrder(spec.codepoint, keyFallback),
        semanticLoss: sourceFallback !== keyFallback,
        paintedFaces,
      }));
    }
    return { order, rows };
  } finally {
    await cdp.detach();
  }
}

export async function runGenericFamilySemanticsAudit(): Promise<GenericFamilySemanticsReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 640 } });
    const orders: GenericFamilySemanticsOrder[] = [];
    clearFontResolutionCaches();
    for (const order of ["forward", "reverse"] as const) {
      const page = await context.newPage();
      try {
        orders.push(await collectOrder(page, order));
      } finally {
        await page.close();
      }
    }
    const legacySeam = legacySeamEvidence();
    const classification = classifyGenericFamilySemanticsEvidence(orders, legacySeam.present);
    return {
      schemaVersion: 1,
      sourcePins: GENERIC_FAMILY_SEMANTICS_SOURCE_PINS,
      environment: {
        platform: platform(),
        architecture: arch(),
        osRelease: release(),
        chromiumVersion: browser.version(),
      },
      legacySeam,
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
  process.exitCode = report.verdict === "confirmed-information-loss" ? 0 : 1;
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
}
