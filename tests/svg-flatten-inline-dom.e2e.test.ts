import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { captureElementTree, elementTreeToSvg } from "../src/index.js";
import { clearEmbeddedFonts, clearGlyphDefs } from "../src/render/index.js";
import { comparePngs } from "../src/review/compare-pngs.js";

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
  return elementTreeToSvg(tree, W, H, { flattenNestedSvg: flatten });
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
    // 40/24 scale at (8,8); the group also carries the root's baked presentation attrs (DM-97E2CN)
    expect(flat).toMatch(/<g [^>]*transform="matrix\(1\.666667 0 0 1\.666667 8 8\)"/);
    expect(flat).not.toMatch(/<svg[^>]*viewBox="0 0 24 24"/); // the nested <svg> wrapper is gone
    expect(flat).toContain('fill="#39c"'); // the circle survived the flatten

    const [a, b] = [await shoot(nested), await shoot(flat)];
    expect(a.equals(b)).toBe(true); // identical paint
  }, 30_000);

  it("a CSS-rotated inline <svg> keeps its placement and rotation when flattened (DM-KDGVCN)", async () => {
    // Kerf's ProgressRing: the <svg> carries `rotate: -90deg`. Capture neutralizes
    // the root's own transform on the clone (`transform:translate(0);rotate:none…`)
    // because the renderer applies it outside the SVG; carried onto the flattened
    // <g>, that CSS `transform` overrode the group's viewport matrix and every
    // ring collapsed onto its group origin.
    await source.setContent(
      `<!doctype html><style>html,body{margin:0;background:#fff}` +
        `.row{display:flex;gap:16px;padding:20px}.ring{width:48px;height:48px;rotate:-90deg}</style>` +
        `<div class="row">` +
        [0.25, 0.5, 0.75]
          .map(
            (p) =>
              `<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" fill="none" stroke="#ddd" stroke-width="4"/>` +
              `<circle cx="18" cy="18" r="15" fill="none" stroke="#c33" stroke-width="4" stroke-dasharray="${(p * 94.25).toFixed(2)} 94.25"/></svg>`,
          )
          .join("") +
        `</div>`,
    );
    const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
    const nested = render(tree, false);
    const flat = render(tree, true);
    expect(flat).not.toMatch(/<svg[^>]*viewBox="0 0 36 36"/); // flattened
    for (const tag of flat.match(/<g [^>]*transform="matrix\([^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/style="[^"]*\b(?:transform|rotate|scale|translate)\s*:/);
    }
    const [expected, a, b] = [
      await source.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }),
      await shoot(nested),
      await shoot(flat),
    ];
    // A rotated viewport matrix vs a nested viewport differs only in edge
    // anti-aliasing, so grade with the suites' region metric, not byte equality.
    // Before the fix every ring painted at its group origin (many regions).
    const dir = mkdtempSync(join(tmpdir(), "dm-kdgvcn-"));
    const file = (name: string, bytes: Buffer) => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    };
    const [exp, nest, fl] = [file("expected.png", expected), file("nested.png", a), file("flat.png", b)];
    expect((await comparePngs(out, nest, fl, join(dir, "diff-nested.png"))).regionCount).toBe(0);
    expect((await comparePngs(out, exp, fl, join(dir, "diff-chrome.png"))).regionCount).toBe(0);
  }, 30_000);

  // An outermost `<svg transform>` attribute is a CSS transform on the root box,
  // about its center. On a DOM-inline svg the capture applies it through the
  // element's own transform; in an `<img>` SVG document nothing else does, so the
  // inlined output composes it around the image center and clips to the image.
  it("a root transform attribute paints like Chrome for DOM-inline and <img> SVG, nested and flattened", async () => {
    const icon =
      `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" transform="rotate(30)">` +
      `<rect width="100" height="40" fill="#e11"/><rect y="60" width="40" height="40" fill="#13e"/></svg>`;
    const dir = mkdtempSync(join(tmpdir(), "dm-qm88gv-"));
    const file = (name: string, bytes: Buffer) => {
      const path = join(dir, name);
      writeFileSync(path, bytes);
      return path;
    };
    const sources = {
      inline: `<div style="position:absolute;left:60px;top:50px">${icon}</div>`,
      img: `<img style="position:absolute;left:60px;top:50px" width="100" height="100" src="data:image/svg+xml,${encodeURIComponent(icon)}">`,
    };
    for (const [kind, body] of Object.entries(sources)) {
      await source.setContent(`<!doctype html><style>html,body{margin:0;background:#fff}</style>${body}`);
      await source.waitForLoadState("networkidle");
      const exp = file(`${kind}-expected.png`, await source.screenshot({ clip: { x: 0, y: 0, width: W, height: H } }));
      const tree = await captureElementTree(source, "body", { x: 0, y: 0, width: W, height: H });
      for (const flatten of [false, true]) {
        const actual = file(`${kind}-${flatten}.png`, await shoot(render(tree, flatten)));
        // Before the fix: the <img> case rotated about the output origin (nested)
        // or not at all (flattened), and the flattened inline case lost its
        // placement — each a large region.
        const cmp = await comparePngs(out, exp, actual, join(dir, `${kind}-${flatten}-diff.png`));
        expect(cmp.regionCount, `${kind} flatten=${flatten}`).toBe(0);
      }
    }
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
