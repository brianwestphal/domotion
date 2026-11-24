import { chromium, type Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";
import { observeLiveTextCaptures } from "./live-text-capture-attempts.js";

const viewport = { x: 0, y: 0, width: 320, height: 240 };
const text = "quick world with several short words";
let browser: Awaited<ReturnType<typeof chromium.launch>>;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => closeBrowserSafely(browser), 15_000);

async function fixture(page: Page, ownerCss = "", memberCss = "", child = "") {
  await page.setContent(
    "<!doctype html><style>body{margin:0}" +
      "@keyframes sample{from{transform:matrix(1.25,0,0,1.125,3,-2)}to{transform:matrix(1.75,0,0,1.375,5,-6)}}" +
      "#owner{position:absolute;left:20.5px;top:20.25px;width:148px;height:136px;padding:.25px .375px;" +
      "font:17px/18.375px Arial;transform-origin:6px 8px;animation:sample 2s -1s linear both paused;" +
      ownerCss +
      "}" +
      "#member{display:inline-block;vertical-align:top;width:72px;height:112px;font-weight:700;color:transparent;" +
      "background:rgb(232,78,31);outline:4px solid rgb(20,116,204);" +
      memberCss +
      "}" +
      '</style><div id="owner"><span id="member">' +
      text +
      child +
      "</span></div>",
  );
  await page.evaluate(async () => {
    const owner = document.getElementById("owner")!;
    const member = document.getElementById("member")!;
    await document.fonts.ready;
    void getComputedStyle(owner).transform;
    await Promise.all(owner.getAnimations({ subtree: true }).map((animation) => animation.ready));
    const source = document.documentElement.dataset;
    source.testEffects = "0";
    source.testStyleWrites = "0";
    const authored = owner.getAnimations()[0];
    const effect = authored.effect;
    Object.defineProperty(owner, "testAuthoredEffect", {
      value: () => owner.getAnimations().includes(authored) && authored.effect === effect,
    });
    window.KeyframeEffect = new Proxy(window.KeyframeEffect, {
      construct(target, args, newTarget) {
        const candidate = Reflect.construct(target, args, newTarget) as KeyframeEffect;
        if (candidate.target === owner || candidate.target === member)
          source.testEffects = String(Number(source.testEffects) + 1);
        return candidate;
      },
    });
    new MutationObserver((records) => {
      source.testStyleWrites = String(Number(source.testStyleWrites) + records.length);
    }).observe(owner, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
}

async function sourceEvidence(page: Page) {
  return page.evaluate(() => {
    const owner = document.getElementById("owner")! as HTMLElement & { testAuthoredEffect: () => boolean };
    return {
      html: owner.outerHTML,
      transform: getComputedStyle(owner).transform,
      animations: owner.getAnimations({ subtree: true }).map(({ currentTime, pending, playState, playbackRate }) => ({
        currentTime,
        pending,
        playState,
        playbackRate,
      })),
      authoredEffect: owner.testAuthoredEffect(),
      effects: document.documentElement.dataset.testEffects,
      styleWrites: document.documentElement.dataset.testStyleWrites,
    };
  });
}

it("captures aligned inline-block decorations and six wrapped text fragments under one live affine wrapper", async () => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await fixture(page);
    const native = await screenshotAfterPresentedFrame(page, { omitBackground: true });
    const before = await sourceEvidence(page);
    expect(before).toMatchObject({ effects: "0", styleWrites: "0", authoredEffect: true });
    const tree = await captureElementTree(page, "body", viewport);
    expect(await sourceEvidence(page)).toEqual(before);
    const [owner] = tree;
    const [member] = owner.children;
    expect(owner.styles.transformPaintShift).toEqual([0.5, -0.25]);
    expect([member.x, member.y, member.width, member.height]).toEqual([20.875, 20.5, 72, 112]);
    expect(member.borderPaintSnap).toMatchObject({ left: -0.375, top: -0.25, right: -0.375, bottom: -0.25 });
    expect(
      member.textPaintGeometry?.fragments.map(({ domUtf16Span, paintMatrix }) => [domUtf16Span, paintMatrix]),
    ).toEqual(
      [
        [0, 5],
        [6, 11],
        [12, 16],
        [17, 24],
        [25, 30],
        [31, 36],
      ].map((span) => [span, [1.5, 0, 0, 1.25, -9.25, -11.0625]]),
    );
    const svg = elementTreeToSvg(tree, viewport.width, viewport.height);
    await output.setContent("<style>body{margin:0}</style>" + svg);
    const wrapper = output.locator("svg g[transform]");
    await expect(wrapper.count()).resolves.toBe(1);
    await expect(wrapper.locator("text").count()).resolves.toBe(6);
    await expect(wrapper.locator("rect").count()).resolves.toBe(2);
    await expect(wrapper.locator("image").count()).resolves.toBe(0);
    const rgba = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
    const expected = await rgba(native);
    expect(expected.some((channel, index) => index % 4 === 3 && channel === 255)).toBe(true);
    expect((await rgba(await output.screenshot({ omitBackground: true }))).equals(expected)).toBe(true);
  } finally {
    await page.close();
    await output.close();
  }
});

it.each([
  { mode: "fractional projected background", owner: "transform-origin:6px 8.25px", member: "outline:none" },
  { mode: "fractional projected outer outline", owner: "", member: "outline-width:2px" },
  { mode: "wrapped multi-box inline", owner: "width:72px", member: "display:inline" },
  { mode: "a second transform owner", owner: "", member: "transform:scale(.75,1.125)" },
  { mode: "unsupported gradient paint", owner: "", member: "background-image:linear-gradient(red,blue)" },
  { mode: "unsupported translucent paint", owner: "", member: "background:rgba(232,78,31,.5)" },
  { mode: "unsupported reflected paint", owner: "", member: "-webkit-box-reflect:below 2px" },
  { mode: "a replaced producer", owner: "", member: "", child: '<input type="checkbox" checked style="">' },
])("uses the existing text route for $mode", async ({ owner, member, child }) => {
  const page = await browser.newPage({ viewport });
  try {
    await fixture(page, owner, member, child);
    const before = await sourceEvidence(page);
    const [captured] = await captureElementTree(page, "body", viewport);
    expect(captured.styles.transformPaintShift).toBeUndefined();
    const after = await sourceEvidence(page);
    expect(Number(after.effects)).toBeGreaterThan(0);
    expect({ ...after, effects: before.effects, styleWrites: before.styleWrites }).toEqual(before);
  } finally {
    await page.close();
  }
});

it("discards an authenticated inline-block frame when paint changes during the final walk", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await fixture(page);
    const spy = observeLiveTextCaptures(page, {
      async afterCapture({ transport, preparation }) {
        if (transport === "shadow carrier" && !preparation)
          await page.evaluate(() => {
            document.getElementById("member")!.style.outlineWidth = "2px";
          });
      },
    });
    try {
      const [captured] = await captureElementTree(page, "body", viewport);
      expect(spy.attempts.filter(({ preparation }) => !preparation)).toEqual([
        { transport: "shadow carrier", preparation: false },
        { transport: "Playwright", preparation: false },
      ]);
      expect(captured.styles.transformPaintShift).toBeUndefined();
      expect(captured.children[0].styles.outlineWidth).toBe("2px");
    } finally {
      spy.restore();
    }
  } finally {
    await page.close();
  }
});

it("requires topology authority for the actual inline-block text member as well as its owner", async () => {
  const page = await browser.newPage({ viewport });
  try {
    await fixture(page);
    const assigned = await page.evaluate(() => {
      const member = document.getElementById("member")!;
      const root = member.attachShadow({ mode: "closed" });
      root.innerHTML = '<div style="contain:layout style"><slot></slot></div>';
      return root.querySelector("slot")!.assignedNodes()[0] === member.firstChild && member.shadowRoot == null;
    });
    expect(assigned).toBe(true);
    const spy = observeLiveTextCaptures(page);
    try {
      const [captured] = await captureElementTree(page, "body", viewport);
      expect(spy.attempts.some(({ transport }) => transport === "shadow carrier")).toBe(false);
      expect(captured.styles.transformPaintShift).toBeUndefined();
      expect(captured.children[0].text).toContain("quick world");
    } finally {
      spy.restore();
    }
  } finally {
    await page.close();
  }
});
