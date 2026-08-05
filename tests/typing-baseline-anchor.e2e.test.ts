import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg, resolveOverlays } from "../src/animation/index.js";
import { htmlWrapper, seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * DM-1750: `anchor.baseline: true` resolves a typing overlay's `y` — which IS
 * the typed text's baseline — to the anchored element's measured FIRST-LINE
 * text baseline. This is the kerf getting-started case: Menlo 12.5px page text
 * used to need a hand-tuned `dy ≈ 11.5` (the Menlo ascent) to land overlay
 * glyphs on the page text; with the baseline anchor and `dy: 0` the glyphs must
 * land pixel-on. Verified against the RASTERIZED SVG vs Chromium's own paint of
 * the same page text.
 */

const W = 360;
const H = 120;
const TEXT = "const count = signal(0);";
// The kerf case: Menlo 12.5px, editor-ish line height, block element (line
// boxes lay from the content top), no padding/border so content = border box.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0}
  body{background:#ffffff;width:${W}px;height:${H}px}
  #code{position:absolute;left:40px;top:60px;font-family:Menlo,monospace;font-size:12.5px;line-height:19px;color:#111111}
</style></head><body><div id="code">${TEXT}</div></body></html>`;
// Crop bracketing the rendered line.
const CROP = { x: 30, y: 50, width: 230, height: 40 };

async function setup() {
  try {
    const browser = await launchChromium();
    const context = await browser.newContext({ viewport: { width: W, height: H } });
    return { browser, page: await context.newPage() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

async function rawPixels(buf: Buffer): Promise<{ data: Buffer; n: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, n: info.width * info.height };
}

/** Ink (darker-than-mid-gray) pixel count + bounding box within the crop. */
async function ink(buf: Buffer): Promise<{ count: number; minX: number; minY: number; maxX: number; maxY: number }> {
  const { data, n } = await rawPixels(buf);
  let count = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if ((data[o] + data[o + 1] + data[o + 2]) / 3 < 128) {
      count++;
      const x = i % CROP.width, y = Math.floor(i / CROP.width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, minY, maxX, maxY };
}

/** Ink mask (darker-than-mid-gray), with the crop's row stride. */
async function inkMask(buf: Buffer): Promise<{ m: Uint8Array; w: number; h: number }> {
  const { data, n } = await rawPixels(buf);
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    m[i] = (data[o] + data[o + 1] + data[o + 2]) / 3 < 128 ? 1 : 0;
  }
  return { m, w: CROP.width, h: n / CROP.width };
}

/** Ink intersection-over-union with `b` displaced by (dx, dy). */
function inkIoU(a: Uint8Array, b: Uint8Array, w: number, h: number, dx: number, dy: number): number {
  let inter = 0, union = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const av = a[y * w + x];
      const sx = x - dx, sy = y - dy;
      const bv = sx >= 0 && sx < w && sy >= 0 && sy < h ? b[sy * w + sx] : 0;
      if (av || bv) union++;
      if (av && bv) inter++;
    }
  }
  return union === 0 ? 0 : inter / union;
}

/**
 * The whole-run displacement that best aligns our ink with Chrome's, searched
 * over ±3px in both axes.
 *
 * DM-1981: this is what "lands pixel-on" actually claims, and it is the only
 * assertion here that is independent of how the two sides RASTERIZE. A pixel
 * diff conflates placement with antialiasing and hinting — on Linux, Chrome
 * paints FreeType-autohinted stems (Blink's defaults are hinting kNormal plus
 * `setForceAutoHinting(true)`, `platform/fonts/web_font_render_style.cc:17-21`
 * and :95-97, rev 7d859f27) while our paths mode emits the raw outline, so a
 * residual is expected there and a placement error can hide inside it. This
 * measure cannot: a one-pixel offset moves the argmax off (0, 0) whatever the
 * rasterizers do. Verified to discriminate — before the half-leading fix it
 * reported dy = −1 on Linux, and (0, 0) after.
 */
async function bestShift(expected: Buffer, actual: Buffer): Promise<{ dx: number; dy: number; iou: number }> {
  const [A, B] = [await inkMask(expected), await inkMask(actual)];
  let best = { dx: 0, dy: 0, iou: -1 };
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const iou = inkIoU(A.m, B.m, A.w, A.h, dx, dy);
      if (iou > best.iou) best = { dx, dy, iou };
    }
  }
  return best;
}

/** Fraction of pixels whose max channel delta exceeds 32. */
async function diffFraction(a: Buffer, b: Buffer): Promise<number> {
  const [ra, rb] = [await rawPixels(a), await rawPixels(b)];
  expect(ra.n).toBe(rb.n);
  let diff = 0;
  for (let i = 0; i < ra.n; i++) {
    const o = i * 4;
    const d = Math.max(
      Math.abs(ra.data[o] - rb.data[o]),
      Math.abs(ra.data[o + 1] - rb.data[o + 1]),
      Math.abs(ra.data[o + 2] - rb.data[o + 2]),
    );
    if (d > 32) diff++;
  }
  return diff / ra.n;
}

describeBrowser("typing anchor.baseline rasterized alignment (DM-1750)", () => {
  it("lands overlay glyphs pixel-on over the anchored element's text with dy: 0 (the kerf 11.5px case)", async () => {
    const { page } = env!;
    // 1. Chromium's own paint of the page text — the ground truth.
    await page.setContent(PAGE, { waitUntil: "load" });
    const expected = await page.screenshot({ type: "png", clip: CROP });
    const expInk = await ink(expected);
    expect(expInk.count).toBeGreaterThan(100);

    // 2. Resolve a typing overlay against the LIVE page: baseline anchor with
    //    dy: 0 (no hand-tuned ascent constant), font adopted from the field.
    const [withBaseline] = await resolveOverlays(page, [
      { kind: "typing", text: TEXT, x: 0, y: 0, fontFamily: "anchor", mode: "paste", delay: 100, color: "#111111", anchor: { selector: "#code", at: "top-left", baseline: true } },
    ]);
    // Control: the same anchor WITHOUT baseline still resolves to the border-box
    // top — the pre-existing behavior stays unchanged.
    const [withoutBaseline] = await resolveOverlays(page, [
      { kind: "typing", text: TEXT, x: 0, y: 0, fontFamily: "anchor", anchor: { selector: "#code", at: "top-left" } },
    ]);
    expect(withoutBaseline.y).toBe(60);
    expect(withBaseline.x).toBe(40);
    // The baseline sits ~one ascent below the box top — the offset kerf
    // hand-tuned as BASELINE_DY ≈ 11.5 for Menlo 12.5px, now measured.
    const ascentOffset = withBaseline.y - withoutBaseline.y;
    expect(ascentOffset).toBeGreaterThan(8);
    expect(ascentOffset).toBeLessThan(16);

    // 3. Rasterize the ACTUAL animated SVG: the overlay alone on a white field
    //    (no page text underneath), fully pasted and held.
    const svg = generateAnimatedSvg({
      width: W, height: H,
      frames: [{ svgContent: `<rect width="${W}" height="${H}" fill="#ffffff"/>`, duration: 2000, overlays: [withBaseline] }],
    });
    await page.setContent(htmlWrapper(svg, "#ffffff"), { waitUntil: "load" });
    await seekTo(page, 1500);
    const actual = await page.screenshot({ type: "png", clip: CROP });
    const actInk = await ink(actual);
    expect(actInk.count).toBeGreaterThan(100);

    // 4. Pixel-on: the overlay glyphs occupy the same ink bounding box as the
    //    page's own text — definitely no ~11.5px baseline offset — and the
    //    residual diff stays within glyph-path-vs-native-text antialiasing.
    //
    //    DM-1981: the VERTICAL bounds are held to 1px, not 2. At 2px a whole-run
    //    one-pixel baseline offset fits inside the tolerance and only shows up
    //    in the diff fraction, where it is indistinguishable from antialiasing.
    //    That is exactly how a floored-half-leading bug survived on Linux: the
    //    envelope assertions passed and the pixel diff was blamed on the hinting
    //    floor. A one-pixel miss on this axis is the failure this test is for.
    expect(Math.abs(actInk.minY - expInk.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(actInk.maxY - expInk.maxY)).toBeLessThanOrEqual(1);
    expect(Math.abs(actInk.minX - expInk.minX)).toBeLessThanOrEqual(2);
    expect(Math.abs(actInk.maxX - expInk.maxX)).toBeLessThanOrEqual(2);

    // 5. The placement claim itself, stated so no rasterization difference can
    //    absorb it: the ink already lines up best where it sits, with no
    //    displacement at all.
    const shift = await bestShift(expected, actual);
    expect({ dx: shift.dx, dy: shift.dy }).toEqual({ dx: 0, dy: 0 });

    // 6. The residual, which IS rasterization-bound and therefore per-platform.
    //    macOS is held to the pixel-exact bar. Linux cannot be: Chrome paints
    //    autohinted stems there and we paint the unhinted outline, so our ink
    //    measures ~79% of Chrome's at this 12.5px size (and ~96% at 40px — the
    //    gap shrinks with ppem exactly as grid-fitting predicts, which is how it
    //    was distinguished from a placement error). That is the documented
    //    paths-mode hinting floor, not a defect in this overlay. Assertion 5 is
    //    what guards this test's actual subject on every platform.
    const RESIDUAL_BOUND = process.platform === "darwin" ? 0.06 : 0.08;
    expect(await diffFraction(expected, actual)).toBeLessThan(RESIDUAL_BOUND);
  });

  it("a border-box anchor without baseline is unchanged (glyphs land an ascent higher)", async () => {
    const { page } = env!;
    await page.setContent(PAGE, { waitUntil: "load" });
    const expected = await page.screenshot({ type: "png", clip: CROP });
    const expInk = await ink(expected);
    const [overlay] = await resolveOverlays(page, [
      { kind: "typing", text: TEXT, x: 0, y: 0, fontFamily: "anchor", mode: "paste", delay: 100, color: "#111111", anchor: { selector: "#code", at: "top-left" } },
    ]);
    const svg = generateAnimatedSvg({
      width: W, height: H,
      frames: [{ svgContent: `<rect width="${W}" height="${H}" fill="#ffffff"/>`, duration: 2000, overlays: [overlay] }],
    });
    await page.setContent(htmlWrapper(svg, "#ffffff"), { waitUntil: "load" });
    await seekTo(page, 1500);
    const actInk = await ink(await page.screenshot({ type: "png", clip: CROP }));
    // y resolved to the border-box TOP, so the baseline — and the whole ink
    // box — sits roughly one ascent (~11.5px at Menlo 12.5) above the page
    // text. That legacy offset is exactly what `baseline: true` removes.
    expect(expInk.minY - actInk.minY).toBeGreaterThan(8);
  });
});
