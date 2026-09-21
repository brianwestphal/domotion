import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { runAnimate } from "../src/cli/animate.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-6SQXGF: `animate --real-text` appends the paintless real-text layer to
// EACH frame, inside the frame's `<g class="f f-N">` wrapper. Because the
// animator toggles that wrapper's `visibility` (DM-641), only the ACTIVE frame's
// authored text is exposed to Find-in-Page / AT — hidden frames' text is
// `visibility:hidden`, which Chrome's find skips. The layer is paintless, so the
// visible output is byte-identical to a non-real-text render (zero visual regions).

async function canLaunch(): Promise<Awaited<ReturnType<typeof launchChromium>> | null> {
  try {
    return await launchChromium();
  } catch {
    return null;
  }
}

const probe = await canLaunch();
if (probe) await closeBrowserSafely(probe); // runAnimate owns its own browser.

const dir = mkdtempSync(join(tmpdir(), "domotion-animate-real-text-"));
const style = `*{margin:0}body{background:#fff;color:#111}.a{padding:24px;font:600 24px/1.4 Arial,sans-serif}`;
const f1 = join(dir, "f1.html");
const f2 = join(dir, "f2.html");
writeFileSync(f1, `<!doctype html><meta charset="utf-8"><style>${style}</style><div class="a">FirstFrameWord</div>`);
writeFileSync(f2, `<!doctype html><meta charset="utf-8"><style>${style}</style><div class="a">SecondFrameWord</div>`);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function animate(realText: boolean): Promise<string> {
  const cfg = {
    width: 480,
    height: 160,
    frames: [
      { input: f1, duration: 400 },
      { input: f2, duration: 400 },
    ],
    ...(realText ? { realText: true } : {}),
  };
  const cfgPath = join(dir, `cfg-${realText}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.svg`);
  await runAnimate([cfgPath, "--quiet", "-o", out], "");
  return readFileSync(out, "utf8");
}

const describeBrowser = probe ? describe : describe.skip;

describeBrowser("animate --real-text (DM-6SQXGF)", () => {
  it("appends one real-text layer per frame, each carrying that frame's text", async () => {
    const svg = await animate(true);
    const layers = svg.match(/data-domotion-real-text-layer="true"/g) ?? [];
    expect(layers.length).toBe(2); // one per frame
    expect(svg).toContain("FirstFrameWord");
    expect(svg).toContain("SecondFrameWord");
    // The real text is authored <text>, not glyph <path>, in the layer.
    expect(svg).toMatch(/data-domotion-real-text-layer="true"[\s\S]*<text/);
  }, 60_000);

  it("exposes only the ACTIVE frame's text to Find-in-Page (hidden frames are visibility:hidden)", async () => {
    const svg = await animate(true);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Pause all animations so frame 0 stays the active (visibility:visible) one.
      await page.setContent(
        `<!doctype html><style>*{animation-play-state:paused !important}</style>` +
          `<body style="margin:0;background:#fff">${svg}</body>`,
      );
      const found = await page.evaluate(() => {
        const sel = () => {
          const s = window.getSelection();
          s && s.removeAllRanges();
        };
        sel();
        const first = window.find("FirstFrameWord");
        sel();
        const second = window.find("SecondFrameWord");
        sel();
        return { first, second };
      });
      expect(found.first).toBe(true); // active frame — findable
      expect(found.second).toBe(false); // hidden frame — visibility:hidden, skipped
    } finally {
      await browser.close();
    }
  }, 60_000);

  it("is paintless: real-text adds zero visual regions vs a plain render", async () => {
    const [withRt, withoutRt] = [await animate(true), await animate(false)];
    const browser = await chromium.launch();
    try {
      const shoot = async (svg: string): Promise<Buffer> => {
        const page = await browser.newPage({ viewport: { width: 480, height: 160 } });
        await page.setContent(
          `<!doctype html><style>*{animation-play-state:paused !important}</style>` +
            `<body style="margin:0;background:#fff">${svg}</body>`,
        );
        const buf = await page.screenshot({ clip: { x: 0, y: 0, width: 480, height: 160 } });
        await page.close();
        return buf;
      };
      const [a, b] = [await shoot(withRt), await shoot(withoutRt)];
      expect(a.equals(b)).toBe(true); // pixel-identical — the layer paints nothing
    } finally {
      await browser.close();
    }
  }, 60_000);
});
