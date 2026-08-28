#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { captureElementTree } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { needsChromiumGradientRaster } from "../src/render/advanced-gradient-raster.js";
import { parseConicGradient } from "../src/render/gradients.js";

type Row = { id: string; expected: unknown; actual: unknown; pass: boolean; source: string };
type Boundary = "replaced" | "element-text" | "native-control" | "backdrop" | "projective" | "glyph" | "url-filter";

function walk(elements: CapturedElement[], visit: (element: CapturedElement) => void): void {
  for (const element of elements) { visit(element); walk(element.children, visit); }
}

function activated(tree: CapturedElement[], boundary: Boundary): boolean {
  let result = false;
  walk(tree, (element) => {
    if (boundary === "replaced" && element.replacedSnapshot?.dataUri != null) result = true;
    if (boundary === "element-text" && element.elementRaster?.dataUri != null) result = true;
    if (boundary === "native-control" && element.nativeControlRaster?.dataUri != null) result = true;
    if (boundary === "backdrop" && element.backdropFilterRaster?.dataUri != null) result = true;
    if (boundary === "projective" && element.transformSubtreeRaster?.dataUri != null) result = true;
    if (boundary === "glyph" && element.textSegments?.some((segment) => segment.rasterDataUri != null || segment.rasterGlyphs?.some((glyph) => glyph.dataUri != null)) === true) result = true;
    if (boundary === "url-filter" && (element.urlFilterRaster?.dataUri != null || element.urlFilterRaster?.empty === true)) result = true;
  });
  return result;
}

async function capture(browser: Browser, html: string): Promise<CapturedElement[]> {
  const page = await browser.newPage({ viewport: { width: 500, height: 320 } });
  try {
    await page.setContent(`<style>html,body{margin:0}body{font:24px Arial,sans-serif}</style>${html}`);
    await page.waitForTimeout(80);
    return await captureElementTree(page, "body", { x: 0, y: 0, width: 500, height: 320 });
  } finally {
    await page.close();
  }
}

