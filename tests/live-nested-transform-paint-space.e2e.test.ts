import type { Browser, CDPSession, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import type { CapturedElement } from "../src/capture/types.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 190, height: 180 };
const watchedBoxes = ["outer", "stage", "inner", "leaf"];
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(() => closeBrowserSafely(browser), 15_000);

type Fixture = "first" | "second" | "fractional" | "fractional-static" | "containment" | "fragmented" | "shadow";

async function setBoxes(page: Page, fixture: Fixture, neutral = false) {
  const phase = fixture === "second" ? 1 : 0;
  const fractional = fixture === "fractional" || fixture === "fractional-static";
  const contained = fixture === "containment";
  const fragmented = fixture === "fragmented";
  const outer = ["matrix(2,0,0,3,3,-2)", "matrix(3,0,0,2,-3,4)"];
  const inner = ["matrix(2,0,0,2,1,2)", "matrix(2,0,0,3,2,0)"];
  const animation = (name: string, sampled: string) => {
    if (neutral) return "transform:none";
    if (fixture === "fractional-static") return `transition:transform 2s;transform:${sampled}`;
    return `animation:${name} 2s ${fractional ? "-1s" : phase === 0 ? "-.5s" : "-1.5s"} linear both paused`;
  };
  const fractionalOuter = "matrix(1.5,0,0,1.25,0,0)";
  const fractionalInner = "matrix(1.25,0,0,1.5,0,0)";
  const frames = fractional
    ? `@keyframes outer{from{transform:matrix(1.25,0,0,1,-.5,.5)}to{transform:matrix(1.75,0,0,1.5,.5,-.5)}}
       @keyframes inner{from{transform:matrix(1,0,0,1.25,-.5,.5)}to{transform:matrix(1.5,0,0,1.75,.5,-.5)}}`
    : `@keyframes outer{from,25%{transform:${outer[0]}}75%,to{transform:${outer[1]}}}
       @keyframes inner{from,25%{transform:${inner[0]}}75%,to{transform:${inner[1]}}}`;
  await page.setContent(`<!doctype html><style>
    html,body{margin:0}
    *{box-sizing:border-box}
    #outer{position:absolute;left:${25.5 - phase * 0.25}px;top:${24.25 + phase * 0.25}px;
      width:${fractional ? 40 : 37}px;height:${fractional ? 40 : 30}px;transform-origin:${fractional ? "0 0" : "6px 8px"};
      background:blue;${animation("outer", fractionalOuter)}}
    #stage{position:absolute;left:${contained ? "1.375" : "0"}px;top:${contained ? "1.625" : "0"}px;
      width:34px;height:22px;${contained ? "contain:layout style" : ""};
      ${fragmented ? "columns:2;column-gap:4px;column-fill:auto;height:12px" : ""}}
    #inner{${
      fragmented
        ? "position:relative;width:100%;height:21px"
        : fractional
          ? "position:absolute;left:8px;top:8px;width:16px;height:16px"
          : `position:absolute;left:${9.375 + phase * 0.25}px;top:${8.625 - phase * 0.25}px;width:16px;height:13px`
    };
      transform-origin:${fractional ? "0 0" : "3px 4px"};background:lime;${animation("inner", fractionalInner)}}
    #leaf{position:absolute;${
      fractional
        ? "left:8px;top:8px;width:8px;height:8px"
        : "left:2.625px;top:2.375px;width:5.25px;height:4.25px;outline:1px solid yellow"
    };
      background:red;${fixture === "shadow" ? "box-shadow:1px 1px 2px black" : ""}}
    ${frames}
    </style><div id=outer data-domotion-anim=outer><div id=stage data-domotion-anim=stage>
    <div id=inner data-domotion-anim=inner><div id=leaf data-domotion-anim=leaf></div></div></div></div>`);
  await page.evaluate(async () => {
    void getComputedStyle(document.getElementById("inner")!).transform;
    await Promise.all(document.getAnimations().map((animation) => animation.ready));
  });
}

async function geometry(page: Page) {
  return page.evaluate(
    (ids) =>
      ids.map((id) => {
        const element = document.getElementById(id)!;
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height];
      }),
    watchedBoxes,
  );
}

