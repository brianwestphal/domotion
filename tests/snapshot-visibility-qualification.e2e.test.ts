import type { Browser, Frame, Page } from "@playwright/test";
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
  browser = await launchChromium({ args: ["--site-per-process"] });
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

  it("refuses an active author-shadow owner without touching the source", async () => {
    const page = await browser.newPage();
    const state = await setup(page, "shadow");
    try {
      const before = await state.evaluate((value) => value.snapshot());
      expect(before).toMatchObject({ alive: true, documentListed: false, effect: true, currentTime: 10_000 });
      await expect(suppressSnapshotVisibilityTransitions(page)).rejects.toThrow("transition in an author shadow root");
      expect(await state.evaluate((value) => value.snapshot())).toEqual(before);
    } finally {
      await state.dispose();
      await page.close();
    }
  });

  it("refuses a newly attached and removed author root during isolation", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<div id=host></div>");
      const lease = await suppressSnapshotVisibilityTransitions(page, true);
      await page.evaluate(() => {
        const host = document.querySelector("#host")!;
        host.attachShadow({ mode: "closed" });
        host.remove();
      });
      await expect(lease.dispose()).rejects.toThrow("author-shadow ownership changed");
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    } finally {
      await page.close();
    }
  });

  it("refuses an existing shadow owner's visibility transition started and canceled between scope reads", async () => {
    const page = await browser.newPage();
    try {
      for (const pseudo of [false, true]) {
        await page.setContent("<div id=host></div>");
        const el = await page.evaluateHandle((pseudo) => {
          const root = document.querySelector("#host")!.attachShadow({ mode: "closed" });
          const style = document.createElement("style");
          style.textContent = `${pseudo ? "div::before" : "div"}{content:"x";width:20px;height:20px;visibility:var(--v,visible);transition:visibility 30s}`;
          root.append(style);
          return root.appendChild(document.createElement("div"));
        }, pseudo);
        const lease = await suppressSnapshotVisibilityTransitions(page, true);
        await el.evaluate(async (el) => {
          void el.offsetWidth;
          el.style.setProperty("--v", "hidden");
          const animation = (el.getRootNode() as ShadowRoot)
            .getAnimations()
            .find((value) => value instanceof CSSTransition)!;
          await animation.ready;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          animation.cancel();
        });
        await expect(lease.dispose()).rejects.toThrow("author-shadow ownership changed");
        expect(await el.evaluate((el) => (el.getRootNode() as ShadowRoot).getAnimations().length)).toBe(0);
        await el.dispose();
      }
    } finally {
      await page.close();
    }
  });

  it("refuses a detached subtree that brings its closed root into and out of the raster", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<div></div>");
      const lease = await suppressSnapshotVisibilityTransitions(page, true);
      await page.evaluate(() => {
        const wrapper = document.createElement("section");
        wrapper.appendChild(document.createElement("div")).attachShadow({ mode: "closed" });
        document.body.append(wrapper);
        wrapper.remove();
      });
      await expect(lease.dispose()).rejects.toThrow("author-shadow ownership changed");
    } finally {
      await page.close();
    }
  });

  const viewport = { x: 0, y: 0, width: 100, height: 100 };
  type Scope = "light" | "open" | "closed";
  async function guardPixel(
    scope: Scope,
    options: {
      active?: boolean;
      child?: "local" | "oopif";
      toHidden?: boolean;
      surface?: "button" | "canvas";
    } = {},
  ) {
    const { active = true, child, toHidden = false, surface = "button" } = options;
    const iframe = child ? `<iframe src="${child === "oopif" ? "http://child.test" : ""}/child"></iframe>` : "";
    const targetHtml =
      surface === "canvas"
        ? '<canvas width="100" height="100" style="position:absolute;inset:0"></canvas>'
        : '<button style="position:absolute;left:20px;top:20px;width:60px;height:30px"></button>';
    const pageHtml = `<style>body{margin:0;background:rgb(12,20,40)}#host,iframe{position:absolute;inset:0;border:0}</style><div id="host"></div>${iframe}${targetHtml}`;
    const page = await browser.newPage({ viewport });
    try {
      let frame: Frame = page.mainFrame();
      if (child) {
        const childHtml = '<div id="host" style="position:absolute;inset:0"></div>';
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          await route.fulfill({ contentType: "text/html", body: url.pathname === "/child" ? childHtml : pageHtml });
        });
        await page.goto("http://parent.test/");
        frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
        expect(frame).toBeDefined();
        if (child === "oopif") {
          const target = await page.context().newCDPSession(frame);
          expect((await target.send("Page.getFrameTree")).frameTree.frame.url).toBe("http://child.test/child");
          await target.detach();
        } else {
          await expect(page.context().newCDPSession(frame)).rejects.toThrow(
            /part of the parent frame's session|does not have a separate CDP session/i,
          );
        }
      } else await page.setContent(pageHtml);
      if (surface === "canvas")
        await page.locator("canvas").evaluate((node: HTMLCanvasElement) => {
          const context = node.getContext("2d")!;
          context.fillStyle = "rgb(0,80,240)";
          context.fillRect(30, 30, 40, 40);
        });
      const source = await frame.evaluateHandle(
        async ({ scope, active, toHidden }) => {
          const host = document.getElementById("host")!;
          const target = scope === "light" ? host : host.attachShadow({ mode: scope });
          const overlay = document.createElement("div");
          target.append(overlay);
          overlay.style.cssText = "position:absolute;inset:0;background:rgba(255,255,255,.2)";
          const events: string[] = [];
          for (const type of ["transitionrun", "transitionstart", "transitionend", "transitioncancel"])
            overlay.addEventListener(type, () => events.push(type));
          let animation: Animation | undefined;
          if (active) {
            overlay.style.visibility = toHidden ? "visible" : "hidden";
            void overlay.offsetWidth;
            overlay.style.transition = "visibility 30s linear";
            void overlay.offsetWidth;
            overlay.style.visibility = toHidden ? "hidden" : "visible";
            animation = overlay.getAnimations().find((a) => a instanceof CSSTransition)!;
            await animation.ready;
            animation.pause();
            await animation.ready;
            animation.currentTime = 10_000;
            await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          }
          const effect = animation?.effect as KeyframeEffect | undefined;
          const read = ShadowRoot.prototype.getAnimations;
          if (scope === "closed") ShadowRoot.prototype.getAnimations = () => [];
          return {
            snapshot: () => ({
              listed:
                animation == null ||
                (target instanceof ShadowRoot ? read.call(target) : document.getAnimations()).includes(animation),
              effect: animation?.effect === effect,
              frames: effect?.getKeyframes(),
              timing: effect?.getTiming(),
              time: animation?.currentTime,
              state: animation?.playState,
              events: [...events],
              hostStyle: host.getAttribute("style"),
              overlayStyle: overlay.getAttribute("style"),
            }),
          };
        },
        { scope, active, toHidden },
      );
      try {
        const original = await source.evaluate((state) => state.snapshot());
        if (active) expect(original).toMatchObject({ listed: true, effect: true, time: 10_000, state: "paused" });
        const capture = await captureElementTreeWithWarnings(page, "body", viewport);
        expect(await source.evaluate((state) => state.snapshot())).toEqual(original);
        const walk = (nodes: CapturedElement[]): CapturedElement[] =>
          nodes.flatMap((node) => [node, ...walk(node.children)]);
        const node = walk(capture.tree).find((candidate) => candidate.tag === surface);
        expect(node).toBeDefined();
        const uri = surface === "button" ? node?.nativeControlRaster?.dataUri : node?.replacedSnapshot?.dataUri;
        const feature = surface === "button" ? "native-control-raster" : "replaced-element snapshot";
        const warnings = capture.warnings.filter((warning) => warning.feature === feature);
        if (active && scope !== "light") {
          expect(uri).toBeUndefined();
          expect(warnings.some((w) => w.detail.includes("transition in an author shadow root is unsupported"))).toBe(
            true,
          );
          return;
        }
        expect(warnings).toEqual([]);
        expect(uri).toMatch(/^data:image\/png;base64,/);
        const guard = await sharp(Buffer.from(uri!.split(",")[1], "base64"))
          .ensureAlpha()
          .extract({ left: 0, top: 0, width: 1, height: 1 })
          .raw()
          .toBuffer();
        expect([...guard]).toEqual([0, 0, 0, 0]);
      } finally {
        await source.dispose();
      }
    } finally {
      await page.close();
    }
  }
  it("keeps the exact native light-DOM and static shadow raster guards", async () => {
    await guardPixel("light");
    await guardPixel("open", { active: false });
    await guardPixel("closed", { active: false });
  });
  for (const scope of ["open", "closed"] as const)
    it.each([false, true])(
      `refuses an active ${scope} shadow transition on the native route, toHidden=%s`,
      async (toHidden) => {
        await guardPixel(scope, { toHidden });
      },
    );
  it.each(["local", "oopif"] as const)(
    "checks real author-shadow scopes in a %s iframe on native and replaced routes",
    async (child) => {
      for (const surface of ["button", "canvas"] as const) {
        await guardPixel("closed", { child, surface });
        await guardPixel("closed", { child, surface, active: false });
        await guardPixel("light", { child, surface });
      }
    },
  );
});
