import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "./index.js";
import { borderBox, resolveCursorTarget, contentBox } from "./content-box.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

// DM-1139 (doc 63 §1): `borderBox` measures the BORDER box (getBoundingClientRect),
// the sibling of `contentBox`'s padding-inset content box. The two MUST stay
// distinct — the cursor targets the border-box center, typing overlays the
// content-box center — so a padded + bordered element has a different center for
// each. `resolveCursorTarget` is the border-box-center sugar.

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

// A box with ASYMMETRIC border + padding so the border-box center and the
// content-box center differ on BOTH axes (a symmetric inset would collapse the
// distinction to zero and pass trivially).
const W = 400, H = 300;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `*{margin:0;box-sizing:border-box}` +
  `#pad{position:absolute;left:50px;top:40px;width:200px;height:120px;` +
  `border-style:solid;border-width:10px 30px 10px 10px;` + // L10 R30 T10 B10
  `padding:20px 0 0 40px;background:#eee}` +              // T20 L40
  `</style></head><body><div id="pad"></div></body></html>`;

describeBrowser("borderBox + resolveCursorTarget (DM-1139)", () => {
  it("measures the border box (getBoundingClientRect), distinct from the content box", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });

      const bb = await borderBox(page, "#pad");
      // Border box = the raw getBoundingClientRect: left/top/size as declared.
      expect(bb.x).toBeCloseTo(50, 1);
      expect(bb.y).toBeCloseTo(40, 1);
      expect(bb.width).toBeCloseTo(200, 1);
      expect(bb.height).toBeCloseTo(120, 1);
      // Default anchor is top-left.
      expect(bb.at[0]).toBeCloseTo(50, 1);
      expect(bb.at[1]).toBeCloseTo(40, 1);

      const cb = await contentBox(page, "#pad");
      // Content box = border + padding removed: x += borderLeft(10)+padLeft(40)=50,
      // y += borderTop(10)+padTop(20)=30; width -= 10+30+40+0; height -= 10+10+20+0.
      expect(cb.x).toBeCloseTo(50 + 50, 1);
      expect(cb.y).toBeCloseTo(40 + 30, 1);
      expect(cb.width).toBeCloseTo(200 - 80, 1);
      expect(cb.height).toBeCloseTo(120 - 40, 1);

      // The crux: border-box center ≠ content-box center on BOTH axes.
      const bbCenter = (await borderBox(page, "#pad", { at: "center" })).at;
      const cbCenter = (await contentBox(page, "#pad", { at: "center" })).at;
      expect(bbCenter[0]).toBeCloseTo(50 + 100, 1);       // 150
      expect(bbCenter[1]).toBeCloseTo(40 + 60, 1);        // 100
      expect(cbCenter[0]).toBeCloseTo(100 + 120 / 2, 1);  // 160
      expect(cbCenter[1]).toBeCloseTo(70 + 80 / 2, 1);    // 110
      expect(bbCenter[0]).not.toBeCloseTo(cbCenter[0], 1);
      expect(bbCenter[1]).not.toBeCloseTo(cbCenter[1], 1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("resolveCursorTarget === borderBox center, and honors dx/dy + anchors", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const center = (await borderBox(page, "#pad", { at: "center" })).at;
      const cursor = await resolveCursorTarget(page, "#pad");
      expect(cursor).toEqual(center);

      // Anchor + nudge resolve off the border box.
      const tr = (await borderBox(page, "#pad", { at: "top-right", dx: -5, dy: 3 })).at;
      expect(tr[0]).toBeCloseTo(50 + 200 - 5, 1);
      expect(tr[1]).toBeCloseTo(40 + 3, 1);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("throws on a selector that matches nothing (fail-fast, like contentBox)", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      await expect(borderBox(page, "#nope")).rejects.toThrow(/matched no element/);
      await expect(resolveCursorTarget(page, "#nope")).rejects.toThrow(/matched no element/);
    } finally {
      await page.close();
    }
  }, 60_000);
});
