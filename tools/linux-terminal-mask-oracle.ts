/**
 * Linux native-vs-embedded terminal-mask oracle (DM-2623).
 *
 * Native text is the reference witness only. Every candidate arm uses font
 * bytes embedded in a data URL; no candidate may resolve through a host font.
 * The matrix isolates cmap addressing, hint retention, CSS text-rendering,
 * fallback-family context, and quarter-pixel phase without changing selected
 * face, glyph, size, baseline, or paint.
 */
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as fontkitNs from "fontkit";
import sharp from "sharp";
import svg2ttf from "svg2ttf";

import { hbSubsetRetainGids, injectPuaCmap } from "../src/render/hb-subset.js";
import { comparePngs } from "../src/review/compare-pngs.js";

const fontkit = (fontkitNs as { default?: typeof fontkitNs }).default ?? fontkitNs;
const FONT_PATHS = {
  wqy: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
  freeSans: "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  unifont: "/usr/share/fonts/opentype/unifont/unifont.otf",
} as const;
const CELL = 96;
const PHASES = [0, 0.25, 0.5, 0.75] as const;
const GLYPH_HELPER = resolve("tools/linux-glyph-extractor/domotion-glyph-paths");

type LinuxTerminalMaskFaceId = "wqy-ui" | "wqy-mono" | "free-sans" | "unifont";

export type LinuxTerminalMaskVariantId =
  | "native-reference"
  | "source-cmap-webfont"
  | "pua-only"
  | "pua-with-source-cmap"
  | "pua-production-policy"
  | "pua-target-hinted-full"
  | "pua-target-hinted-y"
  | "pua-geometric-precision"
  | "pua-optimize-legibility"
  | "pua-optimize-speed"
  | "pua-no-hinting";

export interface LinuxTerminalMaskCase {
  id: string;
  face: LinuxTerminalMaskFaceId;
  fontPath: string;
  postscriptName: string;
  nativeFamily: string;
  sourceCodepoint: number;
  fontSizePx: number;
  geometricPrecisionPolicy: "enabled" | "disabled";
}

export const LINUX_TERMINAL_MASK_CASES: readonly LinuxTerminalMaskCase[] = [
  { id: "ui-meta-13", face: "wqy-ui", fontPath: FONT_PATHS.wqy, postscriptName: "WenQuanYiZenHei", nativeFamily: "WenQuanYi Zen Hei", sourceCodepoint: 0x43, fontSizePx: 13, geometricPrecisionPolicy: "enabled" },
  { id: "mono-label-17", face: "wqy-mono", fontPath: FONT_PATHS.wqy, postscriptName: "WenQuanYiZenHeiMono", nativeFamily: "WenQuanYi Zen Hei Mono", sourceCodepoint: 0x55, fontSizePx: 17, geometricPrecisionPolicy: "enabled" },
  { id: "ui-header-20", face: "wqy-ui", fontPath: FONT_PATHS.wqy, postscriptName: "WenQuanYiZenHei", nativeFamily: "WenQuanYi Zen Hei", sourceCodepoint: 0x43, fontSizePx: 20, geometricPrecisionPolicy: "enabled" },
  { id: "ui-cjk-32", face: "wqy-ui", fontPath: FONT_PATHS.wqy, postscriptName: "WenQuanYiZenHei", nativeFamily: "WenQuanYi Zen Hei", sourceCodepoint: 0x6c94, fontSizePx: 32, geometricPrecisionPolicy: "enabled" },
  { id: "freesans-malayalam-32", face: "free-sans", fontPath: FONT_PATHS.freeSans, postscriptName: "FreeSans", nativeFamily: "'Malayalam Sangam MN','Arial Unicode MS','Apple Symbols','Apple Color Emoji','Noto Sans','Noto Serif',sans-serif", sourceCodepoint: 0x0d10, fontSizePx: 32, geometricPrecisionPolicy: "disabled" },
  { id: "unifont-malayalam-32", face: "unifont", fontPath: FONT_PATHS.unifont, postscriptName: "Unifont", nativeFamily: "'Malayalam Sangam MN','Arial Unicode MS','Apple Symbols','Apple Color Emoji','Noto Sans','Noto Serif',sans-serif", sourceCodepoint: 0x0d04, fontSizePx: 32, geometricPrecisionPolicy: "disabled" },
] as const;

