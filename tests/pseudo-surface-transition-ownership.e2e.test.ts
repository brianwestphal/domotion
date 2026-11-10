import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Frame, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { preparePseudoFragmentGeometry } from "../src/capture/pseudo-fragment-cdp.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";
import { installRealWorldRafOwner } from "./real-world-raf-owner.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));
const viewport = { x: 0, y: 0, width: 100, height: 100 };
const evidenceRuntime = () => ({
  generatedAt: new Date().toISOString(),
  sourceCommit: process.env.GITHUB_SHA ?? null,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  fixtureSha256: createHash("sha256")
    .update(readFileSync(fileURLToPath(import.meta.url), "utf8").replace(/\r\n/g, "\n"))
    .digest("hex"),
});
const html = `<style>body{margin:0;background:rgb(12,20,40)}#overlay{position:absolute;inset:0;background:rgba(255,255,255,.2)}</style><div id="overlay"></div><select id="target" style="position:absolute;left:20px;top:20px;width:60px;height:30px;background:#eee;border:1px solid"><option>A</option></select>`;
async function retain(frame: Frame | Page, selector: string, toHidden: boolean, paused: boolean) {
  return frame.evaluateHandle(
    async ({ selector, toHidden, paused }) => {
      const node = document.querySelector(selector) as HTMLElement;
      node.style.visibility = toHidden ? "visible" : "hidden";
      void node.offsetWidth;
      node.style.transition = "visibility 30s linear";
      void node.offsetWidth;
      const events: string[] = [];
      for (const type of ["transitionrun", "transitionstart", "transitioncancel", "transitionend"])
        node.addEventListener(type, () => events.push(type));
      node.style.visibility = toHidden ? "hidden" : "visible";
      const animation = node
        .getAnimations()
        .find((value) => value instanceof CSSTransition && value.transitionProperty === "visibility")!;
      if (animation == null) throw new Error("fixture has no authored transition");
      await animation.ready;
      if (paused) {
        animation.pause();
        await animation.ready;
      }
      animation.currentTime = 10000;
      const animationEvents: string[] = [];
      for (const type of ["cancel", "finish"]) animation.addEventListener(type, () => animationEvents.push(type));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const effect = animation.effect as KeyframeEffect;
      const nodes = Array.from(document.querySelectorAll("*"));
      const frames = JSON.stringify(effect.getKeyframes()),
        timing = JSON.stringify(effect.getTiming());
      return {
        snapshot() {
          return {
            same: node.getAnimations().includes(animation),
            effect: animation.effect === effect,
            frames: JSON.stringify(effect.getKeyframes()) === frames,
            timing: JSON.stringify(effect.getTiming()) === timing,
            state: animation.playState,
            time: animation.currentTime,
            start: animation.startTime,
            events: [...events],
            animationEvents: [...animationEvents],
            count: document.getAnimations().length,
            attrs: nodes.map((node) => ({
              style: node.getAttribute("style"),
              ancestor: node.getAttribute("data-domotion-pseudo-ancestor"),
              target: node.getAttribute("data-domotion-pseudo-target"),
            })),
          };
        },
      };
    },
    { selector, toHidden, paused },
  );
}
async function authoredMarkers(page: Page) {
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-domotion-pseudo-ancestor", "source-html");
    document.body.setAttribute("data-domotion-pseudo-ancestor", "");
    document.querySelector("#target")!.setAttribute("data-domotion-pseudo-target", "source-target");
  });
}
async function rgba(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer();
}

