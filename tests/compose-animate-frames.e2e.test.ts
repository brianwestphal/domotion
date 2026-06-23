import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChromium } from "../src/capture/index.js";
import {
  composeAnimateConfig,
  composeAnimateFrames,
  validateAnimateConfig,
} from "../src/cli/animate.js";
import { generateAnimatedSvg } from "../src/animation/index.js";
import { closeBrowserSafely } from "../src/test-support/close-browser-safely.js";

// DM-1137 (doc 62 §1): `composeAnimateFrames` runs the same capture→compose
// pipeline as `composeAnimateConfig` but stops before `generateAnimatedSvg`,
// returning the assembled `AnimationConfig` so callers can mutate the frames
// before rendering. `composeAnimateConfig` is reduced to
// `generateAnimatedSvg(await composeAnimateFrames(…))` — one engine, two callers.

const PAGE = (label: string, color: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `body{margin:0;width:200px;height:120px;background:${color};font:20px sans-serif}` +
  `</style></head><body><h1>${label}</h1></body></html>`;

// Normalize the embedded-font base64 bytes (the only run-to-run varying part —
// same approach as the animate-examples golden harness) before a byte compare.
const normFonts = (svg: string) =>
  svg.replace(/data:font\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:font/ttf;base64,__FONT__");

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

describeBrowser("composeAnimateFrames (DM-1137)", () => {
  it("returns the assembled AnimationConfig; mutating it before render is reflected; and composeAnimateConfig == frames-out + render", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(path.join(tmpdir(), "compose-frames-"));
    try {
      writeFileSync(path.join(dir, "a.html"), PAGE("Frame A", "#fff"));
      writeFileSync(path.join(dir, "b.html"), PAGE("Frame B", "#eee"));
      const rawCfg = {
        width: 200, height: 120,
        frames: [
          { input: "a.html", duration: 500 },
          { input: "b.html", duration: 500 },
        ],
      };

      // 1. Frames-out: a mutable AnimationConfig, not a rendered string.
      const config = await composeAnimateFrames(browser, validateAnimateConfig(rawCfg), dir, () => {});
      expect(config.width).toBe(200);
      expect(config.height).toBe(120);
      expect(config.frames).toHaveLength(2);
      for (const f of config.frames) expect(typeof f.svgContent).toBe("string");

      // 2. Rendering it is valid SVG with two frame timelines.
      const full = generateAnimatedSvg(config);
      expect(full).toContain("<svg");
      const kfFull = (full.match(/@keyframes/g) ?? []).length;

      // 3. Mutate (drop the second frame) → the render reflects it (strictly
      //    fewer keyframe blocks, different output). This is the whole point of
      //    the frames-out variant.
      const dropped = generateAnimatedSvg({ ...config, frames: config.frames.slice(0, 1) });
      const kfDropped = (dropped.match(/@keyframes/g) ?? []).length;
      expect(kfDropped).toBeLessThan(kfFull);
      expect(dropped).not.toBe(full);

      // 4. composeAnimateConfig is byte-identical to frames-out + render (one
      //    engine — modulo the run-varying embedded-font bytes, normalized).
      const viaConfig = await composeAnimateConfig(browser, validateAnimateConfig(rawCfg), dir, () => {});
      const viaFrames = generateAnimatedSvg(await composeAnimateFrames(browser, validateAnimateConfig(rawCfg), dir, () => {}));
      expect(normFonts(viaConfig)).toBe(normFonts(viaFrames));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  // DM-1287 (doc 73): a `template` frame embeds a named template's animated SVG
  // as one frame, namespaced so its document-global names don't collide with the
  // outer animation or sibling frames.
  it("embeds a template frame alongside an html frame without name collisions", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(path.join(tmpdir(), "template-frame-"));
    try {
      writeFileSync(path.join(dir, "intro.html"), PAGE("Intro", "#0d1117"));
      const rawCfg = {
        width: 320, height: 180,
        frames: [
          { input: "intro.html", duration: 800, transition: { type: "crossfade", duration: 200 } },
          {
            template: "lower-third",
            params: { title: "Ada Lovelace", subtitle: "First Programmer", holdMs: 1200 },
            duration: 1200,
            transition: { type: "cut", duration: 0 },
          },
        ],
      };

      const svg = await composeAnimateConfig(browser, validateAnimateConfig(rawCfg), dir, () => {});

      // The template rendered: its title text is present (the renderer emits the
      // string as an aria-label on the glyph group).
      expect(svg).toContain("Ada Lovelace");
      // The template frame's content was namespaced with its per-frame token.
      expect(svg).toContain("tf1_");

      // No two `@font-face` blocks share a family name — the whole point of the
      // namespacing pass. A duplicate would make a later @font-face win and
      // reshape the OTHER frame's text to the wrong glyphs.
      const families = [...svg.matchAll(/@font-face\s*\{[^}]*?font-family:\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(families.length).toBeGreaterThanOrEqual(2);
      expect(new Set(families).size).toBe(families.length);

      // Likewise no duplicate `@keyframes` name across the merged document.
      const kf = [...svg.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      expect(new Set(kf).size).toBe(kf.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  // DM-1138 (doc 62 §2): the per-frame onFrame hook + options-object signature.
  it("fires onFrame once per frame (correct index/tree) and reflects a frame.overlays mutation", async () => {
    const { browser } = env!;
    const dir = mkdtempSync(path.join(tmpdir(), "onframe-"));
    try {
      writeFileSync(path.join(dir, "a.html"), PAGE("Frame A", "#fff"));
      writeFileSync(path.join(dir, "b.html"), PAGE("Frame B", "#eee"));
      const rawCfg = {
        width: 200, height: 120,
        frames: [{ input: "a.html", duration: 500 }, { input: "b.html", duration: 500 }],
      };

      const seen: Array<{ index: number; treeNull: boolean; framePushed: boolean }> = [];
      // Options-object signature: `{ configDir, onFrame }` as the 3rd argument.
      const svg = await composeAnimateConfig(browser, validateAnimateConfig(rawCfg), {
        configDir: dir,
        onFrame: (frame, ctx) => {
          seen.push({
            index: ctx.index,
            treeNull: ctx.tree == null,
            framePushed: typeof frame.svgContent === "string",
          });
          // Mutate the just-pushed frame's overlays on frame 0 — must land in the SVG.
          if (ctx.index === 0) {
            frame.overlays = [
              ...(frame.overlays ?? []),
              { kind: "svg", innerSvg: '<rect width="4" height="4"/>', x: 1, y: 1, width: 4, height: 4, animId: "onframemarker" },
            ];
          }
        },
      });

      // Fired once per frame, in order, after each was pushed (svgContent present).
      expect(seen.map((s) => s.index)).toEqual([0, 1]);
      expect(seen.every((s) => s.framePushed)).toBe(true);
      // Non-scroll frames expose their captured tree (non-null).
      expect(seen.every((s) => !s.treeNull)).toBe(true);
      // The overlay added inside the hook is reflected in the final SVG (the
      // animator prefixes the wrapper class with the frame index → `ov-0-…`).
      expect(svg).toContain("onframemarker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
