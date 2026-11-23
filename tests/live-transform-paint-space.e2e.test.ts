import type { Browser, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 100, height: 100 };
let browser: Browser;
beforeAll(async () => {
  browser = await launchChromium();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function boxEvidence(page: Page) {
  return page.evaluate(() => {
    const owner = document.getElementById("owner")!;
    return {
      transform: getComputedStyle(owner).transform,
      rect: owner.getBoundingClientRect().toJSON(),
      style: owner.getAttribute("style"),
      animations: owner.getAnimations().map(({ currentTime, playState, playbackRate }) => ({
        currentTime,
        playState,
        playbackRate,
      })),
      overrides: document.documentElement.dataset.testTransformOverrides,
      changes: document.documentElement.dataset.testTransformChanges,
    };
  });
}

async function watchTransformChanges(page: Page) {
  await page.evaluate(() => {
    const owner = document.getElementById("owner")!;
    const data = document.documentElement.dataset;
    data.testTransformOverrides = "0";
    data.testTransformChanges = "0";
    window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
      construct(target, args, newTarget) {
        const effect = Reflect.construct(target, args, newTarget) as KeyframeEffect;
        if (effect.target === owner) data.testTransformOverrides = String(Number(data.testTransformOverrides) + 1);
        return effect;
      },
    });
    new MutationObserver((records) => {
      data.testTransformChanges = String(Number(data.testTransformChanges) + records.length);
    }).observe(owner, { attributes: true, attributeFilter: ["style"] });
  });
}

it.each([
  { mode: "declared transition", transform: "scale(1.5)", css: "transition:transform 2s" },
  { mode: "sampled transition", transform: "scale(1.25)", css: "transition:transform 2s linear", seekTransition: true },
  {
    mode: "paused CSS animation",
    transform: "none",
    css: "animation:sample 2s linear -1s paused both",
    siblingText: true,
  },
])(
  "restores local decoration geometry for a $mode without source changes",
  async ({ transform, css, seekTransition, siblingText }) => {
    const page = await browser.newPage({ viewport }),
      output = await browser.newPage({ viewport });
    try {
      await page.setContent(`<style>
      body{margin:0}
      @keyframes sample { from{transform:scale(1.25)} to{transform:scale(1.75)} }
      #owner {position:absolute;left:20.5px;top:20.5px;box-sizing:border-box;width:32px;height:28px;transform-origin:6px 8px;transform:${transform};${css};background:red;border:2px solid blue;outline:2px solid green}
      #child {position:absolute;left:7.25px;top:8.25px;width:12px;height:10px;background:yellow;border:2px solid purple;box-shadow:3px 0 cyan}
    </style><div id="owner"><div id="child"></div></div>
    ${siblingText ? '<div style="position:absolute;top:80px">Sibling text</div>' : ""}`);
      if (seekTransition) {
        await page.evaluate(async () => {
          const owner = document.getElementById("owner")!;
          void getComputedStyle(owner).transform;
          owner.style.transform = "scale(1.75)";
          void getComputedStyle(owner).transform;
          const [transition] = owner.getAnimations();
          transition.pause();
          transition.currentTime = 1000;
          await transition.ready;
        });
      }
      await watchTransformChanges(page);
      // Scope the strict comparison to the transformed boxes. The sibling text
      // activates the geometry prepass without introducing font antialiasing.
      const region = { left: 10, top: 10, width: 70, height: 65 };
      const pixels = (bytes: Buffer) => sharp(bytes).extract(region).ensureAlpha().raw().toBuffer();
      const native = await pixels(await screenshotAfterPresentedFrame(page, { omitBackground: true }));
      const before = await boxEvidence(page);
      expect(before.transform).toBe("matrix(1.5, 0, 0, 1.5, 0, 0)");
      const tree = await captureElementTree(page, "body", viewport);
      expect(await boxEvidence(page)).toEqual(before);

      const owner = tree[0];
      expect([owner.x, owner.y, owner.width, owner.height]).toEqual([20.5, 20.5, 32, 28]);
      expect(owner.styles.transformPaintShift).toEqual([0.5, 0.5]);
      expect(owner.children[0].borderPaintSnap).toBeDefined();
      await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
      expect(await pixels(await output.screenshot({ omitBackground: true }))).toEqual(native);
    } finally {
      await page.close();
      await output.close();
    }
  },
);

