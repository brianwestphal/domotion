/**
 * DM-1516 (docs/94): forced CSS pseudo-state capture — real-Chromium round-trip.
 *
 * The unit twin (`force-state.test.ts`) drives `applyForcedPseudoStates` against
 * a fake CDP session. This e2e proves the two things a fake can't:
 *   1. A forced `:hover` override actually survives into `captureElementTree` and
 *      the rendered SVG carries the page's HOVER color — i.e. the session is left
 *      attached long enough (regression guard for the detach-clears-hover bug).
 *   2. The whole `animate` config path (`composeAnimateConfig`) captures the
 *      forced-hover frame's real styling, and the cascade sibling
 *      `.card:has(.cta:hover)` fires — not just the directly-hovered node.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import {
  applyForcedPseudoStates,
  captureElementTree,
  composeAnimateConfig,
  elementTreeToSvgInner,
  launchChromium,
  validateAnimateConfig,
} from "../index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

const REST = "rgb(35,134,54)"; // #238636 — base button
const HOVER = "rgb(46,160,67)"; // #2ea043 — :hover button
const CARD_HOVER_BORDER = "rgb(47,129,247)"; // #2f81f7 — .card:has(.cta:hover)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{background:#0d1117;height:320px}
  .card{margin:40px;padding:24px;width:300px;background:#161b22;border:2px solid #30363d;border-radius:12px}
  .card:has(.cta:hover){border-color:#2f81f7}
  .cta{display:block;width:100%;padding:12px;border:none;border-radius:8px;background:#238636;color:#fff;font-size:16px}
  .cta:hover{background:#2ea043}
</style></head><body>
  <div class="card"><button class="cta">Start free trial</button></div>
</body></html>`;

async function canLaunch(): Promise<Browser | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await canLaunch();

const dir = mkdtempSync(join(tmpdir(), "domotion-force-state-"));
const htmlPath = join(dir, "page.html");
writeFileSync(htmlPath, PAGE);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (browser) await closeBrowserSafely(browser);
});

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("applyForcedPseudoStates → capture round-trip (DM-1516)", () => {
  it("captures the page's real :hover color after forcing (survives past the CDP call)", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 460, height: 320 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });

      // Baseline: no force → rest color, no hover color.
      const restTree = await captureElementTree(page, "body", { x: 0, y: 0, width: 460, height: 320 });
      const restSvg = elementTreeToSvgInner(restTree, 460, 320, "r-", true, 2, false);
      expect(restSvg).toContain(REST);
      expect(restSvg).not.toContain(HOVER);

      // Force :hover, then capture again — the forced paint must be recorded.
      await applyForcedPseudoStates(page, [{ selector: ".cta", states: ["hover"] }]);
      const hoverTree = await captureElementTree(page, "body", { x: 0, y: 0, width: 460, height: 320 });
      const hoverSvg = elementTreeToSvgInner(hoverTree, 460, 320, "h-", true, 2, false);
      expect(hoverSvg).toContain(HOVER);
      expect(hoverSvg).not.toContain(REST);
      // The cascade sibling `.card:has(.cta:hover)` fires too — the card border
      // turns blue, proving it's the browser's own rule engine, not a per-node hack.
      expect(hoverSvg).toContain(CARD_HOVER_BORDER);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("throws when a forceState selector matches nothing", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 200, height: 200 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      await expect(applyForcedPseudoStates(page, [{ selector: ".nope", states: ["hover"] }])).rejects.toThrow(
        /forceState selector "\.nope" matched no element/,
      );
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("the animate config path captures a forced-:hover continue frame", async () => {
    const cfg = validateAnimateConfig({
      width: 460,
      height: 320,
      frames: [
        { input: htmlPath, duration: 800, transition: { type: "crossfade", duration: 200 } },
        { continue: true, duration: 800, forceState: [{ selector: ".cta", states: ["hover"] }] },
      ],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    // Split into the two frame groups; frame 0 rest, frame 1 forced hover.
    const groups = svg.split(/(?=class="f f-\d+")/);
    const rest = groups.find((c) => /class="f f-0"/.test(c)) ?? "";
    const hover = groups.find((c) => /class="f f-1"/.test(c)) ?? "";
    expect(rest).toContain(REST);
    expect(rest).not.toContain(HOVER);
    expect(hover).toContain(HOVER);
    expect(hover).not.toContain(REST);
  }, 120_000);
});
