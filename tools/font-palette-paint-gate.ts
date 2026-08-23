#!/usr/bin/env tsx
/** DM-2510 strict, source-owned COLRv0/COLRv1 native palette paint gate. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Page } from "@playwright/test";
import * as fontkit from "fontkit";
import sharp from "sharp";

import { runFontPaletteOwnershipAudit } from "./font-palette-ownership-audit.js";

export const COLRV1_FIXTURE = "tests/fixtures/font-palette/COLRv1-static-test-glyphs.ttf";
export const COLRV1_SHA256 = "5cc3f86c7db4c4a1a00866cd0690c810acd9e9552c79d5395a53d592722d6d94";
export const COLRV1_GIT_BLOB = "a03de3f8db044859d2392c3a92e8a1f2d909bf35";
export const COLRV1_SOURCE = "third_party/blink/web_tests/virtual/text-antialias/resources/test_glyphs-glyf_colr_1.ttf";
export const COLRV1_CODEPOINT = 0xf0100;
const FAMILY = "DomotionPaletteV1";

type Color = [number, number, number, number];
export interface Colrv1SourceFacts {
  sha256: string;
  gitBlob: string;
  familyName: string;
  postscriptName: string;
  colrVersion: 1;
  cpalVersion: 1;
  glyphId: number;
  paintFormat: 4;
  paletteIndices: [number, number];
  stopOffsets: [number, number];
  paletteEndpoints: [Color, Color][];
}

const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const u24 = (bytes: Buffer, offset: number): number => bytes.readUIntBE(offset, 3);

function tableOffset(bytes: Buffer, tag: string): number {
  const count = bytes.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    if (bytes.toString("ascii", record, record + 4) === tag) return bytes.readUInt32BE(record + 8);
  }
  throw new Error(`missing ${tag} table`);
}

/** Parse the exact PaintGlyph -> PaintLinearGradient chain used by U+F0100. */
export function readColrv1SourceFacts(path = COLRV1_FIXTURE): Colrv1SourceFacts {
  const bytes = readFileSync(resolve(path));
  const digest = sha256(bytes);
  if (digest !== COLRV1_SHA256) throw new Error(`COLRv1 fixture SHA-256 ${digest} != ${COLRV1_SHA256}`);
  const font: any = fontkit.create(bytes);
  if (font.COLR?.version !== 1 || font.CPAL?.version !== 1) throw new Error("fixture must carry COLR v1 + CPAL v1");
  const glyphId = font.glyphForCodePoint(COLRV1_CODEPOINT).id;
  if (glyphId === 0) throw new Error("COLRv1 discriminator maps to .notdef");
  const colr = tableOffset(bytes, "COLR");
  const baseList = colr + bytes.readUInt32BE(colr + 14);
  const recordCount = bytes.readUInt32BE(baseList);
  let paint = -1;
  for (let index = 0; index < recordCount; index += 1) {
    const record = baseList + 4 + index * 6;
    if (bytes.readUInt16BE(record) === glyphId) paint = baseList + bytes.readUInt32BE(record + 2);
  }
  if (paint < 0 || bytes[paint] !== 10) throw new Error("discriminator must start with PaintGlyph");
  paint += u24(bytes, paint + 1);
  if (bytes[paint] !== 4) throw new Error("discriminator must own PaintLinearGradient");
  const colorLine = paint + u24(bytes, paint + 1);
  if (bytes.readUInt16BE(colorLine + 1) !== 2) throw new Error("discriminator must own exactly two gradient stops");
  const stops = [0, 1].map((index) => {
    const stop = colorLine + 3 + index * 6;
    return { offset: bytes.readInt16BE(stop) / 16384, palette: bytes.readUInt16BE(stop + 2) };
  });
  const palettes: [Color, Color][] = font.CPAL.colorRecordIndices.map((start: number) => stops.map(({ palette }) => {
    const value = font.CPAL.colorRecords[start + palette];
    return [value.red, value.green, value.blue, value.alpha] as Color;
  }) as [Color, Color]);
  return {
    sha256: digest, gitBlob: COLRV1_GIT_BLOB, familyName: font.familyName,
    postscriptName: font.postscriptName, colrVersion: 1, cpalVersion: 1, glyphId,
    paintFormat: 4, paletteIndices: [stops[0].palette, stops[1].palette],
    stopOffsets: [stops[0].offset, stops[1].offset], paletteEndpoints: palettes,
  };
}