describe("generated-pseudo surface transition ownership (DM-T8ZTSC)", () => {
  for (const role of ["overlay", "target"] as const)
    for (const toHidden of [true, false])
      for (const paused of [true, false])
        it(`${role} ${toHidden ? "to-hidden" : "to-visible"} ${paused ? "paused" : "running"}`, async () => {
          const page = await browser.newPage({ viewport });
          await page.setContent(html);
          await authoredMarkers(page);
          const state = await retain(page, `#${role}`, toHidden, paused);
          try {
            const before = await state.evaluate((value) => value.snapshot());
            const source = await page.screenshot();
            const capture = await captureElementTreeWithWarnings(page, "body", viewport);
            const after = await state.evaluate((value) => value.snapshot());
            const restored = await page.screenshot();
            expect(after).toMatchObject({
              same: true,
              effect: true,
              frames: true,
              timing: true,
              state: before.state,
              events: before.events,
              animationEvents: [],
              count: 1,
              attrs: before.attrs,
            });
            if (paused) expect(after.time).toBe(before.time);
            else {
              expect(after.start).toBe(before.start);
              expect(Number(after.time)).toBeGreaterThanOrEqual(Number(before.time));
            }
            expect(await rgba(restored)).toEqual(await rgba(source));
            expect(
              capture.warnings.filter(
                (warning) =>
                  warning.feature === "generated-pseudo-fragment-geometry" && warning.status === "unavailable",
              ),
            ).toEqual([]);
            const output = process.env.DOMOTION_T8_EVIDENCE_DIR;
            if (output && role === "overlay" && paused) {
              mkdirSync(output, { recursive: true });
              const name = toHidden ? "to-hidden" : "to-visible";
              writeFileSync(join(output, `${name}-source.png`), source);
              writeFileSync(join(output, `${name}-restored.png`), restored);
              writeFileSync(
                join(output, `${name}-metrics.json`),
                JSON.stringify(
                  {
                    ...evidenceRuntime(),
                    browser: browser.version(),
                    viewport,
                    before,
                    after,
                    warnings: capture.warnings,
                    sourceRestoredRawDiffPct: 0,
                  },
                  null,
                  2,
                ) + "\n",
              );
            }
          } finally {
            await state.dispose();
            await page.close();
          }
        });
  it("keeps the exact original select witness while real-world timers and author rAF are parked", async () => {
    const context = await browser.newContext({ viewport });
    const owner = await installRealWorldRafOwner(context);
    const page = await context.newPage();
    await page.setContent(html);
    const state = await retain(page, "#overlay", false, true);
    try {
      await page.evaluate(() => {
        const host = globalThis as typeof globalThis & { ticks?: number };
        host.ticks = 0;
        const tick = () => {
          host.ticks!++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.waitForFunction(() => (globalThis as typeof globalThis & { ticks: number }).ticks > 1);
      expect(await freezeRealWorldDom(page)).toBe(true);
      await owner.park(page);
      const ticks = await page.evaluate(() => (globalThis as typeof globalThis & { ticks: number }).ticks);
      const before = await state.evaluate((value) => value.snapshot());
      await captureElementTreeWithWarnings(page, "body", viewport);
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { ticks: number }).ticks)).toBe(ticks);
      expect((await owner.verify(page))[0].deliveredCaptureFrames).toBeGreaterThan(0);
    } finally {
      await state.dispose();
      await owner.dispose();
      await context.close();
    }
  });
  for (const opaque of [false, true])
    it(`binds actual iframe ancestors and child owners (${opaque ? "opaque data origin" : "same origin"})`, async () => {
      const page = await browser.newPage({ viewport: { width: 160, height: 120 } });
      const child = html;
      await page.setContent(
        `<body style="margin:0;background:purple"><iframe id="frame" style="width:100px;height:100px;border:0" ${opaque ? `src="data:text/html,${encodeURIComponent(child)}"` : `srcdoc="${child.replace(/&/g, "&amp;").replace(/\"/g, "&quot;")}"`}></iframe>`,
      );
      const childFrame = page.frames().find((frame) => frame !== page.mainFrame())!;
      await childFrame.waitForSelector("#target");
      const parentState = await retain(page, "#frame", false, true);
      const childState = await retain(childFrame, "#overlay", false, true);
      try {
        const beforeParent = await parentState.evaluate((value) => value.snapshot()),
          beforeChild = await childState.evaluate((value) => value.snapshot());
        const source = await page.screenshot();
        const screenshot = page.screenshot.bind(page);
        let isolated: Buffer | undefined;
        page.screenshot = async (options) => {
          const png = await screenshot(options);
          if (options?.animations === "allow") isolated = png;
          return png;
        };
        const probe = await preparePseudoFragmentGeometry(page, "body", { x: 0, y: 0, width: 160, height: 120 });
        delete (page as unknown as Record<string, unknown>).screenshot;
        try {
          expect(probe.warnings.filter((warning) => warning.status === "unavailable")).toEqual([]);
          expect(isolated).toBeDefined();
          const pixels = await rgba(isolated!);
          for (const [x, y] of [
            [90, 90],
            [140, 110],
          ])
            expect([...pixels.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4)]).toEqual([0, 0, 0, 0]);
        } finally {
          await probe.dispose();
        }
        expect(await parentState.evaluate((value) => value.snapshot())).toEqual(beforeParent);
        expect(await childState.evaluate((value) => value.snapshot())).toEqual(beforeChild);
        expect(await rgba(await page.screenshot())).toEqual(await rgba(source));
      } finally {
        await parentState.dispose();
        await childState.dispose();
        await page.close();
      }
    });
  it("restores source owners and markers after readback timeout", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(html);
    await authoredMarkers(page);
    const state = await retain(page, "#overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      const original = page.screenshot.bind(page);
      page.screenshot = async () => {
        throw new Error("Timeout 30000ms exceeded: fixture readback");
      };
      const probe = await preparePseudoFragmentGeometry(page, "body", viewport);
      delete (page as unknown as Record<string, unknown>).screenshot;
      try {
        expect(
          probe.warnings.some(
            (warning) => warning.status === "unavailable" && warning.detail.includes("fixture readback"),
          ),
        ).toBe(true);
      } finally {
        await probe.dispose();
      }
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      expect((await original()).length).toBeGreaterThan(0);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("invalidates a completed readback when a foreign marker takes ownership", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(html);
    await authoredMarkers(page);
    const state = await retain(page, "#overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      const original = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        const png = await original(options);
        await page.evaluate(() =>
          document.documentElement.setAttribute("data-domotion-pseudo-ancestor", "foreign-edit"),
        );
        return png;
      };
      const probe = await preparePseudoFragmentGeometry(page, "body", viewport);
      delete (page as unknown as Record<string, unknown>).screenshot;
      try {
        expect(
          probe.warnings.some(
            (warning) => warning.status === "unavailable" && warning.detail.includes("restoration failed"),
          ),
        ).toBe(true);
      } finally {
        await probe.dispose();
      }
      expect(await state.evaluate((value) => value.snapshot())).toMatchObject({
        same: true,
        effect: true,
        frames: true,
        timing: true,
        time: before.time,
        events: before.events,
        animationEvents: [],
        count: 1,
      });
      expect(await page.locator("html").getAttribute("data-domotion-pseudo-ancestor")).toBe("foreign-edit");
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("refuses a foreign animation API before changing source markers", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(html);
    await authoredMarkers(page);
    const state = await retain(page, "#overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      await page.evaluate(() => {
        Animation.prototype.pause = function () {};
      });
      const probe = await preparePseudoFragmentGeometry(page, "body", viewport);
      try {
        expect(
          probe.warnings.some(
            (warning) =>
              warning.status === "unavailable" && warning.detail.includes("native animation ownership unavailable"),
          ),
        ).toBe(true);
      } finally {
        await probe.dispose();
      }
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("rejects source-frame removal after readback and cleans the surviving context", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(
      html +
        `<iframe style="position:absolute;left:0;top:0;width:50px;height:50px" srcdoc="<select><option>A</option></select>"></iframe>`,
    );
    await page
      .frames()
      .find((frame) => frame !== page.mainFrame())!
      .waitForSelector("select");
    const state = await retain(page, "#overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      const original = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        const png = await original(options);
        await page.locator("iframe").evaluate((node) => node.remove());
        return png;
      };
      await expect(preparePseudoFragmentGeometry(page, "body", viewport)).rejects.toThrow(/detached|destroyed|frame/i);
      delete (page as unknown as Record<string, unknown>).screenshot;
      expect(await state.evaluate((value) => value.snapshot())).toMatchObject({
        same: true,
        effect: true,
        frames: true,
        timing: true,
        time: before.time,
        events: before.events,
        animationEvents: [],
        count: 1,
      });
      expect(await page.locator("[data-domotion-pseudo-ancestor],[data-domotion-pseudo-target]").count()).toBe(0);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("isolates visible intrinsic pseudo-image paint without its transitioning overlay", async () => {
    const page = await browser.newPage({ viewport: { width: 180, height: 160 } });
    const asset = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="orange"/></svg>`)}`;
    await page.setContent(
      `<style>body{margin:0;background:rgb(12,20,40)}#overlay{position:absolute;inset:0;background:rgba(255,255,255,.2)}#host::before{content:url("${asset}");display:inline-block;width:20px;height:20px}</style><div id="overlay"></div><div id="host"></div>`,
    );
    const state = await retain(page, "#overlay", true, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      const source = await page.screenshot();
      const original = page.screenshot.bind(page);
      let isolated: Buffer | undefined;
      page.screenshot = async (options) => {
        const png = await original(options);
        if (options?.animations === "allow") isolated = png;
        return png;
      };
      const probe = await preparePseudoFragmentGeometry(page, "body", { x: 0, y: 0, width: 180, height: 160 });
      delete (page as unknown as Record<string, unknown>).screenshot;
      try {
        expect(probe.warnings.filter((warning) => warning.status === "unavailable")).toEqual([]);
        expect(isolated).toBeDefined();
        const pixels = await rgba(isolated!);
        expect([...pixels.subarray((100 * 180 + 100) * 4, (100 * 180 + 100) * 4 + 4)]).toEqual([0, 0, 0, 0]);
        expect([...pixels.subarray((40 * 180 + 40) * 4, (40 * 180 + 40) * 4 + 4)]).toEqual([255, 165, 0, 255]);
      } finally {
        await probe.dispose();
      }
      const restored = await page.screenshot();
      expect(await rgba(restored)).toEqual(await rgba(source));
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      const output = process.env.DOMOTION_T8_EVIDENCE_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "intrinsic-source.png"), source);
        writeFileSync(join(output, "intrinsic-isolated.png"), isolated!);
        writeFileSync(join(output, "intrinsic-restored.png"), restored);
        writeFileSync(
          join(output, "intrinsic-metrics.json"),
          JSON.stringify(
            {
              ...evidenceRuntime(),
              browser: browser.version(),
              viewport: { width: 180, height: 160 },
              before,
              after: await state.evaluate((value) => value.snapshot()),
              sourceRestoredRawDiffPct: 0,
              guard: [0, 0, 0, 0],
              center: [255, 165, 0, 255],
            },
            null,
            2,
          ) + "\n",
        );
      }
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("refuses unqualified iframe ancestry across an author shadow root", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(`<div id="host"></div>`);
    await page.evaluate(() => {
      const root = document.querySelector("#host")!.attachShadow({ mode: "closed" });
      const frame = document.createElement("iframe");
      frame.srcdoc = `<select><option>A</option></select>`;
      root.append(frame);
    });
    const child = page.frames().find((frame) => frame !== page.mainFrame())!;
    await child.waitForSelector("select");
    try {
      const before = await page.screenshot();
      const probe = await preparePseudoFragmentGeometry(page, "body", viewport);
      try {
        expect(
          probe.warnings.some(
            (warning) => warning.status === "unavailable" && warning.detail.includes("author shadow root"),
          ),
        ).toBe(true);
      } finally {
        await probe.dispose();
      }
      expect(await rgba(await page.screenshot())).toEqual(await rgba(before));
    } finally {
      await page.close();
    }
  });
  it("invalidates a readback after a foreign callback removes its owned stylesheet", async () => {
    const page = await browser.newPage({ viewport });
    await page.setContent(html);
    await authoredMarkers(page);
    const state = await retain(page, "#overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      const original = page.screenshot.bind(page);
      page.screenshot = async (options) => {
        const png = await original(options);
        await page.evaluate(() => {
          const sheet = Array.from(document.querySelectorAll("style")).find((style) =>
            style.textContent?.includes("data-domotion-pseudo-target"),
          );
          if (sheet == null) throw new Error("fixture has no owned isolation sheet");
          sheet.remove();
        });
        return png;
      };
      const probe = await preparePseudoFragmentGeometry(page, "body", viewport);
      delete (page as unknown as Record<string, unknown>).screenshot;
      try {
        expect(
          probe.warnings.some(
            (warning) => warning.status === "unavailable" && warning.detail.includes("restoration failed"),
          ),
        ).toBe(true);
      } finally {
        await probe.dispose();
      }
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
});
