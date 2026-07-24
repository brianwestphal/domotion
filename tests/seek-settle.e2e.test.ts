/**
 * DM-1781 regression guard for `seekTo`.
 *
 * A CSS animation only joins the document timeline at its first style recalc.
 * `seekTo` enumerates `document.getAnimations()` to pause + seek, so on a
 * document seeked IMMEDIATELY after load that enumeration could come back
 * incomplete — the animations it missed kept free-running at wall-clock time and
 * the first sampled state landed a frame off. That produced a parity flake at
 * STATE 0 only (every later state is seeked on an already-rendered page).
 *
 * The fix lets the document render one frame before enumerating, ONCE per
 * document. These tests pin both halves of that contract: the enumeration is
 * complete on a just-loaded page, and the once-per-document marker resets for a
 * fresh document so a reused page still settles.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { loadSeekableSvg } from "./flipbook-parity.js";

// An infinite animation: if `seekTo` misses it, it keeps running at wall-clock
// time and its playState stays "running" — which is exactly what we assert on.
const HTML = `<!doctype html><html><body style="margin:0">
<style>
  @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(400px); } }
  .box { width: 50px; height: 50px; background: #333; animation: slide 2s linear infinite; }
</style>
<div class="box"></div><div class="box"></div>
</body></html>`;

const settledMarker = (): boolean =>
  (document.documentElement as unknown as { __domotionSeekSettled?: boolean }).__domotionSeekSettled === true;

describe("seekTo settles the document before enumerating animations (DM-1781)", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it("pauses and seeks every animation even when seeked immediately after setContent", async () => {
    const page = await browser.newPage();
    // Deliberately NO settle here — reproducing the flake's exact conditions is
    // the whole point, so the guard must not paper over it from the test side.
    await page.setContent(HTML, { waitUntil: "domcontentloaded" });
    await seekTo(page, 500);

    const states = await page.evaluate(() =>
      document.getAnimations().map((a) => ({ playState: a.playState, currentTime: Number(a.currentTime) })));

    expect(states.length).toBe(2);
    for (const s of states) {
      expect(s.playState).toBe("paused");
      expect(s.currentTime).toBe(500);
    }
    await page.close();
  });

  it("settles once per DOCUMENT — and a fresh document settles again", async () => {
    const page = await browser.newPage();
    await page.setContent(HTML, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(settledMarker)).toBe(false);

    await seekTo(page, 100);
    expect(await page.evaluate(settledMarker)).toBe(true);

    // Reusing the page with new content is a NEW document (new documentElement),
    // so the marker must be gone and the next seek must settle it again —
    // otherwise a reused page would silently regress to the unsettled path.
    await page.setContent(HTML, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(settledMarker)).toBe(false);

    await seekTo(page, 250);
    const states = await page.evaluate(() =>
      document.getAnimations().map((a) => ({ playState: a.playState, currentTime: Number(a.currentTime) })));
    expect(states.length).toBe(2);
    for (const s of states) {
      expect(s.playState).toBe("paused");
      expect(s.currentTime).toBe(250);
    }
    await page.close();
  });
});

/**
 * DM-1779 regression guard for `loadSeekableSvg`.
 *
 * The compressor-parity flake at state 0 was NOT a timeline race: `seekTo`
 * parks every animation correctly. It was that under contention the animation
 * free-runs FORWARD past state 0 before the first seek, and seeking it BACK
 * leaves a stable, torn frame. `loadSeekableSvg` pins `animation-play-state:
 * paused` from load so the animation never advances and every seek is
 * forward-only. These tests pin that contract deterministically: the page must
 * NOT free-run (a plain setContent does, which is the whole point), and the
 * pause must not break forward seeking.
 */
describe("loadSeekableSvg pins animations paused so they never free-run (DM-1779)", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  const ANIM = `<style>
    @keyframes slide { from { transform: translateX(0px); } to { transform: translateX(400px); } }
    .box { width: 50px; height: 50px; background: #333; animation: slide 2s linear infinite; }
  </style><div class="box"></div>`;

  it("keeps animations at currentTime 0 across a delay — a plain setContent free-runs", async () => {
    const pinned = await browser.newPage();
    await loadSeekableSvg(pinned, ANIM);
    await pinned.waitForTimeout(300); // a free-running animation would reach ~300ms here
    const pinnedCts = await pinned.evaluate(() =>
      document.getAnimations().map((a) => Number(a.currentTime)));
    expect(pinnedCts.length).toBe(1);
    expect(pinnedCts[0]).toBeLessThan(50); // pinned at ~0, did NOT advance

    // Contrast: the exact same markup loaded WITHOUT the pin free-runs forward —
    // this is the condition that, followed by a backward seek, tore the frame.
    const plain = await browser.newPage();
    await plain.setContent(`<!doctype html><html><body style="margin:0">${ANIM}</body></html>`, { waitUntil: "domcontentloaded" });
    await plain.waitForTimeout(300);
    const plainCts = await plain.evaluate(() =>
      document.getAnimations().map((a) => Number(a.currentTime)));
    expect(plainCts[0]).toBeGreaterThan(100); // free-ran forward

    await pinned.close();
    await plain.close();
  });

  it("still seeks FORWARD to the correct time under the pause", async () => {
    const page = await browser.newPage();
    await loadSeekableSvg(page, ANIM);
    await seekTo(page, 500);
    const states = await page.evaluate(() =>
      document.getAnimations().map((a) => ({ playState: a.playState, currentTime: Number(a.currentTime) })));
    expect(states.length).toBe(1);
    expect(states[0].playState).toBe("paused");
    expect(states[0].currentTime).toBe(500);
    await page.close();
  });
});
