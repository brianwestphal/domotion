#!/usr/bin/env tsx
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import * as fontkit from "fontkit";
import sharp from "sharp";

import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { hbSubsetRetainGids } from "../src/render/hb-subset.js";
import {
  clearGlyphDefs, clearWebfonts, getFontInstance, getGlyphDefs, registerWebfont,
  renderTextAsPath, resetTextRunProvenance, setRenderTextMode, setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";
import { getTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  FREE_SANS_NOBLE_PACKAGE,
  LINUX_MATHML_GREEK_CELL,
  LINUX_MATHML_GREEK_SUBSETS,
  LINUX_MATHML_GREEK_TOKENS,
  linuxMathmlGreekCellSha256,
  type LinuxMathmlGreekGlyph,
  type LinuxMathmlGreekPreterminalEvidence,
} from "./linux-mathml-greek-raster-contract.js";
import type { LinuxMathmlGreekRasterRow } from "./linux-mathml-greek-raster-gate.js";
import { measurePathsRasterResidual } from "./paths-native-raster-metrics.js";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (require("@playwright/test/package.json") as { version: string }).version;
const VIEWPORT = LINUX_MATHML_GREEK_CELL.viewport;
const UNIQUE_PATHS_FAMILY = "DomotionFreeSansMathmlPaths";
const UNIQUE_UNHINTED_FAMILY = "DomotionFreeSansMathmlUnhinted";

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256"), stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function sourceInputsSha256(inputs: string[]): string {
  const files: string[] = [];
  const visit = (entry: string): void => {
    const absolute = resolve(entry);
    if (statSync(absolute).isDirectory()) for (const child of readdirSync(absolute).sort()) visit(resolve(absolute, child));
    else files.push(absolute);
  };
  for (const input of inputs) visit(input);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(resolve("."), file).replaceAll("\\", "/")); hash.update("\0"); hash.update(readFileSync(file)); hash.update("\0");
  }
  return hash.digest("hex");
}

function assertFile(path: string, expectedSize: number, expectedSha: string, label: string): Buffer {
  const bytes = readFileSync(path);
  if (bytes.length !== expectedSize) throw new Error(`${label} byte length ${bytes.length} != ${expectedSize}`);
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) throw new Error(`${label} SHA-256 ${actualSha} != ${expectedSha}`);
  return bytes;
}

function packageField(debPath: string, field: string): string {
  return execFileSync("dpkg-deb", ["--field", debPath, field], { encoding: "utf8" }).trim();
}

function verifyPackage(debPath: string, fontPath: string): Buffer {
  if (platform() !== "linux") throw new Error("the FreeSans MathML native-raster collector is Linux-only");
  assertFile(debPath, FREE_SANS_NOBLE_PACKAGE.byteLength, FREE_SANS_NOBLE_PACKAGE.sha256, "FreeSans .deb");
  const fields = {
    name: packageField(debPath, "Package"), source: packageField(debPath, "Source").split(" ")[0],
    version: packageField(debPath, "Version"), architecture: packageField(debPath, "Architecture"),
  };
  for (const [key, expected] of Object.entries({
    name: FREE_SANS_NOBLE_PACKAGE.name, source: FREE_SANS_NOBLE_PACKAGE.source,
    version: FREE_SANS_NOBLE_PACKAGE.version, architecture: FREE_SANS_NOBLE_PACKAGE.architecture,
  })) if (fields[key as keyof typeof fields] !== expected) throw new Error(`FreeSans package ${key} ${fields[key as keyof typeof fields]} != ${expected}`);
  const normalized = resolve(fontPath).replaceAll("\\", "/");
  if (!normalized.endsWith(`/${FREE_SANS_NOBLE_PACKAGE.fontPath}`)) throw new Error(`FreeSans path is not the authenticated package member: ${fontPath}`);
  return assertFile(fontPath, FREE_SANS_NOBLE_PACKAGE.fontByteLength, FREE_SANS_NOBLE_PACKAGE.fontSha256, "FreeSans.ttf");
}

interface IsolatedFontconfig {
  env: NodeJS.ProcessEnv;
  fontPath: string;
  version: string;
  configSha256: string;
  inventorySha256: string;
  entry: LinuxMathmlGreekPreterminalEvidence["inventory"]["entries"][number];
}

