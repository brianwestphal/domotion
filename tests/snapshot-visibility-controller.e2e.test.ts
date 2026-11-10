import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { rasterizeNativeControlSurfaces } from "../src/capture/native-control-raster.js";
import { rasterizeReplacedElements } from "../src/capture/replaced-element-raster.js";
import { suppressSnapshotVisibilityTransitions } from "../src/capture/snapshot-visibility-transitions.js";
import type { CaptureWarning, CapturedElement } from "../src/capture/types.js";
import { capturedElement } from "../src/test-support/captured-fixtures.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { freezeRealWorldDom } from "./real-world-dom-freeze.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));
const viewport = { x: 0, y: 0, width: 100, height: 100 };
type Route = "native" | "replaced";
async function fixture(page: Page, route: Route, role: "target" | "overlay", toHidden: boolean, paused: boolean) {
  await page.setContent(
    `<style>body{margin:0;background:rgb(12,20,40)}#overlay{position:absolute;inset:0;background:rgba(255,255,255,.2)}</style><div id="overlay"></div>${route === "native" ? '<button id="target" style="position:absolute;left:20px;top:20px;width:60px;height:30px"></button>' : '<canvas id="target" data-domotion-rid="dr0" width="100" height="100" style="position:absolute;inset:0"></canvas>'}`,
  );
  return page.evaluateHandle(
    async ({ role, toHidden, paused, route }) => {
      const target = document.getElementById("target")!;
      if (route === "replaced") {
        const c = (target as HTMLCanvasElement).getContext("2d")!;
        c.fillStyle = "rgb(0,80,240)";
        c.fillRect(30, 30, 40, 40);
      }
      (globalThis as typeof globalThis & Record<string, unknown>).__thpOwners = [target];
      const owner = document.getElementById(role)!;
      owner.style.visibility = toHidden ? "visible" : "hidden";
      void owner.offsetWidth;
      owner.style.transition = "visibility 30s linear";
      void owner.offsetWidth;
      const events: string[] = [];
      for (const type of ["transitionrun", "transitionstart", "transitioncancel", "transitionend"])
        owner.addEventListener(type, () => events.push(type));
      owner.style.visibility = toHidden ? "hidden" : "visible";
      const animation = owner.getAnimations().find((a) => a instanceof CSSTransition)!;
      await animation.ready;
      if (paused) {
        animation.pause();
        await animation.ready;
      }
      animation.currentTime = 10_000;
      const animationEvents: string[] = [];
      for (const type of ["cancel", "finish"]) animation.addEventListener(type, () => animationEvents.push(type));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const effect = animation.effect as KeyframeEffect;
      const frames = JSON.stringify(effect.getKeyframes()),
        timing = JSON.stringify(effect.getTiming());
      const nodes = Array.from(document.querySelectorAll("*"));
      const attrs = nodes.map((node) => node.getAttribute("style"));
      return {
        snapshot() {
          return {
            same: owner.getAnimations().includes(animation),
            effect: animation.effect === effect,
            frames: JSON.stringify(effect.getKeyframes()) === frames,
            timing: JSON.stringify(effect.getTiming()) === timing,
            playState: animation.playState,
            currentTime: animation.currentTime,
            startTime: animation.startTime,
            events: [...events],
            animationEvents: [...animationEvents],
            styles: nodes.map((node) => node.getAttribute("style")),
            originalStyles: attrs,
            animationCount: document.getAnimations().length,
          };
        },
        retarget() {
          owner.style.visibility = toHidden ? "visible" : "hidden";
          void owner.offsetWidth;
          return { oldRetained: owner.getAnimations().includes(animation), count: owner.getAnimations().length };
        },
      };
    },
    { role, toHidden, paused, route },
  );
}
function element(route: Route) {
  return route === "native"
    ? capturedElement({
        tag: "button",
        x: 20,
        y: 20,
        width: 60,
        height: 30,
        children: [],
        nativeControlRaster: { x: 19, y: 19, width: 62, height: 32, sourceNodeIndex: 0, selector: "#target" },
      })
    : capturedElement({
        tag: "canvas",
        children: [],
        styles: { transform: "none" },
        replacedSnapshot: { rid: "dr0", x: 0, y: 0, width: 100, height: 100 },
      });
}
async function raster(page: Page, route: Route) {
  const node = element(route);
  const warnings: CaptureWarning[] = [];
  if (route === "native")
    await rasterizeNativeControlSurfaces(page, [node], viewport, { sourceNodeKey: "__thpOwners", warnings });
  else {
    const report = await rasterizeReplacedElements(page, [node], viewport);
    warnings.push(
      ...report.failures.map((failure) => ({ feature: failure.phase, selector: "#target", detail: failure.detail })),
    );
  }
  return { node, warnings, uri: node.nativeControlRaster?.dataUri ?? node.replacedSnapshot?.dataUri };
}
async function rgba(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer();
}
async function guard(uri: string) {
  return [
    ...(await sharp(Buffer.from(uri.split(",")[1], "base64"))
      .ensureAlpha()
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer()),
  ];
}
function walk(tree: CapturedElement[]): CapturedElement[] {
  return tree.flatMap((node) => [node, ...walk(node.children ?? [])]);
}

