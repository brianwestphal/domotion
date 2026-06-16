import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, captureElementTree, type CapturedElement } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1125: the Alchemical Symbols block (U+1F700-1F77F) sits inside the broad
// `0x1F300-0x1FAFF` "main emoji block" range that `emoji-detect.ts` rasters
// unconditionally. But Chrome paints the block's 116 covered codepoints as
// MONOCHROME Apple Symbols path glyphs, not color emoji. The unconditional
// raster stamped a color-bitmap `<image>` overlay sized to the font CONTENT box
// (ascent+descent ≈ 29px at 32px font-size) — which CLIPPED the tall apparatus
// glyphs (retort/alembic U+1F76F / U+1F770, whose ink is ~35px) because Chrome
// paints the full ink while the raster cropped it to the content box.
//
// The fix gates the alchemical block through the same `isColorGlyph` canvas
// probe the DM-1025 default-presentation-symbol branches use: when the element's
// font cascade reaches Apple Symbols (monochrome) it path-renders; only a cell
// whose cascade reaches the color font rasters.
//
// This is a deterministic capture-level guard: the perceptual visual-diff gate
// is too lenient on a few-px top/bottom clip to catch the regression reliably,
// so we assert the captured segment routing directly — alchemical cells must NOT
// carry a `rasterGlyphs` overlay, while a real color emoji in the SAME cascade
// still must.

const W = 320, H = 120;
const FONT = `"Apple Symbols","Arial Unicode MS","Apple Symbols","Apple Color Emoji","Noto Sans","Noto Serif",sans-serif`;
function cell(cp: number): string {
  return `<x><g>${String.fromCodePoint(cp)}</g><n>U+${cp.toString(16).toUpperCase()}</n></x>`;
}
// U+1F76F / U+1F770 = tall apparatus glyphs that were clipped; U+1F747 = the
// precipitate symbol; U+1F600 = a real color emoji control (must still raster).
const ALCHEMICAL = [0x1F747, 0x1F76F, 0x1F770];
const EMOJI_CONTROL = 0x1F600;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0}` +
  `x{display:inline-flex;flex-direction:column;align-items:center;justify-content:flex-start;` +
  `width:72px;height:78px;padding:4px 2px;box-sizing:border-box;overflow:hidden}` +
  `x>g{font-size:32px;line-height:36px;height:38px;display:flex;align-items:center;justify-content:center;font-family:${FONT}}` +
  `x>n{font-size:17px;line-height:18px;font-family:Menlo,monospace}` +
  `</style></head><body><div class="grid">` +
  [...ALCHEMICAL, EMOJI_CONTROL].map(cell).join("") +
  `</div></body></html>`;

async function setup() {
  try {
    const browser = await launchChromium();
    return { browser };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

interface RasterSeg { text?: string; rasterGlyphs?: unknown[]; rasterRect?: unknown }
function findSegByCodepoint(tree: CapturedElement[], cp: number): RasterSeg | null {
  let hit: RasterSeg | null = null;
  const visit = (nodes: CapturedElement[]): void => {
    for (const n of nodes) {
      for (const s of ((n.textSegments ?? []) as RasterSeg[])) {
        const first = typeof s.text === "string" ? s.text.codePointAt(0) : undefined;
        if (first === cp) { hit = s; return; }
      }
      if (n.children) visit(n.children as CapturedElement[]);
      if (hit) return;
    }
  };
  visit(tree);
  return hit;
}

describeBrowser("DM-1125: Alchemical Symbols block is path-rendered, not rastered", () => {
  it("does NOT route alchemical glyphs through the color-emoji raster overlay", async () => {
    const { browser } = env!;
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      await page.setContent(HTML, { waitUntil: "load" });
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });

      for (const cp of ALCHEMICAL) {
        const seg = findSegByCodepoint(tree, cp);
        const label = `U+${cp.toString(16).toUpperCase()}`;
        expect(seg, `captured a segment for ${label}`).toBeTruthy();
        // Path-rendered: no per-glyph raster overlay, no whole-segment raster.
        expect(seg!.rasterGlyphs ?? null, `${label} must not carry a rasterGlyphs overlay`).toBeNull();
        expect(seg!.rasterRect ?? null, `${label} must not carry a rasterRect`).toBeNull();
      }

      // Control: a genuine color emoji in the SAME font cascade must still raster
      // — the fix must not disable the emoji pipeline wholesale.
      const emoji = findSegByCodepoint(tree, EMOJI_CONTROL);
      expect(emoji, "captured a segment for the emoji control").toBeTruthy();
      expect(
        (emoji!.rasterGlyphs?.length ?? 0) > 0,
        "U+1F600 (color emoji) must still route to the raster overlay",
      ).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
