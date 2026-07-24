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
