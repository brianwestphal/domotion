import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { flattenImgSvg, inlineImgSvg, withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const image = (id: string, color: string, overflow = "hidden"): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" overflow="${overflow}"><defs><linearGradient id="${id}"><stop stop-color="${color}"/></linearGradient></defs><rect width="40" height="40" fill="url(#${id}) lime"/></svg>`;
const cssImage = (css: string, shape = '<rect width="40" height="40" fill="lime"/>'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><style><![CDATA[${css}]]></style>${shape}</svg>`;
interface Fixture {
  name: string;
  sources: string[];
  owners?: string[];
  host?: string;
  typedAttr?: boolean;
  colors?: number[][];
}
const fixtures: Fixture[] = [
  {
    name: "numeric owner prefixes",
    sources: [image("0foo", "red"), image("foo", "blue")],
    owners: ["svgimg1", "svgimg10"],
  },
  { name: "source ID matches drawn-image wrapper suffix", sources: [image("vclip-img", "red", "visible")] },
  { name: "source ID matches viewport wrapper suffix", sources: [image("vclip", "red")] },
  {
    name: "same authored ID in separate owners",
    sources: [image("p", "red"), image("p", "blue")],
    owners: ["svgimg1", "svgimg10"],
  },
  {
    name: "host old generated name cannot steal source resource",
    sources: [image("foo", "blue")],
    owners: ["svgimg10"],
    host: '<svg width="0" height="0" style="position:absolute"><linearGradient id="svgimg10foo"><stop stop-color="purple"/></linearGradient></svg>',
  },
  {
    name: "cross-owner registered custom properties",
    sources: [
      cssImage('@property --0tone {syntax:"<color>";inherits:false;initial-value:red} rect{fill:var(--0tone)}'),
      cssImage('@property --tone {syntax:"<color>";inherits:false;initial-value:blue} rect{fill:var(--tone)}'),
    ],
    owners: ["svgimg1", "svgimg10"],
    colors: [
      [255, 0, 0],
      [0, 0, 255],
    ],
  },
  {
    name: "cross-owner keyframe names",
    sources: [
      cssImage('@keyframes "0paint"{to{fill:red}}rect{animation:"0paint" 1s paused both;animation-delay:-1s}'),
      cssImage("@keyframes paint{to{fill:blue}}rect{animation:paint 1s paused both;animation-delay:-1s}"),
    ],
    owners: ["svgimg1", "svgimg10"],
    colors: [
      [255, 0, 0],
      [0, 0, 255],
    ],
  },
  {
    name: "original selector attr and string semantics with unsafe owner token",
    sources: [
      cssImage(
        'rect[id="20px"][class="a.b"][style*="red"]{width:attr(id type(<length>));--literal:"svgimg1p .a.b #p url(#p)"}',
        '<rect id="20px" class="a.b" width="40" height="40" style="fill:red"/>',
      ),
    ],
    owners: ['a"<&'],
    typedAttr: true,
  },
  {
    name: "transformed image needs both wrapper kinds",
    sources: [image("vclip", "red").replace('overflow="hidden"', 'overflow="hidden" transform="scale(0.5)"')],
  },
];

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

describe.each([false, true])("DM-R7ME85 image namespace ownership (flatten=%s)", (flatten) => {
  it.each(fixtures)("preserves native paint: $name", async (fixture) => {
    const width = fixture.sources.length * 40;
    const page = await browser.newPage({ viewport: { width, height: 40 }, deviceScaleFactor: 1 });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${fixture.host ?? ""}<div id="target" style="display:flex;width:${width}px">${fixture.sources.map((source) => `<img width="40" height="40" style="display:block" src="data:image/svg+xml,${encodeURIComponent(source)}">`).join("")}</div>`,
      );
      await page
        .locator("img")
        .evaluateAll((images) => Promise.all(images.map((image) => (image as HTMLImageElement).decode())));
      const native = await sharp(await page.locator("#target").screenshot())
        .raw()
        .toBuffer();
      const channels = native.length / (width * 40);
      const pixel = (x: number): number[] => [
        ...native.subarray((20 * width + x) * channels, (20 * width + x) * channels + 3),
      ];
      if (fixture.colors != null)
        fixture.colors.forEach((color, index) =>
          expect(pixel(index * 40 + 20), "source must activate the intended CSS name").toEqual(color),
        );
      if (fixture.typedAttr) {
        expect(pixel(10)).toEqual([255, 0, 0]);
        expect(pixel(30)).toEqual([255, 255, 255]);
      }
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width, height: 40 });
      const output =
        fixture.owners == null
          ? withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, width, 40))
          : `<svg width="${width}" height="40">${fixture.sources
              .map((source, index) => {
                const placement = {
                  x: index * 40,
                  y: 0,
                  w: 40,
                  h: 40,
                  par: "none",
                  documentViewport: true,
                  idPrefix: fixture.owners![index],
                };
                return (flatten ? flattenImgSvg(source, placement) : null) ?? inlineImgSvg(source, placement);
              })
              .join("")}</svg>`;
      expect(output).not.toContain("<image ");
      if (fixture.typedAttr) expect(output).toContain('"svgimg1p .a.b #p url(#p)"');
      await page.setContent(
        `<body style="margin:0;background:white">${fixture.host ?? ""}<div id="actual">${output}</div>`,
      );
      const actual = await sharp(await page.locator("#actual > svg").screenshot())
        .raw()
        .toBuffer();
      expect(actual.equals(native), "authored resources and generated wrappers must retain their own paint").toBe(true);
      const ids = await page.locator("#actual [id]").evaluateAll((elements) => elements.map((element) => element.id));
      expect(new Set(ids).size, "all emitted image and wrapper IDs must be unique").toBe(ids.length);
    } finally {
      await page.close();
    }
  });
});