export type V1CaseId = "normal" | "base1" | "override" | "wrong-family" | "missing";
export interface Colrv1PaintRow {
  id: V1CaseId;
  dpr: 1 | 2;
  computedPalette: string;
  isCustomFont: boolean;
  paintedGlyphCount: number;
  opaquePixelCount: number;
  channelMin: [number, number, number];
  channelMax: [number, number, number];
  pngSha256: string;
  pass: boolean;
  blockers: string[];
}

const cases: Array<{ id: V1CaseId; value: string; palette: number; collapse?: "normal" }> = [
  { id: "normal", value: "normal", palette: 0 },
  { id: "base1", value: "--base1", palette: 1 },
  { id: "override", value: "--override", palette: 0 },
  { id: "wrong-family", value: "--wrong-family", palette: 0, collapse: "normal" },
  { id: "missing", value: "--missing", palette: 0, collapse: "normal" },
];
const overrideEndpoints: [Color, Color] = [[255, 0, 255, 255], [0, 255, 255, 255]];

export function adjudicateColrv1Row(
  row: Omit<Colrv1PaintRow, "pass" | "blockers">,
  expectedEndpoints: [Color, Color],
): Colrv1PaintRow {
  const blockers: string[] = [];
  if (!row.isCustomFont) blockers.push("not-custom-font");
  if (row.paintedGlyphCount !== 1) blockers.push("glyph-count");
  if (row.opaquePixelCount === 0) blockers.push("no-opaque-paint");
  for (let channel = 0; channel < 3; channel += 1) {
    const low = Math.min(expectedEndpoints[0][channel], expectedEndpoints[1][channel]);
    const high = Math.max(expectedEndpoints[0][channel], expectedEndpoints[1][channel]);
    if (row.channelMin[channel] < low || row.channelMax[channel] > high) blockers.push(`channel-${channel}-outside-source`);
    if (low === high && (row.channelMin[channel] !== low || row.channelMax[channel] !== high)) blockers.push(`channel-${channel}-constant`);
    if (low !== high && row.channelMin[channel] === row.channelMax[channel]) blockers.push(`channel-${channel}-inert`);
  }
  return { ...row, pass: blockers.length === 0, blockers };
}

async function paintedFace(page: Page): Promise<{ custom: boolean; count: number }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#sample" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const painted = fonts.filter((font) => font.glyphCount > 0);
    return { custom: painted.length === 1 && painted[0].isCustomFont, count: painted.reduce((sum, row) => sum + row.glyphCount, 0) };
  } finally { await cdp.detach(); }
}

