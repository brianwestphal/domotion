/**
 * Event-based wait helpers for Playwright pages (DM-1009).
 *
 * Replaces fixed `page.waitForTimeout(N)` calls in the test runners with
 * waits that resolve on the actual condition they were buffering for —
 * fonts loaded, images loaded, next paint, network quiet. Faster on
 * average (resolves the moment the event fires, not at the worst-case
 * buffer end) AND less flaky (a buffer too short for a slow page produced
 * half-loaded screenshots; an event wait waits for the real signal).
 *
 * Pair `waitForSettled(page)` with `page.goto(...)` in place of the
 * `goto(); waitForTimeout(N);` idiom — it composes fonts + images +
 * paint into one call that returns as soon as everything is ready.
 */

import type { Page } from "@playwright/test";

/** Wait for all `@font-face` fonts on the page to finish loading. Uses
 *  the CSS Font Loading API (`document.fonts.ready`), which Chromium
 *  supports natively. Resolves immediately when no `@font-face` rules
 *  are present. */
export async function waitForFontsReady(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/** Wait for every `<img>` and SVG `<image>` element in the document to
 *  finish loading (either success or error — broken refs don't hang the
 *  wait). Resolves immediately when the page has no image elements.
 *
 *  The evaluate body is passed as a string rather than a TypeScript arrow
 *  function because tsx wraps named arrow functions with a `__name`
 *  runtime helper for debugging — that helper exists in Node but not in
 *  the browser context, so the evaluated function rejects with
 *  `ReferenceError: __name is not defined`. Using a string keeps the body
 *  literal and avoids the transform entirely. */
export async function waitForImagesComplete(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const els = [].concat(
      Array.from(document.querySelectorAll('img')),
      Array.from(document.querySelectorAll('image'))
    );
    return Promise.all(els.map(function (el) {
      if (typeof el.complete === 'boolean' && el.complete) return undefined;
      return new Promise(function (resolve) {
        el.addEventListener('load', function () { resolve(); }, { once: true });
        el.addEventListener('error', function () { resolve(); }, { once: true });
      });
    }));
  })()`);
}

/** Wait for the next browser paint after layout settles. Two
 *  `requestAnimationFrame` calls — the first lets style/layout reflow
 *  resolve, the second hits the next paint after that reflow. Useful
 *  after DOM mutations or scroll events. */
export async function waitForNextPaint(page: Page): Promise<void> {
  await page.evaluate(`new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resolve(); });
    });
  })`);
}

/** Composite "page is fully settled" wait — fonts ready + images
 *  complete + next paint. Use after `page.goto(...)` in place of a
 *  fixed `waitForTimeout(N)` buffer. Set `networkIdle: true` for
 *  real-world pages whose load chain depends on XHR / fetch (ads,
 *  analytics, lazy-loaded sections); local-file fixtures don't need it.
 *
 *  Every step is bounded by `timeoutMs` (default 5000) so a broken font
 *  / image load can't hang the test indefinitely — we still capture the
 *  page after the timeout, accepting a small risk of half-loaded
 *  content over a definite hang. */
export async function waitForSettled(page: Page, opts?: { networkIdle?: boolean; timeoutMs?: number }): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const guard = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await Promise.race([
        p,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
      ]);
    } catch {
      return undefined;
    }
  };
  if (opts?.networkIdle === true) {
    await guard(page.waitForLoadState("networkidle", { timeout: timeoutMs }));
  }
  await guard(waitForFontsReady(page));
  await guard(waitForImagesComplete(page));
  await guard(waitForNextPaint(page));
}
