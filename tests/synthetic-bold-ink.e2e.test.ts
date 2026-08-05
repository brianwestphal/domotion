/**
 * Synthetic bold, graded against Chrome's own paint, in BOTH render modes
 * (DM-1970 for embedded, DM-1984 for paths).
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
 *
 * ── Why paths mode is graded by SHAPE and not by ink (DM-1984) ──────────────
 *
 * The ink-delta metric cancels the two sides' antialiasing difference only
 * because, in embedded mode, the two sides do not have one: the browser
 * rasterizes our embedded subset through the same text pipeline Chrome used, so
 * the un-emboldened bases agree to the unit (13327 both, measured). Paths mode
 * never shares that pipeline — its base measures 11754 for the same glyphs,
 * -12%, the documented unhinted-outline floor. With unequal bases the
 * subtraction no longer cancels anything, and the ratio reads 1.57 for a frame
 * whose GEOMETRY is exact: the emboldened ink box is 66x70 on both sides, the
 * same box Chrome paints, while the un-emboldened one is 65x69.
 *
 * So paths mode is graded on shape agreement (best-shift IoU over the binarized
 * masks) against three references, which is rasterizer-independent:
 *
 *   ours@700 vs Chrome@700   0.9326   <- with the frame
 *   ours@400 vs Chrome@700   0.6699   <- what this shipped as before DM-1984
 *   ours@400 vs Chrome@400   0.8829   <- the plain control
 *
 * The emboldened comparison beats the PLAIN control, because thicker strokes are
 * less sensitive to the outline thinness that the floor consists of.
 */
import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { renderTextAsPath, setRenderTextMode, getRenderTextMode } from "../src/render/text-to-path.js";
import { clearGlyphDefs, getGlyphDefs, resolveFont, type RenderTextMode } from "../src/render/font-resolution.js";
import { faceNeedsSyntheticBold, faceNeedsSyntheticOblique } from "../src/render/synthesis-decision.js";
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

/** Binarized ink mask plus the ink box, for the shape metric paths mode uses. */
async function inkMask(buf: Buffer): Promise<{ m: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const m = new Uint8Array(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if ((255 - (data[i] + data[i + 1] + data[i + 2]) / 3) / 255 > 0.5) m[p] = 1;
  }
  return { m, w: info.width, h: info.height };
}

/** Best intersection-over-union over integer shifts. The shift search is not a
 *  fudge: the two sides' baselines sit at different y (Chrome's is placed by
 *  line-height, ours by the passed baseline), and IoU without it would grade
 *  that offset rather than the glyph shapes. */
function bestIoU(a: { m: Uint8Array; w: number; h: number }, b: { m: Uint8Array; w: number; h: number }): number {
  let best = 0;
  for (let dx = -8; dx <= 8; dx++) {
    for (let dy = -24; dy <= 24; dy++) {
      let inter = 0, union = 0;
      for (let y = 0; y < a.h; y++) {
        for (let x = 0; x < a.w; x++) {
          const A = a.m[y * a.w + x];
          const xb = x + dx, yb = y + dy;
          const B = (xb >= 0 && xb < b.w && yb >= 0 && yb < b.h) ? b.m[yb * b.w + xb] : 0;
          if (A === 1 || B === 1) union++;
          if (A === 1 && B === 1) inter++;
        }
      }
      const v = union > 0 ? inter / union : 0;
      if (v > best) best = v;
    }
  }
  return best;
}

async function chromeShot(family: string, weight: number, style = "normal"): Promise<Buffer> {
  const page = await ctx!.newPage();
  await page.setContent(`<!doctype html><style>*{margin:0;padding:0}
    body{background:#fff;width:${W}px;height:${H}px}
    div{position:absolute;top:0;left:0;font-family:"${family}";font-size:${SIZE}px;
        font-weight:${weight};font-style:${style};line-height:${BASE_Y * 2}px;white-space:pre;color:#000}
    </style><div>${TEXT}</div>`, { waitUntil: "load" });
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  await page.close();
  return buf;
}

async function chromeInk(family: string, weight: number): Promise<{ mass: number; w: number; h: number }> {
  return ink(await chromeShot(family, weight));
}

