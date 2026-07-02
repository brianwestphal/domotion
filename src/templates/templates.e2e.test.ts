import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { renderTemplateToSvg, validateTemplateParams } from "./render.js";
import { resolveFormat } from "./formats.js";
import { lowerThirdTemplate, buildLowerThirdHtml } from "./builtin/lower-third.js";
import { deviceMockupTemplate } from "./builtin/device-mockup.js";
import { backgroundLoopTemplate } from "./builtin/background-loop.js";
import { kineticTextTemplate } from "./builtin/kinetic-text.js";
import { chartTemplate, buildChartHtml, planChart } from "./builtin/chart.js";
import { chatTemplate } from "./builtin/chat.js";
import { subscribeTemplate } from "./builtin/subscribe.js";
import { counterTemplate } from "./builtin/counter.js";

/**
 * DM-1276: end-to-end render of both built-in templates through the real
 * capture/compose pipeline — the generator path (lower-third) and the decorator
 * path (device-mockup, which captures a page then wraps it in a bezel). Proves
 * the Template contract drives the existing pipeline and produces a valid SVG.
 */

let browser: Awaited<ReturnType<typeof launchChromium>> | undefined;
const work = mkdtempSync(join(tmpdir(), "domotion-tmpl-e2e-"));

async function getBrowser(): Promise<Awaited<ReturnType<typeof launchChromium>>> {
  if (browser == null) browser = await launchChromium();
  return browser;
}

afterAll(async () => {
  await closeBrowserSafely(browser);
  rmSync(work, { recursive: true, force: true });
});

