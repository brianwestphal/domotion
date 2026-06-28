import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1271: a color emoji in `::after` content (e.g. `content: " 📄"`) whose
// painted square — its glyph advance, which Chrome enforces at a MINIMUM of
// ~1.25× font-size (20px at font-size 16) — is taller than the `line-height:
// normal` line box (~18px). The segment-level raster screenshots the line box,
// so a line-box-tall rect clipped the emoji's vertical overflow and re-embedded
// it ~2px low ("emoji looks clipped on top a bit").
//
// The capture pass now grows the raster rect to the emoji's square (its own
// advance, measured with the CSS quote delimiters + surrounding whitespace
// excluded so a leading space doesn't inflate it), centered on the real line
// box. This is a deterministic capture-level guard: the perceptual visual-diff
// gate is too lenient on a ~2px top clip to catch the regression reliably (it
// reads as a "minor" sub-3% diff), so we assert the captured rect geometry
// directly — the emoji rect must be a square taller than the line box.

const W = 360, H = 120;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0}` +
  `div{padding:40px;background:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:16px;line-height:normal}` +
  `a{color:#1d4ed8;text-decoration:none}` +
  `a[href$=".pdf"]::after{content:" 📄"}` +
  `</style></head><body><div><a href="report.pdf">Quarterly report</a></div></body></html>`;

interface RasterSeg {
  text?: string;
  rasterRect?: { x: number; y: number; width: number; height: number };
  rasterEmojiSide?: number;
}
function findEmojiSeg(tree: CapturedElement[]): RasterSeg | null {
  let hit: RasterSeg | null = null;
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      for (const s of ((n.textSegments ?? []) as RasterSeg[])) {
        if (typeof s.text === "string" && s.text.includes("\u{1F4C4}")) { hit = s; return; }
      }
      if (n.children) visit(n.children as CapturedElement[]);
      if (hit) return;
    }
  };
  visit(tree);
  return hit;
}

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("DM-1271: ::after color emoji raster grows to its square when it overflows the line box", () => {
  it("captures the emoji raster rect as a square taller than the line box", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const seg = findEmojiSeg(tree);
      expect(seg, "captured the ::after emoji segment").toBeTruthy();
      expect(seg!.rasterRect, "emoji segment carries a rasterRect").toBeTruthy();
      // The emoji square (its advance) at font-size 16 is ~20px; the line box is
      // ~18px. The rect must have been grown past the line box, recorded as
      // rasterEmojiSide, and its height must equal that square (not the line box).
      expect(seg!.rasterEmojiSide, "rasterEmojiSide recorded for the overflowing emoji").toBeGreaterThan(18.5);
      expect(seg!.rasterRect!.height).toBeCloseTo(seg!.rasterEmojiSide!, 1);
      // Sanity: ~20px square at 16px font-size, not inflated by the leading space
      // (a space-inclusive measure would push it well past the emoji's advance).
      expect(seg!.rasterEmojiSide!).toBeGreaterThan(18.5);
      expect(seg!.rasterEmojiSide!).toBeLessThan(24);
    } finally {
      await page.close();
    }
  }, 60_000);
});
