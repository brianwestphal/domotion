import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Backgrounds paint from pixel-snapped local rects (Chromium 7d859f27): the
// color fills ToPixelSnappedRect of the paint rect or, when rounded, the
// PixelSnappedContouredBorder (core/paint/box_painter_base.cc:1056-1058,
// 1213-1214, 1265), and image/gradient layers use ToPixelSnappedRect of the
// contracted destination and positioning areas
// (core/paint/background_image_geometry.cc:391-401). Full RGBA must match.
const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
const svgImage = (w: number, h: number, fill: string) =>
  `url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22${w}%22 height=%22${h}%22%3E%3Crect width=%22${fill}%22 height=%22${fill}%22 fill=%22red%22/%3E%3C/svg%3E')`;

it.each([
  { name: "half-pixel color", own: "background:red;margin:20.5px" },
  { name: "rounded half-pixel color", own: "background:red;margin:20.5px;border-radius:5px" },
  { name: "quarter-pixel color", own: "background:red;margin:20.25px 20.75px" },
  { name: "fractional-width color", own: "background:red;width:20.5px" },
  { name: "translucent color", own: "background:rgba(255,0,0,.5);margin:20.5px" },
  { name: "color under a translucent border", own: "background:red;border:3px solid rgba(0,0,255,.5);margin:20.5px" },
  { name: "color under an own translate", own: "background:red;margin:20.5px;transform:translate(.25px,.5px)" },
  { name: "color under an x-only scale", own: "background:red;margin:20.5px;transform:scale(1.5,1)" },
  { name: "gradient", own: "background:linear-gradient(red,blue);margin:20.5px" },
  {
    name: "rounded gradient",
    own: "background:linear-gradient(90deg,red,blue);margin:20.25px;border-radius:5px",
  },
  {
    name: "padding-box gradient",
    own: "background:linear-gradient(red,blue) padding-box;border:3px solid transparent;margin:20.5px",
  },
  {
    name: "content-box gradient",
    own: "background:linear-gradient(red,blue) content-box;padding:2.25px;margin:20.5px",
  },
  // The color fills the bottom layer's clip box: border widths as integers,
  // padding as LayoutUnits, contracted and then snapped (box_painter_base.cc
  // :1339-1345, 1539-1550).
  {
    name: "padding-box color at an integral origin",
    own: "background:red padding-box;border:3px solid rgba(0,0,255,.3);margin:20px",
  },
  {
    name: "padding-box color at a half-pixel origin",
    own: "background:red padding-box;border:3px solid rgba(0,0,255,.3);margin:20.5px",
  },
  {
    name: "content-box color with fractional padding",
    own: "background:red content-box;padding:2.25px;border:3px solid rgba(0,0,255,.3);margin:20.25px",
  },
  {
    name: "padding-box color under a transparent border",
    own: "background:red padding-box;border:4px solid transparent;margin:20.5px",
  },
  { name: "positioned image", own: `background:${svgImage(10, 10, "10")} no-repeat 2px 3px;margin:20.5px` },
  { name: "repeated image", own: `background:${svgImage(7, 7, "4")};margin:20.5px` },
  { name: "covering image", own: `background:${svgImage(10, 5, "5")} center/cover;margin:20.25px 20.75px` },
])("paints a $name at Blink's snapped rect", async ({ own }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;${own}}</style><div><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    await output.setContent(
      "<style>body{margin:0}</style>" + elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100),
    );
    expect(await rgba(await output.screenshot({ omitBackground: true }))).toEqual(source);
  } finally {
    await page.close();
    await output.close();
  }
});

