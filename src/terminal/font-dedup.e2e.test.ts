import { afterAll, describe, expect, it } from "vitest";
import { launchChromium } from "../capture/index.js";
import { closeBrowserSafely } from "../test-support/close-browser-safely.js";
import { castToAnimatedSvg, castToTermFrames } from "./index.js";
import { generateAnimatedSvg } from "../animation/animator.js";

/**
 * DM-1225 regression guard: the embedded-font builder ACCUMULATES one growing
 * custom TTF across frames, so a multi-frame composer that renders each frame
 * with its own `@font-face` re-embeds a (different, partial) base64 copy per
 * frame — the bug that bloated `examples/term/sample.svg` to 54 `@font-face`
 * blocks. `castToAnimatedSvg` must emit the font ONCE; `castToTermFrames` with
 * `manageFonts: false` must defer it (no per-frame `@font-face`, empty
 * `fontFaceCss`) so a host pipeline can collect it once.
 */

// A short multi-frame cast: several settle points → several frames sharing the
// same monospace font. Without dedup, each frame would carry its own copy.
const E = "\x1b";
const ev = (t: number, d: string): string => JSON.stringify([t, "o", d]);
const CAST = [
  JSON.stringify({ version: 2, width: 40, height: 6, title: "dedup" }),
  ev(0.2, `${E}[32mline one${E}[0m\r\n`),
  ev(1.0, `${E}[33mline two${E}[0m\r\n`),
  ev(2.0, `${E}[36mline three${E}[0m\r\n`),
  ev(3.0, `${E}[1mline four${E}[0m\r\n`),
  ev(4.5, ""),
].join("\n");

const countFontFaces = (svg: string): number => (svg.match(/@font-face/g) ?? []).length;

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

describeBrowser("terminal embedded-font dedup (DM-1225)", () => {
  it("castToAnimatedSvg embeds the font once across all frames, not per frame", async () => {
    const { browser } = env!;
    const { svg, frameCount } = await castToAnimatedSvg(CAST, browser, { theme: "dark" });
    expect(frameCount).toBeGreaterThan(2); // genuinely multi-frame
    const faces = countFontFaces(svg);
    // One @font-face per font VARIANT (regular/bold/…), independent of frame
    // count — never frameCount × variants. A tiny monospace run stays in single
    // digits; the guard is that it doesn't scale with frames.
    expect(faces).toBeGreaterThan(0);
    expect(faces).toBeLessThanOrEqual(8);
    expect(faces).toBeLessThan(frameCount); // the bug had ≈ frameCount × variants
  });

  it("castToTermFrames manages fonts by default — frames carry no @font-face, css is returned once", async () => {
    const { browser } = env!;
    const { frames, fontFaceCss } = await castToTermFrames(CAST, browser, { theme: "dark" });
    expect(fontFaceCss.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.svgContent).not.toContain("@font-face");
    }
    // Re-composing with the returned css yields the font exactly once.
    const svg = generateAnimatedSvg({ width: 100, height: 60, frames, fontFaceCss });
    expect(countFontFaces(svg)).toBe(countFontFaces(fontFaceCss));
  });

  it("castToTermFrames({ manageFonts: false }) defers fonts to the host pipeline", async () => {
    const { browser } = env!;
    const { frames, fontFaceCss } = await castToTermFrames(CAST, browser, { theme: "dark", manageFonts: false });
    expect(fontFaceCss).toBe(""); // deferred — host collects it
    for (const f of frames) {
      expect(f.svgContent).not.toContain("@font-face");
    }
  });
});
