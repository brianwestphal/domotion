import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { reverifyAnimationsAtFrame, seekAnimationsToFrame } from "../src/capture/animation-frame.js";

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

  it("holds document and open-shadow progress timelines at their exact percentages", async () => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><style>
      #scroller { width:120px; height:80px; overflow:auto }
      #space { height:480px }
    </style><div id="scroller"><div id="target">x</div><div id="view">view</div><svg width="80" height="40"><rect id="svg-view" x="3" y="3" width="30" height="20"/></svg><div id="space"></div></div><div id="host"></div>`);
    const supported = await page.evaluate(async () => {
      if (typeof ScrollTimeline !== "function" || typeof CSS?.percent !== "function") return false;
      const scroller = document.querySelector<HTMLElement>("#scroller")!;
      const target = document.querySelector<HTMLElement>("#target")!;
      scroller.scrollTop = 137;
      target.animate([{ opacity: .2 }, { opacity: .8 }], {
        duration: 1,
        fill: "both",
        timeline: new ScrollTimeline({ source: scroller, axis: "block" }),
      });
      document.querySelector<HTMLElement>("#view")!.animate([{ opacity: .2 }, { opacity: .8 }], {
        duration: 1, fill: "both", timeline: new ViewTimeline({ subject: document.querySelector<HTMLElement>("#view")!, axis: "block" }),
      });
      document.querySelector<SVGGraphicsElement>("#svg-view")!.animate([{ opacity: .2 }, { opacity: .8 }], {
        duration: 1, fill: "both", timeline: new ViewTimeline({ subject: document.querySelector<SVGGraphicsElement>("#svg-view")!, axis: "block" }),
      });
      const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
      shadow.innerHTML = `<i>shadow</i>`;
      shadow.querySelector("i")!.animate([{ opacity: .1 }, { opacity: .9 }], {
        duration: 1,
        fill: "both",
        timeline: new ScrollTimeline({ source: scroller, axis: "block" }),
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return true;
    });
    if (!supported) {
      await page.close();
      return;
    }

    const before = await page.evaluate(() => {
      const shadow = document.querySelector("#host")!.shadowRoot! as unknown as { getAnimations(): Animation[] };
      return [document.getAnimations()[0].currentTime!.toString(), shadow.getAnimations()[0].currentTime!.toString()];
    });
    const state = await seekAnimationsToFrame(page, 375, { strict: true });
    expect(state.documents[0]).toMatchObject({
      animationCount: 4,
      documentTimelineCount: 0,
      progressTimelineCount: 4,
      treeScopeCount: 2,
      failures: [],
    });
    expect(state.documents[0].progressTimelines).toHaveLength(4);
    for (const timeline of state.documents[0].progressTimelines) {
      expect(timeline.axis).toBe("block");
      expect(timeline.committed).toBe(true);
      expect(JSON.parse(timeline.sourceSnapshot)).toMatchObject({
        axis: "block",
        scrollTop: 137,
        writingMode: "horizontal-tb",
        direction: "ltr",
      });
    }
    const subjectBranches = state.documents[0].progressTimelines
      .map((timeline) => JSON.parse(timeline.sourceSnapshot).subject?.branch)
      .filter(Boolean).sort();
    expect(subjectBranches).toEqual(["html-stitched-size", "svg-mapped-bounds"]);
    const after = await page.evaluate(() => {
      const shadow = document.querySelector("#host")!.shadowRoot! as unknown as { getAnimations(): Animation[] };
      return [document.getAnimations()[0], shadow.getAnimations()[0]].map((animation) => ({
        time: animation.currentTime!.toString(),
        state: animation.playState,
      }));
    });
    expect(after.map((entry) => entry.time)).toEqual(before);
    expect(after.every((entry) => entry.state === "paused" || entry.state === "finished")).toBe(true);
    await page.evaluate(() => { document.querySelector<HTMLElement>("#scroller")!.scrollTop += 11; });
    await expect(reverifyAnimationsAtFrame(page, state)).rejects.toThrow(/changed between capture prepasses/);
    await page.close();
  });

  it("fails before mutation when a closed TreeScope cannot be enumerated", async () => {
    const page = await browser.newPage();
    await page.setContent(`<style>@keyframes fade{from{opacity:.2}to{opacity:.8}}#box{animation:fade 10s linear infinite}</style><div id="box"></div><div id="host"></div>`);
    await page.evaluate(() => {
      const shadow = document.querySelector("#host")!.attachShadow({ mode: "closed" });
      shadow.innerHTML = `<i>closed</i>`;
    });
    await page.waitForTimeout(20);
    const before = await page.evaluate(() => ({
      state: document.getAnimations()[0].playState,
      time: Number(document.getAnimations()[0].currentTime),
    }));
    await expect(seekAnimationsToFrame(page, 375, { strict: true })).rejects.toThrow(/closed shadow TreeScope/);
    const after = await page.evaluate(() => ({
      state: document.getAnimations()[0].playState,
      time: Number(document.getAnimations()[0].currentTime),
    }));
    expect(before.state).toBe("running");
    expect(after.state).toBe("running");
    expect(after.time).toBeGreaterThanOrEqual(before.time);
    expect(after.time).not.toBe(375);
    await page.close();
  });
});
