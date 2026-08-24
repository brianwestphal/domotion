import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureElementTreeWithWarnings,
  installCaptureRafClock,
} from "../src/capture/index.js";
import { reverifyAnimationsAtFrame, seekAnimationsToFrame } from "../src/capture/animation-frame.js";
import { prepareReplacedMediaFrameTransaction } from "../src/capture/replaced-media-frame.js";
import { reverifyCaptureRafClock, sampleCaptureRafClock, type CaptureRafClockHandle } from "../src/capture/raf-clock.js";
import type { CapturedElement } from "../src/capture/types.js";

const VIDEO_WEBM = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAWLEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggV17AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYhCEDzwoSurnZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhB3NZQDgkLCBILqBGJqBAlW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIQhA88KErq51nyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1Q8nngQCjQwiBAACAcBcAnQEqIAAYAABHCIWFiIWEiAICAnW6JMG+K/i7+t38B6HjQXth+u2UE+A/hP8+/F3/QbxF9mfAB/RX+u+zx/Af5z1gP6KeoD/AesB/hn8l9Dn9M/gB/VH+n+4D/C/5L96V4g5HH1A8zPVCfIvyK/ED2M/oB4gP8P/JD8kqAB/tP4zbID/Af7Z/Af2M9kH90/FX+gegD/VfyA+gr+LfxP+mflL/Xf//ykX6xe19fCoDw93xx9pZGrtopVDo74B+H/ZFc9D+//hOeoR/9bne8e//mBb49CxYXX9t3wJOM8K2RtX8/lDFQAYW48dTeS1QfZo9AjLIq1yla3IYd/81w4YUlTg7bY+JymHUiR2ejh3N6ffaOmnmDD3DEPXNxaTzcf7MH/oVKRA+gCOta+zV1//bRg3AwQEyDrP8wLLjQ4KlEW1Ez8h5+pGUVamaGq/1wqV3/6fzE6ukjJLzv5gBTJjBJAxc5rwXJ1lw4Ct9sZf+fwsFelS5MW/a+BXxP8ATLKkUkf/7RcTBawOpBwA9Fb9f7Zz0mALIY2pcf83oOPpImr1i/zZO2R//RIJ4PzhneiIM//dLyCri/8C+qnOZ/9qeldKsF01xoXitP9k9aW49PFf3bqyKP9PuiT/O0yCYL9G6Z//n5mKWdWIQ73nocHhP5ILW2y4sTHYvzz/88AI7h7/UpC8Nw7WR//N0jIo125ufYL0bIZ0mvecVqZ1GJF39DFdEk0UHXkUhIrQsa/9736R2ycO2cR5Z4Rf+qyC1eJEoMmLQvFdOJMwhsm2BMY//7+F1mlRwoGPU5tUkFC+uRUbBpugapqDMW0A16a9s+9xqWEhAFxQ8U1E2j3hc5Ywuxb0BDFkLtgf+s72GyERlbWK9/zLV5belH/6boU5NgOhugy/0sYds3n56rnnJw+8w1kSSCjUA1bo+kIjNWQkt0fSC+8wFGyNZyP4AvvMBRsjWcj+Af+vkDX7b+KgOETwZRnCmteTWRoyjOFNNP//2L6gp8Q/RaGn//7F9QU+IfotAAKNAuIEB9ACRAwABEBAAGAtvyhQ/d5mWX+PBHGBo5cM35SvamZAq/lx17KCNfchz9x6dlXnL9FCP1B+I2VYz3mg3d9A7BAypS+EW6rPnkq+vooAiGJD/7qVDjObcruK8Ru+e6pacaqf/uX/8H4/iia/nQqA/+YGE7/3CuCFHu2u84MmY4abnOf/+reTmqTLN0TrIMKucK/yqx0q+/+Of7mWVbi2Yj6WhjyrKdYk+yAKTn1y0IkQKcEtn5gAcU7trkbuPs4EAt4r3gQHxggGm8IED";
const viewport = { x: 0, y: 0, width: 180, height: 120 };

async function directTransaction(page: Page, handle: CaptureRafClockHandle) {
  const raf = await sampleCaptureRafClock(page, handle, 250);
  const animation = await seekAnimationsToFrame(page, 250, {
    strict: true,
    includeChildFrames: true,
    settleWithAnimationFrame: false,
  });
  await reverifyAnimationsAtFrame(page, animation, { includeChildFrames: true, settleWithAnimationFrame: false });
  await reverifyCaptureRafClock(page, handle, raf);
  return prepareReplacedMediaFrameTransaction(page, "body", viewport, animation, raf);
}

async function syntheticTree(page: Page, tag: "canvas" | "video"): Promise<CapturedElement[]> {
  const locator = page.locator(tag);
  await locator.evaluate((element) => element.setAttribute("data-domotion-rid", "dr0"));
  const box = await locator.boundingBox();
  if (box == null) throw new Error(`${tag} has no box`);
  const png = await locator.screenshot({ type: "png", omitBackground: true });
  return [{
    tag,
    styles: {},
    replacedSnapshot: {
      rid: "dr0",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      dataUri: `data:image/png;base64,${png.toString("base64")}`,
    },
  } as CapturedElement];
}

