import { createHash } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(() => closeBrowserSafely(browser), 15_000);
const viewport = { x: 0, y: 0, width: 80, height: 80 };
const pageStyle = "<style>body{margin:0;background:rgb(245,245,255)}svg{display:block}</style>";
const icon = '<path fill="#533afd" d="M13.75 6.75H10.25V5H15.5V10.25H13.75ZM6.75 10.25H5V15.5H10.25V13.75H6.75Z"/>';
const svg = (style: string, attrs = 'viewBox="0 0 20 20"', path = icon) =>
  `<svg id="icon" style="${style}" width="20" height="20" ${attrs}>${path}</svg>`;
const sourceSvg = (nodes: CapturedElement[]): CapturedElement | undefined => {
  for (const node of nodes) {
    if (node.svgContent != null) return node;
    const inner = sourceSvg(node.children);
    if (inner) return inner;
  }
  return undefined;
};
const pixels = async (page: Page) =>
  sharp(await screenshotAfterPresentedFrame(page))
    .ensureAlpha()
    .raw()
    .toBuffer();

const positioned = (left: number, top: number) => `position:absolute;left:${left}px;top:${top}px`;

it("reproduces the retained Stripe expand-icon crop and its historical negative control", async () => {
  const size = { x: 0, y: 0, width: 390, height: 844 };
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage(),
    output = await context.newPage();
  // SHA256 of raw RGBA from the original 20×20 source and output crops (DM-7PGR0X).
  const digest = async (p: Page) =>
    createHash("sha256")
      .update(
        await sharp(await screenshotAfterPresentedFrame(p))
          .extract({ left: 329, top: 129, width: 20, height: 20 })
          .ensureAlpha()
          .raw()
          .toBuffer(),
      )
      .digest("hex");
  try {
    await page.setContent(pageStyle + svg(positioned(329, 129.484375)));
    const original = "39a2fcbb0c84599276361cfbe3a267b1b7a6b4c4fa3532e6c6ae5f981e5c321c";
    expect(await digest(page)).toBe(original);
    const tree = await captureElementTree(page, "body", size);
    for (const flattenNestedSvg of [false, true]) {
      await output.setContent(pageStyle + elementTreeToSvg(tree, 390, 844, { flattenNestedSvg }));
      expect(await digest(output)).toBe(original);
    }
    delete sourceSvg(tree)!.svgRootPaint;
    await output.setContent(pageStyle + elementTreeToSvg(tree, 390, 844));
    expect(await digest(output)).toBe("bd6b5f0d131aa5bd133a825a4a39799516d42a55e5c0a3f89223f4cbb1ff83e7");
  } finally {
    await context.close();
  }
});
const wrap = (style: string, body: string) => `<div style="${style};width:60px;height:60px">${body}</div>`;
const spill = '<path fill="#533afd" d="M-9 -17H27V2H-9z M2 2h10v11H2z"/>';
const cases = [
  { name: "Stripe layout phase", html: svg(positioned(29, 29.484375)), x: 29, y: 29 },
  { name: "negative half", html: svg(positioned(-0.5, 29.5)), x: 0, y: 30 },
  {
    name: "eligible containment",
    html: wrap(positioned(11.484375, 10.484375) + ";contain:layout style", svg(positioned(3.3125, 4.3125))),
    x: 14,
    y: 14,
  },
  {
    name: "layout-only containment",
    html: wrap(positioned(11.484375, 10.484375) + ";contain:layout", svg(positioned(3.3125, 4.3125))),
    x: 15,
    y: 15,
  },
  {
    name: "nested eligible containment",
    html: wrap(
      positioned(11.484375, 10.484375) + ";contain:layout style",
      wrap(positioned(7.484375, 8.484375) + ";contain:layout style", svg(positioned(3.484375, 4.484375))),
    ),
    x: 21,
    y: 22,
  },
  {
    name: "integral document scroll",
    html: `<div style="height:300px"></div>${svg(positioned(8.484375, 58.484375))}<script>scrollTo(0,30)</script>`,
    x: 8,
    y: 28,
  },
  {
    name: "integral container scroll",
    html: `<div id="scroller" style="position:absolute;overflow:hidden;width:70px;height:70px"><div style="height:200px"></div>${wrap(positioned(11.484375, 40.484375) + ";contain:layout style", svg(positioned(3.484375, 4.484375)))}</div><script>scroller.scrollTop=30</script>`,
    x: 14,
    y: 14,
  },
  ...["hidden", "visible"].map((overflow) => ({
    name: `translated nonunit viewBox with overflow ${overflow}`,
    html: svg(
      positioned(20.25, 19.484375) + ";overflow:" + overflow,
      'viewBox="-3 -7 11 23" preserveAspectRatio="none"',
      spill,
    ),
    x: 20,
    y: 19,
  })),
];

