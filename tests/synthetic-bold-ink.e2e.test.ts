/**
 * Synthetic bold, graded against Chrome's own paint (DM-1970).
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Synthetic bold had NO pixel coverage anywhere before it, at any level:
 *
 *  - the feature suite pins `paths` mode, which applies no synthesis at all;
 *  - the html-test suite does exercise embedded mode, but its corpus produces
 *    ZERO synthetic-bold runs — measured, 47 fixtures sampled across the corpus,
 *    none. The reason is structural rather than incidental: synthesis fires only
 *    when the resolved face LACKS the requested weight, and the corpus uses
 *    Helvetica / Arial / Georgia / system-ui, every one of which ships a real
 *    bold cut that the matcher routes to instead.
 *
 * So a clean sweep proved nothing about this mechanism, and the strength could
 * drift by any amount without a gate noticing. Unit tests pin the emitted
 * stroke-width arithmetic; this pins the resulting INK against Chrome.
 *
 * ── What is asserted, and why in this form ──────────────────────────────────
 *
 * The metric is the ink DELTA over an un-emboldened control, on both sides —
 * `(ours700 - ours400) / (chrome700 - chrome400)`. A raw ours/Chrome ratio does
 * not work here: our path-fill antialiasing differs from Chrome's hinted,
 * gamma-corrected glyph masks, and a raw ratio charges that difference to the
 * synthesis. The delta cancels it.
 *
 * Measured at 100px deliberately. Below ~24px Chrome's own embolden delta
 * collapses toward zero and is NEGATIVE at 12px (194.5 emboldened against 219.4
 * plain, Papyrus) because the gamma-corrected masks saturate — so the
 * denominator vanishes and the metric stops meaning anything. That is a
 * rasterization floor, not a strength error, and no assertion belongs there.
 *
 * Reference values on macOS (Chromium 147.0.7727.15, Papyrus, "Hamburgefonstiv"):
 * the outline dilation this replaced measured 1.53x, matching the 1.474-1.507x
 * recorded when the defect was filed; Skia's own frame measures 1.00x.
 */
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { renderTextAsPath, setRenderTextMode, getRenderTextMode } from "../src/render/text-to-path.js";
import { clearEmbeddedFontBuilder, getBuiltEmbeddedFontFaceCss } from "../src/render/embedded-font-builder.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const TEXT = "Hamburgefonstiv";
/**
 * Candidate (family, weight) pairs that force SYNTHESIS rather than a route to a
 * real bold sibling — tried in order, first one that actually synthesizes wins.
 *
 * A per-platform list is required, not a nicety. `Papyrus` has no bold cut on
 * macOS, but on Linux the same family name resolves to LiberationSerif-Bold, so
 * both sides simply route to a real bold face and the comparison measures
 * nothing. Measured there: ratio 0.9998 with the fix AND 0.9998 with it
 * reverted — a perfectly healthy-looking number from a test that could not fail.
 * Linux instead uses `system-ui`, which resolves to WenQuanYi Zen Hei
 * (usWeightClass 500, no bold sibling); Blink's Linux gate is
 * `Weight() > 200 + typeface weight` (`skia/font_cache_skia.cc:333-339`), so
 * 800 synthesizes there.
 */
const CANDIDATES: Array<{ family: string; weight: number }> = [
  { family: "Papyrus", weight: 700 },
  { family: "system-ui", weight: 800 },
  { family: "Comic Sans MS", weight: 700 },
];
const SIZE = 100;
const W = 1400, H = SIZE * 5, BASE_Y = SIZE * 3;

let browser: Browser | null = null;
let ctx: BrowserContext | null = null;
try {
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: W, height: H } });
} catch { browser = null; }

afterAll(async () => { await closeBrowserSafely(browser ?? undefined); }, 15_000);

const describeBrowser = browser != null ? describe : describe.skip;

