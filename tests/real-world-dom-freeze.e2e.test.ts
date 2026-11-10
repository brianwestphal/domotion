import { chromium } from "@playwright/test";
import { afterAll, expect, it } from "vitest";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";

const browser = await chromium.launch();
afterAll(async () => closeBrowserSafely(browser), 15_000);

it("freezes pending and future timers without adding a page-global name helper", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div role="dialog" aria-modal="true">Late modal</div>
      <script>
        window.timerFired = 0;
        setTimeout(() => window.timerFired++, 400);
        setInterval(() => window.timerFired++, 400);
      </script>
    `);
    const originalRaf = await page.evaluate(() => window.requestAnimationFrame.toString());

    expect(await freezeRealWorldDom(page)).toBe(true);

    const frozen = await page.evaluate(() => ({
      timeoutId: window.setTimeout(function () {}, 1),
      intervalId: window.setInterval(function () {}, 1),
      raf: window.requestAnimationFrame.toString(),
      addedNameHelper: Object.prototype.hasOwnProperty.call(globalThis, "__name"),
      modalHidden: (document.querySelector('[role="dialog"]') as HTMLElement).style.display,
    }));
    expect(frozen.timeoutId).toBe(0);
    expect(frozen.intervalId).toBe(0);
    expect(frozen.raf).toBe(originalRaf);
    expect(frozen.addedNameHelper).toBe(false);
    expect(frozen.modalHidden).toBe("none");

    const firedAtFreeze = await page.evaluate(() => (window as typeof window & { timerFired: number }).timerFired);
    await new Promise<void>((resolve) => setTimeout(resolve, 550));
    expect(await page.evaluate(() => (window as typeof window & { timerFired: number }).timerFired)).toBe(
      firedAtFreeze,
    );
  } finally {
    await page.close();
  }
});

it("keeps author rAF DOM motion live before WebGL priming", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`<div id="track" style="width:20px;height:20px"></div>
      <script>
        window.rafFrames = 0;
        function tick() {
          window.rafFrames++;
          document.querySelector('#track').style.transform = 'translateX(' + window.rafFrames + 'px)';
          requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      </script>`);
    expect(await freezeRealWorldDom(page)).toBe(true);
    const before = await page.locator("#track").evaluate((element) => element.getBoundingClientRect().x);
    const frames = await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    // DOM freeze intentionally leaves this scheduler live for warmup/priming.
    // Pausing Web Animations does not freeze JavaScript-written transforms.
    await page.waitForFunction(
      (start) => (window as typeof window & { rafFrames: number }).rafFrames >= start + 3,
      frames,
      { timeout: 2000 },
    );
    expect(await page.locator("#track").evaluate((element) => element.getBoundingClientRect().x)).toBeGreaterThan(
      before,
    );
  } finally {
    await page.close();
  }
});