for (const deviceScaleFactor of [1, 2]) {
  it.each(cases)(
    `uses the source origin in both emission modes at DSF ${deviceScaleFactor}: $name`,
    async ({ html, x, y }) => {
      const context = await browser.newContext({ viewport, deviceScaleFactor });
      const page = await context.newPage(),
        output = await context.newPage();
      try {
        await page.setContent(pageStyle + html);
        const source = await pixels(page);
        const rect = await page.locator("#icon").evaluate((el) => el.getBoundingClientRect().toJSON());
        const tree = await captureElementTree(page, "body", viewport);
        const node = sourceSvg(tree)!;
        expect([node.x, node.y, node.width, node.height]).toEqual([rect.x, rect.y, rect.width, rect.height]);
        expect(node.svgRootPaint).toEqual({
          source: "blink-inline-svg-root-paint-v1",
          dx: x - rect.x,
          dy: y - rect.y,
          width: 20,
          height: 20,
        });
        for (const flattenNestedSvg of [false, true]) {
          const result = elementTreeToSvg(tree, viewport.width, viewport.height, { flattenNestedSvg });
          // An inert flatten flag must not turn the second pixel control into a repeat of the first.
          expect((result.match(/<svg\b/g) ?? []).length).toBe(flattenNestedSvg ? 1 : 2);
          await output.setContent(pageStyle + result);
          expect((await pixels(output)).equals(source)).toBe(true);
        }
        delete node.svgRootPaint;
        await output.setContent(pageStyle + elementTreeToSvg(tree, viewport.width, viewport.height));
        expect((await pixels(output)).equals(source)).toBe(false);
      } finally {
        await context.close();
      }
    },
  );
}

it.each([20, 20.25])("adopts the actual SVG candidate at %d px and declines a closed slotted host", async (width) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(
      pageStyle +
        `<main style="outline:1px solid black;width:60px;height:60px"><div id="host">${svg(positioned(29, 29.484375) + `;width:${width}px`)}</div></main>`,
    );
    const capture = async () => sourceSvg(await captureElementTree(page, "main", viewport))!;
    expect((await capture()).svgRootPaint?.dy).toBe(-0.484375);
    await page.locator("#host").evaluate((host) => {
      host.attachShadow({ mode: "closed" }).innerHTML = "<slot></slot>";
    });
    const closed = await capture();
    expect(closed.svgContent).toContain("path");
    expect(closed.svgRootPaint).toBeUndefined();
  } finally {
    await page.close();
  }
});

it.each([
  ["nonunit CSS zoom", "", "zoom:1.25"],
  ["frozen transform", "", "transform:translate(3.125px,2px)"],
  ["SVG border box", "padding:2px", ""],
])("retains prior geometry for %s", async (_name, css, parentCss) => {
  const page = await browser.newPage({ viewport });
  try {
    await page.setContent(pageStyle + wrap(parentCss, svg(positioned(20.25, 19.484375) + ";" + css)));
    const node = sourceSvg(await captureElementTree(page, "body", viewport))!;
    expect(node.svgContent).toContain("path");
    expect(node.svgRootPaint).toBeUndefined();
  } finally {
    await page.close();
  }
});

const fractionalViewport = { x: 0, y: 0, width: 136, height: 137 };
const stripes =
  '<path fill="blue" d="M-4 -4h28v28H-4z"/><path fill="red" d="M3.23 -4h1.28v28H3.23z M13.75 -4h1.7v28h-1.7z"/>';
const fractionalCases = [
  {
    name: "shrink",
    x: 19.234375,
    y: 11.234375,
    width: 20.25,
    height: 20,
    snappedWidth: 20,
    snappedHeight: 20,
    clip: true,
  },
  {
    name: "expand",
    x: 19.484375,
    y: 11.234375,
    width: 20.25,
    height: 20,
    snappedWidth: 21,
    snappedHeight: 20,
    clip: true,
  },
  {
    name: "mixed shrink and expand",
    x: 19.234375,
    y: 11.484375,
    width: 20.25,
    height: 17.75,
    snappedWidth: 20,
    snappedHeight: 18,
    clip: true,
  },
  {
    name: "visible overflow",
    x: 19.234375,
    y: 11.234375,
    width: 20.25,
    height: 20,
    snappedWidth: 20,
    snappedHeight: 20,
    clip: false,
  },
] as const;

