import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import * as fk from "fontkit";
import { launchChromium } from "../src/index.js";
import { captureElementTree, elementTreeToSvg } from "../src/render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1103: an explicitly-named macOS optical cut (`"SF Pro Text"`) must render
// from the Text optical instance (opsz 17 — the axis floor), the way Chrome /
// CoreText paints it, NOT the variable font's default master (opsz 28). fontkit
// only sees the default master and our pipeline otherwise sets opsz = font-size,
// so an "SF Pro Text" headline used to render at the Display optical size and
// its diacritics (ring/dot above/below) sat ~2–3 px too low. The generic
// `system-ui` / `"SF Pro"` path keeps opsz = size (its <20-Text / ≥20-Display
// mapping already matches Chrome) and must NOT change.
//
// Measured signal: ẘ (U+1E98, a base 'w' + ring-above that sits on the baseline,
// so its ink height == ring-top) has maxY ≈ 1680/2048 em at opsz 17 vs 1524 at
// opsz 28. We embed the glyph (default render mode), decode the subset, and read
// the bbox. macOS-only: SF Pro is the system font; on Linux "SF Pro Text"
// resolves to Liberation Sans (no opsz axis), so the cut doesn't apply.

const fontkit = (fk as { default?: typeof fk }).default ?? fk;
const SFNS = "/System/Library/Fonts/SFNS.ttf";
const isDarwin = process.platform === "darwin" && existsSync(SFNS);

async function setup() {
  try { return { browser: await launchChromium() }; } catch { return null; }
}
const env = await setup();
afterAll(async () => { await closeBrowserSafely(env?.browser); }, 15_000);
const describeMac = env && isDarwin ? describe : describe.skip;

// Render `ẘ` at 32px in `family` through the full capture→embed pipeline and
// return the embedded glyph's bbox.maxY normalized to a 2048-unit em.
async function embeddedRingMaxY(browser: NonNullable<typeof env>["browser"], family: string): Promise<number> {
  const page = await browser.newPage({ viewport: { width: 320, height: 160 }, deviceScaleFactor: 1 });
  try {
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><div style="font-size:32px;font-family:${family};color:#000">ẘ</div>`,
      { waitUntil: "networkidle" },
    );
    const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 320, height: 160 });
    const svg = elementTreeToSvg(tree, 320, 160);
    const t = [...svg.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs)].find((m) => /font-size="32"/.test(m[1]) && m[2].trim() !== "");
    if (t == null) throw new Error("no size-32 glyph <text> emitted");
    const fam = /font-family="([^"]+)"/.exec(t[1])?.[1];
    const cp = t[2].codePointAt(0)!;
    const b64 = new RegExp(`font-family:\\s*"${fam}"[^}]*?base64,([A-Za-z0-9+/=]+)`, "s").exec(svg)?.[1];
    if (b64 == null) throw new Error("embedded font not found for " + fam);
    let f = (fontkit as { create: (b: Buffer) => unknown }).create(Buffer.from(b64, "base64")) as { fonts?: unknown[]; glyphForCodePoint: (c: number) => { bbox: { maxY: number } }; unitsPerEm: number };
    if ((f as { fonts?: unknown[] }).fonts) f = (f as { fonts: typeof f[] }).fonts[0];
    const g = f.glyphForCodePoint(cp);
    return Math.round((g.bbox.maxY / f.unitsPerEm) * 2048);
  } finally {
    await page.close();
  }
}

describeMac("DM-1103: SF Pro Text optical-size cut", () => {
  it('renders "SF Pro Text" diacritics at the Text optical size (opsz 17), not the default master', async () => {
    // Single-quoted names so the inner quotes don't terminate the double-quoted
    // `style="…"` attribute (which would silently fall back to Times).
    const maxY = await embeddedRingMaxY(env!.browser, `'SF Pro Text','Arial Unicode MS',sans-serif`);
    // opsz 17 → ~1680; opsz 28 (the old bug) → 1524. Use a midpoint gate.
    expect(maxY).toBeGreaterThan(1600);
  }, 60_000);

  it('leaves generic "SF Pro" / system-ui on the size-derived opsz (unchanged)', async () => {
    const maxY = await embeddedRingMaxY(env!.browser, `system-ui,sans-serif`);
    // At 32px the generic path is the Display master (~1524); must NOT become 1680.
    expect(maxY).toBeLessThan(1600);
  }, 60_000);
});
