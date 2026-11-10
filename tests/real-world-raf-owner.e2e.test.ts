import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { afterAll, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithDebug } from "../src/capture/index.js";
import { registerCaptureFrameScheduler, waitForCaptureAnimationFrames } from "../src/capture/frame-scheduler.js";
import { installCaptureRafClock, sampleCaptureRafClock } from "../src/capture/raf-clock.js";
import { elementTreeToSvgInner } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";
import { forEachElement } from "../src/tree-ops/for-each-element.js";
import { FIXTURE_FONT_CSS, FIXTURE_MONO_FAMILY } from "./fixture-fonts.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { captureRealWorldReferenceFrame } from "./real-world-reference-frame.js";
import { installRealWorldRafOwner } from "./real-world-raf-owner.js";

const browser = await chromium.launch();
afterAll(async () => closeBrowserSafely(browser), 15_000);
const html = `<style>body{margin:0;background:black}#track{width:20px;height:20px;background:lime}</style>
  <div id="track"></div><script>
  window.rafFrames=0;
  function tick(){ window.rafFrames++;document.querySelector('#track').style.transform='translateX('+(window.rafFrames%40)+'px)';requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
  </script>`;

function box(nodes: CapturedElement[]): CapturedElement | undefined {
  for (const node of nodes) {
    if (node.tag === "div" && node.width === 20 && node.height === 20) return node;
    const found = box(node.children);
    if (found) return found;
  }
  return undefined;
}

