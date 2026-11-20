import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// Blink paints a wrapped inline's box shadows per line fragment, from that
// fragment's own pixel-snapped rect, through the shared BoxPainterBase
// producer with the fragment's SidesToInclude()
// (InlineBoxFragmentPainterBase::PaintBoxDecorationBackground,
// inline_box_fragment_painter.cc:427-444, Chromium 7d859f27). Clone includes
// every side; slice drops the sides where the box continues, which
// ClipToSides and AdjustRectForSideClipping turn into an open shadow edge
// (box_painter_base.cc:200-250). The fragments are sized by fixed-width
// inline-blocks so their geometry is integral on every platform, and the text
// is transparent so only decorations are compared, at full RGBA.
const viewport = { x: 0, y: 0, width: 160, height: 160 };
let browser: Browser;
let priorProbe: string | undefined;
beforeAll(async () => {
  priorProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorProbe;
});
const rgba = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
const fixture = (span: string, paragraph = "") =>
  `<style>body{margin:0;font:10px/30px sans-serif}#p{width:90px;margin:10px;color:transparent;${paragraph}}` +
  `i{display:inline-block;width:40px;height:8px}span{${span}}</style>` +
  `<div id="container"><p id="p"><i></i><span><i></i><i></i><i></i></span><i></i></p></div>`;
const clone = "box-decoration-break:clone;-webkit-box-decoration-break:clone;";
const cases = [
  { name: "slice, transparent", html: fixture("box-shadow:4px 4px 0 red") },
  { name: "clone, transparent", html: fixture(`box-shadow:4px 4px 0 red;${clone}`) },
  { name: "slice, translucent background", html: fixture("box-shadow:4px 4px 0 red;background:rgba(0,0,255,.5)") },
  {
    name: "clone, translucent background",
    html: fixture(`box-shadow:4px 4px 0 red;background:rgba(0,0,255,.5);${clone}`),
  },
  { name: "slice, opaque background", html: fixture("box-shadow:4px 4px 0 red;background:blue") },
  { name: "clone, opaque background", html: fixture(`box-shadow:4px 4px 0 red;background:blue;${clone}`) },
  { name: "slice, negative offset with spread", html: fixture("box-shadow:-3px 2px 0 1px red") },
  { name: "slice, right-to-left", html: fixture("box-shadow:4px 4px 0 red", "direction:rtl") },
  { name: "slice, inset", html: fixture("box-shadow:inset -3px 2px 0 1px red") },
  // Rounded fragments keep a 1-8 alpha residual at 1-3 corner pixels that the
  // same rounded box outside an inline does not show; it stays outside these
  // byte-exact controls.
  {
    name: "slice, under a half-pixel translate",
    html: fixture("box-shadow:4px 4px 0 red", "transform:translate(.5px,.5px)"),
  },
  // A block fragmented across columns takes the same producer, its open sides
  // being the block-axis ones.
  {
    name: "multi-column block, slice",
    html: '<style>body{margin:0}#p{columns:2;column-gap:10px;width:110px;height:60px;margin:10px}.b{height:100px;box-shadow:3px 3px 0 red}</style><div id="container"><div id="p"><div class="b"></div></div></div>',
  },
];

it.each(cases)("matches native fragment shadow pixels: $name", async ({ html }) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(html);
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    for (const selector of ["#container", "body"]) {
      const tree = await captureElementTree(page, selector, viewport);
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 160, 160));
      expect(await rgba(await output.screenshot({ omitBackground: true })), selector).toEqual(source);
    }
  } finally {
    await page.close();
    await output.close();
  }
});

// The capture keeps a shadow-only inline's line fragments; without them the
// renderer would paint one shadow around the union of the lines.
it("records the fragments of a shadow-only wrapped inline and needs them", async () => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(fixture("box-shadow:4px 4px 0 red"));
    const source = await rgba(await page.screenshot({ omitBackground: true }));
    const tree = await captureElementTree(page, "#container", viewport);
    const find = (nodes: typeof tree): (typeof tree)[number] | undefined => {
      for (const node of nodes) {
        if (node.tag === "span") return node;
        const found = find(node.children ?? []);
        if (found != null) return found;
      }
      return undefined;
    };
    const span = find(tree);
    expect(span?.inlineFragments?.map((f) => [f.x, f.y, f.width, f.height])).toHaveLength(2);
    const strip = (nodes: typeof tree): typeof tree =>
      nodes.map((node) => {
        const { inlineFragments: _dropped, ...rest } = node;
        return { ...rest, children: strip(node.children ?? []) };
      });
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(strip(tree), 160, 160));
    expect((await rgba(await output.screenshot({ omitBackground: true }))).equals(source)).toBe(false);
  } finally {
    await page.close();
    await output.close();
  }
});
