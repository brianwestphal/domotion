import { chromium, type Browser } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { captureElementTreeWithWarnings } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

/**
 * DM-1446 — a recursed same-origin `<iframe>` whose inner content references a
 * same-document `mask-image: url(#id)` / `clip-path: url(#id)` / `filter:
 * url(#id)` fragment must resolve that fragment against the INNER document
 * (`el.ownerDocument`), not the outer one, so the `<mask>`/`<clipPath>`/
 * `<filter>` def is hoisted into the output SVG. Regression guard for the
 * `el.ownerDocument` fix in `masks-clips.ts`.
 */

const INNER = `<!doctype html><html><head><style>
  body{margin:0;background:#fff}
  .clip{width:120px;height:120px;background:#e11;clip-path:url(#innerClip)}
  .mask{width:120px;height:120px;background:#1a1;-webkit-mask-image:url(#innerMask);mask-image:url(#innerMask)}
  .filt{width:120px;height:60px;background:#14e;filter:url(#innerBlur)}
</style></head><body>
  <svg width="0" height="0"><defs>
    <clipPath id="innerClip"><circle cx="60" cy="60" r="50"/></clipPath>
    <mask id="innerMask"><rect width="120" height="120" fill="white"/><circle cx="60" cy="60" r="40" fill="black"/></mask>
    <filter id="innerBlur"><feGaussianBlur stdDeviation="3"/></filter>
  </defs></svg>
  <div class="clip"></div>
  <div class="mask"></div>
  <div class="filt"></div>
</body></html>`;

const env = await (async () => {
  try {
    return { browser: await chromium.launch() };
  } catch {
    return null;
  }
})();

afterAll(async () => {
  await closeBrowserSafely(env?.browser as Browser | null | undefined);
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("recursed iframe inner mask/clip/filter defs (DM-1446)", () => {
  it("hoists same-document mask / clip-path / filter defs defined inside the iframe", async () => {
    const ctx = await env!.browser.newContext({ viewport: { width: 400, height: 400 } });
    const page = await ctx.newPage();
    try {
      await page.setContent(
        `<div style="padding:10px;"><iframe srcdoc="${INNER.replace(/"/g, "&quot;")}" width="360" height="340" style="border:0;display:block;"></iframe></div>`,
      );
      await page.waitForLoadState("networkidle");
      const { tree, warnings } = await captureElementTreeWithWarnings(page, "body", { x: 0, y: 0, width: 400, height: 400 });
      const root = tree[0] as CapturedElement & {
        maskDefs?: { id: string }[];
        clipPathDefs?: { id: string }[];
        filterDefs?: { id: string }[];
      };

      expect((root.maskDefs ?? []).map((d) => d.id)).toContain("innerMask");
      expect((root.clipPathDefs ?? []).map((d) => d.id)).toContain("innerClip");
      expect((root.filterDefs ?? []).map((d) => d.id)).toContain("innerBlur");

      // No "did not resolve to an inline <…>" warnings for the inner defs.
      const unresolved = warnings.filter((w) =>
        /did not resolve to an inline/.test(JSON.stringify(w)),
      );
      expect(unresolved).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
