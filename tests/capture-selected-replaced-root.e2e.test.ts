import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Browser, Page } from "@playwright/test";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import type { CapturedElement } from "../src/capture/types.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

const viewport = { x: 0, y: 0, width: 100, height: 100 };
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>';
const image = `data:image/svg+xml,${encodeURIComponent(svg)}`;
let browser: Browser;
let priorGenericProbe: string | undefined;
beforeAll(async () => {
  priorGenericProbe = process.env["DOMOTION_GENERIC_PROBE"];
  process.env["DOMOTION_GENERIC_PROBE"] = "0";
  browser = await launchChromium();
});
afterAll(async () => {
  await closeBrowserSafely(browser);
  if (priorGenericProbe == null) delete process.env["DOMOTION_GENERIC_PROBE"];
  else process.env["DOMOTION_GENERIC_PROBE"] = priorGenericProbe;
});

async function fixture(content: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
  await page.setContent(
    `<style>body{margin:0}#container{width:20px;height:20px}#only{display:block;width:20px;height:20px;margin:0;padding:0;border:0;background:transparent}</style><div id="container">${content}</div>`,
  );
  return page;
}
const pixels = async (page: Page, path?: string) =>
  sharp(await page.screenshot({ omitBackground: true, path }))
    .ensureAlpha()
    .raw()
    .toBuffer();
function owned(tree: CapturedElement[], tag: string): CapturedElement[] {
  const found: CapturedElement[] = [];
  forEachElement(tree, (node) => {
    if (node.tag === tag) found.push(node);
  });
  return found;
}
async function matchesSource(
  page: Page,
  tree: CapturedElement[],
  source: Buffer,
  evidenceName?: string,
): Promise<void> {
  const raster = await browser.newPage({ viewport: { width: 100, height: 100 } });
  try {
    const output =
      evidenceName == null
        ? undefined
        : resolve(
            process.env["DOMOTION_OUTPUT_DIR"] ??
              (process.platform === "linux" ? "tests/output-linux" : "tests/output"),
          );
    if (output != null) mkdirSync(output, { recursive: true });
    await raster.setContent(`<body style="margin:0">${elementTreeToSvg(tree, 100, 100)}</body>`);
    expect(await pixels(raster, output == null ? undefined : join(output, `${evidenceName}-actual.png`))).toEqual(
      source,
    );
    expect(await pixels(page, output == null ? undefined : join(output, `${evidenceName}-expected.png`))).toEqual(
      source,
    );
  } finally {
    await raster.close();
  }
}

it("selects a visible transparent image itself, matching body/container and background controls", async () => {
  const page = await fixture(`<img id="only" width="20" height="20" src="${image}">`);
  try {
    await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
    const source = await pixels(page);
    expect(Array.from(source.subarray((10 * 100 + 10) * 4, (10 * 100 + 10) * 4 + 4))).toEqual([255, 0, 0, 255]);
    // The container/document already reach this image; direct selection must
    // retain that same owner without requiring an authored background.
    for (const selector of ["#container", "body", "#only"]) {
      const tree = await captureElementTree(page, selector, viewport);
      const images = owned(tree, "img");
      expect(images, selector).toHaveLength(1);
      expect(images[0].imageSrc).toBe(image);
      expect(images[0].imageIntrinsic).toEqual({ w: 20, h: 20 });
      expect(images[0].children).toEqual([]);
      if (selector !== "body") expect(tree.map((node) => node.tag)).toEqual(["img"]);
      await matchesSource(page, tree, source, selector === "#only" ? "selected-root-image" : undefined);
    }
    await page.locator("#only").evaluate((node: HTMLElement) => {
      node.style.backgroundColor = "white";
    });
    const backgroundTree = await captureElementTree(page, "#only", viewport);
    expect(owned(backgroundTree, "img")).toHaveLength(1);
    await matchesSource(page, backgroundTree, source);
  } finally {
    await page.close();
  }
});

it.each(["canvas", "svg", "iframe", "open-shadow"] as const)(
  "retains a selected %s paint owner through existing capture",
  async (kind) => {
    const content =
      kind === "canvas"
        ? '<canvas id="only" width="20" height="20"></canvas>'
        : kind === "svg"
          ? svg.replace("<svg ", '<svg id="only" ')
          : kind === "iframe"
            ? '<iframe id="only" width="20" height="20" srcdoc="<body style=\'margin:0;width:20px;height:20px;background:red\'></body>"></iframe>'
            : '<paint-leaf id="only"></paint-leaf>';
    const page = await fixture(content);
    try {
      if (kind === "canvas")
        await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext("2d")!;
          context.fillStyle = "red";
          context.fillRect(0, 0, 20, 20);
        });
      if (kind === "iframe") await page.frameLocator("iframe").locator("body").waitFor();
      if (kind === "open-shadow")
        await page.locator("#only").evaluate((node) => {
          node.attachShadow({ mode: "open" }).innerHTML = '<div style="width:20px;height:20px;background:red"></div>';
        });
      const source = await pixels(page);
      expect(Array.from(source.subarray((10 * 100 + 10) * 4, (10 * 100 + 10) * 4 + 4))).toEqual([255, 0, 0, 255]);
      const tree = await captureElementTree(page, "#only", viewport);
      expect(tree).toHaveLength(1);
      expect(tree[0].tag).toBe(kind === "open-shadow" ? "paint-leaf" : kind);
      if (kind === "svg") expect(tree[0].svgContent).toContain("rect");
      if (kind === "canvas" || kind === "open-shadow") expect(tree[0].replacedSnapshot?.dataUri).toMatch(/^data:image/);
      await matchesSource(page, tree, source);
    } finally {
      await page.close();
    }
  },
);

it.each([
  { tag: "input", content: '<input id="only" type="checkbox" checked>' },
  { tag: "textarea", content: '<textarea id="only"></textarea>' },
  { tag: "select", content: '<select id="only"><option>A</option></select>' },
  { tag: "button", content: '<button id="only"></button>' },
  { tag: "progress", content: '<progress id="only" value="0.5" max="1"></progress>' },
  { tag: "meter", content: '<meter id="only" value="0.5" min="0" max="1"></meter>' },
])("admits the existing native-control producer for a selected $tag", async ({ tag, content }) => {
  const page = await fixture(content);
  try {
    const tree = await captureElementTree(page, "#only", viewport);
    expect(tree).toHaveLength(1);
    expect(tree[0].tag).toBe(tag);
    if (tag === "input") expect(tree[0].styles.checked).toBe(true);
    if (tag === "progress") expect(tree[0].styles.progressValue).toBe(0.5);
    if (tag === "meter") expect(tree[0].styles.meterValue).toBe(0.5);
  } finally {
    await page.close();
  }
});

it.each([
  `<img id="only" src="${image}" style="display:none">`,
  `<img id="only" src="${image}" style="visibility:hidden">`,
  `<img id="only" src="${image}" style="position:absolute;left:200px">`,
  '<canvas id="only" width="0" height="0" style="width:0;height:0"></canvas>',
  '<div id="only"></div>',
])("preserves existing visibility/geometry pruning and empty-container flattening: %s", async (content) => {
  const page = await fixture(content);
  try {
    expect(await captureElementTree(page, "#only", viewport)).toEqual([]);
  } finally {
    await page.close();
  }
});