function isolatedFontconfig(fontBytes: Buffer, fontSource: string, artifactDir: string): IsolatedFontconfig {
  const root = resolve(artifactDir, "isolated-fontconfig"), fontDir = resolve(root, "fonts"), cacheDir = resolve(root, "cache");
  mkdirSync(fontDir, { recursive: true }); mkdirSync(cacheDir, { recursive: true });
  const fontPath = resolve(fontDir, "FreeSans.ttf");
  copyFileSync(fontSource, fontPath);
  assertFile(fontPath, FREE_SANS_NOBLE_PACKAGE.fontByteLength, FREE_SANS_NOBLE_PACKAGE.fontSha256, "isolated FreeSans.ttf");
  const config = `<?xml version="1.0"?><fontconfig><dir>${xml(fontDir)}</dir><cachedir>${xml(cacheDir)}</cachedir><config><rescan><int>0</int></rescan></config></fontconfig>`;
  const configPath = resolve(root, "fonts.conf"); writeFileSync(configPath, config);
  const env = { ...process.env, FONTCONFIG_FILE: configPath, FONTCONFIG_PATH: root };
  execFileSync("fc-cache", ["-f", fontDir], { env, stdio: "pipe" });
  // Fontconfig writes its version to stderr on Ubuntu Noble even though the
  // command succeeds. Authenticate the non-empty combined stream rather than
  // silently recording an empty fingerprint from stdout alone.
  const versionResult = spawnSync("fc-list", ["--version"], { env, encoding: "utf8" });
  if (versionResult.status !== 0) throw new Error(`fc-list --version failed: ${versionResult.stderr}`);
  const version = `${versionResult.stdout}${versionResult.stderr}`.trim();
  if (version.length === 0) throw new Error("fc-list --version returned no fingerprint");
  const lines = execFileSync("fc-list", ["-f", "%{file}\t%{family[0]}\t%{postscriptname}\t%{index}\n"], { env, encoding: "utf8" })
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`isolated Fontconfig inventory has ${lines.length} entries, expected one: ${JSON.stringify(lines)}`);
  const [listedPath, familyName, postscriptName, rawIndex] = lines[0].split("\t");
  if (resolve(listedPath) !== fontPath || familyName !== "FreeSans" || postscriptName !== "FreeSans" || Number(rawIndex) !== 0) {
    throw new Error(`isolated Fontconfig inventory mismatch: ${lines[0]}`);
  }
  const entry = {
    path: fontPath, byteLength: fontBytes.length, sha256: sha256(fontBytes), familyName: "FreeSans" as const,
    postscriptName: "FreeSans" as const, faceIndex: 0 as const,
  };
  return { env, fontPath, version, configSha256: sha256(config), inventorySha256: sha256(JSON.stringify(entry)), entry };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function byAnimId(nodes: CapturedElement[], id: string): CapturedElement | null {
  for (const node of nodes) {
    if (node.animId === id) return node;
    const child = byAnimId(node.children ?? [], id);
    if (child != null) return child;
  }
  return null;
}

function outlineIdentity(commands: Array<{ command: string; args: number[] }>): Pick<LinuxMathmlGreekGlyph, "outlineSha256" | "outlineCommandCount"> {
  if (commands.length === 0) throw new Error("FreeSans mathematical Greek glyph unexpectedly has no outline");
  return { outlineSha256: sha256(JSON.stringify(commands)), outlineCommandCount: commands.length };
}

