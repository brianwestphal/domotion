import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { captureFontFamilyDeclarationFacts } from "../src/capture/font-family-declarations-cdp.js";
import * as animationCdp from "../src/capture/font-family-animation-cdp.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * DM-ZAXD0C: an animated `font-family` keeps its authored keyframe's type
 * (Blink applies the keyframe CSSValue itself), although every serialization
 * prints the lossy computed family. Each fixture is checked against two
 * natively painted controls — a static `font-family: initial` element and a
 * static concrete-family element — so the expected type is Chromium's, not a
 * fitted width.
 */
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));

const fixtures = [
  // [id, css, expected type]
  ["flip-late", "animation:flip 100s linear paused;animation-delay:-60s", "standard"],
  ["flip-early", "animation:flip 100s linear paused;animation-delay:-40s", "concrete"],
  ["eased", "animation:eased 100s linear paused;animation-delay:-60s", "concrete"],
  ["layered", "animation:layered 100s linear paused", "standard"],
  ["neutral-base", "font-family:CONCRETE;animation:middle 100s linear paused;animation-delay:-10s", "concrete"],
  ["neutral-hit", "font-family:CONCRETE;animation:middle 100s linear paused;animation-delay:-30s", "standard"],
  ["stacked", "animation:flip 100s linear paused,uniform-concrete 100s linear paused;animation-delay:-60s", "concrete"],
  ["script", "", "standard"],
] as const;

async function load(page: Page, concrete: string): Promise<void> {
  const css = `p{font-size:32px;margin:0;line-height:48px}
  @keyframes flip{0%{font-family:${concrete}}100%{font-family:initial}}
  @keyframes eased{0%{font-family:${concrete};animation-timing-function:steps(1)}100%{font-family:initial}}
  @layer base{@keyframes layered{from,to{font-family:${concrete}}}}
  @keyframes layered{from,to{font-family:initial}}
  @keyframes middle{50%{font-family:initial}}
  @keyframes uniform-concrete{from,to{font-family:${concrete}}}
  #ctl-initial{font-family:initial}#ctl-concrete{font-family:${concrete}}
  ${fixtures.map(([id, rule]) => `#${id}{${rule.replace("CONCRETE", concrete)}}`).join("\n")}`;
  const body = [...fixtures.map(([id]) => id), "ctl-initial", "ctl-concrete"]
    .map((id) => `<p id="${id}" lang="ja"><span id="a-${id}">A</span>漢</p>`)
    .join("");
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${body}`);
  await page.evaluate(() => {
    const animation = document
      .getElementById("script")!
      .animate([{ fontFamily: "initial" }, { fontFamily: "initial" }], { duration: 1e6 });
    animation.pause();
  });
}

async function facts(page: Page): Promise<Record<string, { familyType?: string } | null>> {
  const probe = await captureFontFamilyDeclarationFacts(page);
  try {
    return await page.evaluate(
      (key) =>
        Object.fromEntries(
          [...document.querySelectorAll("p")].map((el) => [
            el.id,
            ((el as unknown as Record<string, unknown>)[key] as { familyType?: string } | undefined) ?? null,
          ]),
        ),
      probe.propertyKey,
    );
  } finally {
    await probe.dispose();
  }
}

async function painted(page: Page, id: string): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${id}` });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    const width = await page.locator(`#${id}`).evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect().width;
    });
    return JSON.stringify({ fonts: fonts.map((f) => [f.postScriptName, f.glyphCount]), width });
  } finally {
    await cdp.detach();
  }
}

describe("animated font-family type (DM-ZAXD0C)", () => {
  it("recovers the applied keyframe's type and matches Chromium's paint", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
    try {
      await page.setContent("<p>x</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      // A concrete family serializing exactly like the standard family: only
      // the type, never the computed string, can tell them apart.
      await load(page, initial);
      const paint = {
        standard: await painted(page, "ctl-initial"),
        concrete: await painted(page, "ctl-concrete"),
      };
      // On macOS Han under lang=ja paints a different face for the standard
      // family than for the same-named concrete family (asserted below), so
      // paint proves each expected type. Another host's generic
      // settings may map both to one face; the type facts are still checked.
      const discriminates = paint.standard !== paint.concrete;
      if (process.platform === "darwin") expect(discriminates).toBe(true);
      const got = await facts(page);
      for (const [id, , type] of fixtures) {
        if (discriminates) expect(await painted(page, id), id).toBe(paint[type]);
        expect(got[id]?.familyType, id).toBe(type);
      }
    } finally {
      await page.close();
    }
  });

  it("negative control: without the page animation join the type stays unknown", async () => {
    const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
    const spy = vi.spyOn(animationCdp, "readPageFamilyAnimations").mockResolvedValue({ computed: "", animations: [] });
    try {
      await page.setContent("<p>x</p>");
      const initial = await page.locator("p").evaluate((el) => getComputedStyle(el).fontFamily);
      await load(page, initial);
      const got = await facts(page);
      expect(spy).toHaveBeenCalled();
      for (const [id] of fixtures) expect(got[id]?.familyType, id).toBeUndefined();
    } finally {
      spy.mockRestore();
      await page.close();
    }
  });
});
