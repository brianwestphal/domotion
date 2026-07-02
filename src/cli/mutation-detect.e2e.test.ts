/**
 * DM-1564 (docs/94 option 3): MutationObserver JS-change harness — real-Chromium
 * round-trip. Proves the thing `forceState` (CSS pseudo-state forcing) cannot do:
 * detect and reveal a page's JAVASCRIPT-driven feedback — here a `mouseover`
 * handler that INJECTS a dropdown menu and flips `aria-expanded`. The unit twin
 * (`mutation-detect.test.ts`) covers the pure spec defaulting.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { composeAnimateConfig, launchChromium, validateAnimateConfig } from "../index.js";
import { buildJsRevealAnimation, detectJsMutations, resolveJsRevealSpec } from "./mutation-detect.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

// A JS dropdown: mouseover on #trigger injects a .menu node + sets aria-expanded.
// #inert reacts to nothing (the no-mutation control).
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{background:#fff;height:260px;font-family:sans-serif;padding:24px}
  #trigger{padding:8px 12px;border:1px solid #ccc;border-radius:6px}
  .menu{position:absolute;top:60px;left:24px;width:180px;border:1px solid #ccc;background:#fff}
  .menu .item{padding:8px 10px}
</style></head><body>
  <button id="trigger" aria-expanded="false">Account</button>
  <span id="inert">inert</span>
  <script>
    var open = false;
    document.getElementById('trigger').addEventListener('mouseover', function () {
      if (open) return; open = true;
      this.setAttribute('aria-expanded', 'true');
      var m = document.createElement('div');
      m.className = 'menu';
      m.innerHTML = '<div class="item">Profile</div><div class="item">Sign out</div>';
      document.body.appendChild(m);
    });
  </script>
</body></html>`;

async function canLaunch(): Promise<Browser | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await canLaunch();

const dir = mkdtempSync(join(tmpdir(), "domotion-js-reveal-"));
const htmlPath = join(dir, "menu.html");
writeFileSync(htmlPath, PAGE);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (browser) await closeBrowserSafely(browser);
});

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("MutationObserver JS-change harness (DM-1564)", () => {
  it("detects the JS-injected node + aria change after mouseover", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 260 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      const summary = await detectJsMutations(page, resolveJsRevealSpec({ selector: "#trigger" }));
      expect(summary.changed).toBe(true);
      expect(summary.structural).toBe(true); // a node was ADDED (the menu)
      expect(summary.addedNodes).toBeGreaterThanOrEqual(1);
      expect(summary.attributes).toBeGreaterThanOrEqual(1); // aria-expanded flip
      // The injected menu really is in the live DOM now (the harness leaves it).
      expect(await page.locator(".menu .item").count()).toBe(2);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("reports no change (and times out) when the element's JS does nothing", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 260 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      const summary = await detectJsMutations(page, resolveJsRevealSpec({ selector: "#inert", settleMs: 250 }));
      expect(summary.changed).toBe(false);
      expect(summary.structural).toBe(false);
      expect(summary.reason).toBe("timeout");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("throws when the jsReveal selector matches nothing", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 260 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      await expect(detectJsMutations(page, resolveJsRevealSpec({ selector: ".nope" }))).rejects.toThrow(
        /jsReveal selector "\.nope" matched no element/,
      );
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("composes a rest→after crossfade when the DOM mutated", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 260 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      const res = await buildJsRevealAnimation(page, resolveJsRevealSpec({ selector: "#trigger", holdMs: 500, crossfadeMs: 200 }), {
        width: 400, height: 260, framePrefix: "jr0_", log: () => {},
      });
      expect(res.summary.structural).toBe(true);
      expect(res.svgContent).not.toMatch(/^<\?xml/);
      expect(res.svgContent).toContain("jr0_f-1"); // the after state
      expect(res.svgContent).toMatch(/@keyframes jr0_fv-1/); // rest→after crossfade
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("emits a single still state when nothing mutated (no invented crossfade)", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 260 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      const res = await buildJsRevealAnimation(page, resolveJsRevealSpec({ selector: "#inert", settleMs: 250, holdMs: 500 }), {
        width: 400, height: 260, framePrefix: "jr0_", log: () => {},
      });
      expect(res.summary.changed).toBe(false);
      expect(res.svgContent).not.toContain("jr0_f-1"); // only the rest state, no after
      expect(res.periodMs).toBe(500); // just holdMs
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("the animate config path nests the JS-reveal crossfade in a single frame", async () => {
    const cfg = validateAnimateConfig({
      width: 400,
      height: 260,
      frames: [{ input: htmlPath, duration: 2000, jsReveal: { selector: "#trigger", holdMs: 700, crossfadeMs: 300 } }],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(1); // one outer frame
    expect((svg.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(svg).toMatch(/@keyframes jr0_fv-1/);
  }, 120_000);
});