// Rounded clips follow ContouredBorderRectForClip (box_painter_base.cc
// :1201-1248): the snapped contour inset by integer-rounded insets, radii
// shrunk by the insets. Geometry matches; the remaining small alpha deltas sit
// on the arc where the inner rrect meets the border's antialiased inner edge
// (the rounded-contour coverage residual tracked separately). Before the clip
// was honored these cases differed by the whole border ring (max alpha 178).
it.each([
  {
    name: "rounded padding-box color",
    own: "background:red padding-box;border:3px solid rgba(0,0,255,.3);border-radius:8px;margin:20.5px",
    maxAlpha: 13,
  },
  {
    name: "rounded content-box color",
    own: "background:red content-box;padding:2.25px;border-radius:8px;margin:20.25px",
    maxAlpha: 2,
  },
])("clips a $name to the inset contour", async ({ own, maxAlpha }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0}#only{width:20px;height:20px;${own}}</style><div><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    await output.setContent(
      "<style>body{margin:0}</style>" + elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100),
    );
    const actual = await rgba(await output.screenshot({ omitBackground: true }));
    let worst = 0;
    for (let i = 3; i < source.length; i += 4) worst = Math.max(worst, Math.abs(source[i] - actual[i]));
    expect(worst).toBeLessThanOrEqual(maxAlpha);
  } finally {
    await page.close();
    await output.close();
  }
});

it("keeps both one-axis-empty corners on the inset padding-box edges", async () => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  // The top-left and top-right corners each have one empty axis. The bottom-right
  // bevel takes the contoured route. Sample the top corners above that bevel.
  const clip = { x: 20, y: 20, width: 38, height: 8 };
  const bodyStyle = "<style>body{margin:0;background:white}</style>";
  try {
    await page.setContent(`${bodyStyle}<div style="position:absolute;left:20px;top:20px;
      width:38px;height:38px;box-sizing:border-box;border:5px solid transparent;
      background:blue padding-box;border-radius:8px 0 12px 0 / 0 8px 12px 0;corner-shape:bevel"></div>`);
    const source = await rgba(await page.screenshot({ clip }));
    const svg = elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100);
    await output.setContent(bodyStyle + svg);
    const actual = await rgba(await output.screenshot({ clip }));
    expect(actual.equals(source)).toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});

it.each([
  { name: "bottom-right", radius: "0 0 12px 0" },
  { name: "top-left", radius: "12px 0 0 0" },
  { name: "top-right", radius: "0 12px 0 0" },
  { name: "bottom-left", radius: "0 0 0 12px" },
  { name: "all four", radius: "12px" },
  { name: "asymmetric borders and radii", radius: "0 9px 12px 0 / 0 10px 15px 0", border: "3px 8px 5px 2px" },
  { name: "other one-axis-empty corners", radius: "8px 0 12px 0 / 0 8px 12px 0" },
  { name: "a translucent background", radius: "0 0 12px 0", color: "rgba(0,0,255,.65)" },
])("clips the $name inset bevel to Blink's padding-box intersection (DM-KKY5P5)", async ({ radius, border, color }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  const bodyStyle = "<style>body{margin:0;background:white}</style>";
  try {
    await page.setContent(`${bodyStyle}<div style="position:absolute;left:20px;top:20px;
      width:38px;height:38px;box-sizing:border-box;border:5px solid transparent;
      border-width:${border ?? "5px"};background:${color ?? "blue"} padding-box;
      border-radius:${radius};corner-shape:bevel"></div>`);
    const source = await rgba(await page.screenshot());
    const svg = elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100);
    await output.setContent(bodyStyle + svg);
    const actual = await rgba(await output.screenshot());
    expect(actual.equals(source)).toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});

