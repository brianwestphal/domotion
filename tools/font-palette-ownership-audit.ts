#!/usr/bin/env tsx
/**
 * DM-2350 investigation oracle: source-owned CPAL selection and Domotion's
 * browser-raster ownership boundary. This is deliberately an audit, not a
 * production fallback. A confirmed gap is a successful investigation result.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type Page } from "@playwright/test";
import * as fontkit from "fontkit";
import sharp from "sharp";

import {
  attachWebfontTracker,
  captureElementTreeWithWarnings,
  discoverAndRegisterWebfonts,
} from "../src/capture/index.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import {
  clearGlyphDefs,
  clearWebfonts,
  selectedGlyphRasterSpans,
} from "../src/render/text-to-path.js";

export const FONT_PALETTE_FIXTURE = "tests/fixtures/font-palette/COLR-palettes-test-font.ttf";
export const FONT_PALETTE_FIXTURE_SHA256 = "39002caac7857a2553ab2f9c832755b91a9c5976a6a303a927837d76a333f607";
export const FONT_PALETTE_FIXTURE_GIT_BLOB = "0f28caf21e6fde2660c251471f528e4ed21b82a3";
export const FONT_PALETTE_SOURCE_PINS = {
  chromium: "7d859f271cbda744098ac69f44978d4edfa62be3",
  skia: "62efacd37737505732dbe3d8daa62abd679626a1",
  fixture: "third_party/blink/web_tests/external/wpt/css/css-fonts/resources/COLR-palettes-test-font.ttf",
} as const;

const FAMILY = "DomotionPaletteAudit";
const GLYPH = "A";
const VIEWPORT = { width: 1280, height: 180 } as const;

export interface RgbaColor { red: number; green: number; blue: number; alpha: number }
export interface PaletteSourceFacts {
  sha256: string;
  familyName: string;
  postscriptName: string;
  glyphId: number;
  colrVersion: number;
  cpalVersion: number;
  paletteEntries: number;
  paletteCount: number;
  paletteTypes: number[];
  layerPaletteIndices: number[];
  palettes: RgbaColor[][];
}

type PaletteOverride = Readonly<Record<number, RgbaColor>>;

export interface PaletteCase {
  id: string;
  value: string;
  expectedBase: number;
  expectedRuleName: string | null;
  overrides?: PaletteOverride;
}

const MAGENTA = { red: 255, green: 0, blue: 255, alpha: 255 } as const;
const RED = { red: 255, green: 0, blue: 0, alpha: 255 } as const;

export const FONT_PALETTE_CASES: readonly PaletteCase[] = [
  { id: "normal-base0", value: "normal", expectedBase: 0, expectedRuleName: null },
  { id: "light-flag", value: "light", expectedBase: 2, expectedRuleName: null },
  { id: "dark-flag", value: "dark", expectedBase: 3, expectedRuleName: null },
  { id: "named-base2", value: "--base2", expectedBase: 2, expectedRuleName: "--base2" },
  { id: "named-base3", value: "--base3", expectedBase: 3, expectedRuleName: "--base3" },
  { id: "override-two-entries", value: "--override", expectedBase: 0, expectedRuleName: "--override", overrides: { 3: MAGENTA, 7: RED } },
  { id: "duplicate-override-later-wins", value: "--duplicate", expectedBase: 0, expectedRuleName: "--duplicate", overrides: { 3: MAGENTA, 7: RED } },
  { id: "out-of-range-base-falls-to-zero", value: "--oor-base", expectedBase: 0, expectedRuleName: "--oor-base" },
  { id: "out-of-range-override-ignored", value: "--oor-override", expectedBase: 0, expectedRuleName: "--oor-override", overrides: { 3: MAGENTA } },
  { id: "family-mismatch-collapses", value: "--wrong-family", expectedBase: 0, expectedRuleName: null },
  { id: "missing-rule-collapses", value: "--missing", expectedBase: 0, expectedRuleName: null },
] as const;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const colorKey = (color: RgbaColor): string => `${color.red},${color.green},${color.blue},${color.alpha}`;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function readPaletteSourceFacts(path = FONT_PALETTE_FIXTURE): PaletteSourceFacts {
  const bytes = readFileSync(resolve(path));
  const digest = sha256(bytes);
  if (digest !== FONT_PALETTE_FIXTURE_SHA256) throw new Error(`font-palette fixture SHA-256 ${digest} != ${FONT_PALETTE_FIXTURE_SHA256}`);
  const font: any = fontkit.create(bytes);
  const cpal = font.CPAL;
  const colr = font.COLR;
  if (cpal?.version !== 1 || colr?.version !== 0) throw new Error("font-palette fixture must carry CPAL v1 + COLR v0");
  const glyph = font.glyphForCodePoint(GLYPH.codePointAt(0)!);
  const base = colr.baseGlyphRecord.find((record: { gid: number }) => record.gid === glyph.id);
  if (base == null || base.numLayers < 2) throw new Error("font-palette fixture A glyph lacks its COLR layers");
  const layerPaletteIndices = colr.layerRecords
    .slice(base.firstLayerIndex, base.firstLayerIndex + base.numLayers)
    .map((layer: { paletteIndex: number }) => layer.paletteIndex);
  const palettes = cpal.colorRecordIndices.map((start: number) => Array.from({ length: cpal.numPaletteEntries }, (_, entry) => {
    const record = cpal.colorRecords[start + entry];
    return { red: record.red, green: record.green, blue: record.blue, alpha: record.alpha };
  }));
  return {
    sha256: digest,
    familyName: font.familyName,
    postscriptName: font.postscriptName,
    glyphId: glyph.id,
    colrVersion: colr.version,
    cpalVersion: cpal.version,
    paletteEntries: cpal.numPaletteEntries,
    paletteCount: cpal.numPalettes,
    paletteTypes: [...cpal.offsetPaletteTypeArray],
    layerPaletteIndices,
    palettes,
  };
}

export function expectedPaletteColors(facts: PaletteSourceFacts, spec: PaletteCase): string[] {
  const palette = facts.palettes[spec.expectedBase] ?? facts.palettes[0];
  return facts.layerPaletteIndices.map((entry) => colorKey(spec.overrides?.[entry] ?? palette[entry])).sort();
}

interface CssPaletteRuleEvidence {
  name: string;
  fontFamily: string;
  basePalette: string;
  overrideColors: string;
}

export interface NativePaletteRow {
  id: string;
  dpr: 1 | 2;
  computedFontPalette: string;
  cssomRule: CssPaletteRuleEvidence | null;
  sourceGlyphId: number;
  paintedFamilyDisplayName: string;
  paintedPostscriptDisplayName: string;
  isCustomFont: boolean;
  paintedGlyphCount: number;
  expectedColors: string[];
  observedOpaqueColors: string[];
  observedColorCounts: Record<string, number>;
  pngSha256: string;
  pass: boolean;
  blockers: string[];
}

export function adjudicateNativePaletteRow(
  row: Omit<NativePaletteRow, "pass" | "blockers">,
  spec: PaletteCase,
  expectedGlyphId: number,
): NativePaletteRow {
  const blockers: string[] = [];
  if (row.computedFontPalette !== spec.value) blockers.push("computed-palette");
  if (row.sourceGlyphId !== expectedGlyphId) blockers.push("source-gid");
  if (!row.isCustomFont) blockers.push("not-custom-font");
  if (row.paintedGlyphCount !== 1) blockers.push("glyph-count");
  if (!same(row.observedOpaqueColors, row.expectedColors)) blockers.push("source-colors");
  if (row.expectedColors.some((color) => (row.observedColorCounts[color] ?? 0) === 0)) blockers.push("inert-color");
  if (spec.expectedRuleName == null
    ? row.cssomRule != null
    : row.cssomRule == null || row.cssomRule.name !== spec.expectedRuleName
      || row.cssomRule.fontFamily.toLowerCase() !== FAMILY.toLowerCase()) {
    blockers.push("cssom-rule");
  }
  return { ...row, pass: blockers.length === 0, blockers };
}

export interface ProductionOrderEvidence {
  order: ["base2", "base3"] | ["base3", "base2"];
  sourcePngSha256: string[];
  sourceOpaqueColors: string[][];
  capturedPngSha256: string[];
  capturedPngCount: number;
  capturedUniquePngCount: number;
  svgImageCount: number;
  captureHasFontPaletteFact: boolean;
  capturedPaletteRecords: unknown[];
  selectedRepresentation: string | null;
  warnings: string[];
  svg: string;
}

export type PaletteAuditVerdict = "source-exact" | "confirmed-palette-identity-gap" | "invalid-evidence" | "inconclusive";

export function classifyPaletteAudit(
  nativeRows: readonly NativePaletteRow[],
  orders: readonly ProductionOrderEvidence[],
  expectedDprs: readonly (1 | 2)[] = [1, 2],
): PaletteAuditVerdict {
  const expectedKeys = expectedDprs.flatMap((dpr) => FONT_PALETTE_CASES.map((spec) => `${dpr}:${spec.id}`));
  const observedKeys = nativeRows.map((row) => `${row.dpr}:${row.id}`);
  if (nativeRows.length !== expectedKeys.length || new Set(observedKeys).size !== observedKeys.length
    || expectedKeys.some((key) => !observedKeys.includes(key)) || nativeRows.some((row) => !row.pass)) return "invalid-evidence";
  if (orders.length !== 2 || orders.some((row) => row.warnings.length > 0 || row.sourcePngSha256.length !== 2
      || row.sourcePngSha256[0] === row.sourcePngSha256[1] || row.selectedRepresentation !== "colr"
      || row.svgImageCount !== 2)) return "invalid-evidence";
  const exact = orders.every((row) => row.capturedPngCount === 2 && row.capturedUniquePngCount === 2
    && row.captureHasFontPaletteFact && row.capturedPaletteRecords.length === 2
    && row.capturedPngSha256.every((hash, index) => hash === row.sourcePngSha256[index]));
  if (exact) return "source-exact";
  const contaminated = orders.every((row) => row.capturedPngCount === 2 && row.capturedUniquePngCount === 1
      && !row.captureHasFontPaletteFact && row.capturedPngSha256.every((hash) => hash === row.sourcePngSha256[0]))
    && orders[0].capturedPngSha256[0] !== orders[1].capturedPngSha256[0];
  return contaminated ? "confirmed-palette-identity-gap" : "inconclusive";
}

async function pngColors(png: Buffer): Promise<{ colors: string[]; counts: Record<string, number> }> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts: Record<string, number> = {};
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] !== 255) continue;
    const key = `${data[offset]},${data[offset + 1]},${data[offset + 2]},${data[offset + 3]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { colors: Object.keys(counts).sort(), counts };
}

function paletteCss(fontUrl: string): string {
  return `
    @font-face{font-family:${FAMILY};src:url('${fontUrl}') format('truetype');font-display:block}
    @font-palette-values --base2{font-family:${FAMILY};base-palette:2}
    @font-palette-values --base3{font-family:${FAMILY};base-palette:3}
    @font-palette-values --override{font-family:${FAMILY};base-palette:0;override-colors:3 #ff00ff,7 #ff0000}
    @font-palette-values --duplicate{font-family:${FAMILY};base-palette:0;override-colors:3 #ff0000,3 #ff00ff,7 #ff0000}
    @font-palette-values --oor-base{font-family:${FAMILY};base-palette:99999}
    @font-palette-values --oor-override{font-family:${FAMILY};base-palette:0;override-colors:3 #ff00ff,99999 #ff0000}
    @font-palette-values --wrong-family{font-family:NotThePaletteFace;base-palette:2}
    html,body{margin:0;background:transparent}.sample{display:inline-block;font:100px/1 ${FAMILY};width:100px;height:100px}
  `;
}

async function ready(page: Page): Promise<void> {
  await page.evaluate(async ({ family }) => {
    await document.fonts.ready;
    await document.fonts.load(`100px ${family}`, "A");
  }, { family: FAMILY });
}

async function cdpFace(page: Page, selector: string): Promise<{ family: string; postscript: string; custom: boolean; glyphCount: number }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const painted = fonts.filter((font) => font.glyphCount > 0);
    if (painted.length !== 1) throw new Error(`${selector}: expected one painted face, got ${JSON.stringify(painted)}`);
    return { family: painted[0].familyName, postscript: painted[0].postScriptName, custom: painted[0].isCustomFont, glyphCount: painted[0].glyphCount };
  } finally { await cdp.detach(); }
}

function collectDataUris(value: unknown, out: string[] = []): string[] {
  if (value == null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "dataUri" || key === "rasterDataUri") && typeof entry === "string" && entry.startsWith("data:image/png;base64,")) out.push(entry);
    else collectDataUris(entry, out);
  }
  return out;
}

function hasKey(value: unknown, wanted: string): boolean {
  if (value == null || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) => key === wanted || hasKey(entry, wanted));
}

function valuesForKey(value: unknown, wanted: string, out: unknown[] = []): unknown[] {
  if (value == null || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === wanted) out.push(entry); else valuesForKey(entry, wanted, out);
  }
  return out;
}

async function nativeRows(browser: Browser, fontUrl: string, facts: PaletteSourceFacts, dpr: 1 | 2, artifactDir?: string): Promise<NativePaletteRow[]> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
  const page = await context.newPage();
  try {
    const samples = FONT_PALETTE_CASES.map((spec) => `<span id="${spec.id}" class="sample" style="font-palette:${spec.value}">A</span>`).join("");
    await page.setContent(`<style>${paletteCss(fontUrl)}</style><main>${samples}</main>`);
    await ready(page);
    const rules = await page.evaluate(() => Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules))
      .filter((rule) => rule.constructor.name === "CSSFontPaletteValuesRule")
      .map((rule: any) => ({ name: rule.name, fontFamily: rule.fontFamily, basePalette: rule.basePalette, overrideColors: rule.overrideColors })));
    const rows: NativePaletteRow[] = [];
    for (const spec of FONT_PALETTE_CASES) {
      const locator = page.locator(`#${spec.id}`);
      const png = await locator.screenshot({ omitBackground: true, type: "png" });
      if (artifactDir != null) writeFileSync(resolve(artifactDir, `native-${spec.id}-dpr${dpr}.png`), png);
      const observed = await pngColors(png);
      const computedFontPalette = await locator.evaluate((element) => getComputedStyle(element).fontPalette);
      const face = await cdpFace(page, `#${spec.id}`);
      const cssomRule = spec.value.startsWith("--")
        ? rules.find((rule) => rule.name === spec.value && rule.fontFamily.toLowerCase() === FAMILY.toLowerCase()) ?? null
        : null;
      rows.push(adjudicateNativePaletteRow({
        id: spec.id, dpr, computedFontPalette, cssomRule,
        sourceGlyphId: facts.glyphId,
        paintedFamilyDisplayName: face.family,
        paintedPostscriptDisplayName: face.postscript,
        isCustomFont: face.custom,
        paintedGlyphCount: face.glyphCount,
        expectedColors: expectedPaletteColors(facts, spec),
        observedOpaqueColors: observed.colors,
        observedColorCounts: observed.counts,
        pngSha256: sha256(png),
      }, spec, facts.glyphId));
    }
    return rows;
  } finally { await context.close(); }
}

async function productionOrder(browser: Browser, fontUrl: string, order: ProductionOrderEvidence["order"], artifactDir?: string): Promise<ProductionOrderEvidence> {
  const context = await browser.newContext({ viewport: { width: 240, height: 120 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const tracker = attachWebfontTracker(page);
  try {
    const spans = order.map((name) => `<span id="${name}" class="sample" style="font-palette:--${name}">A</span>`).join("");
    await page.setContent(`<style>${paletteCss(fontUrl)}</style><main id="stage">${spans}</main>`);
    await ready(page);
    const sourcePngs = await Promise.all(order.map((name) => page.locator(`#${name}`).screenshot({ omitBackground: true, type: "png" })));
    const sourceColors = await Promise.all(sourcePngs.map(pngColors));
    clearWebfonts(); clearGlyphDefs();
    const registration = await discoverAndRegisterWebfonts(page, tracker.urls);
    if (!registration.some((row) => row.ok && row.family === FAMILY)) throw new Error(`palette webfont registration failed: ${JSON.stringify(registration)}`);
    const selected = selectedGlyphRasterSpans("A", [{ start: 0, end: 1 }], {
      fontSize: 100, fontFamily: FAMILY, fontWeight: 400, fontStyle: "normal", fontStretch: "100%", lang: "en",
    })[0];
    const capture = await captureElementTreeWithWarnings(page, "#stage", { x: 0, y: 0, width: 240, height: 120 });
    const dataUris = collectDataUris(capture.tree);
    const capturedPngs = dataUris.map((uri) => Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"));
    const svg = elementTreeToSvgInner(capture.tree, 240, 120);
    if (artifactDir != null) {
      const label = order.join("-");
      sourcePngs.forEach((png, index) => writeFileSync(resolve(artifactDir, `source-${label}-${index}.png`), png));
      capturedPngs.forEach((png, index) => writeFileSync(resolve(artifactDir, `captured-${label}-${index}.png`), png));
      writeFileSync(resolve(artifactDir, `captured-${label}.svg`), svg);
    }
    return {
      order,
      sourcePngSha256: sourcePngs.map(sha256),
      sourceOpaqueColors: sourceColors.map((row) => row.colors),
      capturedPngSha256: capturedPngs.map(sha256),
      capturedPngCount: capturedPngs.length,
      capturedUniquePngCount: new Set(capturedPngs.map(sha256)).size,
      svgImageCount: (svg.match(/<image\b/g) ?? []).length,
      captureHasFontPaletteFact: hasKey(capture.tree, "fontPalette"),
      capturedPaletteRecords: valuesForKey(capture.tree, "colorGlyphIdentity"),
      selectedRepresentation: selected?.representation ?? null,
      warnings: capture.warnings.map((warning) => `${warning.feature}:${warning.status}`),
      svg,
    };
  } finally {
    tracker.detach(); clearWebfonts(); clearGlyphDefs(); await context.close();
  }
}

function fixtureServer(bytes: Buffer): Promise<{ server: Server; url: string }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((_request, response) => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Content-Type", "font/ttf");
      response.end(bytes);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") return reject(new Error("font fixture server did not bind a TCP port"));
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/font.ttf` });
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export interface FontPaletteAuditReport {
  schemaVersion: 1;
  ticket: "DM-2350";
  verdict: PaletteAuditVerdict;
  sourcePins: typeof FONT_PALETTE_SOURCE_PINS;
  fixture: PaletteSourceFacts;
  fingerprint: Record<string, unknown>;
  nativeRows: NativePaletteRow[];
  productionOrders: ProductionOrderEvidence[];
  followUps: string[];
}

export async function runFontPaletteOwnershipAudit(options: { dprs?: Array<1 | 2>; artifactDir?: string } = {}): Promise<FontPaletteAuditReport> {
  const facts = readPaletteSourceFacts();
  const artifactDir = options.artifactDir == null ? undefined : resolve(options.artifactDir);
  if (artifactDir != null) mkdirSync(artifactDir, { recursive: true });
  const fixtureBytes = readFileSync(resolve(FONT_PALETTE_FIXTURE));
  const hosted = await fixtureServer(fixtureBytes);
  const browser = await chromium.launch({ headless: true });
  try {
    const dprs = options.dprs ?? [1, 2];
    const native = (await Promise.all(dprs.map((dpr) => nativeRows(browser, hosted.url, facts, dpr, artifactDir)))).flat();
    // Production font registries/caches are process-global. Run the two order
    // arms serially so the reverse-order mutation changes only DOM order, not
    // an interleaved clear/register race between two captures.
    const orders = [
      await productionOrder(browser, hosted.url, ["base2", "base3"], artifactDir),
      await productionOrder(browser, hosted.url, ["base3", "base2"], artifactDir),
    ];
    const verdict = classifyPaletteAudit(native, orders, dprs);
    const browserCdp = await browser.newBrowserCDPSession();
    const browserVersion = await browserCdp.send("Browser.getVersion");
    await browserCdp.detach();
    const report: FontPaletteAuditReport = {
      schemaVersion: 1,
      ticket: "DM-2350",
      verdict,
      sourcePins: FONT_PALETTE_SOURCE_PINS,
      fixture: facts,
      fingerprint: {
        platform: platform(), architecture: arch(), osRelease: release(),
        chromium: browser.version(), chromiumRevision: browserVersion.revision,
        browserExecutableSha256: await sha256File(chromium.executablePath()),
        node: process.version, sharp: sharp.versions.sharp, libvips: sharp.versions.vips,
      },
      nativeRows: native,
      productionOrders: orders,
      followUps: verdict === "confirmed-palette-identity-gap" ? [
        "DM-2509: capture resolved font-palette ownership and add palette/face/gid/representation to browser-raster cache identity.",
      ] : verdict === "source-exact" ? [
        "DM-2510: promote this audit to a strict COLRv1/COLRv0 three-platform paint gate.",
      ] : [],
    };
    if (artifactDir != null) writeFileSync(resolve(artifactDir, "font-palette-ownership-report.json"), JSON.stringify({ ...report, productionOrders: report.productionOrders.map(({ svg: _svg, ...row }) => row) }, null, 2));
    return report;
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose) => hosted.server.close(() => resolveClose()));
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const json = value("--json");
  const artifactDir = value("--artifact-dir");
  const report = await runFontPaletteOwnershipAudit({ ...(artifactDir == null ? {} : { artifactDir }) });
  const serializable = { ...report, productionOrders: report.productionOrders.map(({ svg: _svg, ...row }) => row) };
  if (json != null) { mkdirSync(dirname(resolve(json)), { recursive: true }); writeFileSync(resolve(json), JSON.stringify(serializable, null, 2)); }
  console.log(JSON.stringify({ verdict: report.verdict, nativeRows: report.nativeRows.length, nativePass: report.nativeRows.filter((row) => row.pass).length, productionOrders: report.productionOrders.map((row) => ({ order: row.order, source: row.sourcePngSha256, captured: row.capturedPngSha256, captureHasFontPaletteFact: row.captureHasFontPaletteFact })) }, null, 2));
  if (report.verdict === "invalid-evidence" || report.verdict === "inconclusive") process.exitCode = 1;
}
