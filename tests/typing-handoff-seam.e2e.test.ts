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

// DM-1796: the typing-overlay → real-captured-field HANDOFF must be seamless.
//
// A `typing` overlay's whole purpose is to be replaced: the next frame (or the
// next state of a compressed run) `fill`s the field for real, so the same value
// is then captured page content. The overlay used to fade out starting 150 ms
// BEFORE its window ended and sit fully transparent for the last ~50 ms — so
// for ~120 ms the value was on NEITHER side of the handoff and the field read
// blank. On `examples/animate/form-fill/` that was measured as a hard hole from
// ~1780 ms to 1900 ms, reported as "the input value disappears then reappears".
//
// This is a rasterized guard, not a keyframe assertion: the failure was only
// ever visible in painted pixels, and the unit tests can be satisfied by a
// timeline that still leaves a gap once the frames composite. It samples the
// field densely across the boundary and asserts the ink NEVER drops out.

const W = 420;
const H = 200;
const TYPED = "Ada Lovelace";
// Two frames: frame 0 types into the empty field, frame 1 fills it for real.
// A `cut` between them is the handoff instant under test.
const HOLD = 1200;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;width:${W}px;height:${H}px;background:#0d1117;font:14px Menlo,monospace}
  .field{position:absolute;left:40px;top:80px;width:320px;height:34px;box-sizing:border-box;
         background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;
         font:14px Menlo,monospace;padding:8px 10px}
</style></head><body>
  <input class="field" value="" />
</body></html>`;

/** Count light (text) pixels inside the field's interior. */
async function fieldInk(page: Page, png: Buffer): Promise<number> {
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
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 110) n++;
    }
    return n;
  }, `data:image/png;base64,${png.toString("base64")}`);
}

async function setup() {
  try {
    const dir = mkdtempSync(join(tmpdir(), "dm-typing-seam-e2e-"));
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

describeBrowser("typing overlay → captured field handoff (DM-1796)", () => {
  it("never blanks the field between the typed overlay and the real captured value", async () => {
    const { browser, dir } = env!;
    const cut = { type: "cut", duration: 0 } as const;
    const cfg = validateAnimateConfig({
      width: W,
      height: H,
      // Keep the two frames as SIBLINGS so this measures the frame-boundary
      // handoff directly rather than the compressed-run state snap (that path
      // is covered by tests/overlay-window.e2e.test.ts).
      autoCompress: false,
      frames: [
        {
          input: "./page.html", duration: HOLD, transition: cut,
          actions: [{ type: "focus", selector: ".field" }],
          overlays: [{ kind: "typing", text: TYPED, x: 51, y: 102, fontSize: 14, color: "#e6edf3", speed: 55 }],
        },
        {
          continue: true, duration: HOLD, transition: cut,
          actions: [{ type: "fill", selector: ".field", value: TYPED }],
        },
      ],
    });
    const config = await composeAnimateFrames(browser, cfg, { configDir: dir, log: () => {} });
    const svg = generateAnimatedSvg(config);

    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    try {
      const viewer = await ctx.newPage();
      await loadSeekableSvg(viewer, svg);
      const clip = { x: 42, y: 82, width: 316, height: 30 }; // the field's interior
      const inkAt = async (t: number): Promise<number> => {
        await seekTo(viewer, t);
        return fieldInk(viewer, await viewer.screenshot({ clip }));
      };

      // Typing completes well before the boundary (300 ms delay + 12 × 55 ms).
      const typedInk = await inkAt(1050);
      expect(typedInk, "the overlay should have typed the value by 1050 ms").toBeGreaterThan(100);

      // Walk the handoff densely. From "fully typed" through the boundary and
      // into the next frame, the field must never lose its text. A 10 ms step
      // resolves any hole a viewer could actually perceive (< one 60 fps frame).
      const samples: Array<{ t: number; ink: number }> = [];
      for (let t = 1050; t <= HOLD + 150; t += 10) samples.push({ t, ink: await inkAt(t) });

      const blank = samples.filter((s) => s.ink === 0);
      expect(
        blank,
        `field went blank at ${blank.map((s) => `${s.t}ms`).join(", ")} — the overlay left before the captured value arrived`,
      ).toEqual([]);

      // Stronger than "not zero": it must never even THIN OUT. A partial fade
      // is the same bug wearing a smaller number, and the pre-DM-1796 timeline
      // would trip this at the fade's midpoint even where ink stayed non-zero.
      const floor = Math.min(...samples.map((s) => s.ink));
      expect(floor, "the value must not fade at the handoff").toBeGreaterThan(typedInk * 0.9);
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
