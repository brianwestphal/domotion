import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { launchChromium } from "../src/capture/index.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { composeAnimateFrames, validateAnimateConfig } from "../src/cli/animate.js";
import { seekTo } from "../src/cli/svg-to-video-core.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";
import { PARITY_LAUNCH_OPTS, loadSeekableSvg } from "./flipbook-parity.js";

// DM-1767 (docs/104): the explicit per-overlay window + per-state anchor
// resolution, exercised end-to-end through the REAL `composeAnimateFrames`
// pipeline and verified by RASTERIZING the composed SVG (never by reasoning
// over the config alone — the verify-the-rendered-SVG rule).
//
// The scene is three plain `continue` + `cut` frames, which `autoCompress`
// collapses into ONE compressed run. The middle frame carries a `blink` overlay
// anchored to an element that MOVES between states. Both halves of the contract
// are then observable in painted pixels:
//
//   • the window — the overlay is on screen during ITS state only, not for the
//     whole collapsed run (which is what a frame-scoped lifetime would give);
//   • the anchor — it paints where the element was in ITS state, not where the
//     element ends up in the run's LAST state (the page's final position, which
//     is all a once-per-frame anchor resolution could ever see).

const W = 400;
const H = 160;
const HOLD = 300;
/** The `#target` box's left edge in state k — `move(k)` steps it 100 px right. */
const LEFT_AT = (k: number): number => 40 + k * 100;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#ffffff;overflow:hidden}
  #target{position:absolute;top:60px;left:${LEFT_AT(0)}px;width:40px;height:24px;background:#0f172a}
</style></head><body>
  <div id="target"></div>
<script>
  window.move = (k) => { document.getElementById("target").style.left = (40 + k * 100) + "px"; };
</script></body></html>`;

/** Bounding box + count of the magenta overlay's pixels in a PNG buffer. */
async function scanMagenta(page: Page, png: Buffer): Promise<{ minX: number; maxX: number; count: number }> {
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return page.evaluate(async (uri: string) => {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("png decode failed"));
      img.src = uri;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    let minX = Infinity, maxX = -Infinity, count = 0;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4;
        // Magenta: strong red + blue, weak green.
        if (d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90) {
          count++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    return { minX, maxX, count };
  }, dataUri);
}

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-overlay-window-e2e-"));
    writeFileSync(join(dir, "page.html"), PAGE_HTML);
    return { browser: await launchChromium(PARITY_LAUNCH_OPTS), dir };
  } catch {
    return null;
  }
}

const env = await setup();
afterAll(async () => {
  await closeBrowserSafely(env?.browser);
  if (env != null) rmSync(env.dir, { recursive: true, force: true });
}, 15_000);

const describeBrowser = env ? describe : describe.skip;

describeBrowser("per-overlay window + per-state anchors inside a compressed run (DM-1767)", () => {
  it("collapses a run whose member carries an anchored overlay, and paints it in that state only, at that state's layout", async () => {
    const { browser, dir } = env!;
    const cut = { type: "cut", duration: 0 } as const;
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      frames: [
        { input: "./page.html", duration: HOLD, transition: cut },
        {
          continue: true, duration: HOLD, transition: cut,
          actions: [{ type: "evaluate", script: "move(1)" }],
          // A long period keeps the blink "on" for the whole window, so a miss
          // is a genuine absence rather than an unlucky sample of the toggle.
          overlays: [{
            kind: "blink", width: 40, height: 24, color: "#ff00ff", periodMs: 100_000,
            anchor: { selector: "#target", at: "top-left" },
          }],
        },
        { continue: true, duration: HOLD, transition: cut, actions: [{ type: "evaluate", script: "move(2)" }] },
      ],
    });
    const logs: string[] = [];
    const config = await composeAnimateFrames(browser, cfg, { configDir: dir, log: (m) => logs.push(m) });

    // The overlay no longer splits the window: all three frames collapse into
    // ONE compressed run (before DM-1767 this was 3 sibling frames).
    expect(config.frames, logs.join("\n")).toHaveLength(1);
    expect(logs.some((l) => /auto-compress: collapsed frames 0–2 into a states run \(3 states/.test(l))).toBe(true);
    // The overlay rides the collapsed frame, re-based onto the run's timeline:
    // it starts at state 1's offset and ends at state 1's end.
    expect(config.frames[0].overlays).toHaveLength(1);
    expect(config.frames[0].overlays?.[0]).toMatchObject({ kind: "blink", delay: HOLD, endAt: 2 * HOLD });

    const svg = generateAnimatedSvg(config);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const viewer = await ctx.newPage();
      await loadSeekableSvg(viewer, svg);
      const shot = async (tMs: number): Promise<Buffer> => {
        await seekTo(viewer, tMs);
        return viewer.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
      };
      const at = async (tMs: number) => scanMagenta(viewer, await shot(tMs));

      // State 0 (before the overlay's state) — nothing painted.
      expect((await at(HOLD / 2)).count, "state 0 should have no overlay").toBe(0);
      // State 1 — the overlay is on screen…
      const on = await at(HOLD + HOLD / 2);
      expect(on.count, "state 1 should paint the overlay").toBeGreaterThan(400);
      // …anchored to where `#target` sits in STATE 1, not where it ends up in
      // state 2. A once-per-frame anchor resolution would land it at LEFT_AT(2).
      expect(on.minX).toBeGreaterThanOrEqual(LEFT_AT(1) - 2);
      expect(on.minX).toBeLessThanOrEqual(LEFT_AT(1) + 2);
      expect(on.maxX).toBeLessThan(LEFT_AT(2));
      // State 2 — the window closed with state 1's snap. Without the explicit
      // per-overlay window this would hold to the end of the whole run.
      expect((await at(2 * HOLD + HOLD / 2)).count, "state 2 should have no overlay").toBe(0);
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
