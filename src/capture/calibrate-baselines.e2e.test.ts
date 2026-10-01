import { afterAll, describe, expect, it } from "vitest";
import { calibrateBaselines, captureElementTree, launchChromium } from "./index.js";
import type { CapturedElement } from "./types.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

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

function walk(nodes: CapturedElement[], visit: (el: CapturedElement) => void): void {
  for (const node of nodes) {
    visit(node);
    walk(node.children ?? [], visit);
  }
}

describeBrowser("calibrateBaselines (ink-scan ascent back-solve)", () => {
  it("replaces an invalid text ascent with a plausible measured value and leaves textless elements alone", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 320, height: 120 } });
    try {
      await page.setContent(
        `<body style="margin:0;background:#fff"><p id="t" style="margin:20px;font:32px Helvetica, Arial, sans-serif;color:#000">Hxgy</p><div id="empty" style="height:10px"></div></body>`,
      );
      const viewport = { x: 0, y: 0, width: 320, height: 120 };
      const tree = await captureElementTree(page, "body", viewport);
      const before = new Map<CapturedElement, number | undefined>();
      walk(tree, (el) => {
        // Linux can already capture the exact calibrated ascent (29px for
        // this fixture). Seed an invalid value so the assertion proves the
        // ink scan writes a measurement rather than merely observing equality.
        if (el.text != null && el.text !== "" && el.textWidth != null && el.textWidth > 0) el.fontAscent = 0;
        before.set(el, el.fontAscent);
      });
      const png = await page.screenshot({ clip: viewport, type: "png" });

      await calibrateBaselines(page, tree, png);

      let calibrated = 0;
      walk(tree, (el) => {
        if (el.text != null && el.text !== "" && el.fontAscent !== before.get(el)) {
          calibrated++;
          const size = parseFloat(el.styles.fontSize);
          // The rejection bounds in CALIBRATE_TUNING: 0.3em .. 1.5em.
          expect(el.fontAscent).toBeGreaterThan(size * 0.3);
          expect(el.fontAscent).toBeLessThan(size * 1.5);
        }
        if (el.text == null || el.text === "") expect(el.fontAscent).toBe(before.get(el));
      });
      expect(calibrated).toBeGreaterThan(0);
      const once = new Map<CapturedElement, number | undefined>();
      walk(tree, (el) => once.set(el, el.fontAscent));
      await calibrateBaselines(page, tree, png);
      walk(tree, (el) => expect(el.fontAscent).toBe(once.get(el)));
    } finally {
      await page.close();
    }
  });

  it("is a no-op for a tree with no text-bearing elements", async () => {
    const page = await env!.browser.newPage({ viewport: { width: 160, height: 100 } });
    try {
      await page.setContent(`<body style="margin:0"><div style="height:10px;background:#eee"></div></body>`);
      const viewport = { x: 0, y: 0, width: 160, height: 100 };
      const tree = await captureElementTree(page, "body", viewport);
      const png = await page.screenshot({ clip: viewport, type: "png" });
      await expect(calibrateBaselines(page, tree, png)).resolves.toBeUndefined();
    } finally {
      await page.close();
    }
  });
});