function verifyFontAndSubsets(fontBytes: Buffer): { hinted: Buffer; unhinted: Buffer } {
  const opened: any = fontkit.create(fontBytes);
  const metadata = {
    familyName: opened.familyName, postscriptName: opened.postscriptName, unitsPerEm: opened.unitsPerEm,
    ascent: opened.ascent, descent: opened.descent, lineGap: opened.lineGap, glyphCount: opened.numGlyphs,
  };
  for (const [key, expected] of Object.entries({
    familyName: FREE_SANS_NOBLE_PACKAGE.familyName, postscriptName: FREE_SANS_NOBLE_PACKAGE.postscriptName,
    unitsPerEm: FREE_SANS_NOBLE_PACKAGE.unitsPerEm, ascent: FREE_SANS_NOBLE_PACKAGE.ascent,
    descent: FREE_SANS_NOBLE_PACKAGE.descent, lineGap: FREE_SANS_NOBLE_PACKAGE.lineGap, glyphCount: FREE_SANS_NOBLE_PACKAGE.glyphCount,
  })) if (metadata[key as keyof typeof metadata] !== expected) throw new Error(`FreeSans ${key} ${metadata[key as keyof typeof metadata]} != ${expected}`);
  for (const token of LINUX_MATHML_GREEK_TOKENS) {
    const glyph = opened.glyphForCodePoint(token.transformedCodePoint);
    const actual = { gid: glyph.id, cluster: 0, advanceX: glyph.advanceWidth, advanceY: 0, offsetX: 0, offsetY: 0, ...outlineIdentity(glyph.path.commands) };
    if (JSON.stringify(actual) !== JSON.stringify(token.glyph)) throw new Error(`${token.id}: authenticated FreeSans glyph facts drifted`);
  }
  const hinted = hbSubsetRetainGids(fontBytes, [...LINUX_MATHML_GREEK_SUBSETS.gids], 0, true, null);
  const unhinted = hbSubsetRetainGids(fontBytes, [...LINUX_MATHML_GREEK_SUBSETS.gids], 0, false, null);
  assertSubset(hinted, LINUX_MATHML_GREEK_SUBSETS.hinted, "hinted");
  assertSubset(unhinted, LINUX_MATHML_GREEK_SUBSETS.unhinted, "unhinted");
  return { hinted, unhinted };
}

function assertSubset(bytes: Buffer, expected: { byteLength: number; sha256: string }, label: string): void {
  if (bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) throw new Error(`${label} FreeSans subset identity drifted`);
  const opened: any = fontkit.create(bytes);
  for (const token of LINUX_MATHML_GREEK_TOKENS) {
    const glyph = opened.getGlyph(token.glyph.gid);
    const actual = { gid: glyph.id, advanceX: glyph.advanceWidth, ...outlineIdentity(glyph.path.commands) };
    if (actual.gid !== token.glyph.gid || actual.advanceX !== token.glyph.advanceX
      || actual.outlineSha256 !== token.glyph.outlineSha256 || actual.outlineCommandCount !== token.glyph.outlineCommandCount) {
      throw new Error(`${label} subset changed retained ${token.id} gid/advance/outline identity`);
    }
  }
}

function sourceDocument(): string {
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:#fff;color:#000}body{font-family:${LINUX_MATHML_GREEK_CELL.bodyFontFamily}}math{position:absolute;left:48px;top:52px;font-size:${LINUX_MATHML_GREEK_CELL.fontSizePx}px;color:#000}</style><math id="cell"><mrow>${LINUX_MATHML_GREEK_TOKENS.map((token) => `<mi id="${token.id}" data-domotion-anim="${token.id}">${token.source}</mi>`).join("")}</mrow></math>`;
}

async function cdpFonts(page: Page, ids: string[]): Promise<Map<string, { familyName: string; postscriptName: string; isCustomFont: boolean; glyphCount: number }>> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable"); await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const out = new Map<string, { familyName: string; postscriptName: string; isCustomFont: boolean; glyphCount: number }>();
    for (const id of ids) {
      const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
      const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
      const painted = fonts.filter((font) => font.glyphCount > 0);
      if (painted.length !== 1) throw new Error(`${id}: expected one painted face, found ${JSON.stringify(painted)}`);
      out.set(id, { familyName: painted[0].familyName, postscriptName: painted[0].postScriptName, isCustomFont: painted[0].isCustomFont, glyphCount: painted[0].glyphCount });
    }
    return out;
  } finally { await session.detach(); }
}

