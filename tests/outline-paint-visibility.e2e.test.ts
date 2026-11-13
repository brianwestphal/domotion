import { afterAll, describe, expect, it } from "vitest";
import type { Browser } from "@playwright/test";
import { captureElementTree, elementTreeToSvg, launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-HGGQMW: Blink paints an outline edge whenever its color is not fully
// transparent (BorderEdge::HasVisibleColorAndStyle, core/style/border_edge.cc
// at 6b5a1b80). An alpha of .004 still quantizes to visible 8-bit pixels, so
// the renderer must not apply its own visibility floor to outline color.

const env = await (async () => {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
})();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);
const describeBrowser = env ? describe : describe.skip;

const VIEW = { x: 0, y: 0, width: 100, height: 100 };

/** Pixels with nonzero alpha in a transparent-background screenshot of `html`. */
async function paintedPixels(browser: Browser, html: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const png = (await page.screenshot({ omitBackground: true })).toString("base64");
    return await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data: rgba } = context.getImageData(0, 0, image.width, image.height);
      let count = 0;
      for (let i = 3; i < rgba.length; i += 4) if (rgba[i]! > 0) count++;
      return count;
    }, png);
  } finally {
    await page.close();
  }
}

/** Alpha channel of a transparent-background screenshot of `html`. */
async function alphaMap(browser: Browser, html: string): Promise<number[]> {
  return (await rgbaMap(browser, html)).filter((_, index) => index % 4 === 3);
}

/** Every RGBA channel of a transparent-background screenshot of `html`. */
async function rgbaMap(browser: Browser, html: string): Promise<number[]> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: "load" });
    const png = (await page.screenshot({ omitBackground: true })).toString("base64");
    return await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data: rgba } = context.getImageData(0, 0, image.width, image.height);
      return Array.from(rgba);
    }, png);
  } finally {
    await page.close();
  }
}

async function renderedSvg(browser: Browser, source: string): Promise<string> {
  const page = await browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
  try {
    await page.setContent(source, { waitUntil: "load" });
    return elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
  } finally {
    await page.close();
  }
}

describeBrowser("low-alpha outline paint (DM-HGGQMW)", () => {
  for (const sample of [
    { color: "rgba(255,0,0,.005)", painted: true },
    { color: "rgba(255,0,0,0)", painted: false },
  ]) {
    it(`matches native coverage for outline-color ${sample.color}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;outline:2px solid ${sample.color}}</style><div id="probe"></div>`;
      const native = await paintedPixels(env!.browser, source);

      const page = await env!.browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
      let svg: string;
      try {
        await page.setContent(source, { waitUntil: "load" });
        svg = elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
      } finally {
        await page.close();
      }
      const rendered = await paintedPixels(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );

      expect(native > 0).toBe(sample.painted);
      expect(rendered).toBe(native);
    });
  }
});

