import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvg } from "../src/index.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { setFlattenNestedSvg } from "../src/render/svg-inline.js";

// DM-7AN9AH: captured DOM inline `<svg>` flattens to a `<g transform>` when opt-in
// is on, renders identically to the nested `<svg>` baseline, and falls back to the
// nested `<svg>` for an unsafe source (here a `<use>` sprite — the DM-499 contract).
const W = 400;
const H = 200;
let browser: Browser;
let source: Page;
let out: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  source = await browser.newPage({ viewport: { width: W, height: H } });
  out = await browser.newPage({ viewport: { width: W, height: H } });
});
afterAll(async () => {
  await browser.close();
});

function render(tree: Awaited<ReturnType<typeof captureElementTree>>, flatten: boolean): string {
  clearGlyphDefs();
  clearEmbeddedFonts();
  setFlattenNestedSvg(flatten);
  try {
    return elementTreeToSvg(tree, W, H, {});
  } finally {
    setFlattenNestedSvg(false);
  }
}

async function shoot(svg: string): Promise<Buffer> {
  await out.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`);
  return out.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
}

describe("captured DOM inline <svg> flattening (DM-7AN9AH)", () => {
  it("a plain icon flattens to <g matrix>, pixel-identical to the nested <svg>", async () => {
    await source.setContent(
      `<!doctype html><style>html,body{margin:0;background:#fff}` +
      `.icon{width:40px;height:40px;color:#c33;padding:8px}</style>` +
      `<div class="icon"><svg viewBox="0 0 24 24"><path d="M3 3h18v18H3z" fill="currentColor"/>` +
      `<circle cx="12" cy="12" r="5" fill="#39c"/></svg></div>`,
    );
    const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });

    const nested = render(tree, false);
    const flat = render(tree, true);
    expect(nested).toMatch(/<svg[^>]*viewBox="0 0 24 24"/); // baseline keeps the nested <svg>
    expect(flat).toMatch(/<g transform="matrix\(1\.666667 0 0 1\.666667 8 8\)"/); // 40/24 scale at (8,8)
    expect(flat).not.toMatch(/<svg[^>]*viewBox="0 0 24 24"/); // the nested <svg> wrapper is gone
    expect(flat).toContain('fill="#39c"'); // the circle survived the flatten

    const [a, b] = [await shoot(nested), await shoot(flat)];
    expect(a.equals(b)).toBe(true); // identical paint
  }, 30_000);

  it("an unsafe source (inner <style> element selector) stays a nested <svg>", async () => {
    // NB: the capture pre-resolves viewport-relative `%` to absolute, so `%` is
    // NOT the unsafe case for captured content. An inner <style> with an element
    // selector IS: it would leak into the outer document once merged.
    await source.setContent(
      `<!doctype html><style>html,body{margin:0;background:#fff}.icon{width:40px;height:40px;color:#282}</style>` +
      `<div class="icon"><svg viewBox="0 0 10 10"><style>rect{fill:currentColor}</style><rect width="10" height="10"/></svg></div>`,
    );
    const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
    const flat = render(tree, true);
    // Not safely flattenable → the icon stays a nested <svg> (no matrix group).
    expect(flat).toMatch(/<svg[^>]*viewBox="0 0 10 10"/);
    expect(flat).not.toMatch(/<g transform="matrix\(/);
  }, 30_000);
});