describe("template render end-to-end (DM-1276)", () => {
  it("lower-third (generator) renders an animated SVG containing the title + reveal animation", async () => {
    const out = await renderTemplateToSvg(
      lowerThirdTemplate,
      { title: "Ada Lovelace", subtitle: "First Programmer", accent: "#22d3ee", width: 800, height: 450 },
      { browser: await getBrowser() },
    );
    expect(out.width).toBe(800);
    expect(out.height).toBe(450);
    expect(out.svg).toContain("<svg");
    expect(out.svg).toContain("</svg>");
    // The reveal is a real intra-frame animation, not baked into the capture.
    expect(out.svg).toMatch(/@keyframes/);
    expect(out.svg).toMatch(/Ada Lovelace|<path|<use/); // text as <text> or glyph paths
  }, 60_000);

  it("device-mockup (decorator) captures a page and grows the output by the chrome bar", async () => {
    const htmlPath = join(work, "page.html");
    writeFileSync(
      htmlPath,
      `<!doctype html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif"><h1>Hello Mockup</h1></body></html>`,
    );
    const out = await renderTemplateToSvg(
      deviceMockupTemplate,
      { input: htmlPath, device: "browser", label: "example.dev", width: 600, height: 360 },
      { browser: await getBrowser() },
    );
    // Browser bezel adds a 44px chrome bar on top only (width unchanged).
    expect(out.width).toBe(600);
    expect(out.height).toBe(404);
    expect(out.svg).toContain("<svg");
    expect(out.svg).toContain("</svg>");
    // The chrome bar's URL label is painted into the bezel.
    expect(out.svg).toContain("example.dev");
    // The captured page content survives nesting (static SVG nests cleanly).
    expect(out.svg).toMatch(/Hello Mockup|<path|<use/);
  }, 60_000);

  it("device-mockup phone at a reel format sizes the inner screen 9:16 + wraps a SCALED bezel (DM-1559)", async () => {
    const htmlPath = join(work, "reel-page.html");
    writeFileSync(
      htmlPath,
      `<!doctype html><html><body style="margin:0;background:#0d1117;color:#fff;font-family:sans-serif"><h1>Reel Screen</h1></body></html>`,
    );
    const reel = resolveFormat("reel"); // 1080×1920 screen (applyFormatSize sets width/height)
    const out = await renderTemplateToSvg(
      deviceMockupTemplate,
      { input: htmlPath, device: "phone", mobile: true, width: reel.width, height: reel.height },
      { browser: await getBrowser(), safeInset: reel.safeInset },
    );
    // The format sized the inner SCREEN (1080×1920); the phone bezel is computed
    // AROUND it and scales with the screen (rim ~39px, not the 14px tuned for a
    // ~390-wide phone), so the output is 1158×1998 and reads as a phone.
    expect(out.width).toBe(1158);
    expect(out.height).toBe(1998);
    expect(out.svg).toContain(`viewBox="0 0 1158 1998"`);
    expect(out.svg).toContain('rx="155" fill="#1c1c1e"'); // scaled body corner radius
    expect(out.svg).toMatch(/<svg x="39" y="39" width="1080" height="1920"/); // screen at scaled rim
    expect(out.svg).toMatch(/Reel Screen|<path|<use/); // captured content survives nesting
  }, 60_000);

  it("background-loop (generator) renders a looping animated background of blobs", async () => {
    const out = await renderTemplateToSvg(
      backgroundLoopTemplate,
      { variant: "aurora", count: 4, width: 640, height: 360, seed: 2 },
      { browser: await getBrowser() },
    );
    expect([out.width, out.height]).toEqual([640, 360]);
    expect(out.svg).toContain("<svg");
    expect(out.svg).toContain("</svg>");
    // Soft blobs are radial gradients; the loop is infinite + alternate.
    expect(out.svg).toMatch(/radialGradient/);
    expect(out.svg).toMatch(/infinite/);
    expect(out.svg).toMatch(/alternate/);
  }, 60_000);

  // DM-1285 / DM-1295: the non-blob variants render through the same pipeline.
  it("background-loop renders the gradient-pan, grid, and wave variants", async () => {
    const pan = await renderTemplateToSvg(
      backgroundLoopTemplate,
      { variant: "gradient-pan", colors: "#111,#abc,#fff", width: 640, height: 360 },
      { browser: await getBrowser() },
    );
    expect(pan.svg).toContain("<svg");
    expect(pan.svg).toMatch(/infinite/); // the continuous pan animation

    const grid = await renderTemplateToSvg(
      backgroundLoopTemplate,
      { variant: "grid", colors: ["#6366f1", "#ec4899"], width: 640, height: 360 },
      { browser: await getBrowser() },
    );
    expect(grid.svg).toContain("<svg");
    expect(grid.svg).toMatch(/infinite/);

    // DM-1298: wave is layered filled sine `<path>`s (parallax pan, no gradient).
    const wave = await renderTemplateToSvg(
      backgroundLoopTemplate,
      { variant: "wave", colors: "#6366f1,#22d3ee,#f59e0b", width: 640, height: 360 },
      { browser: await getBrowser() },
    );
    expect(wave.svg).toContain("<svg");
    expect(wave.svg).toMatch(/<path/);
    expect(wave.svg).toMatch(/infinite/);

    // DM-1298: stars is a sharp twinkling field (radial-gradient points).
    const stars = await renderTemplateToSvg(
      backgroundLoopTemplate,
      { variant: "stars", colors: ["#fff", "#7aa2f7"], width: 640, height: 360 },
      { browser: await getBrowser() },
    );
    expect(stars.svg).toContain("<svg");
    expect(stars.svg).toMatch(/infinite/);
  }, 60_000);

  it("kinetic-text (generator) reveals a headline with staggered per-word animations", async () => {
    const out = await renderTemplateToSvg(
      kineticTextTemplate,
      { text: "Ship faster", variant: "rise", width: 800, height: 360 },
      { browser: await getBrowser() },
    );
    expect([out.width, out.height]).toEqual([800, 360]);
    expect(out.svg).toContain("<svg");
    expect(out.svg).toContain("</svg>");
    // Two words → staggered reveal: opacity fade + translateY rise keyframes.
    expect(out.svg).toMatch(/@keyframes/);
    expect(out.svg).toMatch(/translateY/);
    // The headline text is present (as <text> or glyph paths).
    expect(out.svg).toMatch(/Ship|faster|<path|<use/);
  }, 60_000);

  it("chart (generator) renders a bar chart with grow animations + a line chart that draws in (DM-1279)", async () => {
    const col = await renderTemplateToSvg(
      chartTemplate,
      { type: "column", data: "42,68,90", labels: "A,B,C", title: "Demo", width: 700, height: 420 },
      { browser: await getBrowser() },
    );
    expect([col.width, col.height]).toEqual([700, 420]);
    expect(col.svg).toContain("<svg");
    expect(col.svg).toMatch(/@keyframes/);          // the staggered grow
    expect(col.svg).toMatch(/transform-box: fill-box/); // scaleY about the bar's bottom
    expect(col.svg).toMatch(/Demo/);                // the title

    const line = await renderTemplateToSvg(
      chartTemplate,
      { type: "line", data: [4, 8, 6, 12], width: 700, height: 420 },
      { browser: await getBrowser() },
    );
    expect(line.svg).toMatch(/<polyline|<path/);    // the inline-SVG line
    expect(line.svg).toMatch(/clip-path|inset/);    // the draw-in wipe

    // Multi-series stacked, with a legend + value-axis scale (DM-1301).
    const stacked = await renderTemplateToSvg(
      chartTemplate,
      { type: "column", data: [[20, 35], [15, 25]], labels: "Mon,Tue", seriesNames: "A,B", layout: "stacked", width: 700, height: 420 },
      { browser: await getBrowser() },
    );
    expect(stacked.svg).toMatch(/A|B|Mon|Tue|<path|<use/); // legend + labels rendered
    expect(stacked.svg).toMatch(/@keyframes/);             // stacks grow

    // Pie/donut: arc-path slices that sweep in (DM-1300).
    const donut = await renderTemplateToSvg(
      chartTemplate,
      { type: "donut", data: "50,30,20", labels: "A,B,C", title: "Share", width: 700, height: 420 },
      { browser: await getBrowser() },
    );
    expect(donut.svg).toMatch(/<path/);          // arc slices
    expect(donut.svg).toMatch(/@keyframes/);      // the spin/sweep
    expect(donut.svg).toMatch(/50%|A|B|C|<path|<use/); // legend with percentages
  }, 60_000);

  it("chat (generator) reveals a message thread with staggered pop-ins (DM-1278)", async () => {
    const out = await renderTemplateToSvg(
      chatTemplate,
      { messages: "them: Hi\nme: Hey!\nthem: 👋", title: "Sam", width: 500, height: 600 },
      { browser: await getBrowser() },
    );
    expect([out.width, out.height]).toEqual([500, 600]);
    expect(out.svg).toMatch(/@keyframes/);              // the staggered pop
    expect(out.svg).toMatch(/transform-box: fill-box/); // scale about the bubble corner
    expect(out.svg).toMatch(/Hey|Hi|Sam|<path|<use/);   // text present
    expect(out.svg).toMatch(/ct-dot|translateY/);        // the typing indicator's bouncing dots (DM-1302)
  }, 60_000);

  it("subscribe (generator) pops a card in with a pulsing CTA (DM-1278)", async () => {
    const out = await renderTemplateToSvg(
      subscribeTemplate,
      { name: "Domotion", subtitle: "1.2M subscribers", action: "Subscribe", width: 700, height: 340 },
      { browser: await getBrowser() },
    );
    expect([out.width, out.height]).toEqual([700, 340]);
    expect(out.svg).toMatch(/@keyframes/);
    expect(out.svg).toMatch(/infinite/);                // the looping CTA pulse
    expect(out.svg).toMatch(/Domotion|Subscribe|<path|<use/);

    // Click-through: the Subscribed second state is captured (not culled) so it
    // can cross-fade in (DM-1303).
    const click = await renderTemplateToSvg(
      subscribeTemplate,
      { name: "Domotion", subscribedLabel: "Subscribed", clickAfterMs: 1200, width: 700, height: 340 },
      { browser: await getBrowser() },
    );
    expect(click.svg).toMatch(/Subscribed|✓|<path|<use/);
    expect(click.durationMs).toBeGreaterThan(1200);     // runs through the click
  }, 60_000);

  it("phone bezel grows the output by an even rim on every side", async () => {
    const htmlPath = join(work, "phone.html");
    writeFileSync(htmlPath, `<!doctype html><html><body style="margin:0;background:#111"><p style="color:#fff">x</p></body></html>`);
    const out = await renderTemplateToSvg(
      deviceMockupTemplate,
      { input: htmlPath, device: "phone", width: 390, height: 700 },
      { browser: await getBrowser() },
    );
    expect(out.width).toBe(390 + 28); // 14px rim each side
    expect(out.height).toBe(700 + 28);
  }, 60_000);
});