async function paintRows(dpr: 1 | 2, facts: Colrv1SourceFacts, artifactDir?: string): Promise<Colrv1PaintRow[]> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 180, height: 140 }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const font = readFileSync(resolve(COLRV1_FIXTURE)).toString("base64");
  try {
    await page.setContent(`<style>
      @font-face{font-family:${FAMILY};src:url(data:font/ttf;base64,${font})}
      @font-palette-values --base1{font-family:${FAMILY};base-palette:1}
      @font-palette-values --override{font-family:${FAMILY};base-palette:0;override-colors:0 #ff00ff,4 #00ffff}
      @font-palette-values --wrong-family{font-family:OtherPaletteFace;base-palette:1}
      html,body{margin:0;background:transparent}#sample{font:120px/1 ${FAMILY};display:inline-block;width:130px;height:120px}
    </style><span id=sample>${String.fromCodePoint(COLRV1_CODEPOINT)}</span>`);
    await page.evaluate(async (family) => { await document.fonts.ready; await document.fonts.load(`120px ${family}`); }, FAMILY);
    const result: Colrv1PaintRow[] = [];
    for (const spec of cases) {
      await page.locator("#sample").evaluate((element, value) => { (element as HTMLElement).style.fontPalette = value; }, spec.value);
      const png = await page.locator("#sample").screenshot({ omitBackground: true, type: "png" });
      const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const min: [number, number, number] = [255, 255, 255]; const max: [number, number, number] = [0, 0, 0]; let opaque = 0;
      for (let offset = 0; offset < data.length; offset += 4) if (data[offset + 3] === 255) {
        opaque += 1; for (let channel = 0; channel < 3; channel += 1) { min[channel] = Math.min(min[channel], data[offset + channel]); max[channel] = Math.max(max[channel], data[offset + channel]); }
      }
      const face = await paintedFace(page);
      const computedPalette = await page.locator("#sample").evaluate((element) => getComputedStyle(element).fontPalette);
      const expected = spec.id === "override" ? overrideEndpoints : facts.paletteEndpoints[spec.palette];
      const row = adjudicateColrv1Row({ id: spec.id, dpr, computedPalette, isCustomFont: face.custom, paintedGlyphCount: face.count,
        opaquePixelCount: opaque, channelMin: min, channelMax: max, pngSha256: sha256(png) }, expected);
      if (computedPalette !== spec.value) { row.pass = false; row.blockers.push("computed-palette"); }
      result.push(row);
      if (artifactDir != null) writeFileSync(resolve(artifactDir, `colrv1-${spec.id}-dpr${dpr}.png`), png);
    }
    for (const row of result.filter((entry) => entry.id === "wrong-family" || entry.id === "missing")) {
      const normal = result.find((entry) => entry.id === "normal")!;
      if (row.pngSha256 !== normal.pngSha256) { row.pass = false; row.blockers.push("collapse-mismatch"); }
    }
    if (new Set(result.filter((row) => ["normal", "base1", "override"].includes(row.id)).map((row) => row.pngSha256)).size !== 3) {
      for (const row of result) { row.pass = false; row.blockers.push("palette-mutation-inert"); }
    }
    return result;
  } finally { await context.close(); await browser.close(); }
}

export interface FontPalettePaintGateReport {
  schemaVersion: 1;
  ticket: "DM-2510";
  verdict: "source-exact" | "source-drift";
  fingerprint: Record<string, string>;
  colrv0: Awaited<ReturnType<typeof runFontPaletteOwnershipAudit>>;
  colrv1Source: Colrv1SourceFacts;
  colrv1Rows: Colrv1PaintRow[];
}

export async function runFontPalettePaintGate(options: { artifactDir?: string } = {}): Promise<FontPalettePaintGateReport> {
  const artifactDir = options.artifactDir == null ? undefined : resolve(options.artifactDir);
  if (artifactDir != null) mkdirSync(artifactDir, { recursive: true });
  const colrv0 = await runFontPaletteOwnershipAudit({ dprs: [1, 2], artifactDir });
  const source = readColrv1SourceFacts();
  const rows = [...await paintRows(1, source, artifactDir), ...await paintRows(2, source, artifactDir)];
  const complete = rows.length === 10 && new Set(rows.map((row) => `${row.dpr}:${row.id}`)).size === 10;
  const verdict = colrv0.verdict === "source-exact" && complete && rows.every((row) => row.pass) ? "source-exact" : "source-drift";
  return { schemaVersion: 1, ticket: "DM-2510", verdict,
    fingerprint: { platform: platform(), architecture: arch(), osRelease: release(), chromium: chromium.executablePath(), node: process.version },
    colrv0, colrv1Source: source, colrv1Rows: rows };
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const value = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
  const json = value("--json"); const artifactDir = value("--artifact-dir");
  const report = await runFontPalettePaintGate({ ...(artifactDir == null ? {} : { artifactDir }) });
  if (json != null) { mkdirSync(dirname(resolve(json)), { recursive: true }); writeFileSync(resolve(json), JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify({ verdict: report.verdict, colrv0: report.colrv0.verdict, colrv1: `${report.colrv1Rows.filter((row) => row.pass).length}/${report.colrv1Rows.length}` }, null, 2));
  if (report.verdict !== "source-exact") process.exitCode = 1;
}
