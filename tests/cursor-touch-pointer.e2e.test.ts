import { afterAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { cursorOverlayMarkup, resolveCursorScript, type CursorOverlay } from "../src/animation/cursor-overlay.js";
import { launchChromium } from "../src/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

/**
 * The touch pointer as a viewer sees it: the overlay is rasterized by a real browser with its CSS
 * animations pinned to a moment, so what is asserted is painted pixels, not markup. A touch contact is a
 * disc centered on the hot point — symmetric about it — while the mouse arrow is not, and both must obey
 * the script's show/hide events.
 */
async function setup() {
  try {
    return { browser: await launchChromium() };
  } catch {
    return null;
  }
}
const env = await setup();
afterAll(async () => closeBrowserSafely(env?.browser), 15_000);
const describeBrowser = env ? describe : describe.skip;

const TOTAL = 2000;
const BG = [59, 130, 246] as const; // blue: a white ring and a dark disc both stand out
const HOT = { x: 200, y: 120 };

const script = (pointer: "mouse" | "touch"): CursorOverlay => ({
  style: { pointer },
  events: [
    { type: "show", t: 0, x: 40, y: 50 },
    { type: "move", t: 400, duration: 400, to: HOT },
    { type: "hide", t: 1500 },
  ],
});

async function paintAt(
  pointer: "mouse" | "touch",
  timeMs: number,
): Promise<{ at: (x: number, y: number) => number[] }> {
  const r = resolveCursorScript(script(pointer), TOTAL, [0], null);
  const overlay = cursorOverlayMarkup(r.positions, r.clicks, r.style, TOTAL);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="rgb(${BG.join(",")})"/>${overlay}</svg>`;
  const page = await env!.browser.newPage({ viewport: { width: 300, height: 200 } });
  try {
    await page.setContent(`<body style="margin:0">${svg}</body>`);
    await page.evaluate((t) => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = t;
      }
    }, timeMs);
    const png = await page.screenshot({ type: "png" });
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return {
      at: (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)],
    };
  } finally {
    await page.close();
  }
}

const luma = (p: number[]): number => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const bgLuma = luma([...BG]);

describeBrowser("touch pointer overlay, painted", () => {
  it("draws a dark disc with a light ring centered on the hot point", async () => {
    const shot = await paintAt("touch", 1000); // after the move has landed, before the hide
    expect(luma(shot.at(HOT.x, HOT.y)), "disc darkens the background under the contact").toBeLessThan(bgLuma - 20);
    // The ring sits at radius 14 on every side: it is lighter than the background.
    for (const [dx, dy] of [
      [14, 0],
      [-14, 0],
      [0, 14],
      [0, -14],
    ]) {
      expect(luma(shot.at(HOT.x + dx, HOT.y + dy)), `ring at (${dx},${dy})`).toBeGreaterThan(bgLuma + 25);
    }
    // Well outside the disc the background is untouched.
    expect(shot.at(HOT.x + 40, HOT.y)).toEqual([...BG]);
  });

  it("is symmetric about the hot point where the mouse arrow is not", async () => {
    const touch = await paintAt("touch", 1000);
    const mouse = await paintAt("mouse", 1000);
    const asymmetry = (shot: Awaited<ReturnType<typeof paintAt>>): number =>
      Math.abs(luma(shot.at(HOT.x + 6, HOT.y + 8)) - luma(shot.at(HOT.x - 6, HOT.y + 8))) +
      Math.abs(luma(shot.at(HOT.x + 6, HOT.y - 8)) - luma(shot.at(HOT.x - 6, HOT.y - 8)));
    expect(asymmetry(touch)).toBeLessThan(8);
    expect(asymmetry(mouse)).toBeGreaterThan(40);
  });

  it("shows the disc while the script has it visible and removes it after the hide event", async () => {
    const before = await paintAt("touch", 1000);
    expect(luma(before.at(HOT.x, HOT.y))).toBeLessThan(bgLuma - 20);
    const hidden = await paintAt("touch", 1800); // after the hide event at 1500
    expect(hidden.at(HOT.x, HOT.y)).toEqual([...BG]);
    expect(hidden.at(HOT.x + 14, HOT.y)).toEqual([...BG]);
  });

  it("moves with the pointer: at t=200 the disc is between the start and the target, not at the target", async () => {
    const early = await paintAt("touch", 200);
    expect(early.at(HOT.x, HOT.y)).toEqual([...BG]);
    expect(luma(early.at(40, 50))).toBeLessThan(bgLuma - 20);
  });
});
