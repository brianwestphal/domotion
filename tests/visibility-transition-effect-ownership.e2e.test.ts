import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/capture/index.js";
import { SNAPSHOT_HIDE_CSS } from "../src/capture/replaced-element-raster.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser));

/** Browser protocol proof for DM-FTRBES, not the production isolation API.
 * DM-THP2FS must authenticate/routinely restore actual capture owners before
 * admitting this mechanism into the shipped pipeline. */
async function fixture(page: Page, role: "target" | "overlay", direction: "to-hidden" | "to-visible", paused: boolean) {
  await page.setContent(
    `<style>body{margin:0;background:rgb(12,20,40)}#overlay{position:absolute;inset:0;background:rgba(255,255,255,.2);transition:visibility 30s linear}canvas{position:absolute;inset:0;display:block;transition:visibility 30s linear}</style><div id="overlay"></div><canvas id="target" width="100" height="100"></canvas>`,
  );
  return page.evaluateHandle(
    async ({ role, direction, paused }) => {
      const target = document.querySelector("canvas")!;
      const context = target.getContext("2d")!;
      context.fillStyle = "rgb(0,80,240)";
      context.fillRect(30, 30, 40, 40);
      const owner = document.getElementById(role)!;
      owner.style.transition = "none";
      owner.style.visibility = direction === "to-hidden" ? "visible" : "hidden";
      void owner.offsetWidth;
      owner.style.transition = "visibility 30s linear";
      void owner.offsetWidth;
      const events: string[] = [];
      for (const type of ["transitionrun", "transitionstart", "transitioncancel", "transitionend"]) {
        document.addEventListener(type, (event) => events.push(`${type}:${(event.target as Element).id}`));
      }
      owner.style.visibility = direction === "to-hidden" ? "hidden" : "visible";
      const animation = owner.getAnimations().find((value) => value instanceof CSSTransition)!;
      if (animation == null) throw new Error("fixture did not create an authored transition");
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
      const frames = JSON.stringify(effect.getKeyframes());
      const timing = JSON.stringify(effect.getTiming());
      const originalStyles = [owner, target, document.getElementById("overlay")!].map((node) => ({
        node,
        value: node.getAttribute("style"),
      }));
      let sheet: HTMLStyleElement | undefined;
      let owned: Animation | undefined;
      let guard: Animation | undefined;
      return {
        snapshot() {
          return {
            sameAnimation: owner.getAnimations().includes(animation),
            sameEffect: animation.effect === effect,
            frames: JSON.stringify(effect.getKeyframes()) === frames,
            timing: JSON.stringify(effect.getTiming()) === timing,
            playState: animation.playState,
            currentTime: animation.currentTime,
            startTime: animation.startTime,
            visibility: getComputedStyle(owner).visibility,
            events: [...events],
            animationEvents: [...animationEvents],
            styles: originalStyles.map(({ node }) => node.getAttribute("style")),
            animationCount: document.getAnimations().length,
          };
        },
        install(css: string) {
          // Chromium KeyframeEffect::Create(source) copies transition priority
          // and the CSS event delegate. Never mutate/replace the SOURCE effect.
          // CanCalculateTransitionUpdateForProperty returns early while an
          // ordinary animation owns visibility. This protects the original CSS
          // transition from retargeting without guessing its CSS destination.
          guard = new Animation(
            new KeyframeEffect(owner, [{ visibility: "visible" }, { visibility: "visible" }], {
              duration: 1,
              fill: "both",
            }),
            document.timeline,
          );
          guard.currentTime = 0;
          guard.pause();
          const clone = new KeyframeEffect(effect);
          const visibility = role === "target" ? "visible" : "hidden";
          clone.setKeyframes([{ visibility }, { visibility }]);
          // Base Animation::setEffect rebinds the clone's CSS event delegate to
          // null when replacing a dummy effect with a real target. Directly
          // constructing Animation(clone) would share the source delegate.
          owned = new Animation(new KeyframeEffect(owner, [], { duration: 30_000 }), document.timeline);
          owned.effect = clone;
          owned.currentTime = 10_000;
          owned.pause();
          for (const node of [target, document.getElementById("overlay")!]) {
            if (node !== owner)
              node.style.setProperty(
                "transition",
                `${getComputedStyle(node).transition}, visibility 0s linear 0s`,
                "important",
              );
          }
          target.setAttribute("data-domotion-snapshot-target", "");
          sheet = document.createElement("style");
          sheet.textContent = css;
          document.documentElement.append(sheet);
          void target.getBoundingClientRect();
        },
        restore() {
          sheet?.remove();
          target.removeAttribute("data-domotion-snapshot-target");
          // Commit the returned source values before restoring transition lists,
          // so non-active owners do not acquire capture-induced transitions.
          for (const { node } of originalStyles) void getComputedStyle(node).visibility;
          for (const { node, value } of originalStyles) {
            if (node.getAttribute("style") !== value) {
              if (value == null) node.removeAttribute("style");
              else node.setAttribute("style", value);
            }
          }
          owned?.cancel();
          guard?.cancel();
          void owner.getBoundingClientRect();
        },
      };
    },
    { role, direction, paused },
  );
}

