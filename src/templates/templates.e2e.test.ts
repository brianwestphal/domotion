import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { renderTemplateToSvg } from "./render.js";
import { lowerThirdTemplate } from "./builtin/lower-third.js";
import { deviceMockupTemplate } from "./builtin/device-mockup.js";

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