type FractionalCase = {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  snappedWidth: number;
  snappedHeight: number;
  clip: boolean;
};
async function verifyFractionalCase(
  contextBrowser: Browser,
  deviceScaleFactor: number,
  row: FractionalCase,
  scaleX = 1,
  scaleY = 1,
) {
  const context = await contextBrowser.newContext({ viewport: fractionalViewport, deviceScaleFactor });
  const page = await context.newPage(),
    output = await context.newPage();
  try {
    const style =
      positioned(row.x, row.y) +
      `;width:${row.width}px;height:${row.height}px;overflow:${row.clip ? "hidden" : "visible"}`;
    await page.setContent(`<!doctype html>${pageStyle}${svg(style, 'viewBox="0 0 20 20"', stripes)}`);
    const source = await pixels(page);
    const tree = await captureElementTree(page, "body", fractionalViewport);
    const node = sourceSvg(tree)!;
    expect([node.x, node.y, node.width, node.height]).toEqual([row.x, row.y, row.width, row.height]);
    expect(node.svgRootPaint).toEqual({
      source: "blink-inline-svg-root-paint-v2",
      dx: Math.round(row.x) - row.x,
      dy: Math.round(row.y) - row.y,
      width: row.width,
      height: row.height,
      snappedWidth: row.snappedWidth,
      snappedHeight: row.snappedHeight,
      clip: row.clip,
      scaleX,
      scaleY,
    });
    for (const flattenNestedSvg of [false, true]) {
      const result = elementTreeToSvg(tree, fractionalViewport.width, fractionalViewport.height, { flattenNestedSvg });
      expect((result.match(/<svg\b/g) ?? []).length).toBe(flattenNestedSvg ? 1 : 2);
      await output.setContent(`<!doctype html>${pageStyle}${result}`);
      expect(
        (await pixels(output)).equals(source),
        `${row.name}, flatten=${flattenNestedSvg}, DPR=${deviceScaleFactor}`,
      ).toBe(true);
    }
    delete node.svgRootPaint;
    await output.setContent(
      `<!doctype html>${pageStyle}${elementTreeToSvg(tree, fractionalViewport.width, fractionalViewport.height)}`,
    );
    expect((await pixels(output)).equals(source)).toBe(false);
  } finally {
    await context.close();
  }
}

for (const deviceScaleFactor of [1, 2]) {
  it.each(fractionalCases)(
    `preserves the fractional layout and snapped paint viewport at DPR ${deviceScaleFactor}: $name`,
    (row) => verifyFractionalCase(browser, deviceScaleFactor, row),
  );
}

it("matches native uniform and nonuniform paint shrink when Chromium's test feature is explicitly enabled", async () => {
  const enabled = await launchChromium({ args: ["--enable-blink-features=SvgInlineRootPixelSnappingScaleAdjustment"] });
  try {
    const horizontalScale = Math.fround(20 / 20.25);
    await verifyFractionalCase(enabled, 1, fractionalCases[0], horizontalScale, horizontalScale);
    await verifyFractionalCase(enabled, 1, fractionalCases[2], horizontalScale, horizontalScale);
    await verifyFractionalCase(enabled, 1, fractionalCases[1]);
    await verifyFractionalCase(
      enabled,
      1,
      {
        ...fractionalCases[2],
        name: "exactly one pixel of uniform remainder",
        height: 20.25,
        snappedHeight: 21,
      },
      horizontalScale,
      horizontalScale,
    );
    await verifyFractionalCase(
      enabled,
      1,
      {
        ...fractionalCases[0],
        name: "nonuniform shrink beyond one pixel",
        width: 10.25,
        height: 100,
        snappedWidth: 10,
        snappedHeight: 100,
      },
      Math.fround(10 / 10.25),
      1,
    );
  } finally {
    await closeBrowserSafely(enabled);
  }
}, 30_000);

it("uses only the runtime-independent expansion when the shrink mode is unverified", async () => {
  const unverified = await launchChromium({ args: ["--enable-features=SvgInlineRootPixelSnappingScaleAdjustment"] });
  try {
    const page = await unverified.newPage({ viewport });
    try {
      const shrink = svg(positioned(19.234375, 11.234375) + ";width:20.25px");
      await page.setContent(pageStyle + shrink);
      const node = sourceSvg(await captureElementTree(page, "body", viewport))!;
      expect(node.svgContent).toContain("path");
      expect(node.svgRootPaint).toBeUndefined();
    } finally {
      await page.close();
    }
    await verifyFractionalCase(unverified, 1, fractionalCases[1]);
  } finally {
    await closeBrowserSafely(unverified);
  }
}, 30_000);