/** Total ink (1 - luminance, summed) plus the ink box, over a white field. */
async function ink(buf: Buffer): Promise<{ mass: number; w: number; h: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let mass = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const o = (y * info.width + x) * 4;
      const v = (255 - (data[o] + data[o + 1] + data[o + 2]) / 3) / 255;
      if (v > 0.01) {
        mass += v;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return { mass, w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function chromeInk(family: string, weight: number): Promise<{ mass: number; w: number; h: number }> {
  const page = await ctx!.newPage();
  await page.setContent(`<!doctype html><style>*{margin:0;padding:0}
    body{background:#fff;width:${W}px;height:${H}px}
    div{position:absolute;top:0;left:0;font-family:"${family}";font-size:${SIZE}px;
        font-weight:${weight};line-height:${BASE_Y * 2}px;white-space:pre;color:#000}
    </style><div>${TEXT}</div>`, { waitUntil: "load" });
  const m = await ink(await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
  await page.close();
  return m;
}

async function ourInk(family: string, weight: number): Promise<{ mass: number; w: number; h: number; markup: string } | null> {
  const prev = getRenderTextMode();
  setRenderTextMode("embedded-font");
  clearEmbeddedFontBuilder();
  // `ascentOverride: 0` pins baselineY === y. Without it `y` is NOT the
  // baseline and the run lands ~0.9em lower — which silently made an earlier
  // version of this measurement compare different parts of two images.
  const markup = renderTextAsPath(TEXT, 0, BASE_Y,
    { fontSize: SIZE, fontFamily: family, fontWeight: String(weight), fill: "#000", ascentOverride: 0 });
  const css = getBuiltEmbeddedFontFaceCss();
  setRenderTextMode(prev);
  if (markup == null) return null;
  const page = await ctx!.newPage();
  await page.setContent(`<!doctype html><style>*{margin:0;padding:0}body{background:#fff}</style>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><style>${css}</style>`
    + `<rect width="${W}" height="${H}" fill="#fff"/>${markup}</svg>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const m = await ink(await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
  await page.close();
  // The markup travels back so liveness can be judged MECHANISM-INDEPENDENTLY —
  // see the loop below. Keying liveness on the presence of a stroke would tie it
  // to this implementation, and a revert to the old outline dilation would then
  // read as "skip" rather than as the failure it is.
  return { ...m, markup };
}

describeBrowser("synthetic bold matches Chrome's painted weight (DM-1970)", () => {
  it("adds the same ink Chrome's own synthetic bold adds", async () => {
    // Find a pair this host can actually exercise. "Our side emitted a frame"
    // is the liveness test — a family that routes to a real bold sibling
    // produces a large, healthy-looking Chrome delta and a ratio near 1.0 from
    // a comparison that is measuring nothing at all.
    // Find a pair this host can actually exercise, and judge that by whether our
    // 700 output DIFFERS from our 400 output at all. That signal is independent
    // of how the synthesis is implemented: an outline dilation changes the
    // embedded subset, a frame changes the `<text>` attributes, and a family
    // that merely routed to a real bold sibling changes neither in a way that
    // survives (the two renders resolve the same face and emit the same thing).
    //
    // Getting this wrong is not hypothetical. Keyed on `Papyrus` alone, this
    // test measured 0.9998 on Linux both with the fix and with it reverted —
    // because there `Papyrus` resolves to LiberationSerif-Bold and neither side
    // synthesized anything. A healthy number from a test that could not fail.
    let chosen: { family: string; weight: number } | null = null;
    let ours700: Awaited<ReturnType<typeof ourInk>> = null;
    let ours400: Awaited<ReturnType<typeof ourInk>> = null;
    for (const c of CANDIDATES) {
      const hi = await ourInk(c.family, c.weight);
      const lo = await ourInk(c.family, 400);
      if (hi != null && lo != null && hi.markup !== lo.markup) {
        chosen = c; ours700 = hi; ours400 = lo; break;
      }
    }
    if (chosen == null || ours700 == null || ours400 == null) {
      // No installed family on this host forces synthesis. Skip explicitly
      // rather than pass: a silent pass is indistinguishable from a verified
      // one, which is the failure this whole file exists to avoid.
      console.warn("[synthetic-bold-ink] SKIPPED — no candidate family synthesizes on this host");
      return;
    }
    const [chrome700, chrome400] = [
      await chromeInk(chosen.family, chosen.weight), await chromeInk(chosen.family, 400),
    ];

    // Precondition: the comparison is between the same painted thing. If the ink
    // boxes disagree the masses are not comparable, and two earlier versions of
    // this measurement were wrong in exactly that way (a clipped canvas, then a
    // mis-set baseline) while still producing plausible-looking ratios.
    expect(Math.abs(ours700.w - chrome700.w), `ink widths must agree (${chosen.family})`).toBeLessThanOrEqual(3);
    expect(Math.abs(ours700.h - chrome700.h), `ink heights must agree (${chosen.family})`).toBeLessThanOrEqual(3);

    // Precondition: Chrome must be adding weight too, or there is nothing to
    // compare against.
    const chromeDelta = chrome700.mass - chrome400.mass;
    expect(chromeDelta / chrome400.mass, `Chrome must embolden ${chosen.family}`).toBeGreaterThan(0.1);

    // The claim. Skia's frame is `textSize * fakeBoldScale`, 1/32 at 100px =
    // 3.125px (src/core/SkTextFormatParams.h:16-29,
    // src/core/SkScalerContext.cpp:1019-1041). The outline dilation this
    // replaced measured 1.53 here on macOS.
    const ratio = (ours700.mass - ours400.mass) / chromeDelta;
    expect(ratio, `${chosen.family}@${chosen.weight}`).toBeGreaterThan(0.85);
    expect(ratio, `${chosen.family}@${chosen.weight}`).toBeLessThan(1.15);
  }, 180_000);
});
