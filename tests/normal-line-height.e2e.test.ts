import { afterAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * `line-height: normal` is the primary face's LineSpacing() = round(ascent) + round(descent) +
 * round(line gap), and the line gap is the platform's own leading. fontkit's hhea line gap does not
 * reproduce it for every face (Helvetica, Times and Courier read 0 there and about 0.15 em in Chromium), so
 * the capture asks the browser and records the answer as `normalLineHeight`.
 */
async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

function find(nodes: CapturedElement[], tag: string): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    const inner = find(node.children ?? [], tag);
    if (inner != null) return inner;
  }
  return undefined;
}

async function measure(css: string, extraStyle = "") {
  const context = await env!.browser.newContext({ viewport: { width: 400, height: 300 } });
  const page = await context.newPage();
  await page.setContent(
    `<body style="margin:0;${css}"><div id="d" style="line-height:normal;${extraStyle}">a<br>b<br>c<br>d</div></body>`,
  );
  const chromePitch = await page.evaluate(() => document.getElementById("d")!.getBoundingClientRect().height / 4);
  const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 400, height: 300 }, {});
  await context.close();
  return { chromePitch, normalLineHeight: find(captured.tree, "div")?.normalLineHeight };
}

describeBrowser("captured line-height: normal", () => {
  it.each([
    ["Helvetica", 12],
    ["Helvetica", 33],
    ["Times", 16],
    ["Courier", 20],
    ["Arial", 16],
    ["Georgia", 16],
    ["Menlo", 13],
    ["system-ui", 16],
  ])("equals Chromium's used line pitch for %s at %ipx", async (family, size) => {
    const { chromePitch, normalLineHeight } = await measure(`font:${size}px '${family}'`);
    expect(chromePitch).toBeGreaterThan(size); // a real line box, not a collapsed one
    expect(normalLineHeight).toBe(chromePitch);
  });

  it("is measured at the computed size under CSS zoom", async () => {
    const { chromePitch, normalLineHeight } = await measure("font:16px Helvetica", "zoom:2");
    expect(normalLineHeight).toBeDefined();
    expect(normalLineHeight).toBeCloseTo(chromePitch, 0);
  });

  it("is absent when the computed line-height is a length, so no probe is paid for it", async () => {
    const context = await env!.browser.newContext({ viewport: { width: 400, height: 300 } });
    const page = await context.newPage();
    await page.setContent(
      `<body style="margin:0;font:16px Helvetica"><div style="line-height:30px">a<br>b</div></body>`,
    );
    const captured = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 400, height: 300 }, {});
    await context.close();
    expect(find(captured.tree, "div")?.normalLineHeight).toBeUndefined();
  });
});
