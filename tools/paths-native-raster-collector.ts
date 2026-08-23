#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { arch, platform, release } from "node:os";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import * as fontkit from "fontkit";
import sharp from "sharp";

import {
  clearGlyphDefs,
  clearWebfonts,
  getFontInstance,
  getGlyphDefs,
  registerWebfont,
  renderTextAsPath,
  resetTextRunProvenance,
  setRenderTextMode,
  setTextRunProvenanceEnabled,
} from "../src/render/text-to-path.js";
import { getTextRunProvenance } from "../src/render/text-run-provenance.js";
import {
  loadPathsRasterFixtures,
  PATHS_NATIVE_RASTER_FEATURES,
  PATHS_NATIVE_RASTER_METRIC_ALGORITHM,
  PATHS_NATIVE_RASTER_ORIGIN,
  PATHS_NATIVE_RASTER_SKIA_SOURCE,
  PATHS_NATIVE_RASTER_SOURCE,
  PATHS_NATIVE_RASTER_VIEWPORT,
  pathsNativeRasterMatrix,
  pathsRasterCellSha256,
  pathsRasterFixtureInventorySha256,
  type LoadedPathsRasterFixture,
  type PathsRasterMatrixCell,
} from "./paths-native-raster-corpus.js";
import type { PathsRasterRow } from "./paths-native-raster-gate.js";
import { measurePathsRasterResidual } from "./paths-native-raster-metrics.js";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_VERSION = (require("@playwright/test/package.json") as { version: string }).version;
const VIEWPORT = PATHS_NATIVE_RASTER_VIEWPORT;
const ORIGIN_X = PATHS_NATIVE_RASTER_ORIGIN.x;
const BASELINE_Y = PATHS_NATIVE_RASTER_ORIGIN.baselineY;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function repositoryRevision(): string {
  const supplied = process.env.GITHUB_SHA?.trim();
  if (supplied != null && supplied !== "") return supplied;
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unavailable"; }
}

function runProvenance(): PathsRasterRow["runProvenance"] {
  return {
    githubRunId: process.env.GITHUB_RUN_ID?.trim() || "local",
    githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT?.trim() || "local",
    githubJob: process.env.GITHUB_JOB?.trim() || "local",
    runnerName: process.env.RUNNER_NAME?.trim() || `local-${platform()}-${process.pid}`,
    workflowRef: process.env.GITHUB_WORKFLOW_REF?.trim() || "local",
  };
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function cssFamily(id: string): string {
  return `DomotionPathsRaster_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function cssVariation(axes: Record<string, number>): string {
  const entries = Object.entries(axes);
  return entries.length === 0 ? "normal" : entries.map(([tag, value]) => `&quot;${html(tag)}&quot; ${value}`).join(", ");
}

function matrixAttribute(matrix: PathsRasterRow["expectedLogical"]["matrix"]): string {
  return `matrix(${matrix.join(" ")})`;
}

function fontMime(loaded: LoadedPathsRasterFixture): string {
  return loaded.tables.includes("glyf") ? "font/ttf" : "font/otf";
}

function fontFormat(loaded: LoadedPathsRasterFixture): string {
  return loaded.tables.includes("glyf") ? "truetype" : "opentype";
}

function fontFaceCss(family: string, loaded: LoadedPathsRasterFixture): string {
  const range = loaded.fixture.technology.startsWith("variable-") ? "100 900" : "400";
  return `@font-face{font-family:'${family}';src:url(data:${fontMime(loaded)};base64,${loaded.bytes.toString("base64")}) format('${fontFormat(loaded)}');font-style:normal;font-weight:${range};font-display:block}`;
}

export function logicalPaintedPostscriptName(sourcePostscript: string | null, paintedPostscript: string): { logical: string; sourceMatch: boolean } {
  const logical = sourcePostscript ?? paintedPostscript;
  return {
    logical,
    sourceMatch: paintedPostscript === logical || paintedPostscript.startsWith(`${logical}_`),
  };
}

function documentFor(body: string, family: string, loaded: LoadedPathsRasterFixture): string {
  return `<!doctype html><style>html,body{margin:0;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px;overflow:hidden;background:#fff}${fontFaceCss(family, loaded)}</style>${body}`;
}

async function paintedPostscriptName(page: Page): Promise<{ postscriptName: string; glyphCount: number; isCustomFont: boolean }> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#native" });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const painted = fonts.filter((font) => font.glyphCount > 0);
    if (painted.length !== 1 || painted[0].postScriptName.trim() === "") {
      throw new Error(`native arm painted ${painted.length} concrete faces: ${JSON.stringify(painted)}`);
    }
    return { postscriptName: painted[0].postScriptName, glyphCount: painted[0].glyphCount, isCustomFont: painted[0].isCustomFont };
  } finally {
    await cdp.detach();
  }
}