export async function runRasterBoundaryOracle(): Promise<{ rows: Row[]; mutationMoved: boolean }> {
  const browser = await chromium.launch({ headless: true });
  const rows: Row[] = [];
  const add = (id: string, expected: unknown, actual: unknown, source: string): void => {
    rows.push({ id, expected, actual, pass: JSON.stringify(actual) === JSON.stringify(expected), source });
  };
  try {
    const cases: Array<[string, Boundary, boolean, string, string]> = [
      ["replaced.canvas", "replaced", true, '<canvas width="80" height="40"></canvas>', "Blink canvas paint is a bitmap surface"],
      ["replaced.ordinary-div-vector", "replaced", false, '<div style="width:80px;height:40px;background:red"></div>', "ordinary CSS box has an SVG representation"],
      ["replaced.cross-origin-frame", "replaced", true, '<iframe src="data:text/html,<body style=background:red>opaque</body>" width="120" height="60"></iframe>', "inaccessible browsing-context snapshot boundary"],
      ["replaced.same-origin-frame-vector", "replaced", false, '<iframe srcdoc="<body style=background:red>same</body>" width="120" height="60"></iframe>', "accessible iframe recursively captured as vector DOM"],
      ["replaced.sprite-replacement", "replaced", true, '<div aria-label="icon" style="width:40px;height:40px;text-indent:-9999px;overflow:hidden;white-space:nowrap;background-image:linear-gradient(red,red)">icon</div>', "CSS image-replacement hides unreachable offscreen text"],
      ["replaced.background-vector", "replaced", false, '<div style="width:40px;height:40px;background-image:linear-gradient(red,red)"></div>', "ordinary background remains vector"],
      ["text.textarea-soft-wrap-vector", "element-text", false, '<textarea style="width:100px;height:70px;appearance:none">a long soft wrapped textarea value</textarea>', "logical line capture replaced the retired textarea raster path"],
      ["text.vertical-vector", "element-text", false, '<div style="writing-mode:vertical-rl;height:100px">Vertical text</div>', "vertical run geometry is represented as vectors"],
      ["control.native-checkbox", "native-control", true, '<input type="checkbox" checked>', "Blink LayoutTheme owns native appearance"],
      ["control.appearance-none-vector", "native-control", false, '<input type="checkbox" checked style="appearance:none;width:20px;height:20px;background:red">', "author-owned appearance has an SVG representation"],
      ["backdrop.active", "backdrop", true, '<div style="width:80px;height:40px;backdrop-filter:blur(2px)"></div>', "backdrop input surface is unavailable inside an image SVG"],
      ["backdrop.none-vector", "backdrop", false, '<div style="width:80px;height:40px;filter:blur(2px)"></div>', "ordinary filter consumes the element surface and stays SVG"],
      ["url-filter.convolve-html", "url-filter", true, '<svg width="0" height="0"><filter id="conv"><feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" edgeMode="duplicate"/></filter></svg><div style="width:80px;height:40px;background:red;filter:url(#conv)"></div>', "Blink layer pixels and Skia matrix crop/tile own HTML SourceGraphic"],
      ["url-filter.gaussian-vector", "url-filter", false, '<svg width="0" height="0"><filter id="blur"><feGaussianBlur stdDeviation="2"/></filter></svg><div style="width:80px;height:40px;background:red;filter:url(#blur)"></div>', "ordinary URL filter graph remains native SVG"],
      ["url-filter.direct-svg-vector", "url-filter", false, '<svg width="100" height="60"><filter id="conv"><feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0"/></filter><rect width="80" height="40" fill="red" filter="url(#conv)"/></svg>', "native SVG SourceGraphic stays within SVG ownership"],
      ["transform.projective", "projective", true, '<div style="perspective:300px;width:120px;height:80px"><div style="width:80px;height:50px;background:red;transform:rotateY(35deg)"></div></div>', "projective quad cannot be represented by an affine SVG transform"],
      ["transform.affine-vector", "projective", false, '<div style="width:80px;height:50px;background:red;transform:rotate(35deg)"></div>', "affine CSS transform maps exactly to SVG matrix"],
      ["glyph.emoji", "glyph", true, '<div>😀</div>', "color bitmap glyph has no monochrome outline"],
      ["glyph.ascii-vector", "glyph", false, '<div>Vector text</div>', "ordinary outline glyph stays on text/path pipeline"],
    ];
    for (const [id, boundary, expected, html, source] of cases) {
      add(id, expected, activated(await capture(browser, html), boundary), source);
    }

    const pseudoFilterTree = await capture(browser, `<style>
      #pf{position:relative;width:100px;height:60px}
      #pf::before{content:"";position:absolute;inset:10px;background:rgba(255,0,0,.5);
        filter:blur(2px) saturate(1.4) drop-shadow(blue 3px 2px 1px)}
    </style><div id="pf"></div>`);
    const pseudoFilterSvg = elementTreeToSvg(pseudoFilterTree, 500, 320);
    add(
      "filter.pseudo-shorthand-vector",
      true,
      pseudoFilterSvg.includes("style=\"filter:blur(2px) saturate(1.4) drop-shadow")
        && !pseudoFilterSvg.includes("<feGaussianBlur")
        && !pseudoFilterSvg.includes("<image"),
      "CSS shorthand lists stay in Blink's native SVG CSS-filter pipeline; they are not screenshot or primitive-lowering boundaries",
    );

    add("gradient.oklab-raster", true, needsChromiumGradientRaster("linear-gradient(in oklab, red, blue)"), "SVG lacks CSS Color 4 interpolation spaces");
    add("gradient.alpha-raster", true, needsChromiumGradientRaster("linear-gradient(rgba(255,0,0,.2), blue)"), "Blink premultiplies alpha while SVG does not");
    add("gradient.opaque-srgb-vector", false, needsChromiumGradientRaster("linear-gradient(red, blue)"), "opaque sRGB interpolation is native SVG");
    add("conic.active", true, parseConicGradient("conic-gradient(red, blue)") != null, "SVG has no conic paint server");
    add("conic.linear-negative", false, parseConicGradient("linear-gradient(red, blue)") != null, "linear gradient remains native SVG");
    const supportPage = await browser.newPage();
    try {
      add("mask.element-dormant", false, await supportPage.evaluate(() => CSS.supports("mask-image", "element(#source)")), "pinned Chromium parse-rejects CSS element() masks");
    } finally {
      await supportPage.close();
    }

    const previous = process.env.DOMOTION_DISABLE_HELPER;
    process.env.DOMOTION_DISABLE_HELPER = "1";
    try {
      add("helper-disabled.ascii-stays-vector", false, activated(await capture(browser, '<div>Helperless best effort</div>'), "glyph"), "helper absence degrades font precision, not the vector/raster contract");
      add("helper-disabled.emoji-still-raster", true, activated(await capture(browser, '<div>😀</div>'), "glyph"), "color bitmap boundary is independent of native outline helper availability");
    } finally {
      if (previous == null) delete process.env.DOMOTION_DISABLE_HELPER;
      else process.env.DOMOTION_DISABLE_HELPER = previous;
    }
  } finally { await browser.close(); }
  const positive = rows.find((row) => row.id === "gradient.oklab-raster")?.actual;
  const negative = rows.find((row) => row.id === "gradient.opaque-srgb-vector")?.actual;
  return { rows, mutationMoved: positive === true && negative === false };
}

async function main(): Promise<void> {
  const report = await runRasterBoundaryOracle();
  const failures = report.rows.filter((row) => !row.pass);
  const jsonIndex = process.argv.indexOf("--json");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1] != null) writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(report, null, 2));
  console.log(`raster boundary oracle: ${report.rows.length - failures.length}/${report.rows.length}; mutation control ${report.mutationMoved ? "moved" : "DID NOT MOVE"}`);
  for (const failure of failures) console.log(`FAIL ${failure.id}: expected=${JSON.stringify(failure.expected)} actual=${JSON.stringify(failure.actual)}`);
  if (failures.length > 0 || !report.mutationMoved) process.exitCode = 1;
}
if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