// DM-RGE1V9: Blink keeps an empty pixel-snapped rect for a normal outline, but
// not for a focus ring (OutlinePainter::PaintOutlineRects, outline_painter.cc:924
// at 6b5a1b80), so a zero-area box still paints its outline.
describeBrowser("zero-area box outline paint (DM-RGE1V9)", () => {
  for (const sample of [
    { name: "zero width", size: "width:0;height:20px", outline: "2px solid red", painted: true },
    { name: "zero height", size: "width:20px;height:0", outline: "2px solid red", painted: true },
    { name: "zero both", size: "width:0;height:0", outline: "2px solid red", painted: true },
    { name: "focus ring", size: "width:0;height:0", outline: "2px auto red", painted: false },
    { name: "no outline", size: "width:0;height:20px", outline: "none", painted: false },
  ]) {
    it(`matches native coverage for a ${sample.name} box`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;${sample.size};outline:${sample.outline}}</style><div id="probe"></div>`;
      const native = await paintedPixels(env!.browser, source);

      const page = await env!.browser.newPage({ viewport: { width: VIEW.width, height: VIEW.height } });
      let svg: string;
      try {
        await page.setContent(source, { waitUntil: "load" });
        svg = elementTreeToSvg(await captureElementTree(page, "body", VIEW), VIEW.width, VIEW.height);
      } finally {
        await page.close();
      }
      const rendered = await paintedPixels(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );

      expect(native > 0).toBe(sample.painted);
      expect(rendered).toBe(native);
    });
  }
});

// DM-9X9M8A: a solid rounded outline fills between two contours whose radii
// are the constrained border radii grown per component by each side's outset
// (ContouredBorderGeometry::PixelSnappedContouredBorderWithOutsets and
// FloatRoundedRect::Radii::Outset at 6b5a1b80). Per-corner and elliptical
// radii used to collapse to the top-left corner's scalar radius. Curve edges
// keep a few levels of anti-aliasing difference; a geometry error is a full
// coverage difference.
describeBrowser("per-corner outline radii (DM-9X9M8A)", () => {
  for (const radius of ["8px/4px", "5px 10px 0px 5px", "0 12px", "5px"]) {
    for (const offset of ["0", "3px", "-2px"]) {
      it(`matches native outline coverage for border-radius ${radius}, outline-offset ${offset}`, async () => {
        const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:30px;height:24px;border-radius:${radius};outline:3px solid red;outline-offset:${offset}}</style><div id="probe"></div>`;
        const native = await alphaMap(env!.browser, source);
        const svg = await renderedSvg(env!.browser, source);
        const rendered = await alphaMap(
          env!.browser,
          `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
        );
        const worst = Math.max(...native.map((alpha, index) => Math.abs(alpha - rendered[index]!)));
        expect(native.some((alpha) => alpha > 0)).toBe(true);
        expect(worst).toBeLessThanOrEqual(16);
      });
    }
  }
});

// DM-XDTVBW: Blink builds every rounded outline contour from the pixel-snapped
// border box, so a circular radius at a fractional origin or size paints at the
// snapped position. The old stroke used the unsnapped DOM rect.
describeBrowser("fractional rounded outline paint space (DM-XDTVBW)", () => {
  for (const box of [
    "left:20.5px;top:20.5px;width:20px;height:20px",
    "left:20px;top:20px;width:20.5px;height:20.5px",
    "left:20.25px;top:20.75px;width:20.6px;height:20px",
  ]) {
    it(`matches native outline coverage for ${box}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;${box};border-radius:5px;outline:2px solid red}</style><div id="probe"></div>`;
      const native = await alphaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await alphaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      const worst = Math.max(...native.map((alpha, index) => Math.abs(alpha - rendered[index]!)));
      expect(native.some((alpha) => alpha > 0)).toBe(true);
      expect(worst).toBeLessThanOrEqual(16);
    });
  }
});

// DM-W1Q7TN: a single-rect outline paints through BoxBorderPainter with the
// outline style on every edge, so 3D styles take the border bevel (shades,
// side order and integer split) on the outline's pixel-snapped outer rect.
describeBrowser("3D outline styles (DM-W1Q7TN)", () => {
  for (const outline of ["3px groove red", "3px ridge red", "4px inset red", "4px outset rgb(40,90,200)"]) {
    it(`matches native ${outline} outline`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;outline:${outline}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      expect(svg).not.toContain('stroke="rgb(255,0,0)"');
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      // One level of blend rounding at the mitered corner joins, as for borders.
      const worst = Math.max(...native.map((value, index) => Math.abs(value - rendered[index]!)));
      expect(worst).toBeLessThanOrEqual(1);
    });
  }
});

// DM-3W427J: a translucent outline is one opacity group with adjacent sides,
// so BoxBorderPainter::PaintOpacityGroup paints its sides opaque inside
// BeginLayer(alpha). Separately translucent side strokes double-blended at the
// corners.
describeBrowser("translucent dashed and dotted outlines (DM-3W427J)", () => {
  for (const outline of [
    "2px dashed rgba(255,0,0,.5)",
    "2px dotted rgba(255,0,0,.5)",
    "3px dashed rgba(0,128,0,.7);outline-offset:2px",
  ]) {
    it(`matches native ${outline} outline`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;outline:${outline}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      expect(rendered).toEqual(native);
    });
  }
});

// DM-XYZ4SD: a square double outline keeps square stripe corners; Blink grows
// only nonzero radius components (FloatRoundedRect::Radii::Outset). The outer
// stripe used to get a 1px radius from the stripe half-offset.
describeBrowser("square double outlines (DM-XYZ4SD)", () => {
  for (const outline of ["3px double red", "6px double blue", "5px double red;outline-offset:2px"]) {
    it(`matches native ${outline} outline`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;outline:${outline}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      expect(rendered).toEqual(native);
    });
  }
});

// DM-C77Q41: rounded dashed/dotted outlines clip Blink's doubled curved stroke
// with anti-aliased rounded-rect clips. Dash phase and length already matched
// (no on/off disagreement at DPR 4); the residual was edge coverage of an
// even-odd arc-path ring mask (premultiplied max 26-51). A rounded-rect clip
// plus inner rounded-rect cut-out leaves 8-15.
describeBrowser("rounded dashed and dotted outline clipping (DM-C77Q41)", () => {
  for (const css of [
    "border-radius:5px;outline:2px dashed red",
    "border-radius:5px;outline:2px dotted red",
    "border-radius:5px;outline:4px dashed red",
    "border-radius:8px;outline:3px dotted blue",
  ]) {
    it(`keeps curved-edge coverage close to native for ${css}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:20px;height:20px;${css}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      let worst = 0;
      for (let i = 0; i < native.length; i += 4) {
        const premultiplied = [0, 1, 2].map((k) =>
          Math.abs((native[i + k]! * native[i + 3]!) / 255 - (rendered[i + k]! * rendered[i + 3]!) / 255),
        );
        worst = Math.max(worst, ...premultiplied, Math.abs(native[i + 3]! - rendered[i + 3]!));
      }
      expect(worst).toBeLessThanOrEqual(16);
    });
  }
});