async function rgba(png: Buffer): Promise<Buffer> {
  return sharp(png).ensureAlpha().raw().toBuffer();
}

/** DM-DQGEDM: three CI recurrences retained an all-white SOURCE screenshot,
 * taken before isolation, as well as white isolated and retake frames, always
 * in the file's first case (the first page of a freshly launched browser). The
 * page had not presented its first frame, so the isolation assertions had no
 * valid input. A later recurrence presented the body but not yet the canvas.
 * Wait, bounded, for the fixture's dark body and blue canvas before isolating;
 * a page that never paints fails here with that cause. */
const CENTER = (50 * 100 + 50) * 4;

async function presentedSource(page: Page): Promise<Buffer> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const png = await page.screenshot();
    const pixels = await rgba(png);
    const corner = [...pixels.subarray(0, 3)];
    const center = [...pixels.subarray(CENTER, CENTER + 3)];
    // The navy body (under the translucent overlay when it is visible), not
    // Chromium's default white, and the canvas's blue square: a later
    // recurrence presented the body while the canvas was still blank.
    if (corner.some((channel) => channel < 128) && center[0]! < 128 && center[2]! > 200) return png;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  throw new Error("fixture page never presented its first painted frame");
}

/** DM-DQGEDM: when an isolated `omitBackground` screenshot comes back with an
 * opaque corner (Chromium's default white) or without the canvas, keep the PNGs, the root paint
 * state and a second transparent screenshot one frame later, so a recurrence
 * tells a background-override frame race from an override that never applied.
 * Diagnostic only: the original assertion still fails. */
async function retainIsolationFailure(
  page: Page,
  name: string,
  images: { source: Buffer; isolated: Buffer },
): Promise<void> {
  try {
    const state = await page.evaluate(() => ({
      visibilityState: document.visibilityState,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      htmlVisibility: getComputedStyle(document.documentElement).visibility,
      bodyVisibility: getComputedStyle(document.body).visibility,
      styleSheets: document.styleSheets.length,
    }));
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const retake = await page.screenshot({ omitBackground: true, timeout: 5_000 });
    const retakePixels = await rgba(retake);
    const directory = join(process.env["DOMOTION_OUTPUT_DIR"] ?? "tests/output", "visibility-isolation");
    mkdirSync(directory, { recursive: true });
    const stem = `${name}-${process.pid}-${Date.now()}`;
    writeFileSync(join(directory, `${stem}-source.png`), images.source);
    writeFileSync(join(directory, `${stem}-isolated.png`), images.isolated);
    writeFileSync(join(directory, `${stem}-retake.png`), retake);
    writeFileSync(
      join(directory, `${stem}.json`),
      JSON.stringify(
        {
          schemaVersion: 1,
          sourceCommit: process.env["GITHUB_SHA"] ?? null,
          case: name,
          isolatedCorner: [...(await rgba(images.isolated)).subarray(0, 4)],
          retakeCorner: [...retakePixels.subarray(0, 4)],
          state,
        },
        null,
        2,
      ),
    );
  } catch {
    console.warn("Isolated screenshot failed; diagnostic evidence could not be written.");
  }
}

