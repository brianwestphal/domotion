import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { launchChromium, injectBrandVariables, captureElementTree } from "./index.js";
import { elementTreeToSvg } from "../render/element-tree-to-svg.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import type { Brand } from "../templates/brand.js";

// DM-1540 (docs/92): `injectBrandVariables` themes a CAPTURED real page by
// injecting the brand's CSS custom properties onto `:root` BEFORE capture, so a
// page authored against `var(--brand-*)` picks up the brand. This exercises the
// real Playwright path: a file navigation (goto), NOT `setContent` — the latter's
// `document.write` would wipe an init-set root, which the DOMContentLoaded
// re-apply is designed to survive.

async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}

const env = await setup();
const dir = mkdtempSync(join(tmpdir(), "domotion-brand-inject-"));
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
  rmSync(dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

// The `.box` fill/text and radius are driven ENTIRELY by brand vars, each with a
// distinct fallback so an un-injected control reads differently from the branded
// run. `#2f6df6` resolves to rgb(47, 109, 246); the fallback to rgb(200, 0, 0).
const W = 320, H = 220;
const HTML =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `html,body{margin:0;background:#fff}` +
  `.box{width:200px;height:120px;` +
  `background:var(--brand-primary, rgb(200,0,0));` +
  `border-radius:var(--brand-radius, 0px)}` +
  `</style></head><body><div class="box"></div></body></html>`;

const ACME: Brand = {
  palette: { primary: "#2f6df6", accent: "#22d3ee" },
  font: { family: "Inter, sans-serif" },
  radius: 16,
};

function fixtureUrl(): string {
  const p = join(dir, "brand-page.html");
  writeFileSync(p, HTML);
  return pathToFileURL(p).href;
}

describeBrowser("injectBrandVariables (DM-1540)", () => {
  it("makes var(--brand-*) resolve to the brand at capture time; render carries the color", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    try {
      await injectBrandVariables(ctx, ACME);
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(), { waitUntil: "load" });

      // getComputedStyle during capture sees the brand var (the crux — the vars
      // are present before the capture reads styles).
      const cs = await page.evaluate(() => {
        const s = getComputedStyle(document.querySelector(".box")!);
        return { bg: s.backgroundColor, radius: s.borderTopLeftRadius };
      });
      expect(cs.bg).toBe("rgb(47, 109, 246)"); // #2f6df6, NOT the rgb(200,0,0) fallback
      expect(cs.radius).toBe("16px"); // --brand-radius: 16px, NOT the 0px fallback

      // The rendered SVG carries the brand color through to output.
      const tree = await captureElementTree(page, "body", { x: 0, y: 0, width: W, height: H });
      const svg = elementTreeToSvg(tree, W, H);
      expect(svg.replace(/\s+/g, "")).toContain("rgb(47,109,246)");
      expect(svg).not.toContain("rgb(200, 0, 0)");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("without injection, the page keeps its own var() fallbacks (control)", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    try {
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(), { waitUntil: "load" });
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector(".box")!).backgroundColor);
      expect(bg).toBe("rgb(200, 0, 0)"); // the fallback, since --brand-primary is unset
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("a brand that maps to nothing injects nothing (no-op)", async () => {
    const { browser } = env!;
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    try {
      await injectBrandVariables(ctx, {}); // no mappable token
      const page = await ctx.newPage();
      await page.goto(fixtureUrl(), { waitUntil: "load" });
      const styleAttr = await page.evaluate(() => document.documentElement.getAttribute("style"));
      expect(styleAttr).toBeNull(); // nothing was set on :root
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