async function ourShot(mode: RenderTextMode, family: string, weight: number, style = "normal"):
    Promise<{ buf: Buffer; markup: string } | null> {
  const prev = getRenderTextMode();
  setRenderTextMode(mode);
  clearEmbeddedFontBuilder();
  clearGlyphDefs();
  // `ascentOverride: 0` pins baselineY === y. Without it `y` is NOT the
  // baseline and the run lands ~0.9em lower — which silently made an earlier
  // version of this measurement compare different parts of two images.
  const markup = renderTextAsPath(TEXT, 0, BASE_Y,
    { fontSize: SIZE, fontFamily: family, fontWeight: String(weight), fontStyle: style, fill: "#000", ascentOverride: 0 });
  // Paths mode emits `<use href="#gN">`, so its `<defs>` must travel with it or
  // the page renders empty — and an empty page scores a perfectly stable ink
  // mass of zero rather than failing loudly.
  const css = mode === "embedded-font" ? getBuiltEmbeddedFontFaceCss() : "";
  const defs = mode === "paths" ? getGlyphDefs() : "";
  setRenderTextMode(prev);
  if (markup == null) return null;
  const page = await ctx!.newPage();
  await page.setContent(`<!doctype html><style>*{margin:0;padding:0}body{background:#fff}</style>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><style>${css}</style>`
    + `<defs>${defs}</defs>`
    + `<rect width="${W}" height="${H}" fill="#fff"/>${markup}</svg>`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
  await page.close();
  return { buf, markup };
}

async function ourInk(family: string, weight: number): Promise<{ mass: number; w: number; h: number; markup: string } | null> {
  const shot = await ourShot("embedded-font", family, weight);
  if (shot == null) return null;
  const m = await ink(shot.buf);
  const markup = shot.markup;
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

  it("paths mode moves TOWARD Chrome's emboldened shape, not away from it (DM-1984)", async () => {
    // Paths mode had no synthesis at all until DM-1984 — a run whose face lacks
    // the requested weight painted the thin natural outline. The mode ships:
    // the visual suites pin it, and it is the always-correct fallback whenever
    // a run cannot be embedded.
    //
    // The candidate search asks the DECISION, not the emission — deliberately
    // the opposite way round from the embedded test above, and for a reason
    // specific to this mode. There, a revert to the old outline dilation still
    // changes the emitted markup, so "markup differs" is a live signal. Here,
    // reverting the fix removes the frame entirely and the two weights emit
    // BYTE-IDENTICAL markup — so a markup-differs gate would report SKIP for
    // precisely the regression this test exists to catch. Keying on
    // `faceNeedsSyntheticBold` (the shared predicate, which is upstream of both
    // modes) means a host with the font FAILS when the frame goes missing, and
    // only a host without it skips.
    let chosen: { family: string; weight: number } | null = null;
    for (const c of CANDIDATES) {
      const face = resolveFont(c.family, c.weight, SIZE, 0);
      if (face != null && faceNeedsSyntheticBold(face, c.weight, undefined)) { chosen = c; break; }
    }
    if (chosen == null) {
      console.warn("[synthetic-bold-ink] paths SKIPPED — no candidate family synthesizes on this host");
      return;
    }
    const hi = await ourShot("paths", chosen.family, chosen.weight);
    const lo = await ourShot("paths", chosen.family, 400);
    expect(hi, `paths mode rendered nothing for ${chosen.family}`).not.toBeNull();
    expect(lo, `paths mode rendered nothing for ${chosen.family}@400`).not.toBeNull();
    const hi700 = hi!.buf, lo400 = lo!.buf;

    const [oursBold, oursPlain, chromeBold, chromePlain] = await Promise.all([
      inkMask(hi700), inkMask(lo400),
      chromeShot(chosen.family, chosen.weight).then(inkMask),
      chromeShot(chosen.family, 400).then(inkMask),
    ]);

    // The three references. `plainVsBold` is literally what this shipped as
    // before the fix — our un-emboldened paint graded against Chrome's
    // emboldened one — so it is the non-vacuity floor rather than a nicety.
    const withFrame = bestIoU(oursBold, chromeBold);
    const plainVsBold = bestIoU(oursPlain, chromeBold);
    const control = bestIoU(oursPlain, chromePlain);
    const label = `${chosen.family}@${chosen.weight}: frame=${withFrame.toFixed(4)} `
      + `pre-fix=${plainVsBold.toFixed(4)} control=${control.toFixed(4)}`;

    // The control also guards the instrument: if the harness were rendering an
    // empty page, or comparing different parts of two images, every IoU would
    // collapse together and this would fail first.
    expect(control, label).toBeGreaterThan(0.8);
    // The claim: the frame closes most of the gap the missing synthesis opened.
    // Measured on macOS (Papyrus, 100px): 0.9326 / 0.6699 / 0.8829.
    expect(withFrame, label).toBeGreaterThan(plainVsBold + 0.15);
    // …and lands at least as close to Chrome as the plain glyph does to ITS own
    // control, i.e. the synthesis adds no shape error of its own. It scores
    // BETTER in practice, because thicker strokes are less sensitive to the
    // unhinted-outline thinness that the paths-mode floor consists of.
    expect(withFrame, label).toBeGreaterThan(control - 0.02);
  }, 180_000);
});

