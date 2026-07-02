/**
 * DM-1556 (docs/93 §2): per-keystroke real-site re-sampling — real-Chromium
 * round-trip. The unit twin (`type-resample.test.ts`) covers the pure timeline /
 * defaulting. This proves the thing a fake can't: driving a live masked field one
 * keystroke at a time and re-capturing after each keystroke serializes the page's
 * OWN input mask (raw "5551234567" → the field's "(555) 123-4567"), not the raw
 * keystrokes — and that the whole `animate` config path composes it into one
 * frame's nested per-keystroke animated SVG.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "@playwright/test";
import { composeAnimateConfig, launchChromium, validateAnimateConfig } from "../index.js";
import { buildTypeResampleAnimation, resolveTypeResampleSpec } from "./type-resample.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";

// A phone field that masks the raw digits into "(NNN) NNN-NNNN" on every input
// event — so the DISPLAYED value diverges from the raw keystrokes. Text renders
// as glyph paths on macOS, so the assertions look for the mask's STRUCTURE
// (11 re-captured states, one caret per state) rather than literal characters
// (which aren't `<text>` on the calibrated platform). The masking is proven via
// a direct page probe below where we CAN read `input.value`.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;box-sizing:border-box}
  body{background:#fff;height:200px}
  #phone{margin:40px;width:300px;height:40px;font-size:16px;font-family:monospace;padding:0 12px}
</style></head><body>
  <input id="phone" type="tel" autocomplete="off">
  <script>
    var el = document.getElementById('phone');
    el.addEventListener('input', function () {
      var d = el.value.replace(/\\D/g, '').slice(0, 10);
      var out = '';
      if (d.length > 0) out = '(' + d.slice(0, 3);
      if (d.length >= 3) out += ') ' + d.slice(3, 6);
      if (d.length >= 6) out += '-' + d.slice(6, 10);
      el.value = out;
    });
  </script>
</body></html>`;

async function canLaunch(): Promise<Browser | null> {
  try { return await launchChromium(); } catch { return null; }
}
const browser = await canLaunch();

const dir = mkdtempSync(join(tmpdir(), "domotion-type-resample-"));
const htmlPath = join(dir, "phone.html");
writeFileSync(htmlPath, PAGE);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  if (browser) await closeBrowserSafely(browser);
});

const describeBrowser = browser ? describe : describe.skip;

describeBrowser("buildTypeResampleAnimation → capture round-trip (DM-1556)", () => {
  it("re-captures the field's OWN masked value after each keystroke (not the raw keys)", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 200 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });

      // Type one digit at a time exactly as the re-sampler does; probe the live
      // field's value each time — the page mask must be diverging the shown value
      // from the raw keystrokes.
      await page.fill("#phone", "");
      await page.focus("#phone");
      await page.keyboard.type("5");
      await page.keyboard.type("5");
      await page.keyboard.type("5");
      expect(await page.inputValue("#phone")).toBe("(555) "); // mask injected "(" and ") " — not typed
      for (const d of "1234567") await page.keyboard.type(d);
      expect(await page.inputValue("#phone")).toBe("(555) 123-4567"); // full mask captured
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("composes N+1 re-captured states into one nested animated SVG with a caret per state", async () => {
    const ctx = await browser!.newContext({ viewport: { width: 400, height: 200 } });
    try {
      const page = await ctx.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle" });
      const spec = resolveTypeResampleSpec({ selector: "#phone", text: "5551234567", speed: 50, tailMs: 200 });
      const res = await buildTypeResampleAnimation(page, spec, {
        width: 400, height: 200, framePrefix: "tr0_", log: () => {},
      });
      // 10 keystrokes → 11 states. Nested animated SVG, namespaced, no XML prolog.
      expect(res.svgContent).not.toMatch(/^<\?xml/);
      expect(res.svgContent).toContain("<svg");
      expect(res.svgContent).toContain("tr0_f-10"); // the final (10-keystroke) state
      expect(res.svgContent).toContain("tr0_blink10"); // caret on the final state
      // period = delay(0) + 10*speed(50) + tailMs(200) = 700.
      expect(res.periodMs).toBe(700);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("the animate config path nests the per-keystroke animation in a single frame", async () => {
    const cfg = validateAnimateConfig({
      width: 400,
      height: 200,
      frames: [
        {
          input: htmlPath,
          actions: [{ type: "focus", selector: "#phone" }],
          duration: 700,
          typeResample: { selector: "#phone", text: "5551234567", speed: 50, tailMs: 200 },
        },
      ],
    });
    const svg = await composeAnimateConfig(browser!, cfg, dir);
    // Exactly one OUTER frame group; the keystroke states nest inside it.
    expect((svg.match(/class="f f-\d+"/g) ?? []).length).toBe(1);
    expect((svg.match(/<svg/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain("tr0_f-10");
  }, 120_000);
});