describe("production snapshot visibility controller (DM-THP2FS)", () => {
  for (const toHidden of [true, false])
    it(`retains unchanged native retarget control ${toHidden}`, async () => {
      const page = await browser.newPage({ viewport });
      const state = await fixture(page, "replaced", "overlay", toHidden, true);
      try {
        expect(await state.evaluate((value) => value.retarget())).toEqual({
          oldRetained: false,
          count: toHidden ? 0 : 1,
        });
      } finally {
        await state.dispose();
        await page.close();
      }
    });
  for (const route of ["native", "replaced"] as const)
    for (const role of ["overlay", "target"] as const)
      for (const toHidden of [true, false])
        for (const paused of [true, false]) {
          it(`${route} ${role} ${toHidden ? "to-hidden" : "to-visible"} ${paused ? "paused" : "running"}`, async () => {
            const page = await browser.newPage({ viewport });
            const state = await fixture(page, route, role, toHidden, paused);
            try {
              const before = await state.evaluate((value) => value.snapshot());
              const source = await page.screenshot();
              const screenshot = page.screenshot.bind(page);
              let during: typeof before | undefined;
              page.screenshot = async (options) => {
                if (options?.omitBackground) during = await state.evaluate((value) => value.snapshot());
                return screenshot(options);
              };
              const result = await raster(page, route);
              delete (page as unknown as Record<string, unknown>).screenshot;
              expect(result.warnings).toEqual([]);
              expect(result.uri).toMatch(/^data:image\/png;base64,/);
              expect(await guard(result.uri!)).toEqual([0, 0, 0, 0]);
              const after = await state.evaluate((value) => value.snapshot());
              for (const fact of [during!, after]) {
                expect(fact).toMatchObject({
                  same: true,
                  effect: true,
                  frames: true,
                  timing: true,
                  playState: before.playState,
                  events: before.events,
                  animationEvents: [],
                });
                if (paused) expect(fact.currentTime).toBe(before.currentTime);
                else expect(fact.startTime).toBe(before.startTime);
              }
              expect(after.styles).toEqual(before.originalStyles);
              expect(after.animationCount).toBe(before.animationCount);
              const restored = await page.screenshot();
              expect(await rgba(restored)).toEqual(await rgba(source));
              // Native CSS ownership must survive the next real authored retarget,
              // not merely immediate object/pixel comparison after cleanup.
              expect(await state.evaluate((value) => value.retarget())).toEqual({
                oldRetained: false,
                count: toHidden ? 0 : 1,
              });
              const output = process.env.DOMOTION_THP_EVIDENCE_DIR;
              if (output && role === "overlay" && !toHidden && paused) {
                mkdirSync(output, { recursive: true });
                writeFileSync(join(output, `${route}-source.png`), source);
                writeFileSync(join(output, `${route}-isolated.png`), Buffer.from(result.uri!.split(",")[1], "base64"));
                writeFileSync(join(output, `${route}-restored.png`), restored);
                writeFileSync(
                  join(output, `${route}-metrics.json`),
                  JSON.stringify(
                    {
                      route,
                      generatedAt: new Date().toISOString(),
                      sourceCommit: process.env.GITHUB_SHA ?? null,
                      platform: process.platform,
                      arch: process.arch,
                      node: process.version,
                      fixtureSha256: createHash("sha256")
                        .update(readFileSync(fileURLToPath(import.meta.url), "utf8").replace(/\r\n/g, "\n"))
                        .digest("hex"),
                      browser: browser.version(),
                      viewport,
                      before,
                      during,
                      after,
                      guard: await guard(result.uri!),
                      sourceRestoredRawEqual: true,
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
        }
  for (const route of ["native", "replaced"] as const)
    it(`captures actual ${route} pipeline after real-world DOM freeze`, async () => {
      const page = await browser.newPage({ viewport });
      const state = await fixture(page, route, "overlay", false, true);
      try {
        expect(await freezeRealWorldDom(page)).toBe(true);
        const before = await state.evaluate((value) => value.snapshot());
        const capture = await captureElementTreeWithWarnings(page, "body", viewport);
        const node = walk(capture.tree).find((node) =>
          route === "native" ? node.nativeControlRaster != null : node.replacedSnapshot != null,
        )!;
        const uri = node.nativeControlRaster?.dataUri ?? node.replacedSnapshot?.dataUri;
        expect(uri).toMatch(/^data:image\/png;base64,/);
        expect(await guard(uri!)).toEqual([0, 0, 0, 0]);
        expect(capture.warnings.filter((warning) => /native-control-raster|replaced/.test(warning.feature))).toEqual(
          [],
        );
        expect(await state.evaluate((value) => value.snapshot())).toMatchObject({
          same: true,
          effect: true,
          frames: true,
          timing: true,
          currentTime: before.currentTime,
          events: before.events,
          animationEvents: [],
          animationCount: 1,
        });
      } finally {
        await state.dispose();
        await page.close();
      }
    });
  it("captures partial file-button decoration with a frozen authored visibility overlay", async () => {
    const page = await browser.newPage({ viewport });
    const state = await fixture(page, "native", "overlay", false, true);
    try {
      await page.locator("#target").evaluate((node) => {
        node.outerHTML = `<input type="file" id="target" style="position:absolute;left:10px;top:20px;width:90px;height:30px;font:8px Arial">`;
      });
      expect(await freezeRealWorldDom(page)).toBe(true);
      const before = await state.evaluate((value) => value.snapshot());
      const source = await page.screenshot();
      const capture = await captureElementTreeWithWarnings(page, "body", viewport);
      const select = walk(capture.tree).find((node) => node.tag === "input")!;
      expect(select.nativeControlDecorationRaster?.dataUri).toMatch(/^data:image\/png;base64,/);
      expect(capture.warnings.filter((warning) => warning.feature === "native-control-decoration-raster")).toEqual([]);
      expect(await state.evaluate((value) => value.snapshot())).toMatchObject({
        same: true,
        effect: true,
        frames: true,
        timing: true,
        currentTime: before.currentTime,
        events: before.events,
        animationEvents: [],
        animationCount: 1,
      });
      expect(await rgba(await page.screenshot())).toEqual(await rgba(source));
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  for (const route of ["native", "replaced"] as const)
    for (const failure of [
      route === "native"
        ? "source readback rejected"
        : "Protocol error (Page.captureScreenshot): deliberate CDP readback failure",
      "Timeout 30000ms exceeded",
    ])
      it(`${route} restores after ${failure}`, async () => {
        const page = await browser.newPage({ viewport });
        const state = await fixture(page, route, "overlay", false, true);
        try {
          const before = await state.evaluate((value) => value.snapshot());
          const source = await page.screenshot();
          const screenshot = page.screenshot.bind(page);
          page.screenshot = async () => {
            throw new Error(failure);
          };
          const result = await raster(page, route);
          delete (page as unknown as Record<string, unknown>).screenshot;
          expect(result.uri).toBeUndefined();
          expect(result.warnings.length).toBeGreaterThan(0);
          expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
          expect(await rgba(await screenshot())).toEqual(await rgba(source));
        } finally {
          await state.dispose();
          await page.close();
        }
      });
  for (const route of ["native", "replaced"] as const)
    it(`${route} rejects foreign cancellation of its private paint owner`, async () => {
      const page = await browser.newPage({ viewport });
      const state = await fixture(page, route, "overlay", false, true);
      try {
        const before = await state.evaluate((value) => value.snapshot());
        const screenshot = page.screenshot.bind(page);
        page.screenshot = async (options) => {
          const image = await screenshot(options);
          if (options?.omitBackground)
            await page.evaluate(() => {
              const owned = document
                .getAnimations()
                .find(
                  (animation) =>
                    !(animation instanceof CSSTransition) &&
                    (animation.effect as KeyframeEffect).getKeyframes().every((frame) => frame.visibility === "hidden"),
                );
              if (owned == null) throw new Error("fixture did not find private paint animation");
              owned.cancel();
            });
          return image;
        };
        const result = await raster(page, route);
        delete (page as unknown as Record<string, unknown>).screenshot;
        expect(result.uri).toBeUndefined();
        expect(result.warnings.some((warning) => /restore|cleanup/.test(warning.detail))).toBe(true);
        expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      } finally {
        await state.dispose();
        await page.close();
      }
    });
  it("refuses a foreign/frozen animation API without source mutation", async () => {
    const page = await browser.newPage({ viewport });
    const state = await fixture(page, "replaced", "overlay", false, true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      await page.evaluate(() => {
        Animation.prototype.pause = function () {};
      });
      await expect(suppressSnapshotVisibilityTransitions(page)).rejects.toThrow(
        "native animation ownership unavailable",
      );
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
  it("refuses source replacement between preparation and activation", async () => {
    const page = await browser.newPage({ viewport });
    const state = await fixture(page, "replaced", "overlay", false, true);
    const owner = await suppressSnapshotVisibilityTransitions(page, true);
    try {
      await page.locator("#overlay").evaluate((node) => node.replaceWith(node.cloneNode(true)));
      await expect(
        page.evaluate(
          (key) => (globalThis as typeof globalThis & Record<string, { start(): void }>)[key].start(),
          owner.key,
        ),
      ).rejects.toThrow("ownership changed");
      await expect(owner.dispose()).rejects.toThrow("ownership changed");
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
});