// A rounded box whose border paints and obscures the background edge shrinks
// its border-box background by half of each border width (a sixth for a
// double border) for bleed avoidance, so the background's antialiased rim
// stays under the border (BoxDecorationData::ComputeBleedAvoidance,
// core/paint/box_decoration_data.cc:23-68;
// BackgroundContouredRectAdjustedForBleedAvoidance,
// core/paint/box_painter_base.cc:1165-1232; Chromium 7d859f27). The box's own
// overflow clip must not cut its snapped border either.
const bleedCases = [
  {
    name: "color under a solid border",
    own: "background:#fff;border:1px solid #d4d4d8;border-radius:8px;margin:20.25px",
    inset: 0.5,
  },
  {
    name: "color under a thick solid border",
    own: "background:#fff;border:3px solid #1d4ed8;border-radius:9px;margin:20.75px 20.5px",
    inset: 1.5,
  },
  {
    name: "color under a double border",
    own: "background:#fff;border:6px double #111;border-radius:10px;margin:20.5px",
    inset: 1,
  },
  {
    name: "gradient under a solid border",
    own: "background:linear-gradient(#fff,#fde68a);border:2px solid #92400e;border-radius:7px;margin:20.25px",
    inset: 1,
  },
];

// Counts pixels whose RGBA differs at all, on an opaque dark page so the
// background's rim shows against it. `rewrite` edits the emitted SVG.
async function bleedDiff(own: string, rewrite?: (svg: string) => string): Promise<{ pixels: number; worst: number }> {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(
      `<style>body{margin:0;background:#0d1117}#only{width:40px;height:30px;${own}}</style><div><div id="only"></div></div>`,
    );
    const source = await rgba(await page.screenshot());
    const svg = elementTreeToSvg(await captureElementTree(page, "body", viewport), 100, 100);
    await output.setContent("<style>body{margin:0}</style>" + (rewrite == null ? svg : rewrite(svg)));
    const actual = await rgba(await output.screenshot());
    let pixels = 0;
    let worst = 0;
    for (let i = 0; i < source.length; i += 4) {
      const delta = Math.max(
        Math.abs(source[i] - actual[i]),
        Math.abs(source[i + 1] - actual[i + 1]),
        Math.abs(source[i + 2] - actual[i + 2]),
        Math.abs(source[i + 3] - actual[i + 3]),
      );
      if (delta > 0) pixels++;
      worst = Math.max(worst, delta);
    }
    return { pixels, worst };
  } finally {
    await page.close();
    await output.close();
  }
}

// Negative control: grow the emitted background rect back to the full border
// contour (undo the shrink of `inset` on every side and on the radius).
const unshrink = (inset: number) => (svg: string) =>
  svg.replace(
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" (fill="(?:rgb\(255,255,255\)|url\(#[^"]+\))")/,
    (_match, x: string, y: string, w: string, h: string, rx: string, fill: string) =>
      `<rect x="${+x - inset}" y="${+y - inset}" width="${+w + 2 * inset}" height="${+h + 2 * inset}" rx="${+rx + inset}" ${fill}`,
  );

it.each(bleedCases)("shrinks a rounded $name for bleed avoidance", async ({ own, inset }) => {
  expect(await bleedDiff(own)).toEqual({ pixels: 0, worst: 0 });
  const control = await bleedDiff(own, unshrink(inset));
  expect(control.pixels).toBeGreaterThan(20);
});

// The rounded case keeps a low-amplitude corner residual (61 pixels, at most
// 2 levels) that the square case does not have.
it.each([
  { name: "square", own: "background:#fff;border:1px solid #d4d4d8;margin:20.25px;overflow:hidden", worst: 0 },
  {
    name: "rounded",
    own: "background:#fff;border:1px solid #d4d4d8;border-radius:8px;margin:20.25px;overflow:hidden",
    worst: 2,
  },
])("keeps a $name overflow clip off the box's own snapped border", async ({ own, worst }) => {
  expect((await bleedDiff(own)).worst).toBeLessThanOrEqual(worst);
  // Negative control: bound the wrapper clip by the fractional box again.
  const control = await bleedDiff(own, (svg) =>
    svg.replace(
      /(<clipPath id="cp\d+"><rect x=")([\d.]+)(" y=")([\d.]+)/,
      (_match, before: string, x: string, middle: string, y: string) => `${before}${+x + 0.25}${middle}${+y + 0.25}`,
    ),
  );
  expect(control.worst).toBeGreaterThan(20);
});
