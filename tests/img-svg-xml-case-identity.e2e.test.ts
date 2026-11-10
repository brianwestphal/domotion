import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { inlineImgSvg, withFlattenNestedSvg } from "../src/render/svg-inline.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const blue = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="blue"/></svg>')}`;
interface Fixture {
  name: string;
  body: string;
  attributes?: string;
  raster: boolean;
  color?: number[];
}
const backdrop = '<rect width="40" height="40" fill="red"/>';
const image = (attribute: string) => `<image ${attribute}="${blue}" width="40" height="40"/>`;
const fixtures: Fixture[] = [
  {
    name: "uppercase-css-type",
    body: '<style>RECT{fill:blue}</style><rect width="40" height="40" fill="red"/>',
    raster: true,
  },
  {
    name: "uppercase-css-attribute",
    body: '<style>[DATA-MARK]{fill:blue}</style><rect data-mark="red" width="40" height="40" fill="red"/>',
    raster: true,
  },
  { name: "HREF", body: backdrop + image("HREF"), raster: true },
  { name: "mixed-href", body: backdrop + image("hReF"), raster: true },
  { name: "STYLE", body: '<rect width="40" height="40" fill="red" STYLE="fill:blue"/>', raster: true },
  { name: "mixed-style", body: '<rect width="40" height="40" fill="red" Style="fill:blue"/>', raster: true },
  { name: "duplicate-folded-fill", body: '<rect width="40" height="40" FILL="blue" fill="red"/>', raster: true },
  { name: "uppercase-tag", body: backdrop + '<RECT width="40" height="40" fill="blue"/>', raster: true },
  {
    name: "lowercase-gradient",
    body: '<defs><lineargradient id="p"><stop stop-color="blue"/></lineargradient></defs><rect width="40" height="40" fill="url(#p) red"/>',
    raster: true,
  },
  { name: "lowercase-viewbox", body: backdrop, attributes: 'viewbox="0 0 80 80"', raster: true },
  {
    name: "unknown-attribute-case",
    body: '<style>[data-MARK="red"] rect{fill:red}</style><g data-MARK="red"><rect width="40" height="40" fill="blue"/></g>',
    raster: true,
  },
  { name: "host-id-alias", body: backdrop + '<use HREF="#hostshape"/>', raster: true },
  { name: "canonical-href", body: backdrop + image("href"), raster: false, color: [0, 0, 255] },
  {
    name: "canonical-style",
    body: '<rect width="40" height="40" style="fill:blue"/>',
    raster: false,
    color: [0, 0, 255],
  },
  {
    name: "canonical-unknown-attribute",
    body: '<style><![CDATA[[data-mark="red"] rect{fill:red}rect{fill:attr(data-color type(<color>),blue)}]]></style><g data-mark="red"><rect data-color="red" width="40" height="40"/></g>',
    raster: false,
  },
  {
    name: "canonical-gradient-viewBox",
    body: '<defs><linearGradient id="p" gradientUnits="userSpaceOnUse"><stop stop-color="blue"/></linearGradient></defs><rect width="40" height="40" fill="url(#p)"/>',
    attributes: 'viewBox="0 0 40 40" preserveAspectRatio="none"',
    raster: false,
    color: [0, 0, 255],
  },
  {
    name: "canonical-clipPath",
    body: '<defs><clipPath id="c" clipPathUnits="userSpaceOnUse"><rect width="40" height="40"/></clipPath></defs><rect width="40" height="40" fill="red" clip-path="url(#c)"/>',
    raster: false,
  },
];
let browser: Browser;
const rows: Array<Record<string, unknown>> = [];
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => {
  try {
    const directory = process.env.DOMOTION_XML_CASE_EVIDENCE;
    if (directory != null) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "results.json"),
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            sourceCommit: process.env.GITHUB_SHA ?? null,
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            browser: browser.version(),
            rows,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await closeBrowserSafely(browser);
  }
});
const host =
  '<svg width="0" height="0" style="position:absolute"><defs><rect id="hostshape" width="40" height="40" fill="blue"/></defs></svg>';
describe.each([false, true])("XML image case identity flatten=%s (DM-SC5Y23)", (flatten) => {
  it.each(fixtures)("preserves native source paint: $name", async (fixture) => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" ${fixture.attributes ?? ""}>${fixture.body}</svg>`;
    const page = await browser.newPage({ viewport: { width: 40, height: 40 }, deviceScaleFactor: 1 });
    const requests: string[] = [];
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(new URL(request.url()).origin);
    });
    try {
      await page.setContent(
        `<body style="margin:0;background:white">${host}<div id="target"><img style="display:block" width="40" height="40" src="data:image/svg+xml,${encodeURIComponent(source)}"></div>`,
      );
      await page.locator("img").evaluate((image) => (image as HTMLImageElement).decode());
      const before = await page.locator("img").screenshot();
      const expected = await sharp(before).ensureAlpha().raw().toBuffer();
      expect([...expected.subarray((20 * 40 + 20) * 4, (20 * 40 + 20) * 4 + 3)]).toEqual(fixture.color ?? [255, 0, 0]);
      expect(
        inlineImgSvg(source, { x: 0, y: 0, w: 40, h: 40, par: "none", idPrefix: "case-", documentViewport: true }) ==
          null,
      ).toBe(fixture.raster);
      const tree = await captureElementTree(page, "#target", { x: 0, y: 0, width: 40, height: 40 });
      const output = withFlattenNestedSvg(flatten, () => elementTreeToSvg(tree, 40, 40));
      const parsed = await page.evaluate((markup) => {
        const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
        return [...doc.querySelectorAll("image")].map((image) => image.getAttribute("href"));
      }, output);
      // A vector-admitted SVG may itself contain a valid nested data image.
      // Whole-source fallback is identified by its source body, not tag count.
      const wholeSource = parsed.some(
        (href) =>
          href != null &&
          (href.includes(encodeURIComponent(fixture.body)) ||
            (href.includes(";base64,") &&
              Buffer.from(href.split(";base64,")[1], "base64").toString().includes(fixture.body))),
      );
      expect(wholeSource).toBe(fixture.raster);
      if (fixture.raster) expect(output).toContain("data:image/svg+xml");
      await page.setContent(`<body style="margin:0;background:white">${host}<div id="actual">${output}</div>`);
      const after = await page.locator("#actual > svg").screenshot();
      const actual = await sharp(after).ensureAlpha().raw().toBuffer();
      expect(actual).toEqual(expected);
      expect(requests).toEqual([]);
      expect(await page.evaluate(() => 1 + 1)).toBe(2);
      const name = `${fixture.name}-${flatten ? "flat" : "nested"}`;
      const directory = process.env.DOMOTION_XML_CASE_EVIDENCE;
      if (directory != null) {
        await mkdir(directory, { recursive: true });
        await Promise.all([
          writeFile(join(directory, `${name}-source.png`), before),
          writeFile(join(directory, `${name}-captured.png`), after),
          writeFile(join(directory, `${name}-source.svg`), source),
          writeFile(join(directory, `${name}-captured.svg`), output),
        ]);
      }
      rows.push({
        name,
        raster: fixture.raster,
        inlineAdmission: !fixture.raster,
        wholeSourceFallback: wholeSource,
        sourceBytes: Buffer.byteLength(source),
        exactPixels: true,
        sourceSha256: createHash("sha256").update(source).digest("hex"),
        rgbSha256: createHash("sha256").update(actual).digest("hex"),
        extraRequests: requests,
      });
    } finally {
      await page.close();
    }
  });
});