async function monitorOwners(page: Page) {
  return page.evaluateHandle(() => {
    const outer = document.getElementById("outer")!;
    const inner = document.getElementById("inner")!;
    const initial = [outer, inner].map((owner) => {
      const [animation] = owner.getAnimations();
      return { animation, effect: animation.effect };
    });
    let overrides = 0;
    let mutations = 0;
    window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
      construct(native, args, newTarget) {
        const effect = Reflect.construct(native, args, newTarget) as KeyframeEffect;
        if (effect.target === outer || effect.target === inner) overrides++;
        return effect;
      },
    });
    new MutationObserver((records) => {
      mutations += records.length;
    }).observe(outer, { subtree: true, attributes: true, attributeFilter: ["style"] });
    return () => ({
      overrides,
      mutations,
      owners: [outer, inner].map((owner, index) => {
        const animations = owner.getAnimations();
        return {
          transform: getComputedStyle(owner).transform,
          effects: animations.map((animation) => [animation.playState, animation.currentTime, animation.pending]),
          sameAnimation: animations[0] === initial[index].animation && animations[0]?.effect === initial[index].effect,
        };
      }),
    });
  });
}

async function captureUnchanged(page: Page) {
  const evidence = await monitorOwners(page);
  const before = await evidence.evaluate((read) => read());
  const tree = await captureElementTree(page, "body", viewport);
  expect(await evidence.evaluate((read) => read())).toEqual(before);
  expect([before.overrides, before.mutations]).toEqual([0, 0]);
  expect(before.owners.every(({ sameAnimation }) => sameAnimation)).toBe(true);
  return tree;
}

function boxes(tree: CapturedElement[]): CapturedElement[] {
  const [outer] = tree;
  const [stage] = outer.children;
  const [inner] = stage.children;
  const [leaf] = inner.children;
  return [outer, stage, inner, leaf];
}

const pixels = async (page: Page) =>
  sharp(await screenshotAfterPresentedFrame(page, { omitBackground: true }))
    .ensureAlpha()
    .raw()
    .toBuffer();

it.each([
  {
    fixture: "first",
    shifts: [
      [0.5, -0.25],
      [-0.375, 0.375],
    ],
    ctm: [4, 0, 0, 6, -102.5, -170.25],
  },
  {
    fixture: "second",
    shifts: [
      [-0.25, 0.5],
      [0.375, -0.375],
    ],
    ctm: [6, 0, 0, 6, -172.25, -176.25],
  },
] as const)(
  "recovers the two independent live paint bases at the $fixture held phase",
  async ({ fixture, shifts, ctm }) => {
    const source = await browser.newPage({ viewport });
    const output = await browser.newPage({ viewport });
    try {
      await setBoxes(source, fixture);
      await setBoxes(output, fixture, true);
      const neutral = await geometry(output);
      const native = await pixels(source);
      const tree = await captureUnchanged(source);
      const [outer, stage, inner, leaf] = boxes(tree);
      expect([outer, stage, inner, leaf].map(({ x, y, width, height }) => [x, y, width, height])).toEqual(neutral);
      expect([outer.styles.transformPaintShift, inner.styles.transformPaintShift]).toEqual(shifts);
      expect(leaf.borderPaintSnap?.source).toBe("blink-pixel-snapped-border-v1");
      await output.setContent(
        `<!doctype html><style>body{margin:0}</style>${elementTreeToSvg(tree, viewport.width, viewport.height)}`,
      );
      const groups = output.locator("g[transform]");
      expect(await groups.count()).toBe(2);
      expect(
        await groups.last().evaluate((node: SVGGElement) => {
          const matrix = node.getCTM()!;
          return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f];
        }),
      ).toEqual(ctm);
      expect(await pixels(output)).toEqual(native);
    } finally {
      await source.close();
      await output.close();
    }
  },
);