export const LINUX_TERMINAL_MASK_VARIANTS: ReadonlyArray<{
  id: LinuxTerminalMaskVariantId;
  embedded: boolean;
  addressing: "source" | "pua";
  bytes: "source-cmap" | "pua-only" | "pua-with-source" | "pua-no-hinting" | "target-hinted-full" | "target-hinted-y" | null;
  textRendering: "auto" | "geometricPrecision" | "optimizeLegibility" | "optimizeSpeed" | "productionPolicy";
}> = [
  { id: "native-reference", embedded: false, addressing: "source", bytes: null, textRendering: "auto" },
  { id: "source-cmap-webfont", embedded: true, addressing: "source", bytes: "source-cmap", textRendering: "auto" },
  { id: "pua-only", embedded: true, addressing: "pua", bytes: "pua-only", textRendering: "auto" },
  { id: "pua-with-source-cmap", embedded: true, addressing: "pua", bytes: "pua-with-source", textRendering: "auto" },
  { id: "pua-production-policy", embedded: true, addressing: "pua", bytes: "pua-only", textRendering: "productionPolicy" },
  { id: "pua-target-hinted-full", embedded: true, addressing: "pua", bytes: "target-hinted-full", textRendering: "productionPolicy" },
  { id: "pua-target-hinted-y", embedded: true, addressing: "pua", bytes: "target-hinted-y", textRendering: "productionPolicy" },
  { id: "pua-geometric-precision", embedded: true, addressing: "pua", bytes: "pua-only", textRendering: "geometricPrecision" },
  { id: "pua-optimize-legibility", embedded: true, addressing: "pua", bytes: "pua-only", textRendering: "optimizeLegibility" },
  { id: "pua-optimize-speed", embedded: true, addressing: "pua", bytes: "pua-only", textRendering: "optimizeSpeed" },
  { id: "pua-no-hinting", embedded: true, addressing: "pua", bytes: "pua-no-hinting", textRendering: "auto" },
] as const;

export function linuxTerminalMaskMatrix(): Array<LinuxTerminalMaskCase & { phaseX: number; phaseY: number }> {
  return LINUX_TERMINAL_MASK_CASES.flatMap((testCase) =>
    PHASES.flatMap((phaseY) => PHASES.map((phaseX) => ({ ...testCase, phaseX, phaseY }))));
}