it("preserves fractional local outline coordinates that map to whole native pixels", async () => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>
      body{margin:0}
      @keyframes sample {
        from{transform:matrix(1.25,0,0,1.125,3,-2)}
        to{transform:matrix(1.75,0,0,1.375,5,-6)}
      }
      #owner{position:absolute;left:20.5px;top:20.25px;width:46px;height:48px;padding:.25px .375px;
        transform-origin:6px 8px;animation:sample 2s -1s linear both paused}
      #member{display:inline-block;vertical-align:top;width:32px;height:40px;outline:4px solid rgb(20,116,204)}
    </style><div id="owner"><span id="member"></span></div>`);
    await watchTransformChanges(page);
    const pixels = (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
    const native = await pixels(await screenshotAfterPresentedFrame(page, { omitBackground: true }));
    const before = await boxEvidence(page);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(await boxEvidence(page)).toEqual(before);
    expect(owner.styles.transformPaintShift).toEqual([0.5, -0.25]);
    expect(owner.children[0].borderPaintSnap?.top).toBe(-0.25);
    // The outline crosses whole device pixels even though its local y is 18.25.
    const alpha = (x: number, y: number) => native[(y * viewport.width + x) * 4 + 3];
    expect([alpha(35, 8), alpha(35, 9), alpha(35, 13), alpha(35, 14)]).toEqual([0, 255, 255, 0]);
    expect([alpha(35, 63), alpha(35, 64), alpha(35, 68), alpha(35, 69)]).toEqual([0, 255, 255, 0]);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg([owner], 100, 100));
    expect(await output.locator("svg g[transform] rect[stroke]").getAttribute("y")).toBe("18.25");
    expect((await pixels(await output.screenshot({ omitBackground: true }))).equals(native)).toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});

it.each([
  { transform: "scaleX(1.5)", unchangedAxis: "y", shift: [-0.25, 0] },
  { transform: "scaleY(1.5)", unchangedAxis: "x", shift: [0, -0.25] },
] as const)("keeps fractional paint accumulation on $unchangedAxis for a declared transition", async (fixture) => {
  const page = await browser.newPage({ viewport }),
    output = await browser.newPage({ viewport });
  try {
    await page.setContent(`<style>
      body{margin:0}
      #owner{position:absolute;left:20.25px;top:20.25px;width:32px;height:28px;transform-origin:0 0;transform:${fixture.transform};transition:transform 1s}
      #child{position:absolute;left:3.375px;top:3.375px;width:12px;height:10px;background:red}
    </style><div id="owner"><div id="child"></div></div>`);
    await watchTransformChanges(page);
    const pixels = (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();
    const native = await pixels(await screenshotAfterPresentedFrame(page, { omitBackground: true }));
    const before = await boxEvidence(page);
    expect(before.animations).toEqual([]);
    const firstPaint = (axis: "x" | "y") => {
      for (let offset = 0; offset < viewport.width; offset++) {
        const [x, y] = axis === "x" ? [offset, 30] : [30, offset];
        if (native[(y * viewport.width + x) * 4 + 3] > 0) return offset;
      }
    };
    // Resetting the unit axis would snap the child at 20 + round(3.375) = 23.
    expect(firstPaint(fixture.unchangedAxis)).toBe(24);
    const tree = await captureElementTree(page, "body", viewport);
    expect(await boxEvidence(page)).toEqual(before);
    const [owner] = tree;
    expect([owner.x, owner.y, owner.width, owner.height]).toEqual([20.25, 20.25, 32, 28]);
    expect(owner.styles.transformPaintShift).toEqual(fixture.shift);
    await output.setContent("<style>body{margin:0}</style>" + elementTreeToSvg(tree, 100, 100));
    expect(await pixels(await output.screenshot({ omitBackground: true }))).toEqual(native);
  } finally {
    await page.close();
    await output.close();
  }
});

it.each([
  { mode: "running one-axis animation", transform: "scaleX(1.5)", css: "animation:sample 2s linear infinite" },
  { mode: "paused one-axis animation", transform: "scaleY(1.5)", css: "animation:sample 2s linear -1s paused both" },
  { mode: "paused identity crossing", transform: "scaleX(1)", css: "animation:crossing 2s linear -1s paused both" },
  { mode: "one-axis will-change", transform: "scaleX(1.5)", css: "will-change:transform" },
  { mode: "one-axis outer isolation", transform: "scaleX(1.5)", ancestorCss: "contain:paint" },
  {
    mode: "replaced producer",
    transform: "scale(1.5)",
    child: '<img width="3" height="3" alt="Unsupported producer">',
  },
])(
  "preserves live geometry when the subtree cannot prove a shared inverse: $mode",
  async ({ transform, css = "", child = "", ancestorCss }) => {
    const page = await browser.newPage({ viewport });
    try {
      const ownerHtml = `<div id="owner" style="position:absolute;left:20.5px;top:20.5px;width:24px;height:20px;transform:${transform};transition:transform 1s;background:red;${css}">${child}</div>`;
      await page.setContent(`<style>
          @keyframes sample {from,to{transform:${transform}}}
          @keyframes crossing {from{transform:scaleX(.75)} to{transform:scaleX(1.25)}}
        </style>${ancestorCss ? `<div style="${ancestorCss};height:90px">${ownerHtml}</div>` : ownerHtml}`);
      await watchTransformChanges(page);
      const before = await boxEvidence(page);
      if (css.includes("animation:")) expect(before.animations).toHaveLength(1);
      if (css.includes("crossing")) expect(before.transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
      const [root] = await captureElementTree(page, "body", viewport);
      const owner = ancestorCss ? root.children[0] : root;
      const after = await boxEvidence(page);
      expect([after.transform, after.style, after.overrides, after.changes]).toEqual([
        before.transform,
        before.style,
        "0",
        "0",
      ]);
      expect([owner.x, owner.y, owner.width, owner.height]).toEqual([
        before.rect.x,
        before.rect.y,
        before.rect.width,
        before.rect.height,
      ]);
      expect(owner.styles.transform).toBe("none");
      expect(owner.styles.transformPaintShift).toBeUndefined();
    } finally {
      await page.close();
    }
  },
);
