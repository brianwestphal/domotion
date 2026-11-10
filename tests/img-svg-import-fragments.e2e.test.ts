import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const sheet = (css: string): string => `data:text/css;base64,${Buffer.from(css).toString("base64")}`;
const gradient = (id = 'id="p"', color = "red"): string =>
  `<linearGradient ${id}><stop stop-color="${color}"/></linearGradient>`;
const rectangle = '<rect class="paint" width="40" height="40" fill="lime"/>';
const marker = (color: string): string =>
  `<marker id="p" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="4" refY="4"><rect width="8" height="8" fill="${color}"/></marker>`;
interface Fixture {
  name: string;
  css: string;
  own: string;
  host: string;
  shape?: string;
  raster?: boolean;
}
const fixtures: Fixture[] = [
  {
    name: "escaped class selector",
    css: ".\\70 aint{fill:url(#p)}",
    own: gradient(),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "class attribute whitespace",
    css: ".paint{fill:url(#p)}",
    own: gradient(),
    host: gradient('id="p"', "blue"),
    shape: '<rect class = "paint" width="40" height="40" fill="lime"/>',
    raster: true,
  },
  {
    name: "attribute selector containing a dot",
    css: 'rect[id="shape.dot"]{fill:url(#p)}',
    own: gradient(),
    host: gradient('id="p"', "blue"),
    shape: '<rect id="shape.dot" width="40" height="40" fill="lime"/>',
    raster: true,
  },
  { name: "fill", css: ".paint{fill:url(#p)}", own: gradient(), host: gradient('id="p"', "blue") },
  {
    name: "quoted URL and single-quoted ID",
    css: '.paint{fill:URL( "#p" )}',
    own: gradient("id='p'"),
    host: gradient('id="p"', "blue"),
  },
  {
    name: "stroke",
    css: ".paint{stroke:url('#p')}",
    own: gradient(),
    host: gradient('id="p"', "blue"),
    shape: '<rect class="paint" x="5" y="5" width="30" height="30" fill="none" stroke="lime" stroke-width="6"/>',
  },
  {
    name: "clip path",
    css: ".paint{clip-path:url(#p)}",
    own: '<clipPath id="p"><rect width="20" height="40"/></clipPath>',
    host: '<clipPath id="p"><rect x="20" width="20" height="40"/></clipPath>',
  },
  {
    name: "filter",
    css: ".paint{filter:url(#p)}",
    own: '<filter id="p"><feFlood flood-color="red"/></filter>',
    host: '<filter id="p"><feFlood flood-color="blue"/></filter>',
  },
  ...["mask", "mask-image"].map((property) => ({
    name: property,
    css: `.paint{${property}:url(#p)}`,
    own: '<mask id="p" maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><rect width="20" height="40" fill="white"/></mask>',
    host: '<mask id="p" maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40"><rect x="20" width="20" height="40" fill="white"/></mask>',
  })),
  ...["marker-start", "marker-mid", "marker-end"].map((property) => ({
    name: property,
    css: `.paint{${property}:url(#p)}`,
    own: marker("red"),
    host: marker("blue"),
    shape: '<path class="paint" d="M8 20L20 20L32 20" stroke="black" stroke-width="2" fill="none"/>',
  })),
  {
    name: "neighboring gradient href chain",
    css: ".paint{fill:url(#p)}",
    own: gradient('id="g"') + '<linearGradient id="p" href="#g"/>',
    host: gradient('id="p"', "blue"),
  },
  {
    name: "nested data import",
    css: `@import "${sheet(".paint{fill:url(#p)}")}";`,
    own: gradient(),
    host: gradient('id="p"', "blue"),
  },
  {
    name: "missing target",
    css: ".paint{fill:url(#p) lime}",
    own: gradient('id="other"'),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "ID attribute whitespace",
    css: ".paint{fill:url(#p)}",
    own: gradient('id = "p"'),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "entity-encoded ID",
    css: ".paint{fill:url(#p)}",
    own: gradient('id="&#112;"'),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "percent-encoded fragment",
    css: ".paint{fill:url(#%70)}",
    own: gradient(),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "duplicate target",
    css: ".paint{fill:url(#p)}",
    own: gradient() + gradient('id="p"', "purple"),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "unproved custom-property consumer",
    css: ".paint{--paint:url(#p);fill:var(--paint)}",
    own: gradient(),
    host: gradient('id="p"', "blue"),
    raster: true,
  },
  {
    name: "neighboring unresolved use",
    css: ".paint{fill:url(#p)}",
    own: gradient(),
    host: gradient('id="p"', "blue") + '<rect id="hostshape" width="40" height="40" fill="blue"/>',
    shape: rectangle + '<use href="#hostshape"/>',
    raster: true,
  },
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe.each([false, true])("DM-YMAF0G imported fragment ownership (flatten=%s)", (flatten) => {
  it.each(fixtures)("matches native source paint with competing host IDs: $name", async (fixture) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style>@import "${sheet(fixture.css)}";</style><defs>${fixture.own}</defs>${fixture.shape ?? rectangle}</svg>`;
    const host = `<svg width="0" height="0" style="position:absolute"><defs>${fixture.host}</defs></svg>`;
    const page = await browser.newPage({ viewport: { width: 40, height: 40 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${host}<div id="target"><img style="display:block" width="40" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}"></div>`,
      );
      await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      const native = await sharp(await page.locator("img").screenshot())
        .raw()
        .toBuffer();
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 40, height: 40 });
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 40, 40));
      if (!fixture.raster) expect(output).not.toMatch(/url\(\s*['"]?#p['"]?\s*\)/i);
      await page.setContent(`<body style="margin:0;background:white">${host}<div id="actual">${output}</div>`);
      const actual = await sharp(await page.locator("#actual > svg").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native), "host IDs must not change the image's native pixels").toBe(true);
      expect(output.includes("<image ")).toBe(fixture.raster === true);
    } finally {
      await page.close();
    }
  });
});