// DM-KA85VS: curved dashed/dotted borders take the same Blink clip
// construction as outlines (ClipContouredRect / ClipOutContouredRect around
// DrawCurvedDashedDottedBoxSide). With the even-odd arc-path ring mask these
// cases measured premultiplied max 25, 30 and 47; rounded-rect clips leave
// 10-23. Per-corner radii and unequal widths keep the path ring.
describeBrowser("rounded dashed and dotted border clipping (DM-KA85VS)", () => {
  for (const css of [
    "border-radius:5px;border:2px dashed red",
    "border-radius:5px;border:2px dotted red",
    "border-radius:8px;border:3px dotted blue",
  ]) {
    it(`keeps curved-edge coverage close to native for ${css}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:36px;height:28px;${css}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      let worst = 0;
      for (let i = 0; i < native.length; i += 4) {
        const premultiplied = [0, 1, 2].map((k) =>
          Math.abs((native[i + k]! * native[i + 3]!) / 255 - (rendered[i + k]! * rendered[i + 3]!) / 255),
        );
        worst = Math.max(worst, ...premultiplied, Math.abs(native[i + 3]! - rendered[i + 3]!));
      }
      expect(svg).not.toContain('fill-rule="evenodd"');
      expect(worst).toBeLessThanOrEqual(24);
    });
  }
});

// DM-2PSXZV: double, dashed and dotted outlines follow each corner's own
// (possibly elliptical) radius, not one scalar from the top-left corner. With
// the scalar these differed at max 255. Double stripes are contour rings and
// match to AA; dashed/dotted per-corner rings keep the arc-path clip, whose
// coverage floor is tracked separately.
describeBrowser("per-corner rounded double, dashed and dotted outlines (DM-2PSXZV)", () => {
  for (const [css, bound] of [
    ["outline:6px double red;border-radius:8px 2px 8px 2px", 8],
    ["outline:6px double red;border-radius:10px/4px", 8],
    ["outline:6px double red;border-radius:6px", 0],
    ["outline:2px dashed red;border-radius:8px 0 8px 0", 64],
    ["outline:3px dotted blue;border-radius:10px/5px", 32],
    ["outline:2px dashed red;border-radius:0 6px 6px 6px", 64],
  ] as const) {
    it(`follows per-corner radii for ${css}`, async () => {
      const source = `<!doctype html><style>body{margin:0}#probe{position:absolute;left:20px;top:20px;width:36px;height:28px;${css}}</style><div id="probe"></div>`;
      const native = await rgbaMap(env!.browser, source);
      const svg = await renderedSvg(env!.browser, source);
      const rendered = await rgbaMap(
        env!.browser,
        `<!doctype html><style>body{margin:0}svg{display:block}</style>${svg}`,
      );
      let worst = 0;
      for (let i = 0; i < native.length; i += 4) {
        const premultiplied = [0, 1, 2].map((k) =>
          Math.abs((native[i + k]! * native[i + 3]!) / 255 - (rendered[i + k]! * rendered[i + 3]!) / 255),
        );
        worst = Math.max(worst, ...premultiplied, Math.abs(native[i + 3]! - rendered[i + 3]!));
      }
      expect(worst).toBeLessThanOrEqual(bound);
    });
  }
});
