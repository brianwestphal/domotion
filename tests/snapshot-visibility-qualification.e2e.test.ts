import type { Browser, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { captureElementTreeWithWarnings, launchChromium } from "../src/capture/index.js";
import { suppressSnapshotVisibilityTransitions } from "../src/capture/snapshot-visibility-transitions.js";
import type { CapturedElement } from "../src/capture/types.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-284W1M qualification of the raster-isolation visibility controller
// beyond the ordinary same-document Element / document.timeline owner that
// DM-THP2FS qualified. Each unsupported owner must be an explicit refusal
// that leaves the source Animation, effect, frames, timing, time, events and
// style attributes untouched. Supported-but-unusual owners must be accepted
// without changing them. A transition's interpolated value outranks every
// !important declaration (CSS Cascade 5 §6.1), which is why an unhandled
// owner would otherwise defeat the isolation stylesheet.
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

type Variant =
  "ordinary" | "pseudo" | "shadow" | "custom-timeline" | "foreign-frames" | "modified-timing" | "near-finish";

async function setup(page: Page, variant: Variant) {
  await page.setContent(
    `<!doctype html><style>body{margin:0}#host::before{content:"x";visibility:var(--v,visible);transition:visibility 30s linear}</style><div id="host"></div><div id="owner">o</div>`,
  );
  return page.evaluateHandle(async (variant) => {
    let owner: Element = document.getElementById("owner")!;
    const host = document.getElementById("host")!;
    if (variant === "shadow") {
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<div id="inner">i</div>`;
      owner = root.getElementById("inner")!;
    }
    const events: string[] = [];
    for (const type of ["transitionrun", "transitionstart", "transitioncancel", "transitionend"])
      (variant === "pseudo" ? host : owner).addEventListener(type, () => events.push(type));
    let animation: Animation;
    if (variant === "pseudo") {
      void getComputedStyle(host, "::before").visibility;
      host.style.setProperty("--v", "hidden");
      void getComputedStyle(host, "::before").visibility;
      animation = document.getAnimations().find((a) => a instanceof CSSTransition)!;
    } else {
      const el = owner as HTMLElement;
      el.style.visibility = "visible";
      void el.offsetWidth;
      el.style.transition = "visibility 30s linear";
      void el.offsetWidth;
      el.style.visibility = "hidden";
      animation = el.getAnimations().find((a) => a instanceof CSSTransition)!;
    }
    await animation.ready;
    animation.pause();
    await animation.ready;
    animation.currentTime = variant === "near-finish" ? 29_600 : 10_000;
    const effect = animation.effect as KeyframeEffect;
    if (variant === "custom-timeline") animation.timeline = new DocumentTimeline({ originTime: 0 });
    if (variant === "foreign-frames")
      effect.setKeyframes([
        { visibility: "visible", color: "red" },
        { visibility: "hidden", color: "blue" },
      ]);
    if (variant === "modified-timing") effect.updateTiming({ duration: 60_000, easing: "ease-in" });
    if (variant === "near-finish") animation.play();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const frames = JSON.stringify(effect.getKeyframes()),
      timing = JSON.stringify(effect.getTiming());
    const attrs = () =>
      [
        document.documentElement,
        ...document.querySelectorAll("*"),
        ...(host.shadowRoot?.querySelectorAll("*") ?? []),
      ].map((node) => [...node.attributes].map((attr) => `${attr.name}=${attr.value}`).join(" "));
    const originalAttrs = attrs();
    return {
      snapshot() {
        return {
          alive: animation.playState !== "idle",
          documentListed: document.getAnimations().includes(animation),
          effect: animation.effect === effect,
          frames: JSON.stringify(effect.getKeyframes()) === frames,
          timing: JSON.stringify(effect.getTiming()) === timing,
          timeline: animation.timeline === document.timeline,
          playState: animation.playState,
          currentTime: animation.playState === "paused" ? animation.currentTime : null,
          events: [...events],
          attrs: JSON.stringify(attrs()) === JSON.stringify(originalAttrs),
          animations: document.getAnimations().length,
        };
      },
    };
  }, variant);
}

describe("snapshot visibility controller qualification (DM-284W1M)", () => {
  for (const [variant, message] of [
    ["pseudo", "owner/timeline is unsupported"],
    ["custom-timeline", "owner/timeline is unsupported"],
    ["foreign-frames", "keyframe ownership is unsupported"],
  ] as const)
    it(`refuses a ${variant} owner explicitly without touching the source`, async () => {
      const page = await browser.newPage();
      const state = await setup(page, variant);
      try {
        const before = await state.evaluate((value) => value.snapshot());
        expect(before.alive).toBe(true);
        await expect(suppressSnapshotVisibilityTransitions(page)).rejects.toThrow(message);
        expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      } finally {
        await state.dispose();
        await page.close();
      }
    });

  for (const variant of ["ordinary", "modified-timing"] as const)
    it(`qualifies a paused ${variant} owner and restores it exactly`, async () => {
      const page = await browser.newPage();
      const state = await setup(page, variant);
      try {
        const before = await state.evaluate((value) => value.snapshot());
        const owner = await suppressSnapshotVisibilityTransitions(page);
        // The controller owns the channel through private animations; the
        // caller's isolation declarations (not installed here) hide paint.
        expect(await page.evaluate(() => document.getAnimations().some((a) => !(a instanceof CSSTransition)))).toBe(
          true,
        );
        await owner.dispose();
        expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
      } finally {
        await state.dispose();
        await page.close();
      }
    });

  it("fails closed when a running owner finishes naturally during isolation", async () => {
    const page = await browser.newPage();
    const state = await setup(page, "near-finish");
    try {
      expect((await state.evaluate((value) => value.snapshot())).playState).toBe("running");
      const owner = await suppressSnapshotVisibilityTransitions(page).catch((error: Error) => error);
      if (owner instanceof Error) {
        // Already finished before activation: refused as an unsupported owner
        // or a changed one, never silently accepted.
        expect(owner.message).toMatch(/unsupported|changed/);
      } else {
        await page.waitForTimeout(800);
        await expect(owner.dispose()).rejects.toThrow("ownership changed");
      }
      // No capture-owned animation leaks; the source finished on its own.
      const after = await state.evaluate((value) => value.snapshot());
      expect(after.playState).toBe("finished");
      expect(after.effect && after.frames && after.timing && after.attrs).toBe(true);
      expect(await page.evaluate(() => document.getAnimations().some((a) => !(a instanceof CSSTransition)))).toBe(
        false,
      );
    } finally {
      await state.dispose();
      await page.close();
    }
  });

  // Qualification gap, repair DM-J5V8WD: Document.getAnimations() lists only
  // animations targeting the document's own tree scope
  // (DocumentAnimations::getAnimations(tree_scope),
  // core/animation/document_animations.cc:277-291, Chromium 7d859f27), so an
  // author-shadow owner is neither qualified nor refused.
  it("does not see an author-shadow owner (documented gap)", async () => {
    const page = await browser.newPage();
    const state = await setup(page, "shadow");
    try {
      const before = await state.evaluate((value) => value.snapshot());
      expect(before).toMatchObject({ alive: true, documentListed: false });
      const owner = await suppressSnapshotVisibilityTransitions(page);
      await owner.dispose();
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });

  // Production witness for that gap: the shadow overlay's paused visibility
  // transition outranks the isolation stylesheet and paints into the native
  // control raster with no warning. The light-DOM overlay and a
  // transition-free shadow overlay are clean controls. The defect value is
  // pinned exactly; DM-J5V8WD must change it to the transparent guard.
  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  const guardPixel = async (where: "light" | "shadow" | "shadow-static") => {
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<style>body{margin:0;background:rgb(12,20,40)}#host{position:absolute;inset:0}</style><div id="host"></div><button id="target" style="position:absolute;left:20px;top:20px;width:60px;height:30px"></button>`,
      );
      await page.evaluate(async (where) => {
        const host = document.getElementById("host")!;
        const overlay = document.createElement("div");
        if (where === "light") host.append(overlay);
        else host.attachShadow({ mode: "closed" }).append(overlay);
        overlay.style.cssText = "position:absolute;inset:0;background:rgba(255,255,255,.2)";
        if (where === "shadow-static") return;
        overlay.style.visibility = "hidden";
        void overlay.offsetWidth;
        overlay.style.transition = "visibility 30s linear";
        void overlay.offsetWidth;
        overlay.style.visibility = "visible";
        const animation = overlay.getAnimations().find((a) => a instanceof CSSTransition)!;
        await animation.ready;
        animation.pause();
        animation.currentTime = 10_000;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }, where);
      const capture = await captureElementTreeWithWarnings(page, "body", viewport);
      const walk = (nodes: CapturedElement[]): CapturedElement[] =>
        nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
      const uri = walk(capture.tree).find((node) => node.nativeControlRaster != null)?.nativeControlRaster?.dataUri;
      expect(uri).toMatch(/^data:image\/png;base64,/);
      return [
        ...(await sharp(Buffer.from(uri!.split(",")[1], "base64"))
          .ensureAlpha()
          .extract({ left: 0, top: 0, width: 1, height: 1 })
          .raw()
          .toBuffer()),
      ];
    } finally {
      await page.close();
    }
  };
  it("isolates a native control raster from a light-DOM visibility transition (control)", async () => {
    expect(await guardPixel("light")).toEqual([0, 0, 0, 0]);
    expect(await guardPixel("shadow-static")).toEqual([0, 0, 0, 0]);
  });
  it("lets an author-shadow visibility transition contaminate the native raster (pinned defect)", async () => {
    expect(await guardPixel("shadow")).toEqual([255, 255, 255, 51]);
  });
});