async function rasterize(page: Page, markup: string, family: string, loaded: LoadedPathsRasterFixture): Promise<Buffer> {
  await page.setContent(documentFor(markup, family, loaded), { waitUntil: "load" });
  const loadedFace = await page.evaluate(async ({ name, text }) => {
    await document.fonts.ready;
    await document.fonts.load(`16px '${name}'`, text);
    return document.fonts.check(`16px '${name}'`, text);
  }, { name: family, text: loaded.fixture.text });
  if (!loadedFace) throw new Error(`${loaded.fixture.technology}: browser did not load the fixture face`);
  return page.screenshot({ type: "png" });
}

function outlineIdentity(commands: Array<{ command: string; args: number[] }>): { outlineSha256: string; outlineCommandCount: number } {
  if (commands.length === 0) throw new Error("paths/native fixture glyph unexpectedly has no source outline");
  return { outlineSha256: sha256(JSON.stringify(commands)), outlineCommandCount: commands.length };
}

function expectedGlyphs(loaded: LoadedPathsRasterFixture, cell: PathsRasterMatrixCell): PathsRasterRow["expectedLogical"]["glyphs"] {
  const base: any = fontkit.create(loaded.bytes);
  const outlineFace: any = Object.keys(cell.variationAxes).length > 0 && typeof base.getVariation === "function"
    ? base.getVariation(cell.variationAxes)
    : base;
  let cluster = 0;
  return [...loaded.fixture.text].map((character) => {
    const glyph = outlineFace.glyphForCodePoint(character.codePointAt(0)!);
    const result = {
      gid: glyph.id,
      cluster,
      // HarfBuzz exposes the variable HVAR result in integer font units at
      // this unscaled logical boundary; fontkit retains the interpolation
      // fraction. Round the authenticated source-table value before comparing
      // it with the production HB stream (static advances are already ints).
      advanceX: Math.round(glyph.advanceWidth),
      advanceY: 0,
      offsetX: 0,
      offsetY: 0,
      ...outlineIdentity(glyph.path.commands),
    };
    cluster += character.length;
    return result;
  });
}

export function rendererPlacementFromMarkup(
  pathsMarkup: string,
  pathsSvg: string,
): { baseline: number; matrix: PathsRasterRow["actualLogical"]["matrix"]; paintPlan: PathsRasterRow["actualLogical"]["paintPlan"] } {
  const baselineMatch = /<g\s+transform="translate\(\s*[-+.\deE]+(?:\s*,\s*|\s+)([-+.\deE]+)\)/.exec(pathsMarkup);
  if (baselineMatch == null) throw new Error("renderer markup omitted its baseline translation");
  const matrixMatch = /<g\s+transform="matrix\(([^\"]+)\)"/.exec(pathsSvg);
  if (matrixMatch == null) throw new Error("paths SVG omitted its declared outer matrix");
  const values = matrixMatch[1].trim().split(/[\s,]+/).map(Number);
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) throw new Error("paths SVG has a malformed outer matrix");
  return {
    baseline: Number(baselineMatch[1]),
    matrix: values as PathsRasterRow["actualLogical"]["matrix"],
    paintPlan: { syntheticBold: /\sstroke-width="/.test(pathsMarkup), syntheticOblique: /\smatrix\(1,0,-0\.25,1,0,0\)/.test(pathsMarkup) },
  };
}