async function sourceEvidence(page: Page, packagePath: string, fontconfig: IsolatedFontconfig, fontBytes: Buffer): Promise<LinuxMathmlGreekPreterminalEvidence> {
  await page.setContent(sourceDocument(), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const dom = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const element = document.getElementById(id)!;
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = range.getBoundingClientRect(), style = getComputedStyle(element);
    return [id, { source: element.textContent ?? "", textTransform: style.textTransform, fontStyle: style.fontStyle, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
  })), LINUX_MATHML_GREEK_TOKENS.map((token) => token.id)) as Record<string, { source: string; textTransform: string; fontStyle: string; rect: { x: number; y: number; width: number; height: number } }>;
  const faces = await cdpFonts(page, LINUX_MATHML_GREEK_TOKENS.map((token) => token.id));
  const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height });
  const opened: any = fontkit.create(fontBytes);
  const tokens = LINUX_MATHML_GREEK_TOKENS.map((expected) => {
    const node = byAnimId(tree, expected.id);
    if (node == null) throw new Error(`${expected.id}: capture tree omitted MathML token`);
    if (node.text.trim() !== expected.transformed) throw new Error(`${expected.id}: capture math-auto produced ${JSON.stringify(node.text)} instead of ${expected.transformed}`);
    const textTop = node.textTop ?? node.y, fontAscent = node.fontAscent;
    if (fontAscent == null || !Number.isFinite(fontAscent) || fontAscent <= 0) throw new Error(`${expected.id}: capture omitted exact font ascent`);
    const face = faces.get(expected.id)!;
    const glyph = opened.glyphForCodePoint(expected.transformedCodePoint);
    return {
      id: expected.id, source: dom[expected.id].source, transformed: node.text.trim(), sourceCodePoint: expected.sourceCodePoint,
      transformedCodePoint: expected.transformedCodePoint, textTransform: dom[expected.id].textTransform as "math-auto",
      computedFontStyle: dom[expected.id].fontStyle as "normal",
      geometry: {
        x: node.textLeft ?? dom[expected.id].rect.x, y: node.textTop ?? dom[expected.id].rect.y,
        width: node.textWidth ?? dom[expected.id].rect.width, height: node.textHeight ?? dom[expected.id].rect.height,
        textTop, fontAscent, baseline: textTop + fontAscent, matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      },
      nativeFace: face,
      glyph: { gid: glyph.id, cluster: 0, advanceX: glyph.advanceWidth, advanceY: 0, offsetX: 0, offsetY: 0, ...outlineIdentity(glyph.path.commands) },
    };
  });
  return {
    schemaVersion: 1,
    package: {
      suite: FREE_SANS_NOBLE_PACKAGE.suite, name: FREE_SANS_NOBLE_PACKAGE.name, source: FREE_SANS_NOBLE_PACKAGE.source,
      version: FREE_SANS_NOBLE_PACKAGE.version, architecture: FREE_SANS_NOBLE_PACKAGE.architecture,
      filename: FREE_SANS_NOBLE_PACKAGE.filename, byteLength: FREE_SANS_NOBLE_PACKAGE.byteLength, sha256: FREE_SANS_NOBLE_PACKAGE.sha256,
    },
    inventory: { fontconfigVersion: fontconfig.version, configSha256: fontconfig.configSha256, inventorySha256: fontconfig.inventorySha256, entries: [fontconfig.entry] },
    sourceFont: {
      packagePath: FREE_SANS_NOBLE_PACKAGE.fontPath, runtimePath: fontconfig.fontPath,
      byteLength: fontBytes.length, sha256: sha256(fontBytes), familyName: opened.familyName, postscriptName: opened.postscriptName,
      faceIndex: 0, unitsPerEm: opened.unitsPerEm, ascent: opened.ascent, descent: opened.descent, lineGap: opened.lineGap, glyphCount: opened.numGlyphs,
    },
    subset: {
      retainedGids: [...LINUX_MATHML_GREEK_SUBSETS.gids] as [0, 6548, 6549, 6555, 6563],
      hinted: { ...LINUX_MATHML_GREEK_SUBSETS.hinted }, unhinted: { ...LINUX_MATHML_GREEK_SUBSETS.unhinted },
    },
    tokens,
  };
}

function parseBaseline(markup: string): number {
  const match = /<g\s+transform="translate\(\s*[-+.\deE]+(?:\s*,\s*|\s+)([-+.\deE]+)\)/.exec(markup);
  if (match == null) throw new Error("production paths markup omitted baseline translation");
  return Number(match[1]);
}

