import type { Browser, CDPSession, Page } from "@playwright/test";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { captureElementTree, launchChromium } from "../src/capture/index.js";
import { elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { screenshotAfterPresentedFrame } from "../src/test-support/presented-frame-screenshot.js";

const viewport = { x: 0, y: 0, width: 100, height: 90 };
let browser: Browser;
let png: string;
beforeAll(async () => {
  browser = await launchChromium();
  const palette = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0];
  png = `data:image/png;base64,${await sharp(Buffer.from([...palette, ...palette, ...palette, ...palette]), {
    raw: { width: 4, height: 4, channels: 3 },
  })
    .png()
    .toBuffer()
    .then((bytes) => bytes.toString("base64"))}`;
});
afterAll(() => closeBrowserSafely(browser), 15_000);

async function setup(page: Page, image: boolean, hiddenReset: boolean) {
  const member = image ? `<img id="member" src="${png}">` : `<div id="box-host"><div id="member"></div></div>`;
  await page.setContent(`<!doctype html><style>
    html,body{margin:0}
    #owner{position:absolute;left:20.5px;top:20.25px;width:24px;height:18px;transform-origin:0 0;
      animation:sample 2s -1s linear both paused}
    @keyframes sample {from{transform:scale(1.5,2.5)}to{transform:scale(2.5,3.5)}}
    #box-host{position:absolute;inset:0}
    #member{position:absolute;display:block;left:3.375px;top:3.375px;width:4px;height:4px;
      overflow:visible;object-fit:fill;${image ? "" : "background:red"}}
    </style><div id="owner">${member}</div>`);
  const witness = await page.evaluate(async (closed) => {
    const owner = document.getElementById("owner")!;
    const member = document.getElementById("member")!;
    const host = member.parentElement!;
    let assigned = false;
    if (closed) {
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>#hidden{position:absolute;left:1.375px;top:1.625px;width:17px;height:12px;
        contain:layout style}</style><div id="hidden"><slot></slot></div>`;
      assigned = root.querySelector("slot")!.assignedElements()[0] === member;
    }
    if (member instanceof HTMLImageElement) await member.decode();
    await Promise.all(owner.getAnimations().map((animation) => animation.ready));
    return { assigned, publicShadow: host.shadowRoot != null, publicSlot: member.assignedSlot != null };
  }, hiddenReset);
  expect(witness).toEqual({ assigned: hiddenReset, publicShadow: false, publicSlot: false });
}

const pixels = async (page: Page) =>
  sharp(await screenshotAfterPresentedFrame(page, { omitBackground: true }))
    .ensureAlpha()
    .raw()
    .toBuffer();

async function readAuthorState(page: Page) {
  return page.locator("#owner").evaluate((owner) => ({
    css: getComputedStyle(owner).transform,
    inline: owner.getAttribute("style"),
    animations: owner
      .getAnimations()
      .map(({ playState, currentTime, playbackRate }) => [playState, currentTime, playbackRate]),
  }));
}

it.each([
  { type: "box", image: false },
  { type: "source PNG", image: true },
])("uses the live-rect fallback for a $type beneath an actual closed slot", async ({ image }) => {
  const page = await browser.newPage({ viewport });
  const output = await browser.newPage({ viewport });
  try {
    await setup(page, image, false);
    const flatPixels = await pixels(page);
    const flatState = await readAuthorState(page);
    const flat = await captureElementTree(page, "body", viewport);
    expect(await readAuthorState(page)).toEqual(flatState);
    expect(flat[0].styles.transformPaintShift).toEqual([0.5, -0.25]);
    await output.setContent(
      `<!doctype html><style>body{margin:0}</style>${elementTreeToSvg(flat, viewport.width, viewport.height)}`,
    );
    expect(await pixels(output)).toEqual(flatPixels);

    await setup(page, image, true);
    const native = await pixels(page);
    const nativeFirst = native.findIndex((value, offset) => offset % 4 === 3 && value === 255) / 4;
    expect(Math.floor(nativeFirst) % viewport.width).toBe(29);
    const before = await readAuthorState(page);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(await readAuthorState(page)).toEqual(before);
    expect(owner.styles.transform).toBe("none");
    expect(owner.styles.transformPaintShift).toBeUndefined();
    const [child] = owner.children;
    const member = image ? child : child.children[0];
    expect([member.x, member.y, member.width, member.height]).toEqual([30, 35.25, 8, 12]);
    expect(member.borderPaintSnap).toBeUndefined();
    expect(member.imagePaintBasis).toBeUndefined();
    if (image) expect(member.imageSrc).toBe(png);
  } finally {
    await page.close();
    await output.close();
  }
});

function interceptSourceProtocol(
  page: Page,
  hook: (send: CDPSession["send"], session: CDPSession, method: string, params?: object) => Promise<unknown>,
) {
  const context = page.context();
  const original = context.newCDPSession.bind(context);
  const sessions: Array<() => void> = [];
  const connect = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const session = await original(target);
    const send = session.send;
    const spy = vi
      .spyOn(session, "send")
      .mockImplementation(((method: string, params?: object) =>
        hook(send, session, method, params)) as CDPSession["send"]);
    sessions.push(() => spy.mockRestore());
    return session;
  });
  return () => {
    connect.mockRestore();
    for (const restore of sessions) restore();
  };
}

it("keeps live geometry when the pierced participant authority is unavailable", async () => {
  const page = await browser.newPage({ viewport });
  let denied = 0;
  const restore = interceptSourceProtocol(page, async (send, session, method, params) => {
    const expression = (params as { expression?: string } | undefined)?.expression;
    if (method === "Runtime.evaluate" && expression?.includes('"mode":"live-affine-boxes"')) {
      denied++;
      throw new Error("test denies live affine participant authority");
    }
    return Reflect.apply(send, session, [method, params]);
  });
  try {
    await setup(page, true, false);
    const [owner] = await captureElementTree(page, "body", viewport);
    expect(denied).toBe(1);
    expect(owner.styles.transform).toBe("none");
    expect(owner.children[0].imagePaintBasis).toBeUndefined();
  } finally {
    restore();
    await page.close();
  }
});

it("rejects a transient participant change after the live affine capture instead of retrying it", async () => {
  const page = await browser.newPage({ viewport });
  let captures = 0;
  const restore = interceptSourceProtocol(page, async (send, session, method, params) => {
    const value: unknown = await Reflect.apply(send, session, [method, params]);
    const declaration = (params as { functionDeclaration?: string } | undefined)?.functionDeclaration;
    if (method === "Runtime.callFunctionOn" && declaration?.includes('"liveAffineBoxes":admin')) {
      captures++;
      await page.evaluate(() => {
        const owner = document.getElementById("owner")!;
        const entrant = document.createElement("i");
        owner.append(entrant);
        entrant.remove();
      });
    }
    return value;
  });
  try {
    await setup(page, true, false);
    await expect(captureElementTree(page, "body", viewport)).rejects.toThrow("author-shadow adopted context changed");
    expect(captures).toBe(1);
  } finally {
    restore();
    await page.close();
  }
});