function actualGlyphs(cell: PathsRasterMatrixCell, family: string): {
  glyphs: PathsRasterRow["actualLogical"]["glyphs"];
  postscriptName: string;
  sourceSha256: string;
  faceIndex: number;
  variationAxes: Record<string, number>;
  warnings: string[];
} {
  const snapshot = getTextRunProvenance();
  const warnings: string[] = [];
  if (snapshot.transitions.length !== 1 || snapshot.transitions[0].kind !== "paths-succeeded") warnings.push(`path transition: ${JSON.stringify(snapshot.transitions)}`);
  if (snapshot.runs.length !== 1) throw new Error(`${cell.id}: expected one production path run, found ${snapshot.runs.length}`);
  const run = snapshot.runs[0];
  if (run.emitter !== "paths" || run.finalRepresentation !== "svg-paths" || run.shapeError != null) warnings.push(`path run did not terminate exactly: ${run.shapeError ?? run.finalRepresentation}`);
  const expectedFontKey = `webfont:${family.toLowerCase()}`;
  if (run.selected.fontKey !== expectedFontKey) warnings.push(`production selected ${run.selected.fontKey}, expected ${expectedFontKey}`);
  const postscriptName = run.selected.instantiatedPostscriptName ?? run.selected.postscriptName ?? "";
  const selected = getFontInstance(
    run.selected.fontKey,
    run.request.fontWeight,
    run.request.fontSizePx,
    0,
    run.request.variationSettings,
  );
  const sourceBytes = selected?.webfontBuffer;
  if (sourceBytes == null) throw new Error(`${cell.id}: selected production webfont omitted its registered source bytes`);
  if (sourceBytes.subarray(0, 4).toString("ascii") === "ttcf") throw new Error(`${cell.id}: fixture unexpectedly selected a collection member without a source-owned face index`);
  const glyphs = run.glyphs.map((glyph) => ({
    gid: glyph.id,
    cluster: glyph.cluster,
    advanceX: glyph.xAdvance,
    advanceY: glyph.yAdvance,
    offsetX: glyph.xOffset,
    offsetY: glyph.yOffset,
    ...(glyph.sourceOutline == null
      ? (() => { throw new Error(`${cell.id}: production glyph ${glyph.id} omitted its source outline identity`); })()
      : { outlineSha256: glyph.sourceOutline.sha256, outlineCommandCount: glyph.sourceOutline.commandCount }),
  }));
  return {
    glyphs,
    postscriptName,
    sourceSha256: sha256(sourceBytes),
    faceIndex: 0,
    variationAxes: { ...(run.request.variationSettings ?? {}) },
    warnings,
  };
}

function artifactPath(observationRoot: string, artifactDir: string, filename: string): { absolute: string; relative: string } {
  const absolute = resolve(artifactDir, filename);
  const rel = relative(observationRoot, absolute).replaceAll("\\", "/");
  if (rel === "" || rel.startsWith("../") || rel.includes("/../") || resolve(observationRoot, rel) !== absolute) {
    throw new Error(`artifact directory must be inside the observation root: ${artifactDir}`);
  }
  return { absolute, relative: rel };
}