describe("visibility-transition paint ownership browser contract (DM-FTRBES)", () => {
  for (const role of ["overlay", "target"] as const)
    for (const direction of ["to-hidden", "to-visible"] as const)
      for (const paused of [true, false]) {
        it(`keeps ${role} ${direction} ${paused ? "paused" : "running"} ownership while isolating paint`, async () => {
          const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
          const state = await fixture(page, role, direction, paused);
          try {
            const before = await state.evaluate((value) => value.snapshot());
            const source = await presentedSource(page);
            let isolated: Buffer;
            try {
              await state.evaluate((value, css) => value.install(css), SNAPSHOT_HIDE_CSS);
              const during = await state.evaluate((value) => value.snapshot());
              expect(during).toMatchObject({
                sameAnimation: true,
                sameEffect: true,
                frames: true,
                timing: true,
                playState: paused ? "paused" : "running",
                visibility: role === "target" ? "visible" : "hidden",
                events: before.events,
                animationEvents: [],
              });
              if (paused) expect(during.currentTime).toBe(before.currentTime);
              else expect(during.startTime).toBe(before.startTime);
              isolated = await page.screenshot({ omitBackground: true, timeout: 5_000 });
              const pixels = await rgba(isolated);
              if (pixels[3] !== 0 || pixels[CENTER + 3] !== 255) {
                await retainIsolationFailure(page, `${role}-${direction}-${paused ? "paused" : "running"}`, {
                  source,
                  isolated,
                });
              }
              expect([...pixels.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
              expect([...pixels.subarray(CENTER, CENTER + 4)]).toEqual([0, 80, 240, 255]);
            } finally {
              await state.evaluate((value) => value.restore());
            }
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
            );
            const after = await state.evaluate((value) => value.snapshot());
            expect(after).toMatchObject({
              sameAnimation: true,
              sameEffect: true,
              frames: true,
              timing: true,
              playState: before.playState,
              visibility: before.visibility,
              events: before.events,
              animationEvents: [],
              styles: before.styles,
              animationCount: before.animationCount,
            });
            if (paused) expect(after.currentTime).toBe(before.currentTime);
            else {
              expect(after.startTime).toBe(before.startTime);
              expect(Number(after.currentTime)).toBeGreaterThanOrEqual(Number(before.currentTime));
            }
            const restored = await page.screenshot();
            expect(await rgba(restored)).toEqual(await rgba(source));
            const output = process.env.DOMOTION_FTR_EVIDENCE_DIR;
            if (output != null) {
              mkdirSync(output, { recursive: true });
              const name = `${role}-${direction}-${paused ? "paused" : "running"}`;
              writeFileSync(join(output, `${name}-source.png`), source);
              writeFileSync(join(output, `${name}-isolated.png`), isolated!);
              writeFileSync(join(output, `${name}-restored.png`), restored);
              writeFileSync(
                join(output, `${name}.json`),
                JSON.stringify(
                  { before, after, scope: "browser protocol proof; production admission is separate DM-THP2FS" },
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

  it("restores source ownership when a readback throws", async () => {
    const page = await browser.newPage({ viewport: { width: 100, height: 100 } });
    const state = await fixture(page, "overlay", "to-visible", true);
    try {
      const before = await state.evaluate((value) => value.snapshot());
      await expect(
        (async () => {
          try {
            await state.evaluate((value, css) => value.install(css), SNAPSHOT_HIDE_CSS);
            throw new Error("forced readback failure");
          } finally {
            await state.evaluate((value) => value.restore());
          }
        })(),
      ).rejects.toThrow("forced readback failure");
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });
});
