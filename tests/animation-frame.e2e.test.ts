import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { seekAnimationsToFrame } from "../src/capture/animation-frame.js";

describe("stable multi-document CSS/SMIL frame seeking (DM-2359)", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it("pauses the top document and a same-origin frame at one exact time", async () => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      @keyframes move { from { transform: translateX(0) } to { transform: translateX(100px) } }
      #box { animation: move 1s linear infinite }
    </style><div id="box"></div>
    <svg id="smil" width="20" height="20"><rect width="10" height="10"><animate attributeName="x" from="0" to="10" dur="1s" repeatCount="indefinite"/></rect></svg>
    <iframe srcdoc="<style>@keyframes fade{from{opacity:0}to{opacity:1}}i{animation:fade 1s linear infinite}</style><i>x</i>"></iframe>`);
    await page.locator("iframe").contentFrame().locator("i").waitFor();

    const state = await seekAnimationsToFrame(page, 375, { strict: true, includeChildFrames: true });
    expect(state.documents).toHaveLength(2);
    expect(state.animationCount).toBe(2);
    expect(state.smilTimelineCount).toBe(1);
    expect(state.documents.every((documentState) => documentState.failures.length === 0)).toBe(true);

    const top = await page.evaluate(() => ({
      cssTime: Number(document.getAnimations()[0]?.currentTime),
      cssState: document.getAnimations()[0]?.playState,
      smilTime: document.querySelector("svg")!.getCurrentTime(),
    }));
    expect(top.cssTime).toBe(375);
    expect(top.cssState).toBe("paused");
    expect(top.smilTime).toBeCloseTo(0.375, 3);
    const child = await page.locator("iframe").contentFrame().locator("i").evaluate(() => ({
      time: Number(document.getAnimations()[0]?.currentTime),
      state: document.getAnimations()[0]?.playState,
    }));
    expect(child).toEqual({ time: 375, state: "paused" });
    await page.close();
  });

  it("rejects invalid frame times before touching the page", async () => {
    const page = await browser.newPage();
    await expect(seekAnimationsToFrame(page, Number.NaN, { strict: true })).rejects.toThrow(/finite non-negative/);
    await page.close();
  });
});