async function collectCell(
  browser: Browser,
  loaded: LoadedPathsRasterFixture,
  cell: PathsRasterMatrixCell,
  fingerprint: PathsRasterRow["fingerprint"],
  observationRoot: string,
  artifactDir: string,
  runLabel: PathsRasterRow["runLabel"],
): Promise<PathsRasterRow> {
  const family = cssFamily(cell.id);
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: cell.dimensions.deviceScaleFactor, locale: fingerprint.locale });
  const page = await context.newPage();
  try {
    const variation = cssVariation(cell.variationAxes);
    const group = matrixAttribute(cell.matrix);
    const nativeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}" viewBox="0 0 ${VIEWPORT.width} ${VIEWPORT.height}"><rect width="100%" height="100%" fill="#fff"/><g transform="${group}"><text id="native" x="${ORIGIN_X}" y="${BASELINE_Y}" fill="#000" style="font-family:'${family}';font-size:${cell.dimensions.fontSizePx}px;font-weight:${cell.dimensions.weight};font-style:normal;font-variation-settings:${variation};font-kerning:none;font-feature-settings:'kern' 0,'liga' 0,'clig' 0">${html(loaded.fixture.text)}</text></g></svg>`;
    const native = await rasterize(page, nativeSvg, family, loaded);
    const painted = await paintedPostscriptName(page);

    clearWebfonts(); clearGlyphDefs(); resetTextRunProvenance();
    registerWebfont(family, 400, "normal", loaded.bytes, undefined, undefined,
      loaded.fixture.technology.startsWith("variable-") ? "100 900" : "400", "normal");
    setRenderTextMode("paths"); setTextRunProvenanceEnabled(true);
    const ascent = loaded.ascent * cell.dimensions.fontSizePx / loaded.unitsPerEm;
    const pathsMarkup = renderTextAsPath(loaded.fixture.text, ORIGIN_X, BASELINE_Y - ascent, {
      fontSize: cell.dimensions.fontSizePx,
      fontFamily: family,
      fontWeight: String(cell.dimensions.weight),
      fontStyle: "normal",
      variationSettings: cell.variationAxes,
      features: [...PATHS_NATIVE_RASTER_FEATURES],
      ascentOverride: ascent,
      fill: "#000",
      lang: "en",
    });
    const actual = actualGlyphs(cell, family);
    const defs = getGlyphDefs();
    const pathsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEWPORT.width}" height="${VIEWPORT.height}" viewBox="0 0 ${VIEWPORT.width} ${VIEWPORT.height}"><rect width="100%" height="100%" fill="#fff"/><defs>${defs}</defs><g transform="${group}">${pathsMarkup}</g></svg>`;
    const rendererPlacement = rendererPlacementFromMarkup(pathsMarkup, pathsSvg);
    const paths = await rasterize(page, pathsSvg, family, loaded);
    const residual = await measurePathsRasterResidual(native, paths);
    const nativePath = artifactPath(observationRoot, artifactDir, `${cell.id}-native.png`);
    const pathsPath = artifactPath(observationRoot, artifactDir, `${cell.id}-paths.png`);
    writeFileSync(nativePath.absolute, native); writeFileSync(pathsPath.absolute, paths);

    const expected = expectedGlyphs(loaded, cell);
    const warnings = [...actual.warnings];
    if (painted.glyphCount !== expected.length) warnings.push(`painted glyph count ${painted.glyphCount} != HarfBuzz ${expected.length}`);
    if (!painted.isCustomFont) warnings.push("native arm did not report the pinned data-URL face as a custom font");
    if (actual.postscriptName === "") warnings.push("production path run omitted PostScript identity");
    // Blink gives some variable instances a generated PostScript suffix whose
    // encoded coordinates are already represented exactly by variationAxes.
    // The logical face name stays the source face's PostScript name; require
    // the painted name to be that name or a Blink-generated instance of it.
    const paintedIdentity = logicalPaintedPostscriptName(loaded.postscriptName, painted.postscriptName);
    const logicalPostscript = paintedIdentity.logical;
    if (!paintedIdentity.sourceMatch) {
      warnings.push(`painted PostScript ${painted.postscriptName} is not source face ${logicalPostscript}`);
    }
    const actualPostscript = actual.postscriptName || logicalPostscript;
    const expectedPaintPlan = {
      syntheticBold: !cell.fixture.technology.startsWith("variable-") && cell.dimensions.weight >= 600,
      syntheticOblique: false,
    };
    return {
      id: cell.id,
      runLabel,
      runProvenance: runProvenance(),
      cellSha256: pathsRasterCellSha256(cell),
      fingerprint,
      dimensions: cell.dimensions,
      expectedLogical: {
        postscriptName: logicalPostscript,
        sourceSha256: loaded.sha256,
        faceIndex: 0,
        variationAxes: cell.variationAxes,
        glyphs: expected,
        baseline: BASELINE_Y,
        matrix: cell.matrix,
        paintPlan: expectedPaintPlan,
      },
      actualLogical: {
        postscriptName: actualPostscript,
        sourceSha256: actual.sourceSha256,
        faceIndex: actual.faceIndex,
        variationAxes: actual.variationAxes,
        glyphs: actual.glyphs,
        baseline: rendererPlacement.baseline,
        matrix: rendererPlacement.matrix,
        paintPlan: rendererPlacement.paintPlan,
      },
      residual,
      nativeArtifact: { path: nativePath.relative, sha256: sha256(native), width: VIEWPORT.width * cell.dimensions.deviceScaleFactor, height: VIEWPORT.height * cell.dimensions.deviceScaleFactor },
      pathsArtifact: { path: pathsPath.relative, sha256: sha256(paths), width: VIEWPORT.width * cell.dimensions.deviceScaleFactor, height: VIEWPORT.height * cell.dimensions.deviceScaleFactor },
      warnings,
    };
  } finally {
    setTextRunProvenanceEnabled(false); clearWebfonts(); clearGlyphDefs(); resetTextRunProvenance();
    await context.close();
  }
}

