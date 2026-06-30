import { chromium, type Browser } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";
import { captureElementTree } from "../src/capture/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import type { CapturedElement } from "../src/capture/types.js";

/**
 * DM-1443 — a recursed same-origin `<iframe>` must run the capture pre-passes
 * against its OWN document, not reuse the outer document's pre-pass state.
 * Without this, CSS counters inside the frame resolve to 0 and text under an
 * inner `transform: scale()` keeps its unscaled font size. Regression guard for
 * `_runInnerDocumentPrePasses`.
 */

function findByTag(tree: CapturedElement[], tag: string): CapturedElement | null {
  for (const el of tree) {
    if (el.tag === tag) return el;
    const r = el.children ? findByTag(el.children, tag) : null;
    if (r != null) return r;
  }
  return null;
}
function collectText(el: CapturedElement, out: string[] = []): string[] {
  if (el.text) out.push(el.text);
  for (const c of el.children ?? []) collectText(c, out);
  return out;
}
function findText(el: CapturedElement, needle: string): CapturedElement | null {
  if ((el.text ?? "").includes(needle)) return el;
  for (const c of el.children ?? []) {
    const r = findText(c, needle);
    if (r != null) return r;
  }
  return null;
}

const INNER = `<!doctype html><html><head><style>
  body{margin:0;font-family:sans-serif;color:#fff;background:#123}
  .sec{counter-increment:sec}
  .sec::before{content:counter(sec) '. '}
</style></head><body>
  <div style="counter-reset:sec">
    <h3 class="sec">First</h3>
    <h3 class="sec">Second</h3>
    <h3 class="sec">Third</h3>
  </div>
  <div id="scaled" style="transform:scale(2);transform-origin:0 0;font-size:10px;">Scaled</div>
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

describeBrowser("recursed iframe inner-document pre-passes (DM-1443)", () => {
  it("resolves CSS counters and pre-scales text under an inner transform", async () => {
    const ctx = await env!.browser.newContext({ viewport: { width: 400, height: 400 } });
    const page = await ctx.newPage();
    try {
      await page.setContent(
        `<div style="padding:10px;"><iframe srcdoc="${INNER.replace(/"/g, "&quot;")}" width="360" height="320" style="border:0;display:block;"></iframe></div>`,
      );
      await page.waitForLoadState("networkidle");
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: 400, height: 400 });
      const iframe = findByTag(tree, "iframe");
      expect(iframe, "iframe must recurse to native children").not.toBeNull();
      expect(iframe!.children?.length ?? 0).toBeGreaterThan(0);

      // Counters resolve against the INNER document, not 0/0/0.
      const texts = collectText(iframe!).join(" | ");
      expect(texts).toContain("1. ");
      expect(texts).toContain("2. ");
      expect(texts).toContain("3. ");
      expect(texts).not.toContain("0. ");

      // Inner transform: scale(2) on a 10px element → captured font size ~20px.
      const scaled = findText(iframe!, "Scaled");
      expect(scaled, "scaled element captured").not.toBeNull();
      const fs = parseFloat(String(scaled!.styles?.fontSize));
      expect(fs).toBeGreaterThan(19);
      expect(fs).toBeLessThan(21);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
