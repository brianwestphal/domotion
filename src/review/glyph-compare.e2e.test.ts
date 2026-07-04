/**
 * E2E guard for the glyph font-identity comparator (DM-1686): real system
 * fonts rendered through real Chromium at DPR 2 — the production crop regime.
 * A trimmed slice of the full calibration corpus (tools/glyph-compare-
 * calibrate.ts); if a threshold or metric change breaks the calibrated
 * separations, this fails before the change ships. macOS-calibrated font
 * names; the comparator itself is platform-agnostic (it only sees pixels).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compareGlyphPngs } from "./glyph-compare.js";

let browser: Browser;
let page: Page;
let dir: string;

beforeAll(async () => {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 400, height: 140 }, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  dir = mkdtempSync(join(tmpdir(), "glyph-compare-e2e-"));
});

afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function renderGlyph(
  family: string, char: string,
  opts: { weight?: number; style?: string; size?: number; offset?: number } = {},
): Promise<string> {
  const { weight = 400, style = "normal", size = 32, offset = 0 } = opts;
  await page.setContent(
    `<!doctype html><html><body style="margin:0; background:#fff;">
      <span id="g" style="position:absolute; left:${20 + offset}px; top:24px;
        font-family:${family}; font-weight:${weight}; font-style:${style};
        font-size:${size}px; color:#000;">${char}</span></body></html>`,
  );
  const box = (await page.locator("#g").boundingBox())!;
  const file = join(dir, `g${n++}.png`);
  await page.screenshot({
    path: file,
    clip: { x: box.x - 5, y: box.y - 5, width: box.width + 10, height: box.height + 10 },
  });
  return file;
}

describe("glyph-compare on real Chromium renders", () => {
  it("matches the same font re-rendered at a different subpixel phase", async () => {
    const a = await renderGlyph("Helvetica", "R");
    const b = await renderGlyph("Helvetica", "R", { offset: 0.37 });
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("match");
    expect(r.confidence).toBe("high");
  });

  it("flags Helvetica vs Arial 'R' (straight vs curved leg)", async () => {
    const a = await renderGlyph("Helvetica", "R");
    const b = await renderGlyph("Arial", "R");
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("mismatch");
    expect(r.confidence).toBe("high");
  });

  it("flags the hardest lookalike: Helvetica vs Helvetica Neue 'e'", async () => {
    const a = await renderGlyph("Helvetica", "e");
    const b = await renderGlyph("'Helvetica Neue'", "e");
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("mismatch");
  });

  it("flags a weight step (400 vs 700)", async () => {
    const a = await renderGlyph("Helvetica", "a");
    const b = await renderGlyph("Helvetica", "a", { weight: 700 });
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("mismatch");
    expect([...r.hardSignals, ...r.softSignals]).toEqual(
      expect.arrayContaining([expect.stringMatching(/mass|stroke/)]),
    );
  });

  it("flags a ~6% size step (32 vs 34px)", async () => {
    const a = await renderGlyph("Times", "g", { size: 32 });
    const b = await renderGlyph("Times", "g", { size: 34 });
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("mismatch");
  });

  it("flags italic vs upright", async () => {
    const a = await renderGlyph("Georgia", "a");
    const b = await renderGlyph("Georgia", "a", { style: "italic" });
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("mismatch");
    expect(r.confidence).toBe("high");
  });

  it("matches a truly identical lookalike glyph (Helvetica vs Arial 'l') — shape equality IS correctness", async () => {
    const a = await renderGlyph("Helvetica", "l");
    const b = await renderGlyph("Arial", "l");
    const r = await compareGlyphPngs(a, b);
    expect(r.verdict).toBe("match");
  });
});