it("keeps the live rect when even whole projected edges do not authenticate fractional compositor paint", async () => {
  const source = await browser.newPage({ viewport });
  const noncomposited = await browser.newPage({ viewport });
  try {
    await setBoxes(source, "fractional");
    await setBoxes(noncomposited, "fractional-static");
    expect(await geometry(source)).toEqual(await geometry(noncomposited));
    const base = await pixels(noncomposited);
    const active = await pixels(source);
    let differingPixels = 0;
    for (let offset = 0; offset < base.length; offset += 4)
      if (base.subarray(offset, offset + 4).some((channel, index) => active[offset + index] !== channel))
        differingPixels++;
    expect(differingPixels).toBeGreaterThan(0);
    if (process.platform === "darwin") expect(differingPixels).toBe(60);
    // The whole-edge leaf starts at (53,49) in the sampled static paint. The
    // paused compositor raster shifts its fully red corner one pixel inward.
    const redPixel = (buffer: Buffer, x: number, y: number) => {
      const start = (y * viewport.width + x) * 4;
      return [...buffer.subarray(start, start + 4)];
    };
    expect(redPixel(base, 53, 49)).toEqual([255, 0, 0, 255]);
    expect(redPixel(active, 53, 49)).not.toEqual([255, 0, 0, 255]);
    expect(redPixel(active, 55, 51)).toEqual([255, 0, 0, 255]);
    const [outer, , inner] = boxes(await captureUnchanged(source));
    expect([outer.styles.transform, inner.styles.transform]).toEqual(["none", "none"]);
  } finally {
    await source.close();
    await noncomposited.close();
  }
});

it.each(["containment", "fragmented", "shadow"] as const)(
  "keeps the live subtree when it includes %s",
  async (fixture) => {
    const source = await browser.newPage({ viewport });
    try {
      await setBoxes(source, fixture);
      const count = await source.locator("#inner").evaluate((inner) => inner.getClientRects().length);
      expect(count).toBe(fixture === "fragmented" ? 2 : 1);
      const [outer, , inner] = boxes(await captureUnchanged(source));
      expect([outer.styles.transform, inner.styles.transform]).toEqual(["none", "none"]);
      expect([outer.styles.transformPaintShift, inner.styles.transformPaintShift]).toEqual([undefined, undefined]);
    } finally {
      await source.close();
    }
  },
);

it("requires composed ancestry for the intermediate host before applying either wrapper", async () => {
  const source = await browser.newPage({ viewport });
  try {
    await setBoxes(source, "first");
    const slot = await source.evaluate(async () => {
      const host = document.getElementById("stage")!;
      const inner = document.getElementById("inner")!;
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>#hidden{position:absolute;left:1.375px;top:1.625px;width:34px;height:22px;contain:layout style}</style>
        <div id="hidden"><slot></slot></div>`;
      // Installing the slot rebuilds the inner animation's paint attachment.
      void getComputedStyle(inner).transform;
      await Promise.all(inner.getAnimations().map((animation) => animation.ready));
      return {
        assigned: root.querySelector("slot")!.assignedElements()[0] === inner,
        publicRoot: host.shadowRoot != null,
        publicSlot: inner.assignedSlot != null,
        fragments: inner.getClientRects().length,
      };
    });
    expect(slot).toEqual({ assigned: true, publicRoot: false, publicSlot: false, fragments: 1 });
    const [, , live] = await geometry(source);
    expect(live).toEqual([40, 31, 64, 78]);
    const [outer, , inner, leaf] = boxes(await captureUnchanged(source));
    expect([outer.styles.transform, inner.styles.transform]).toEqual(["none", "none"]);
    expect([inner.x, inner.y, inner.width, inner.height]).toEqual(live);
    expect(leaf.borderPaintSnap).toBeUndefined();
  } finally {
    await source.close();
  }
});

it("keeps both live rects when the participant authority is unavailable", async () => {
  const page = await browser.newPage({ viewport });
  const context = page.context();
  const createSession = context.newCDPSession.bind(context);
  let denied = 0;
  const connections = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const session = await createSession(target);
    const send = session.send.bind(session);
    vi.spyOn(session, "send").mockImplementation((async (method: string, params?: object) => {
      const expression = (params as { expression?: string } | undefined)?.expression;
      if (method === "Runtime.evaluate" && expression?.includes('"mode":"live-affine-boxes"')) {
        denied++;
        throw new Error("test denies nested participant authority");
      }
      return Reflect.apply(send, session, [method, params]);
    }) as CDPSession["send"]);
    return session;
  });
  try {
    await setBoxes(page, "first");
    const [outer, , inner, leaf] = boxes(await captureUnchanged(page));
    expect(denied).toBe(1);
    expect([outer.styles.transform, inner.styles.transform]).toEqual(["none", "none"]);
    expect(leaf.borderPaintSnap).toBeUndefined();
  } finally {
    connections.mockRestore();
    await page.close();
  }
});