export interface CollectPathsRasterOptions {
  fontRoot: string;
  out: string;
  artifactDir: string;
  dpr?: 1 | 2;
  runLabel?: PathsRasterRow["runLabel"];
}

export async function collectPathsNativeRaster(options: CollectPathsRasterOptions): Promise<PathsRasterRow[]> {
  const out = resolve(options.out), observationRoot = dirname(out), artifactDir = resolve(options.artifactDir);
  mkdirSync(observationRoot, { recursive: true }); mkdirSync(artifactDir, { recursive: true });
  const fixtures = loadPathsRasterFixtures(resolve(options.fontRoot));
  const byTechnology = new Map(fixtures.map((fixture) => [fixture.fixture.technology, fixture]));
  const browser = await chromium.launch({ headless: true });
  try {
    const browserCdp = await browser.newBrowserCDPSession();
    const browserVersion = await browserCdp.send("Browser.getVersion");
    await browserCdp.detach();
    const executableSha256 = await sha256File(chromium.executablePath());
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    const fingerprint: PathsRasterRow["fingerprint"] = {
      platform: platform() as PathsRasterRow["fingerprint"]["platform"],
      osImage: process.env.ImageOS?.trim() || `${platform()}-${release()}`,
      osImageVersion: process.env.ImageVersion?.trim() || "unavailable",
      arch: arch(),
      osRelease: release(),
      chromium: browser.version(),
      chromiumRevision: browserVersion.revision,
      browserExecutableSha256: executableSha256,
      skia: `browser-binary:${executableSha256}`,
      harfbuzz: `browser-binary:${executableSha256}`,
      oracleSkiaRevision: PATHS_NATIVE_RASTER_SKIA_SOURCE,
      oracleHarfbuzzRevision: PATHS_NATIVE_RASTER_SOURCE.revision,
      fontInventorySha256: pathsRasterFixtureInventorySha256(fixtures),
      rendererRevision: repositoryRevision(),
      consumerRasterizer: `playwright-${PLAYWRIGHT_VERSION}/chromium-svg-headless`,
      playwrightVersion: PLAYWRIGHT_VERSION,
      nodeVersion: process.versions.node,
      icuVersion: process.versions.icu ?? "unavailable",
      sharpVersion: sharp.versions.sharp,
      libvipsVersion: sharp.versions.vips,
      metricAlgorithm: PATHS_NATIVE_RASTER_METRIC_ALGORITHM,
      launchFlags: ["headless"],
      locale,
    };
    if (!["darwin", "linux", "win32"].includes(fingerprint.platform)) throw new Error(`unsupported platform ${fingerprint.platform}`);
    const cells = pathsNativeRasterMatrix().filter((cell) => options.dpr == null || cell.dimensions.deviceScaleFactor === options.dpr);
    const rows: PathsRasterRow[] = [];
    for (const cell of cells) {
      const loaded = byTechnology.get(cell.fixture.technology);
      if (loaded == null) throw new Error(`${cell.id}: fixture was not loaded`);
      rows.push(await collectCell(browser, loaded, cell, fingerprint, observationRoot, artifactDir, options.runLabel ?? "proposal"));
      process.stdout.write(`${cell.id}: logical evidence and lossless pair collected\n`);
    }
    writeFileSync(out, JSON.stringify(rows, null, 2));
    return rows;
  } finally {
    await browser.close();
  }
}

function cliArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fontRoot = cliArg("--font-root"), out = cliArg("--out"), artifactDir = cliArg("--artifact-dir");
  if (fontRoot == null || out == null || artifactDir == null) throw new Error("usage: paths-native-raster-collector --font-root <dir> --out <observations.json> --artifact-dir <dir> [--dpr 1|2] [--run-label proposal|validation]");
  const rawDpr = cliArg("--dpr");
  const dpr = rawDpr == null ? undefined : Number(rawDpr);
  if (dpr != null && dpr !== 1 && dpr !== 2) throw new Error("--dpr must be 1 or 2");
  const runLabel = cliArg("--run-label") ?? "proposal";
  if (runLabel !== "proposal" && runLabel !== "validation") throw new Error("--run-label must be proposal or validation");
  const rows = await collectPathsNativeRaster({ fontRoot, out, artifactDir, runLabel, ...(dpr == null ? {} : { dpr: dpr as 1 | 2 }) });
  console.log(`Collected ${rows.length} paths/native rows on ${platform()}/${arch()}.`);
}