/**
 * DM-1537: with a format's safe-area inset, a template's content must lay out
 * within `canvas − safeInset` (vertical formats reserve top/bottom room for
 * platform UI). Measured on the real captured page — the flex-padding path
 * (lower-third) and the chart wrapper path both land inside the safe rect;
 * without an inset the layout is unchanged (banner sits against its own margin,
 * outside the would-be safe rect).
 */
describe("format safe-area reflow (DM-1537)", () => {
  const reel = resolveFormat("reel");
  const { width, height, safeInset: s } = reel;
  const safe = { l: s.left, t: s.top, r: width - s.right, b: height - s.bottom };

  /** Union bounding box (viewport px) of the elements matching `sel`. */
  async function boundsOf(html: string, sel: string): Promise<{ minX: number; minY: number; maxX: number; maxY: number }> {
    const ctx = await (await getBrowser()).newContext({ viewport: { width, height } });
    try {
      const page = await ctx.newPage();
      await page.setContent(html);
      await page.waitForTimeout(50);
      return await page.evaluate((sel) => {
        const els = [...document.querySelectorAll(sel)];
        let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for (const el of els) {
          const r = el.getBoundingClientRect();
          minX = Math.min(minX, r.left); minY = Math.min(minY, r.top);
          maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom);
        }
        return { minX, minY, maxX, maxY };
      }, sel);
    } finally {
      await ctx.close();
    }
  }

  it("lower-third banner lays out within the safe rect at reel (9:16)", async () => {
    const p = validateTemplateParams(lowerThirdTemplate, { title: "Launch day", subtitle: "On brand", width, height });
    const b = await boundsOf(buildLowerThirdHtml(p, s), ".lt-panel");
    expect(b.minX).toBeGreaterThanOrEqual(safe.l - 1);
    expect(b.minY).toBeGreaterThanOrEqual(safe.t - 1);
    expect(b.maxX).toBeLessThanOrEqual(safe.r + 1);
    expect(b.maxY).toBeLessThanOrEqual(safe.b + 1);
  }, 60_000);

  it("without an inset the banner keeps its own margin (reflow is opt-in via format)", async () => {
    const p = validateTemplateParams(lowerThirdTemplate, { title: "Launch day", width, height });
    const b = await boundsOf(buildLowerThirdHtml(p, undefined), ".lt-panel");
    // Bottom-left banner with the default 48px padding sits below the safe bottom.
    expect(b.maxY).toBeGreaterThan(safe.b);
  }, 60_000);

  it("counter reel survives capture — off-canvas digit cells are kept (DM-1532 capture fix)", async () => {
    // The odometer strip is taller than the canvas; its off-canvas digit cells
    // roll into view during the animation. Capture must NOT drop them (they live
    // in a data-domotion-anim subtree). Pre-fix only ~1 digit/column survived and
    // the reels rendered blank mid-roll.
    const out = await renderTemplateToSvg(
      counterTemplate,
      { to: 128500, grouping: true, fontSize: 200 },
      { browser: await getBrowser() },
    );
    expect(out.svg).toMatch(/@keyframes/);
    // Every reel animation rests at identity (translateY(0)) — the Domotion-safe
    // shape that avoids the double-transform. (No `translateY(-…)` resting.)
    expect(out.svg).toMatch(/translateY\(0/);
    // Many digit cells present (6 reels, several rolling multiple turns) — far more
    // than the ~1-per-column that survived before the capture exemption.
    const digitCells = (out.svg.match(/>[0-9]</g) ?? []).length;
    expect(digitCells).toBeGreaterThan(40);
  }, 60_000);

  it("chart plots inside the safe rect at reel (9:16)", async () => {
    const p = validateTemplateParams(chartTemplate, {
      type: "column", data: "42,68,55", labels: "A,B,C", title: "Growth", width, height,
    });
    const inner = { ...p, width: width - s.left - s.right, height: height - s.top - s.bottom };
    const b = await boundsOf(buildChartHtml(inner, planChart(inner), s), ".ch-safe");
    expect(b.minX).toBeGreaterThanOrEqual(safe.l - 1);
    expect(b.minY).toBeGreaterThanOrEqual(safe.t - 1);
    expect(b.maxX).toBeLessThanOrEqual(safe.r + 1);
    expect(b.maxY).toBeLessThanOrEqual(safe.b + 1);
  }, 60_000);
});