it("authenticates image-owned fonts while author frames and page timers are parked", async () => {
  const context = await browser.newContext({ viewport: { width: 100, height: 60 } });
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="40" style="font:20px '${FIXTURE_MONO_FAMILY}';transform:translateX(2ch)"><style>${FIXTURE_FONT_CSS}</style><rect width="10" height="10" fill="red"/></svg>`;
    const uri = `data:image/svg+xml,${encodeURIComponent(source)}`;
    await page.setContent(`<body style="margin:0"><img width="90" height="40" src="${uri}"></body>`);
    await page.locator("img").evaluate((image: HTMLImageElement) => image.decode());
    await freezeRealWorldDom(page);
    await owner.park(page);
    const captured = await captureElementTreeWithDebug(page, "body", { x: 0, y: 0, width: 100, height: 60 });
    let image: CapturedElement | undefined;
    forEachElement(captured.tree, (node) => {
      if (node.imageSrc === uri) image = node;
    });
    expect(image?.imageOwnFonts?.authority).toBe("chromium-svg-image-fonts-v1");
    expect(await page.evaluate(() => document.fonts.size)).toBe(0);
    expect(await elementTreeToSvgInner(captured.tree, 100, 60)).toContain("translate(24 0)");
    await owner.verify(page);
  } finally {
    await owner.dispose();
    await context.close();
  }
}, 15_000);

it("parks only after warmup and preserves source/tree pixels while capture frames still commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domotion-raf-owner-"));
  const context = await browser.newContext({ viewport: { width: 160, height: 100 } });
  const owner = await installRealWorldRafOwner(context);
  const page = await context.newPage();
  const output = await browser.newPage({ viewport: { width: 160, height: 100 } });
  try {
    await page.setContent(html);
    await page.waitForFunction(() => (window as typeof window & { rafFrames: number }).rafFrames >= 3);
    const count = () => page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    const live = await count();
    await freezeRealWorldDom(page);
    await expect.poll(count, { timeout: 5_000 }).toBeGreaterThan(live);
    let sampled = -1;
    await captureRealWorldReferenceFrame(page, {
      path: join(directory, "expected.png"),
      clip: { x: 0, y: 0, width: 160, height: 100 },
      entirePage: false,
      afterWebGlFreeze: async () => {
        await owner.park(page);
        sampled = await count();
      },
    });
    await waitForCaptureAnimationFrames(page, 2);
    await page.waitForTimeout(50);
    expect(await count()).toBe(sampled);
    const before = await page.locator("#track").evaluate((element) => element.getBoundingClientRect().x);
    const captured = await captureElementTreeWithDebug(page, "body", { x: 0, y: 0, width: 160, height: 100 });
    expect(box(captured.tree)?.x).toBe(before);
    expect(await count()).toBe(sampled);
    const states = await owner.verify(page);
    expect(states[0].deliveredCaptureFrames).toBeGreaterThanOrEqual(2);
    expect(states[0].queuedAuthorCallbacks).toBeGreaterThan(0);
    const inner = await elementTreeToSvgInner(captured.tree, 160, 100);
    await output.setContent(
      `<style>body{margin:0}</style><svg width="160" height="100"><rect width="160" height="100" fill="black"/>${inner}</svg>`,
    );
    const crop = { left: 0, top: 0, width: 80, height: 25 };
    const source = await sharp(Buffer.from(captured.debug.expectedPng)).extract(crop).removeAlpha().raw().toBuffer();
    const actual = await sharp(await output.screenshot())
      .extract(crop)
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(actual).toEqual(source);
  } finally {
    await owner.dispose();
    await context.close();
    await output.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("parks cross-origin child callbacks and rejects a changed frame set", async () => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await context.newPage();
    await page.goto("https://main.raf.test/");
    const childReady = page.waitForEvent("framenavigated", {
      predicate: (frame) => frame.url().startsWith("https://child.raf.test"),
    });
    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      iframe.src = "https://child.raf.test/";
      document.body.append(iframe);
    });
    await page.waitForSelector("iframe");
    const child = await childReady;
    await child.waitForSelector("#track");
    await owner.park(page);
    const frames = page.frames();
    const counts = await Promise.all(
      frames.map((frame) => frame.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames)),
    );
    await Promise.all(frames.map((frame) => waitForCaptureAnimationFrames(frame, 2)));
    await page.waitForTimeout(50);
    expect(
      await Promise.all(
        frames.map((frame) => frame.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames)),
      ),
    ).toEqual(counts);
    expect(await owner.verify(page)).toHaveLength(2);
    const lateFrame = page.waitForEvent("frameattached");
    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      iframe.srcdoc = '<div id="late">late</div>';
      document.body.append(iframe);
    });
    await (await lateFrame).waitForSelector("#late");
    await expect(owner.verify(page)).rejects.toThrow("frame set changed");
  } finally {
    await owner.dispose();
    await context.close();
  }
}, 15_000);

it("does not fall back to author scheduling for an unknown owner", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const owner = registerCaptureFrameScheduler(context, "missing-private-control");
  try {
    await expect(waitForCaptureAnimationFrames(page, 1)).rejects.toThrow("ownership unavailable");
    expect(() => owner.assertValid()).toThrow("capture frame scheduler failed");
  } finally {
    owner.dispose();
    await context.close();
  }
});

it("preserves a warmup decorator only when registration and cancellation reach the owned queue", async () => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    await page.setContent(html);
    const wrapper = await page.evaluateHandle(() => {
      const request = requestAnimationFrame;
      const cancel = cancelAnimationFrame;
      window.requestAnimationFrame = (callback) =>
        request(function (this: Window, time) {
          callback.call(this, time);
        });
      window.cancelAnimationFrame = (id) => cancel(id);
      return window.requestAnimationFrame;
    });
    const warm = await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    await waitForCaptureAnimationFrames(page, 2);
    const before = await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    expect(before).toBeGreaterThan(warm);
    await owner.park(page);
    const sampled = await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    expect(sampled).toBeGreaterThanOrEqual(before);
    await waitForCaptureAnimationFrames(page, 2);
    expect(await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames)).toBe(sampled);
    expect(await wrapper.evaluate((value) => requestAnimationFrame === value)).toBe(true);
    await owner.dispose();
    expect(await wrapper.evaluate((value) => requestAnimationFrame === value)).toBe(true);
    // Its saved forwarding function remains usable after terminal cleanup,
    // but cleanup itself never replays the parked author loop.
    await waitForCaptureAnimationFrames(page, 2);
    expect(await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames)).toBe(sampled);
    await wrapper.dispose();
  } finally {
    await owner.dispose();
    await context.close();
  }
});

it.each(["bypass", "synchronous"])("rejects a warmup replacement with invalid delegation (%s)", async (mode) => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    await page.setContent("<div>foreign scheduler</div>");
    const foreign = await page.evaluateHandle((mode) => {
      const previous = requestAnimationFrame;
      window.requestAnimationFrame =
        mode === "bypass"
          ? () => 123
          : (callback) => {
              callback(0);
              return previous(callback);
            };
      return window.requestAnimationFrame;
    }, mode);
    await expect(owner.park(page)).rejects.toThrow("foreign rAF delegate");
    await expect(owner.dispose()).rejects.toThrow("cleanup lost ownership");
    expect(await foreign.evaluate((value) => requestAnimationFrame === value)).toBe(true);
    await foreign.dispose();
  } finally {
    await context.close();
  }
});

it("preserves callback receivers and cancellation before and after parking", async () => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    await page.setContent("<div>scheduler semantics</div>");
    const live = await page.evaluate(async () => {
      let cancelled = false;
      const id = requestAnimationFrame(() => {
        cancelled = true;
      });
      cancelAnimationFrame(id);
      const receiver = await new Promise<boolean>((resolve) => {
        requestAnimationFrame(function (this: Window) {
          resolve(this === window);
        });
      });
      return { cancelled, receiver };
    });
    expect(live).toEqual({ cancelled: false, receiver: true });
    await owner.park(page);
    await page.evaluate(() => {
      const state = window as typeof window & { parkedCallback?: boolean };
      const cancelled = requestAnimationFrame(() => {
        state.parkedCallback = true;
      });
      cancelAnimationFrame(cancelled);
      requestAnimationFrame(() => {
        state.parkedCallback = true;
      });
    });
    await waitForCaptureAnimationFrames(page, 2);
    expect((await owner.verify(page))[0].queuedAuthorCallbacks).toBe(1);
    expect(
      await page.evaluate(() => (window as typeof window & { parkedCallback?: boolean }).parkedCallback),
    ).toBeUndefined();
  } finally {
    await owner.dispose();
    await context.close();
  }
});

it("fails closed on foreign scheduler ownership and never overwrites it during cleanup", async () => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    await page.setContent(html);
    await owner.park(page);
    const saved = await page.evaluateHandle(() => requestAnimationFrame);
    await page.evaluate(() => {
      window.requestAnimationFrame = () => 123;
    });
    await expect(waitForCaptureAnimationFrames(page, 1)).rejects.toThrow("ownership lost");
    await expect(owner.verify(page)).rejects.toThrow("capture frame scheduler failed");
    await expect(owner.dispose()).rejects.toThrow("cleanup lost ownership");
    expect(await page.evaluate(() => requestAnimationFrame(() => {}))).toBe(123);
    await expect(saved.evaluate((raf) => raf(() => {}))).rejects.toThrow("disposed without ownership");
    await saved.dispose();
  } finally {
    await context.close();
  }
});

it("cannot bypass the existing authenticated rAF clock with a capture-native frame", async () => {
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  const clock = await installCaptureRafClock(context);
  try {
    const page = await context.newPage();
    await page.setContent("<div>controlled source</div>");
    const protectedRaf = await page.evaluateHandle(() => requestAnimationFrame);
    await expect(waitForCaptureAnimationFrames(page, 1)).rejects.toThrow("ownership");
    const sample = await sampleCaptureRafClock(page, clock, 0);
    expect(sample.targets.every((target) => target.callbacksExecuted === 0)).toBe(true);
    await expect(owner.dispose()).rejects.toThrow("cleanup lost ownership");
    expect(await protectedRaf.evaluate((raf) => requestAnimationFrame === raf)).toBe(true);
    await protectedRaf.dispose();
  } finally {
    await context.close();
  }
});

it("restores scheduler globals after a reference failure without replaying parked callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "domotion-raf-error-"));
  const context = await browser.newContext();
  const owner = await installRealWorldRafOwner(context);
  try {
    const page = await context.newPage();
    await page.setContent(html);
    const originalClear = await page.evaluateHandle(() => WebGLRenderingContext.prototype.clear);
    await expect(
      captureRealWorldReferenceFrame(page, {
        path: join(directory, "unexpected.png"),
        clip: { x: 0, y: 0, width: 80, height: 80 },
        entirePage: false,
        afterWebGlFreeze: async () => {
          await owner.park(page);
          throw new Error("reference failure");
        },
      }),
    ).rejects.toThrow("reference failure");
    expect(await originalClear.evaluate((clear) => WebGLRenderingContext.prototype.clear === clear)).toBe(true);
    await originalClear.dispose();
    const count = await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames);
    await owner.dispose();
    expect(await page.evaluate(() => requestAnimationFrame.toString())).toContain("[native code]");
    await waitForCaptureAnimationFrames(page, 2);
    expect(await page.evaluate(() => (window as typeof window & { rafFrames: number }).rafFrames)).toBe(count);
    await expect(owner.verify(page)).rejects.toThrow("not parked");
  } finally {
    await owner.dispose();
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