interface FaceBuild {
  fontPath: string;
  sourceCmap: Buffer;
  puaOnly: Buffer;
  puaWithSource: Buffer;
  puaNoHinting: Buffer;
  puaForSourceCodepoint: Map<number, number>;
  faceIndex: number;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  sourceGlyphs: Array<{ codepoint: number; gid: number; pua: number }>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function buildFace(sourceBytes: Buffer, fontPath: string, postscriptName: string, codepoints: number[]): FaceBuild {
  const opened = fontkit.openSync(fontPath) as unknown as {
    fonts?: Array<{ postscriptName?: string; unitsPerEm: number; ascent: number; descent: number; glyphForCodePoint(cp: number): { id: number } }>;
    postscriptName?: string;
    unitsPerEm: number;
    ascent: number;
    descent: number;
    glyphForCodePoint(cp: number): { id: number };
  };
  const faces = opened.fonts ?? [opened];
  const faceIndex = faces.findIndex((face) => face.postscriptName === postscriptName);
  if (faceIndex < 0) throw new Error(`oracle face not found: ${postscriptName} in ${fontPath}`);
  const face = faces[faceIndex];
  const uniqueCodepoints = [...new Set(codepoints)];
  const sourceGlyphs = uniqueCodepoints.map((codepoint, index) => ({
    codepoint,
    gid: face.glyphForCodePoint(codepoint).id,
    pua: 0xe000 + index,
  }));
  if (sourceGlyphs.some((glyph) => glyph.gid === 0)) {
    throw new Error(`${postscriptName}: matrix contains an uncovered source codepoint`);
  }
  const gids = sourceGlyphs.map((glyph) => glyph.gid);
  const hinted = hbSubsetRetainGids(sourceBytes, gids, faceIndex, true);
  const unhinted = hbSubsetRetainGids(sourceBytes, gids, faceIndex, false);
  const puaToGid = new Map(sourceGlyphs.map((glyph) => [glyph.pua, glyph.gid]));
  const sourceToGid = new Map(sourceGlyphs.map((glyph) => [glyph.codepoint, glyph.gid]));
  const sourceAndPuaToGid = new Map([...sourceToGid, ...puaToGid]);
  return {
    fontPath,
    // injectPuaCmap accepts any Unicode→gid map. Source-addressed and mixed
    // maps exist only as oracle controls; production remains PUA-only.
    sourceCmap: injectPuaCmap(hinted, sourceToGid),
    puaOnly: injectPuaCmap(hinted, puaToGid),
    puaWithSource: injectPuaCmap(hinted, sourceAndPuaToGid),
    puaNoHinting: injectPuaCmap(unhinted, puaToGid),
    puaForSourceCodepoint: new Map(sourceGlyphs.map((glyph) => [glyph.codepoint, glyph.pua])),
    faceIndex,
    unitsPerEm: face.unitsPerEm,
    ascent: face.ascent,
    descent: face.descent,
    sourceGlyphs,
  };
}

type SourceByteKind = "source-cmap" | "pua-only" | "pua-with-source" | "pua-no-hinting";

function embeddedBytes(face: FaceBuild, kind: SourceByteKind): Buffer {
  if (kind === "source-cmap") return face.sourceCmap;
  if (kind === "pua-only") return face.puaOnly;
  if (kind === "pua-with-source") return face.puaWithSource;
  return face.puaNoHinting;
}

interface TargetHintedCaseFace {
  full: Buffer;
  yOnly: Buffer;
  pua: number;
  targetUnitsPerEm: number;
  sourceUnitsPerEm: number;
  sourceGid: number;
}

interface OutlineCommand {
  command: "M" | "L" | "Q" | "C" | "Z";
  args: number[];
}

function parseOutline(d: string): OutlineCommand[] {
  const tokens = d.match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const argCounts = { M: 2, L: 2, Q: 4, C: 6, Z: 0 } as const;
  const commands: OutlineCommand[] = [];
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++] as OutlineCommand["command"];
    if (!(command in argCounts)) throw new Error(`unknown helper path token: ${command}`);
    const args = tokens.slice(index, index + argCounts[command]).map(Number);
    index += argCounts[command];
    commands.push({ command, args });
  }
  return commands;
}

