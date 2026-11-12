import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

interface Fixture {
  name: string;
  id?: string;
  url?: string;
  css?: string;
  own?: string;
  shape?: string;
  raster?: boolean;
  /** XML prolog before the root element (DM-1YAE1F doctype admission). */
  prolog?: string;
}
const gradient = (attribute: string, color = "red"): string =>
  `<linearGradient ${attribute}><stop stop-color="${color}"/></linearGradient>`;
const rectangle = '<rect class="paint" width="40" height="40" fill="lime"/>';
const fixtures: Fixture[] = [
  { name: "canonical ID", id: 'id="p"' },
  { name: "whitespace around ID equals", id: 'id = "p"' },
  { name: "decimal entity ID", id: 'id="&#112;"' },
  { name: "hexadecimal entity ID", id: "id='&#x70;'" },
  { name: "percent encoded URL", url: "#%70" },
  { name: "escaped CSS URL function and argument", css: '.paint{fill:u\\72l("#\\70 ") lime}' },
  { name: "UTF8 fragment", id: 'id="é"', url: "#%C3%A9" },
  { name: "isomorphic fragment", id: 'id="é"', url: "#%E9" },
  { name: "whole invalid UTF8 sequence", id: 'id="Ã©é"', url: "#%C3%A9%E9" },
  {
    name: "entity encoded presentation reference",
    css: "",
    shape: '<rect width="40" height="40" fill="url(&#35;%70) lime"/>',
  },
  {
    name: "inline CSS reference",
    css: "",
    shape: '<rect width="40" height="40" style="fill:u\\72l(&quot;#%70&quot;) lime"/>',
  },
  { name: "encoded neighboring href chain", own: gradient('id="g"') + '<linearGradient id="p" href="&#35;%67"/>' },
  {
    name: "escaped ID and class selector",
    id: 'id="p.q"',
    css: '#p\\.q{--literal:".paint url(#p.q)"}.paint\\.x{fill:url(#p%2Eq)}',
    shape: '<rect class="paint.x" width="40" height="40" fill="lime"/>',
  },
  {
    name: "ID attribute comparison",
    id: 'id="p"',
    css: 'rect[id="shape"]{fill:url(#p)}',
    shape: '<rect id="shape" width="40" height="40" fill="lime"/>',
  },
  {
    name: "href comparison and use",
    css: 'use[href="#shape"]{fill:url(#p)}',
    own: gradient('id="p"') + '<rect id="shape" width="40" height="40"/>',
    shape: '<use href="&#35;shape"/>',
  },
  {
    name: "class and style comparison",
    css: '[class="paint"][style*="url(#p)"]{stroke:blue;stroke-width:4}',
    shape: '<rect class="paint" width="40" height="40" style="fill:url(#p)"/>',
  },
  {
    name: "SVG 1.1 public DOCTYPE",
    prolog:
      '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  },
  { name: "bare DOCTYPE", prolog: "<!DOCTYPE svg>" },
  {
    name: "XHTML public DOCTYPE enables named entities",
    prolog: '<!DOCTYPE svg PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">',
    raster: true,
  },
  { name: "internal subset entity ID", prolog: '<!DOCTYPE svg [<!ENTITY i "p">]>', id: 'id="&i;"', raster: true },
  {
    name: "internal subset default attribute",
    prolog: '<!DOCTYPE svg [<!ATTLIST rect class CDATA "paint">]>',
    shape: '<rect width="40" height="40" fill="lime"/>',
    raster: true,
  },
  { name: "missing local target", own: gradient('id="other"'), raster: true },
  { name: "duplicate decoded IDs", own: gradient('id="p"') + gradient('id="&#112;"', "purple"), raster: true },
  { name: "missing neighboring use", shape: rectangle + '<use href="#hostshape"/>', raster: true },
  { name: "custom property URL retains source", css: ".paint{--x:url(#p);fill:var(--x)}", raster: true },
  {
    name: "typed attr ID reads original DOM value",
    css: "rect{width:attr(id type(<length>));fill:url(#p)}",
    shape: '<rect id="20px" width="40" height="40"/>',
  },
  {
    name: "typed attr class reads original DOM value",
    css: "rect{width:attr(class type(<length>));fill:url(#p)}",
    shape: '<rect class="20px" width="40" height="40"/>',
  },
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe.each([false, true])("DM-WT73T4 ordinary image identity (flatten=%s)", (flatten) => {
  it.each(fixtures)("matches image paint despite hostile host IDs: $name", async (fixture) => {
    const css = fixture.css ?? `.paint{fill:url(${fixture.url ?? "#p"}) lime}`;
    const source = `${fixture.prolog ?? ""}<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style><![CDATA[${css}]]></style><defs>${fixture.own ?? gradient(fixture.id ?? 'id="p"')}</defs>${fixture.shape ?? rectangle}</svg>`;
    const host = `<svg width="0" height="0" style="position:absolute"><defs>${gradient('id="p"', "blue")}${gradient('id="é"', "blue")}${gradient('id="Ã©é"', "blue")}<rect id="hostshape" width="40" height="40" fill="blue"/></defs></svg>`;
    const page = await browser.newPage({ viewport: { width: 40, height: 40 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${host}<div id="target"><img style="display:block" width="40" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}"></div>`,
      );
      await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      if (fixture.name.startsWith("typed attr")) {
        const channels = native.length / (40 * 40);
        const pixel = (x: number): number[] => [
          ...native.subarray((20 * 40 + x) * channels, (20 * 40 + x) * channels + 3),
        ];
        expect(pixel(10), "native typed attr must select the authored 20px width").toEqual([255, 0, 0]);
        expect(pixel(30), "unsupported native attr would incorrectly leave a full-width rectangle").toEqual([
          255, 255, 255,
        ]);
      }
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 40, height: 40 });
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 40, 40));
      expect(output.includes("<image "), "vector admission must authenticate every reference").toBe(
        fixture.raster === true,
      );
      await page.setContent(`<body style="margin:0;background:white">${host}<div id="actual">${output}</div>`);
      const actual = await sharp(await page.locator("#actual > svg").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native), "native source pixels must survive host collision").toBe(true);
    } finally {
      await page.close();
    }
  });
});