describe("atomic replaced-media capture transaction", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let handle: CaptureRafClockHandle;

  beforeEach(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 180, height: 120 } });
    handle = await installCaptureRafClock(context);
    page = await context.newPage();
  });

  afterEach(async () => {
    await browser.close();
  });

  it("screenshots every canvas/video owner in one stable epoch across repeated production captures", async () => {
    await page.setContent(`<canvas id=c width=80 height=80 style="position:fixed;left:0;top:0;width:80px;height:80px"></canvas>
      <video muted preload="auto" src="data:video/webm;base64,${VIDEO_WEBM}" style="position:fixed;left:90px;top:0;width:80px;height:80px"></video>`);
    await page.locator("#c").evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgb(32,96,192)";
      context.fillRect(0, 0, canvas.width, canvas.height);
    });
    const first = await captureElementTreeWithWarnings(page, "body", viewport, { animationTimeMs: 250, rafClock: handle });
    const second = await captureElementTreeWithWarnings(page, "body", viewport, { animationTimeMs: 250, rafClock: handle });
    const firstOwners = new Map(first.replacedMediaFrameState?.owners.map((owner) => [owner.kind, owner]));
    const secondOwners = new Map(second.replacedMediaFrameState?.owners.map((owner) => [owner.kind, owner]));
    expect([...firstOwners.keys()].sort()).toEqual(["canvas", "video"]);
    for (const kind of ["canvas", "video"] as const) {
      expect(firstOwners.get(kind)?.capturedByteDigest).toBe(secondOwners.get(kind)?.capturedByteDigest);
    }
    expect(firstOwners.get("canvas")?.frameEpoch).toBe(secondOwners.get("canvas")?.frameEpoch);
    expect(firstOwners.get("video")?.requestedTimeSeconds).toBe(0.25);
    expect(firstOwners.get("video")?.currentTimeSeconds).toBe(secondOwners.get("video")?.currentTimeSeconds);
    expect(firstOwners.get("video")?.frameEpoch).toMatch(/^video:\d+:0:32:24:presented$/);
    const capturedOwners = first.tree.flatMap((node) => [node, ...(node.children ?? [])])
      .map((node) => node.replacedSnapshot?.frameTransaction)
      .filter((owner) => owner != null);
    expect(capturedOwners).toEqual(first.replacedMediaFrameState?.owners);
  });

  it("fails closed when a canvas surface mutates after owner binding", async () => {
    await page.setContent("<canvas width=120 height=80 style='width:120px;height:80px'></canvas>");
    const transaction = await directTransaction(page, handle);
    try {
      const tree = await syntheticTree(page, "canvas");
      await transaction.bindCapturedOwners(tree);
      await page.locator("canvas").evaluate((node) => {
        const canvas = node as HTMLCanvasElement;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "red";
        context.fillRect(0, 0, 12, 12);
      });
      await expect(transaction.finalize(tree)).rejects.toThrow(/surfaceDigest/);
    } finally {
      await transaction.dispose();
    }
  });

  it("waits for a concrete video frame and rejects a hostile post-bind seek", async () => {
    await page.setContent(`<video muted preload="auto" src="data:video/webm;base64,${VIDEO_WEBM}" style="width:120px;height:80px"></video>`);
    const transaction = await directTransaction(page, handle);
    try {
      const tree = await syntheticTree(page, "video");
      await transaction.bindCapturedOwners(tree);
      await page.locator("video").evaluate((video) => { (video as HTMLVideoElement).currentTime = 0.75; });
      await expect(transaction.finalize(tree)).rejects.toThrow(/currentTimeSeconds|frameEpoch/);
    } finally {
      await transaction.dispose();
    }
  });

  it("rejects owner detachment and document replacement", async () => {
    await page.setContent("<canvas width=120 height=80 style='width:120px;height:80px'></canvas>");
    const detached = await directTransaction(page, handle);
    try {
      const tree = await syntheticTree(page, "canvas");
      await detached.bindCapturedOwners(tree);
      await page.locator("canvas").evaluate((node) => node.remove());
      await expect(detached.finalize(tree)).rejects.toThrow(/connected/);
    } finally {
      await detached.dispose();
    }

    await page.setContent("<canvas width=120 height=80 style='width:120px;height:80px'></canvas>");
    const navigated = await directTransaction(page, handle);
    const tree = await syntheticTree(page, "canvas");
    await navigated.bindCapturedOwners(tree);
    await page.goto("data:text/html,<main>replacement%20document</main>");
    await expect(navigated.finalize(tree)).rejects.toThrow(/transaction state|navigation/);
    await navigated.dispose();
  });

  it("rejects child-frame navigation even when the main document remains stable", async () => {
    await page.setContent(`<canvas width=120 height=80 style="width:120px;height:80px"></canvas>
      <iframe src="data:text/html,first"></iframe>`);
    await page.locator("iframe").waitFor();
    await expect.poll(() => page.frames().at(1)?.url()).toContain("first");
    const transaction = await directTransaction(page, handle);
    try {
      const tree = await syntheticTree(page, "canvas");
      await transaction.bindCapturedOwners(tree);
      await page.locator("iframe").evaluate((frame) => {
        (frame as HTMLIFrameElement).src = "data:text/html,second";
      });
      await expect.poll(() => page.frames().at(1)?.url()).toContain("second");
      await expect(transaction.finalize(tree)).rejects.toThrow(/frame navigation/);
    } finally {
      await transaction.dispose();
    }
  });
});