function actualPaths(preterminal: LinuxMathmlGreekPreterminalEvidence, fontBytes: Buffer): { markup: string; defs: string; logical: LinuxMathmlGreekRasterRow["pathsLogical"] } {
  clearWebfonts(); clearGlyphDefs(); resetTextRunProvenance();
  registerWebfont(UNIQUE_PATHS_FAMILY, 400, "normal", fontBytes, undefined, undefined, "400", "normal");
  setRenderTextMode("paths"); setTextRunProvenanceEnabled(true);
  const fragments = preterminal.tokens.map((token) => renderTextAsPath(token.transformed, token.geometry.x, token.geometry.textTop, {
    fontSize: LINUX_MATHML_GREEK_CELL.fontSizePx, fontFamily: UNIQUE_PATHS_FAMILY,
    fontWeight: "400", fontStyle: "normal", ascentOverride: token.geometry.fontAscent, fill: "#000", lang: "en",
  }));
  const snapshot = getTextRunProvenance();
  if (snapshot.runs.length !== LINUX_MATHML_GREEK_TOKENS.length || snapshot.transitions.length !== LINUX_MATHML_GREEK_TOKENS.length
    || snapshot.transitions.some((transition) => transition.kind !== "paths-succeeded")) {
    throw new Error(`production paths terminal was not exact: ${JSON.stringify(snapshot)}`);
  }
  const selected = getFontInstance(`webfont:${UNIQUE_PATHS_FAMILY.toLowerCase()}`, 400, LINUX_MATHML_GREEK_CELL.fontSizePx, 0, {});
  if (selected?.webfontBuffer == null || sha256(selected.webfontBuffer) !== FREE_SANS_NOBLE_PACKAGE.fontSha256) throw new Error("production paths selected bytes are not authenticated FreeSans");
  const tokens = preterminal.tokens.map((source, index) => {
    const run = snapshot.runs[index], glyph = run?.glyphs[0];
    if (run == null || glyph == null || run.sourceText !== source.transformed || run.glyphs.length !== 1 || run.shapeError != null
      || run.emitter !== "paths" || run.finalRepresentation !== "svg-paths" || glyph.sourceOutline == null) throw new Error(`${source.id}: malformed production path provenance`);
    return {
      id: source.id,
      glyph: { gid: glyph.id, cluster: glyph.cluster, advanceX: glyph.xAdvance, advanceY: glyph.yAdvance, offsetX: glyph.xOffset, offsetY: glyph.yOffset, outlineSha256: glyph.sourceOutline.sha256, outlineCommandCount: glyph.sourceOutline.commandCount },
      baseline: parseBaseline(fragments[index]), matrix: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    };
  });
  return {
    markup: fragments.join(""), defs: getGlyphDefs(),
    logical: {
      sourceSha256: FREE_SANS_NOBLE_PACKAGE.fontSha256, faceIndex: 0, postscriptName: "FreeSans",
      subsetHintedSha256: LINUX_MATHML_GREEK_SUBSETS.hinted.sha256, subsetUnhintedSha256: LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256,
      tokens,
    },
  };
}

async function screenshotMarkup(page: Page, markup: string): Promise<Buffer> {
  await page.setContent(`<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:#fff}</style>${markup}`, { waitUntil: "load" });
  return page.screenshot({ type: "png" });
}

function pathsSvg(markup: string, defs: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}" viewBox="0 0 ${VIEWPORT.width} ${VIEWPORT.height}"><rect width="100%" height="100%" fill="#fff"/><defs>${defs}</defs>${markup}</svg>`;
}

