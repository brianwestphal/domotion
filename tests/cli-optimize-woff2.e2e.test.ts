import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * The `--optimize` chain as a user actually runs it: `domotion capture` on a
 * real page, whose default `embedded-font` text mode embeds sfnt subsets as
 * `@font-face` data URIs and whose repeated `<img>` payloads are hoisted into
 * `<use href="#dmiN">` references, then `compressEmbeddedFontsToWoff2(optimizeSvg(svg))`.
 * The unit tests cover each pass on synthetic input; this drives the CLI end to
 * end and checks the three things that can only go wrong in combination:
 *
 *  - the embedded fonts come out as WOFF2 (`data:font/woff2`), with no raw
 *    sfnt payload left behind;
 *  - svgo keeps every hoisted `dmiN` def that a `<use>` references (a pass that
 *    renames or prunes ids would leave dangling references and invisible images);
 *  - the optimized document still PAINTS like the unoptimized one when a
 *    consumer loads it through `<img>`, so a WOFF2 the browser rejects (which
 *    would silently fall back to a system font) or a broken reference shows up
 *    as a pixel difference rather than passing on markup alone.
 *
 * `.svgz` output implies `--optimize` plus gzip, so the same assertions run on
 * the gunzipped `.svgz` too.
 *
 * The CLI is spawned as a child process: the built `dist/cli/index.js` when it
 * exists (so a local `npm run build && npm run test:e2e` exercises the shipped
 * artifact), else the TypeScript entry through tsx, because CI's e2e jobs do not
 * build `dist/` and would otherwise skip the test entirely.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DIST_CLI = resolve(REPO_ROOT, "dist/cli/index.js");
const SRC_CLI = resolve(REPO_ROOT, "src/cli/index.ts");
const CLI_ARGV = existsSync(DIST_CLI) ? [DIST_CLI] : ["--import", "tsx", SRC_CLI];

const WIDTH = 600;
const HEIGHT = 260;

async function canLaunch(): Promise<Browser | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}
const browser = await canLaunch();
let page: Page | null = null;
if (browser != null) {
  page = await (
    await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 })
  ).newPage();
}

/** 48×48 noise, so its data URI clears the hoisting pass's payload-size floor. */
async function noisePng(): Promise<string> {
  const raw = Buffer.alloc(48 * 48 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) % 251;
  const png = await sharp(raw, { raw: { width: 48, height: 48, channels: 3 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

const dir = mkdtempSync(join(tmpdir(), "domotion-cli-optimize-"));
const htmlPath = join(dir, "page.html");
const img = await noisePng();
writeFileSync(
  htmlPath,
  `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0}
  body{background:#fff;color:#111;padding:20px;font:32px Helvetica, Arial, sans-serif}
  .serif{font-family:Georgia, "Times New Roman", serif}
  img{width:48px;height:48px;margin-right:8px}
</style></head><body>
  <p>Hello optimize</p>
  <p class="serif">Serif text line</p>
  <img src="${img}"><img src="${img}"><img src="${img}">
</body></html>`,
);

afterAll(async () => {
  await closeBrowserSafely(browser ?? undefined);
  rmSync(dir, { recursive: true, force: true });
}, 15_000);

function runCli(out: string, extra: string[]): void {
  const res = spawnSync(
    process.execPath,
    [
      ...CLI_ARGV,
      "capture",
      htmlPath,
      "--width",
      String(WIDTH),
      "--height",
      String(HEIGHT),
      "--quiet",
      "-o",
      out,
      ...extra,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
  );
  if (res.status !== 0) {
    throw new Error(`domotion capture exited ${String(res.status)}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  }
}

/** Rasterize through `<img>`, the way a consumer embeds the file, and return RGBA. */
async function rasterize(svg: string): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page!.setContent(
    `<!doctype html><html><body style="margin:0;background:#fff"><img id="o" src="${src}" width="${WIDTH}" height="${HEIGHT}"></body></html>`,
  );
  await page!.waitForFunction(() => {
    const el = document.getElementById("o") as HTMLImageElement | null;
    return el != null && el.complete && el.naturalWidth > 0;
  });
  // Web fonts inside an <img> SVG decode asynchronously; give them a beat so a
  // late-loading face is not mistaken for a fallback one.
  await page!.waitForTimeout(250);
  const png = await page!.screenshot({ clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** Count of pixels in a band that are clearly dark (text ink, not background). */
function darkPixels(rgba: Buffer, y0: number, y1: number): number {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const o = (y * WIDTH + x) * 4;
      if (rgba[o] + rgba[o + 1] + rgba[o + 2] < 3 * 96) n++;
    }
  }
  return n;
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function assertOptimizedStructure(svg: string): void {
  // Fonts are embedded and recompressed to WOFF2, with no sfnt left behind.
  const faces = svg.match(/@font-face/g) ?? [];
  expect(faces.length).toBeGreaterThan(0);
  expect((svg.match(/data:font\/woff2;base64,/g) ?? []).length).toBe(faces.length);
  expect(svg).not.toMatch(/data:font\/(?:ttf|otf|sfnt)|data:application\/(?:x-font-ttf|font-sfnt)/);

  // Every hoisted `<use href="#dmiN">` still has its def.
  const refs = [...svg.matchAll(/href="#(dmi\d+)"/g)].map((m) => m[1]);
  expect(refs.length).toBeGreaterThanOrEqual(3);
  const defined = new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of new Set(refs)) expect(defined.has(id), `#${id} is referenced but not defined`).toBe(true);
}

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("domotion capture --optimize on a real embedded-font capture", () => {
  let plainRaster: Buffer | null = null;

  it("the unoptimized capture exercises both passes (precondition)", async () => {
    const out = join(dir, "plain.svg");
    runCli(out, []);
    const svg = readFileSync(out, "utf8");
    // Discrimination guard: the optimize assertions below are only meaningful
    // if the default capture really embeds sfnt fonts and hoists the images.
    expect(svg).toMatch(/data:font\/(?:ttf|otf);base64,/);
    expect(svg).not.toContain("data:font/woff2");
    expect([...svg.matchAll(/href="#dmi\d+"/g)].length).toBeGreaterThanOrEqual(3);
    plainRaster = await rasterize(svg);
    expect(darkPixels(plainRaster, 20, 110)).toBeGreaterThan(400);
  }, 180_000);

  it("--optimize emits WOFF2 fonts, keeps hoisted ids, and paints like the unoptimized capture", async () => {
    const out = join(dir, "opt.svg");
    runCli(out, ["--optimize"]);
    const svg = readFileSync(out, "utf8");
    assertOptimizedStructure(svg);
    const raster = await rasterize(svg);
    expect(darkPixels(raster, 20, 110)).toBeGreaterThan(400);
    expect(plainRaster).not.toBeNull();
    expect(meanAbsDiff(raster, plainRaster!)).toBeLessThan(0.5);
  }, 180_000);

  it(".svgz output implies --optimize and gzips the same document", async () => {
    const out = join(dir, "out.svgz");
    runCli(out, []);
    const bytes = readFileSync(out);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const svg = gunzipSync(bytes).toString("utf8");
    assertOptimizedStructure(svg);
    const raster = await rasterize(svg);
    expect(plainRaster).not.toBeNull();
    expect(meanAbsDiff(raster, plainRaster!)).toBeLessThan(0.5);
  }, 180_000);
});