/**
 * Synthetic OBLIQUE in paths mode (DM-1984) — the shear had the same coverage
 * hole synthetic bold did, and worse: no pixel test existed for it in EITHER
 * mode, only unit tests over `shearPathCommands`' arithmetic.
 *
 * Graded on shape rather than ink for the reason given at the top of this file,
 * and additionally because a shear moves ink sideways without adding any: an
 * ink metric is blind to a wrong-signed shear, which is the one mistake this
 * transform can actually make. That is not hypothetical — the ticket flagged
 * the sign as needing a rendered check rather than a derivation, because the
 * inner `scale(s,-s)` groups flip the y axis between the design space the
 * factor is defined in and the user space the transform applies in.
 *
 * Measured on macOS (Chromium 147.0.7727.15, Papyrus, "Hamburgefonstiv", 100px):
 *
 *   ours italic (sheared)   vs Chrome italic   0.8792
 *   ours UPRIGHT            vs Chrome italic   0.4337   <- pre-DM-1984
 *   ours WRONG-SIGN shear   vs Chrome italic   0.2553
 *   ours upright            vs Chrome upright  0.8829   <- control
 *
 * The sheared score lands on the control, i.e. the synthesized oblique costs
 * nothing in shape agreement, and the wrong sign scores WORSE than applying no
 * shear at all — so the sign is pinned by measurement, not by argument.
 */
describeBrowser("synthetic oblique matches Chrome's painted slant in paths mode (DM-1984)", () => {
  it("shears toward Chrome's oblique, and in the right direction", async () => {
    // Same decision-keyed liveness as the bold paths test: a family with a real
    // italic sibling routes to it and synthesizes nothing.
    let family: string | null = null;
    for (const c of [...CANDIDATES.map((c) => c.family), "Papyrus", "Impact"]) {
      const face = resolveFont(c, 400, SIZE, -1);
      if (face != null && faceNeedsSyntheticOblique(face, -1, undefined)) { family = c; break; }
    }
    if (family == null) {
      console.warn("[synthetic-oblique] SKIPPED — no candidate family synthesizes an oblique on this host");
      return;
    }

    const italic = await ourShot("paths", family, 400, "italic");
    const upright = await ourShot("paths", family, 400, "normal");
    expect(italic, `paths mode rendered nothing for ${family}`).not.toBeNull();
    expect(upright, `paths mode rendered nothing for ${family}`).not.toBeNull();

    const [oursItalic, oursUpright, chromeItalic, chromeUpright] = await Promise.all([
      inkMask(italic!.buf), inkMask(upright!.buf),
      chromeShot(family, 400, "italic").then(inkMask),
      chromeShot(family, 400, "normal").then(inkMask),
    ]);

    const sheared = bestIoU(oursItalic, chromeItalic);
    const unsheared = bestIoU(oursUpright, chromeItalic);
    const control = bestIoU(oursUpright, chromeUpright);
    const label = `${family}: sheared=${sheared.toFixed(4)} `
      + `pre-fix=${unsheared.toFixed(4)} control=${control.toFixed(4)}`;

    expect(control, label).toBeGreaterThan(0.8);
    // The claim, and the non-vacuity floor in one: `unsheared` is what this
    // shipped as before DM-1984.
    expect(sheared, label).toBeGreaterThan(unsheared + 0.2);
    // A shear is a pure affine transform, so unlike the embolden it should cost
    // NOTHING against the control — no rasterization residual of its own.
    expect(sheared, label).toBeGreaterThan(control - 0.02);
  }, 180_000);
});