async function hintingOffArm(page: Page, preterminal: LinuxMathmlGreekPreterminalEvidence, unhinted: Buffer): Promise<{ png: Buffer; evidence: LinuxMathmlGreekRasterRow["hintingControl"] }> {
  const face = `@font-face{font-family:'${UNIQUE_UNHINTED_FAMILY}';src:url(data:font/ttf;base64,${unhinted.toString("base64")}) format('truetype');font-style:normal;font-weight:400;font-display:block}`;
  const texts = preterminal.tokens.map((token) => `<text id="hint-${token.id}" x="${token.geometry.x}" y="${token.geometry.baseline}" fill="#000" style="font-family:'${UNIQUE_UNHINTED_FAMILY}';font-size:${LINUX_MATHML_GREEK_CELL.fontSizePx}px;font-weight:400;font-style:normal">${html(token.transformed)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}" viewBox="0 0 ${VIEWPORT.width} ${VIEWPORT.height}"><rect width="100%" height="100%" fill="#fff"/>${texts}</svg>`;
  await page.setContent(`<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:#fff}${face}</style>${svg}`, { waitUntil: "load" });
  const loaded = await page.evaluate(async ({ family, text }) => { await document.fonts.ready; await document.fonts.load(`24px '${family}'`, text); return document.fonts.check(`24px '${family}'`, text); }, { family: UNIQUE_UNHINTED_FAMILY, text: LINUX_MATHML_GREEK_TOKENS.map((token) => token.transformed).join("") });
  if (!loaded) throw new Error("browser did not load the authenticated unhinted subset");
  const faces = await cdpFonts(page, LINUX_MATHML_GREEK_TOKENS.map((token) => `hint-${token.id}`));
  const pageFacts = await page.locator("#hint-alpha").evaluate((element) => {
    const rules: CSSFontFaceRule[] = [];
    for (const sheet of Array.from(document.styleSheets)) for (const rule of Array.from(sheet.cssRules)) if (rule.constructor.name === "CSSFontFaceRule") rules.push(rule as CSSFontFaceRule);
    return {
      requestedFamily: (element as SVGElement).style.fontFamily.trim().replace(/^(\"|')(.*)\1$/, "$2"),
      computedFamily: getComputedStyle(element).fontFamily.trim().replace(/^(\"|')(.*)\1$/, "$2"),
      fontFaceRuleFamily: (rules[0]?.style.getPropertyValue("font-family") ?? "").trim().replace(/^(\"|')(.*)\1$/, "$2"),
      fontFaceRuleCount: rules.length,
      source: rules[0]?.style.getPropertyValue("src") ?? "",
    };
  });
  const base64 = /base64,([A-Za-z0-9+/=]+)/.exec(pageFacts.source)?.[1] ?? "";
  if (sha256(Buffer.from(base64, "base64")) !== LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256) throw new Error("hinting-off browser source bytes are unauthenticated");
  const logicalTokens = preterminal.tokens.map((token) => ({ id: token.id, glyph: token.glyph, baseline: token.geometry.baseline, matrix: token.geometry.matrix }));
  return {
    png: await page.screenshot({ type: "png" }),
    evidence: {
      requestedFamily: pageFacts.requestedFamily, computedFamily: pageFacts.computedFamily,
      fontFaceRuleFamily: pageFacts.fontFaceRuleFamily, fontFaceRuleCount: pageFacts.fontFaceRuleCount as 1,
      sourceSha256: LINUX_MATHML_GREEK_SUBSETS.unhinted.sha256, sourceByteLength: unhinted.length,
      isCustomFont: [...faces.values()].every((entry) => entry.isCustomFont), glyphCount: [...faces.values()].reduce((sum, entry) => sum + entry.glyphCount, 0) as 4,
      tokens: logicalTokens,
    },
  };
}

function artifact(root: string, dir: string, name: string, bytes: Buffer): LinuxMathmlGreekRasterRow["nativeArtifact"] {
  const absolute = resolve(dir, name), relativePath = relative(root, absolute).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath.includes("/../")) throw new Error(`artifact directory escapes observation root: ${dir}`);
  writeFileSync(absolute, bytes);
  return { path: relativePath, sha256: sha256(bytes), width: VIEWPORT.width, height: VIEWPORT.height };
}

function runnerBootIdSha256(): string {
  const path = "/proc/sys/kernel/random/boot_id";
  if (!existsSync(path)) throw new Error("Linux runner omitted its boot id; independent proposal/validation ownership cannot be proved");
  const value = readFileSync(path, "utf8").trim();
  if (value === "") throw new Error("Linux runner boot id is empty");
  return sha256(value);
}

export interface CollectLinuxMathmlGreekOptions {
  debPath: string;
  fontPath: string;
  out: string;
  artifactDir: string;
  runLabel: "proposal" | "validation";
}

export async function collectLinuxMathmlGreekRaster(options: CollectLinuxMathmlGreekOptions): Promise<LinuxMathmlGreekRasterRow[]> {
  const fontSource = resolve(options.fontPath);
  const fontBytes = verifyPackage(resolve(options.debPath), fontSource);
  const subsets = verifyFontAndSubsets(fontBytes);
  const out = resolve(options.out), observationRoot = dirname(out), artifactDir = resolve(options.artifactDir);
  mkdirSync(observationRoot, { recursive: true }); mkdirSync(artifactDir, { recursive: true });
  const fontconfig = isolatedFontconfig(fontBytes, fontSource, artifactDir);
  const bootSha = runnerBootIdSha256();
  const browser = await chromium.launch({ headless: true, env: fontconfig.env });
  try {
    const browserCdp = await browser.newBrowserCDPSession(), browserVersion = await browserCdp.send("Browser.getVersion"); await browserCdp.detach();
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: "en-US" });
    const page = await context.newPage();
    try {
      const preterminal = await sourceEvidence(page, FREE_SANS_NOBLE_PACKAGE.fontPath, fontconfig, fontBytes);
      const nativePng = await page.screenshot({ type: "png" });
      const paths = actualPaths(preterminal, fontBytes);
      const pathsPng = await screenshotMarkup(page, pathsSvg(paths.markup, paths.defs));
      const hintingOff = await hintingOffArm(page, preterminal, subsets.unhinted);
      const residual = await measurePathsRasterResidual(nativePng, pathsPng);
      const hintingOffResidual = await measurePathsRasterResidual(nativePng, hintingOff.png);
      const sourceFiles = [
        "tools/linux-mathml-greek-raster-contract.ts", "tools/linux-mathml-greek-raster-collector.ts",
        "tools/linux-mathml-greek-raster-gate.ts", "tools/paths-native-raster-metrics.ts",
        ".github/workflows/linux-mathml-greek-raster-floor.yml",
      ];
      const executableSha256 = await sha256File(chromium.executablePath());
      const row: LinuxMathmlGreekRasterRow = {
        schemaVersion: 1, id: LINUX_MATHML_GREEK_CELL.id, runLabel: options.runLabel,
        runProvenance: {
          githubRunId: process.env.GITHUB_RUN_ID?.trim() || "local", githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() || "local",
          githubJob: process.env.GITHUB_JOB?.trim() || "local", runnerName: process.env.RUNNER_NAME?.trim() || `local-linux-${process.pid}`,
          runnerBootIdSha256: bootSha, workflowRef: process.env.GITHUB_WORKFLOW_REF?.trim() || "local",
        },
        cellSha256: linuxMathmlGreekCellSha256(),
        fingerprint: {
          platform: "linux", osImage: process.env.ImageOS?.trim() || `linux-${release()}`, osImageVersion: process.env.ImageVersion?.trim() || "unavailable",
          arch: arch(), osRelease: release(),
          chromium: browser.version(), chromiumRevision: browserVersion.revision, browserExecutableSha256: executableSha256,
          fontconfigVersion: fontconfig.version, fontconfigConfigSha256: fontconfig.configSha256, fontInventorySha256: fontconfig.inventorySha256,
          rendererSourceSha256: sourceInputsSha256(["src/capture/index.ts", "src/capture/script.generated.ts", "src/render/font-resolution.ts", "src/render/hb-subset.ts", "src/render/text-to-path.ts", "src/render/text-run-provenance.ts", "package-lock.json"]),
          oracleSourceSha256: sourceInputsSha256(sourceFiles),
          consumerRasterizer: `playwright-${PLAYWRIGHT_VERSION}/chromium-headless-linux`, playwrightVersion: PLAYWRIGHT_VERSION,
          nodeVersion: process.versions.node, icuVersion: process.versions.icu ?? "unavailable", sharpVersion: sharp.versions.sharp,
          libvipsVersion: sharp.versions.vips, metricAlgorithm: LINUX_MATHML_GREEK_CELL.metricAlgorithm,
          launchFlags: ["headless", "isolated-fontconfig"], locale: "en-US",
        },
        preterminal, pathsLogical: paths.logical, hintingControl: hintingOff.evidence,
        nativeArtifact: artifact(observationRoot, artifactDir, `${LINUX_MATHML_GREEK_CELL.id}-native.png`, nativePng),
        pathsArtifact: artifact(observationRoot, artifactDir, `${LINUX_MATHML_GREEK_CELL.id}-paths.png`, pathsPng),
        hintingOffArtifact: artifact(observationRoot, artifactDir, `${LINUX_MATHML_GREEK_CELL.id}-hinting-off.png`, hintingOff.png),
        residual, hintingOffResidual, warnings: [],
      };
      writeFileSync(out, JSON.stringify([row], null, 2));
      return [row];
    } finally {
      setTextRunProvenanceEnabled(false); setRenderTextMode("embedded-font"); clearWebfonts(); clearGlyphDefs(); resetTextRunProvenance();
      await context.close();
    }
  } finally { await browser.close(); }
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const debPath = arg("--deb"), fontPath = arg("--font"), out = arg("--out"), artifactDir = arg("--artifact-dir"), runLabel = arg("--run-label");
  if (debPath == null || fontPath == null || out == null || artifactDir == null || (runLabel !== "proposal" && runLabel !== "validation")) {
    throw new Error("usage: linux-mathml-greek-raster-collector --deb <fonts-freefont.deb> --font <FreeSans.ttf> --out <observations.json> --artifact-dir <dir> --run-label proposal|validation");
  }
  const rows = await collectLinuxMathmlGreekRaster({ debPath, fontPath, out, artifactDir, runLabel });
  console.log(`Collected ${rows.length} authenticated Linux FreeSans MathML Greek cell.`);
}
