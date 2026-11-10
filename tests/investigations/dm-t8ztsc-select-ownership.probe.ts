// Strict executable ownership witness, also covered by the T8 browser suite.
// Published baseline fails; the DM-T8ZTSC repair preserves the original source.
import type { Page } from "@playwright/test";
import { launchChromium, captureElementTreeWithWarnings } from "../../src/capture/index.js";
import { freezeRealWorldDom } from "../../tests/real-world-dom-freeze.js";
type Route = "native" | "replaced";
const viewport = { x: 0, y: 0, width: 100, height: 100 };
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

const browser = await launchChromium();
const page = await browser.newPage({ viewport });
const state = await fixture(page, "native", "overlay", false, true);
await page.locator("#target").evaluate((node) => {
  node.outerHTML = `<select id="target" style="position:absolute;left:20px;top:20px;width:60px;height:30px;background:#eee;border:1px solid"><option>A</option></select>`;
});
await freezeRealWorldDom(page);
console.log("BEFORE", await state.evaluate((v) => v.snapshot()));

try {
  const before = await state.evaluate((value) => value.snapshot());
  await captureElementTreeWithWarnings(page, "body", viewport);
  const after = await state.evaluate((value) => value.snapshot());
  console.log(JSON.stringify({ before, after }, null, 2));
  if (!after.same || after.currentTime !== before.currentTime || after.animationEvents.length !== 0)
    throw new Error("DM-T8ZTSC: generated-pseudo isolation canceled original source transition");
} finally {
  await browser.close();
}