function compactNumber(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function targetStrikePath(
  designD: string,
  hintedD: string,
  sourceUnitsPerEm: number,
  targetUnitsPerEm: number,
  mode: "full" | "yOnly",
): string {
  const design = parseOutline(designD);
  const hinted = parseOutline(hintedD);
  if (design.length !== hinted.length) throw new Error("hinted outline changed command count");
  const sourceScale = targetUnitsPerEm / sourceUnitsPerEm;
  return design.map((designCommand, index) => {
    const hintedCommand = hinted[index];
    if (designCommand.command !== hintedCommand.command || designCommand.args.length !== hintedCommand.args.length) {
      throw new Error("hinted outline changed command topology");
    }
    if (designCommand.command === "Z") return "Z";
    const args = designCommand.args.map((value, argIndex) => {
      if (mode === "full" || argIndex % 2 === 1) return hintedCommand.args[argIndex];
      return value * sourceScale;
    });
    return `${designCommand.command} ${args.map(compactNumber).join(" ")}`;
  }).join(" ");
}

function buildTargetStrikeFont(
  family: string,
  face: FaceBuild,
  targetUnitsPerEm: number,
  pua: number,
  advance: number,
  d: string,
): Buffer {
  const metricScale = targetUnitsPerEm / face.unitsPerEm;
  const svgFont =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg"><defs>` +
    `<font id="${family}" horiz-adv-x="${compactNumber(advance)}">` +
    `<font-face font-family="${family}" units-per-em="${targetUnitsPerEm}"` +
    ` ascent="${compactNumber(face.ascent * metricScale)}" descent="${compactNumber(face.descent * metricScale)}"/>` +
    `<missing-glyph horiz-adv-x="0"/>` +
    `<glyph unicode="&#x${pua.toString(16)};" horiz-adv-x="${compactNumber(advance)}" d="${d}"/>` +
    `</font></defs></svg>`;
  return Buffer.from(svg2ttf(svgFont, { ts: 0 }).buffer);
}

function buildTargetHintedCaseFaces(faces: Record<LinuxTerminalMaskFaceId, FaceBuild>): Map<string, TargetHintedCaseFace> {
  if (!existsSync(GLYPH_HELPER)) {
    throw new Error(`target-strike oracle requires the Linux helper built at ${GLYPH_HELPER}`);
  }
  const cases = LINUX_TERMINAL_MASK_CASES.filter((testCase) => testCase.geometricPrecisionPolicy === "enabled");
  const envelope = {
    fonts: cases.map((testCase) => ({
      ref: testCase.id,
      fontPath: testCase.fontPath,
      postscriptName: testCase.postscriptName,
      size: testCase.fontSizePx,
    })),
    queries: cases.flatMap((testCase) => [
      { type: "glyphs", fontRef: testCase.id, glyphs: [{ cp: testCase.sourceCodepoint }] },
      { type: "hintedGlyphs", fontRef: testCase.id, fontSizePx: testCase.fontSizePx, glyphs: [{ cp: testCase.sourceCodepoint }] },
    ]),
  };
  const child = spawnSync(GLYPH_HELPER, [], { input: JSON.stringify(envelope), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (child.error != null || child.status !== 0) {
    throw new Error(`target-strike helper failed: ${child.error?.message ?? child.stderr.trim()}`);
  }
  const response = JSON.parse(child.stdout) as {
    results: Array<{ type: string; error?: string; glyphs?: Array<{ id: number; advance: number; d: string }> }>;
  };
  const built = new Map<string, TargetHintedCaseFace>();
  for (let index = 0; index < cases.length; index++) {
    const testCase = cases[index];
    const design = response.results[index * 2];
    const hinted = response.results[index * 2 + 1];
    const designGlyph = design?.glyphs?.[0];
    const hintedGlyph = hinted?.glyphs?.[0];
    if (designGlyph == null || hintedGlyph == null || designGlyph.d.length === 0 || hintedGlyph.d.length === 0) {
      throw new Error(`${testCase.id}: target-strike outline unavailable (${design?.error ?? hinted?.error ?? "empty path"})`);
    }
    const face = faces[testCase.face];
    const targetUnitsPerEm = Math.round(testCase.fontSizePx * 64);
    const pua = face.puaForSourceCodepoint.get(testCase.sourceCodepoint)!;
    const advance = designGlyph.advance * targetUnitsPerEm / face.unitsPerEm;
    const family = `dm-oracle-target-${testCase.id}`;
    built.set(testCase.id, {
      full: buildTargetStrikeFont(
        `${family}-full`, face, targetUnitsPerEm, pua, advance,
        targetStrikePath(designGlyph.d, hintedGlyph.d, face.unitsPerEm, targetUnitsPerEm, "full"),
      ),
      yOnly: buildTargetStrikeFont(
        `${family}-y`, face, targetUnitsPerEm, pua, advance,
        targetStrikePath(designGlyph.d, hintedGlyph.d, face.unitsPerEm, targetUnitsPerEm, "yOnly"),
      ),
      pua,
      targetUnitsPerEm,
      sourceUnitsPerEm: face.unitsPerEm,
      sourceGid: designGlyph.id,
    });
  }
  return built;
}

function variantDocument(
  variant: (typeof LINUX_TERMINAL_MASK_VARIANTS)[number],
  faces: Record<LinuxTerminalMaskFaceId, FaceBuild>,
  targetHintedFaces: Map<string, TargetHintedCaseFace>,
): string {
  const matrix = linuxTerminalMaskMatrix();
  const width = PHASES.length * PHASES.length * CELL;
  const height = LINUX_TERMINAL_MASK_CASES.length * CELL;
  let css = "html,body{margin:0;background:#fff}svg{display:block}";
  const targetKind = variant.bytes === "target-hinted-full" || variant.bytes === "target-hinted-y"
    ? variant.bytes
    : null;
  if (targetKind != null) {
    for (const testCase of LINUX_TERMINAL_MASK_CASES) {
      const target = targetHintedFaces.get(testCase.id);
      // Production is deliberately the one oracle-proven strike. The broader
      // WQY 13/20/32 experiment was mixed or worse, so those rows remain on the
      // current geometricPrecision policy as negative breadth witnesses.
      const usesTarget = testCase.id === "mono-label-17" && target != null;
      const bytes = usesTarget
        ? (targetKind === "target-hinted-full" ? target.full : target.yOnly)
        : faces[testCase.face].puaOnly;
      css += `@font-face{font-family:"dm-oracle-target-${testCase.id}";font-style:normal;font-weight:400;src:url("data:font/ttf;base64,${bytes.toString("base64")}")}`;
    }
  } else if (variant.embedded && variant.bytes != null) {
    for (const faceId of Object.keys(faces) as LinuxTerminalMaskFaceId[]) {
      const bytes = embeddedBytes(faces[faceId], variant.bytes as SourceByteKind);
      css += `@font-face{font-family:"dm-oracle-${faceId}";font-style:normal;font-weight:400;src:url("data:font/ttf;base64,${bytes.toString("base64")}")}`;
    }
  }
  const texts = matrix.map((cell, index) => {
    const row = Math.floor(index / 16);
    const column = index % 16;
    const x = column * CELL + 32 + cell.phaseX;
    const y = row * CELL + 64 + cell.phaseY;
    const face = faces[cell.face];
    const codepoint = variant.addressing === "source"
      ? cell.sourceCodepoint
      : face.puaForSourceCodepoint.get(cell.sourceCodepoint)!;
    const family = targetKind != null
      ? `dm-oracle-target-${cell.id}`
      : (variant.embedded ? `dm-oracle-${cell.face}` : cell.nativeFamily);
    const textRendering = variant.textRendering === "productionPolicy"
      ? (cell.geometricPrecisionPolicy === "enabled" ? "geometricPrecision" : "auto")
      : variant.textRendering;
    return `<text data-cell="${index}" x="${x}" y="${y}" font-family="${family}" font-size="${cell.fontSizePx}" font-weight="400" text-rendering="${textRendering}" fill="#000">${String.fromCodePoint(codepoint)}</text>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#fff"/>${texts}</svg></body></html>`;
}

interface InkGeometry {
  mass: number;
  centroidX: number;
  centroidY: number;
  bbox: [number, number, number, number] | null;
}

function inkGeometry(data: Buffer, width: number, height: number, channels: number): InkGeometry {
  let mass = 0, weightedX = 0, weightedY = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * channels;
    const ink = 255 - Math.min(data[offset], data[offset + 1], data[offset + 2]);
    if (ink === 0) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    mass += ink; weightedX += x * ink; weightedY += y * ink;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    mass,
    centroidX: mass === 0 ? 0 : weightedX / mass,
    centroidY: mass === 0 ? 0 : weightedY / mass,
    bbox: mass === 0 ? null : [minX, minY, maxX, maxY],
  };
}

function rawResidual(
  expected: { data: Buffer; width: number; height: number; channels: number },
  actual: { data: Buffer; width: number; height: number; channels: number },
) {
  if (expected.width !== actual.width || expected.height !== actual.height || expected.channels !== actual.channels) {
    throw new Error("terminal-mask raster dimensions differ");
  }
  let changedPixels = 0, totalChannelDelta = 0;
  for (let pixel = 0; pixel < expected.width * expected.height; pixel++) {
    const offset = pixel * expected.channels;
    let pixelDelta = 0;
    for (let channel = 0; channel < expected.channels; channel++) {
      pixelDelta += Math.abs(expected.data[offset + channel] - actual.data[offset + channel]);
    }
    if (pixelDelta !== 0) changedPixels++;
    totalChannelDelta += pixelDelta;
  }
  const expectedInk = inkGeometry(expected.data, expected.width, expected.height, expected.channels);
  const actualInk = inkGeometry(actual.data, actual.width, actual.height, actual.channels);
  return {
    changedPixels,
    totalChannelDelta,
    meanChannelDeltaPct: totalChannelDelta / (255 * expected.channels * expected.width * expected.height) * 100,
    expectedInk,
    actualInk,
    centroidDelta: {
      x: actualInk.centroidX - expectedInk.centroidX,
      y: actualInk.centroidY - expectedInk.centroidY,
    },
  };
}

async function decode(bytes: Buffer) {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels };
}

export interface LinuxTerminalMaskOracleOptions {
  out: string;
  artifactDir: string;
}

interface LinuxTerminalMaskScoreCase {
  id: string;
  totalChannelDelta: number;
  centroidDelta?: { x: number; y: number };
  phases?: Array<{ phaseX: number; phaseY: number; totalChannelDelta: number }>;
}

interface LinuxTerminalMaskScoreRow {
  id: string;
  embedded: boolean;
  sha256: string;
  global?: { diffPct: number };
  cases?: LinuxTerminalMaskScoreCase[];
}

/**
 * Turn the diagnostic matrix into a portable regression contract. Exact
 * percentages vary with runner architecture, so the gate asserts only the
 * causal relationships the experiment established: cmap addressing and the
 * non-geometric CSS modes are raster-inert, while the production face policy
 * improves its enabled surfaces and leaves excluded faces byte-identical to
 * the control. The all-geometric arm must also retain a negative witness.
 */
export function validateLinuxTerminalMaskResults(results: readonly LinuxTerminalMaskScoreRow[]): string[] {
  const errors: string[] = [];
  const byId = new Map(results.map((row) => [row.id, row]));
  const required = LINUX_TERMINAL_MASK_VARIANTS.map((variant) => variant.id);
  for (const id of required) {
    if (!byId.has(id)) errors.push(`missing result: ${id}`);
  }
  for (const row of results.filter((candidate) => candidate.id !== "native-reference")) {
    if (!row.embedded) errors.push(`${row.id}: candidate is not embedded`);
  }
  const control = byId.get("pua-only");
  const geometric = byId.get("pua-geometric-precision");
  const production = byId.get("pua-production-policy");
  const targetY = byId.get("pua-target-hinted-y");
  if (control?.global == null || geometric?.global == null || production?.global == null || targetY?.global == null) {
    errors.push("control, production-policy, target-hinted-y, or geometricPrecision score is missing");
    return errors;
  }
  for (const inertId of [
    "source-cmap-webfont",
    "pua-with-source-cmap",
    "pua-optimize-legibility",
    "pua-optimize-speed",
  ]) {
    const inert = byId.get(inertId);
    if (inert != null && inert.sha256 !== control.sha256) {
      errors.push(`${inertId}: expected raster-inert control differs from pua-only`);
    }
  }
  if (production.global.diffPct >= control.global.diffPct * 0.85) {
    errors.push(`production-policy aggregate improvement is below 15% (${control.global.diffPct} -> ${production.global.diffPct})`);
  }
  const geometricCases = new Map((geometric.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const productionCases = new Map((production.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const targetYCases = new Map((targetY.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const policyByCase = new Map(LINUX_TERMINAL_MASK_CASES.map((testCase) => [testCase.id, testCase.geometricPrecisionPolicy]));
  let negativeWitnesses = 0;
  for (const controlCase of control.cases ?? []) {
    const geometricCase = geometricCases.get(controlCase.id);
    const productionCase = productionCases.get(controlCase.id);
    const targetYCase = targetYCases.get(controlCase.id);
    if (geometricCase == null) errors.push(`geometricPrecision case is missing: ${controlCase.id}`);
    if (productionCase == null) {
      errors.push(`production-policy case is missing: ${controlCase.id}`);
      continue;
    }
    if (targetYCase == null) {
      errors.push(`target-hinted-y case is missing: ${controlCase.id}`);
      continue;
    }
    if (targetYCase.totalChannelDelta > productionCase.totalChannelDelta) {
      errors.push(`${controlCase.id}: scoped target strike regressed production policy`);
    }
    if (controlCase.id === "mono-label-17") {
      if (targetYCase.totalChannelDelta > productionCase.totalChannelDelta * 0.05) {
        errors.push(`mono-label-17: target strike did not remove at least 95% of the production residual`);
      }
      if (targetYCase.centroidDelta != null && Math.abs(targetYCase.centroidDelta.y) >= 0.05) {
        errors.push(`mono-label-17: target strike vertical centroid is not near-native (${targetYCase.centroidDelta.y})`);
      }
    }
    if (policyByCase.get(controlCase.id) === "enabled") {
      if (productionCase.totalChannelDelta >= controlCase.totalChannelDelta) {
        errors.push(`${controlCase.id}: production policy did not reduce terminal-mask delta`);
      }
      const controlPhases = new Map((controlCase.phases ?? []).map((phase) => [`${phase.phaseX},${phase.phaseY}`, phase]));
      for (const productionPhase of productionCase.phases ?? []) {
        const controlPhase = controlPhases.get(`${productionPhase.phaseX},${productionPhase.phaseY}`);
        if (controlPhase != null && productionPhase.totalChannelDelta > controlPhase.totalChannelDelta) {
          errors.push(`${controlCase.id}: production phase ${productionPhase.phaseX},${productionPhase.phaseY} regressed terminal-mask delta`);
        }
      }
    } else {
      if (controlCase.totalChannelDelta !== 0) {
        errors.push(`${controlCase.id}: excluded fallback-stack control is not exact`);
      }
      if (productionCase.totalChannelDelta !== controlCase.totalChannelDelta) {
        errors.push(`${controlCase.id}: excluded production face moved`);
      }
      const controlPhases = new Map((controlCase.phases ?? []).map((phase) => [`${phase.phaseX},${phase.phaseY}`, phase]));
      for (const geometricPhase of geometricCase?.phases ?? []) {
        const controlPhase = controlPhases.get(`${geometricPhase.phaseX},${geometricPhase.phaseY}`);
        if (controlPhase != null && geometricPhase.totalChannelDelta > controlPhase.totalChannelDelta) negativeWitnesses++;
      }
    }
  }
  if (negativeWitnesses === 0) errors.push("blanket geometricPrecision has no negative face witness");
  return errors;
}

export async function runLinuxTerminalMaskOracle(options: LinuxTerminalMaskOracleOptions) {
  if (platform() !== "linux") throw new Error("linux-terminal-mask-oracle must run on Linux");
  const sourceBytesByPath = new Map<string, Buffer>();
  const faces = {} as Record<LinuxTerminalMaskFaceId, FaceBuild>;
  const faceIds = [...new Set(LINUX_TERMINAL_MASK_CASES.map((testCase) => testCase.face))];
  for (const faceId of faceIds) {
    const faceCases = LINUX_TERMINAL_MASK_CASES.filter((testCase) => testCase.face === faceId);
    const definition = faceCases[0];
    let sourceBytes = sourceBytesByPath.get(definition.fontPath);
    if (sourceBytes == null) {
      sourceBytes = readFileSync(definition.fontPath);
      sourceBytesByPath.set(definition.fontPath, sourceBytes);
    }
    faces[faceId] = buildFace(
      sourceBytes,
      definition.fontPath,
      definition.postscriptName,
      faceCases.map((testCase) => testCase.sourceCodepoint),
    );
  }
  const targetHintedFaces = buildTargetHintedCaseFaces(faces);
  const out = resolve(options.out);
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const screenshots = new Map<LinuxTerminalMaskVariantId, Buffer>();
  try {
    const page = await browser.newPage({ viewport: { width: 1536, height: LINUX_TERMINAL_MASK_CASES.length * CELL }, deviceScaleFactor: 1 });
    for (const variant of LINUX_TERMINAL_MASK_VARIANTS) {
      await page.setContent(variantDocument(variant, faces, targetHintedFaces));
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const bytes = await page.locator("svg").screenshot();
      screenshots.set(variant.id, bytes);
      writeFileSync(resolve(artifactDir, `${variant.id}.png`), bytes);
    }
    await page.close();
  } finally {
    await browser.close();
  }

  const native = screenshots.get("native-reference")!;
  const nativeDecoded = await decode(native);
  const results = [];
  const compareBrowser = await chromium.launch({ headless: true });
  const comparePage = await compareBrowser.newPage();
  try {
    for (const variant of LINUX_TERMINAL_MASK_VARIANTS) {
      const bytes = screenshots.get(variant.id)!;
      const path = resolve(artifactDir, `${variant.id}.png`);
      if (variant.id === "native-reference") {
        results.push({ id: variant.id, embedded: false, artifact: relative(dirname(out), path), sha256: sha256(bytes), exact: true });
        continue;
      }
      const diffPath = resolve(artifactDir, `${variant.id}-diff.png`);
      const global = await comparePngs(comparePage, resolve(artifactDir, "native-reference.png"), path, diffPath);
      const actualDecoded = await decode(bytes);
      const cases = [];
      for (let row = 0; row < LINUX_TERMINAL_MASK_CASES.length; row++) {
        const top = row * CELL;
        const width = 16 * CELL;
        const [expectedCrop, actualCrop] = await Promise.all([
          sharp(nativeDecoded.data, { raw: { width: nativeDecoded.width, height: nativeDecoded.height, channels: nativeDecoded.channels } })
            .extract({ left: 0, top, width, height: CELL }).raw().toBuffer({ resolveWithObject: true }),
          sharp(actualDecoded.data, { raw: { width: actualDecoded.width, height: actualDecoded.height, channels: actualDecoded.channels } })
            .extract({ left: 0, top, width, height: CELL }).raw().toBuffer({ resolveWithObject: true }),
        ]);
        cases.push({
          id: LINUX_TERMINAL_MASK_CASES[row].id,
          ...rawResidual(
            { data: expectedCrop.data, width: expectedCrop.info.width, height: expectedCrop.info.height, channels: expectedCrop.info.channels },
            { data: actualCrop.data, width: actualCrop.info.width, height: actualCrop.info.height, channels: actualCrop.info.channels },
          ),
          phases: await Promise.all(PHASES.flatMap((phaseY, phaseYIndex) => PHASES.map(async (phaseX, phaseXIndex) => {
            const left = (phaseYIndex * PHASES.length + phaseXIndex) * CELL;
            const [expectedCell, actualCell] = await Promise.all([
              sharp(expectedCrop.data, { raw: { width: expectedCrop.info.width, height: expectedCrop.info.height, channels: expectedCrop.info.channels } })
                .extract({ left, top: 0, width: CELL, height: CELL }).raw().toBuffer({ resolveWithObject: true }),
              sharp(actualCrop.data, { raw: { width: actualCrop.info.width, height: actualCrop.info.height, channels: actualCrop.info.channels } })
                .extract({ left, top: 0, width: CELL, height: CELL }).raw().toBuffer({ resolveWithObject: true }),
            ]);
            return {
              phaseX,
              phaseY,
              ...rawResidual(
                { data: expectedCell.data, width: expectedCell.info.width, height: expectedCell.info.height, channels: expectedCell.info.channels },
                { data: actualCell.data, width: actualCell.info.width, height: actualCell.info.height, channels: actualCell.info.channels },
              ),
            };
          }))),
        });
      }
      results.push({
        id: variant.id,
        embedded: true,
        artifact: relative(dirname(out), path),
        diffArtifact: relative(dirname(out), diffPath),
        sha256: sha256(bytes),
        global: {
          diffPct: global.diffPct,
          nonAaPixels: global.nonAaPixels,
          sigPixelPct: global.sigPixelPct,
          regionCount: global.regionCount,
          totalChangedArea: global.totalChangedArea,
        },
        cases,
      });
    }
  } finally {
    await comparePage.close();
    await compareBrowser.close();
  }
  const report = {
    schemaVersion: 1,
    authority: "diagnostic-oracle",
    productionConstraint: "candidate arms are self-contained embedded fonts; native is reference-only",
    fingerprint: {
      platform: platform(), arch: arch(), osRelease: release(), chromium: browserVersion,
      fonts: [...sourceBytesByPath].map(([fontPath, bytes]) => ({ fontPath, fontSha256: sha256(bytes) })),
    },
    matrix: linuxTerminalMaskMatrix(),
    faces: Object.fromEntries(Object.entries(faces).map(([id, face]) => [id, {
      fontPath: face.fontPath,
      faceIndex: face.faceIndex,
      sourceGlyphs: face.sourceGlyphs,
      byteLengths: {
        sourceCmap: face.sourceCmap.length,
        puaOnly: face.puaOnly.length,
        puaWithSource: face.puaWithSource.length,
        puaNoHinting: face.puaNoHinting.length,
      },
    }])),
    targetHintedFaces: Object.fromEntries([...targetHintedFaces].map(([id, face]) => [id, {
      pua: face.pua,
      sourceGid: face.sourceGid,
      sourceUnitsPerEm: face.sourceUnitsPerEm,
      targetUnitsPerEm: face.targetUnitsPerEm,
      fullSha256: sha256(face.full),
      yOnlySha256: sha256(face.yOnly),
    }])),
    results,
  };
  writeFileSync(out, JSON.stringify(report, null, 2));
  return report;
}

function cliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = cliArg("--out") ?? "tests/output/linux-terminal-mask/report.json";
  const artifactDir = cliArg("--artifact-dir") ?? "tests/output/linux-terminal-mask/artifacts";
  const report = await runLinuxTerminalMaskOracle({ out, artifactDir });
  const summary = report.results.filter((row) => row.id !== "native-reference").map((row) => ({
    id: row.id,
    diffPct: "global" in row ? row.global.diffPct : 0,
    regions: "global" in row ? row.global.regionCount : 0,
  }));
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv.includes("--gate")) {
    const errors = validateLinuxTerminalMaskResults(report.results);
    if (errors.length > 0) {
      console.error(`Linux terminal-mask gate failed:\n- ${errors.join("\n- ")}`);
      process.exitCode = 1;
    }
  }
}
