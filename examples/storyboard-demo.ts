/**
 * Showcase: the `domotion storyboard` runner (DM-1527 + DM-1552/1553/1554).
 *
 * Sequences FOUR distinct scenes end-to-end into ONE self-contained animated SVG,
 * with a different inter-scene transition between each — including the DM-1524
 * reveal set now plumbed through to storyboards (DM-1552):
 *
 *   1. title-card template   ──crossfade──▶
 *   2. live HTML/CSS capture ──wipe────────▶   (+ a per-scene typing + tap overlay)
 *   3. kinetic-text template ──zoom-in──────▶
 *   4. pre-rendered SVG (a cta card)  ──cut (loops back to scene 1)
 *
 * DM-1554: the capture scene carries per-scene overlays (a typed caption + a tap
 * ripple), and a storyboard-level cursor track glides a macOS pointer onto the
 * card and clicks — one pointer spanning scenes. DM-1553: scenes that share a font
 * embed it once (byte-identical `@font-face` payloads are collapsed).
 *
 * Each scene runs its OWN animation while it's on screen and holds otherwise —
 * the same template-frame / cast-frame embedding the `animate` pipeline uses,
 * re-anchored per scene. The output is a normal animated SVG, so it plays in an
 * `<img>` and exports to MP4 via `svg-to-video`.
 *
 *   npx tsx examples/storyboard-demo.ts   →  examples/output/storyboard-demo.svg
 */

import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "@playwright/test";
import { composeStoryboardConfig, type StoryboardConfig } from "../src/cli/storyboard.js";
import { renderTemplateToSvg } from "../src/templates/render.js";
import { loadTemplate } from "../src/templates/registry.js";

const W = 960;
const H = 540;
const OUT_DIR = resolve("examples/output");
const OUTPUT = resolve(OUT_DIR, "storyboard-demo.svg");

/** The live-capture scene: a small styled card (captured HTML/CSS → native SVG). */
const CAPTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #0b1020, #1b2a4a); color: #e6edf3; }
  .card { padding: 40px 56px; border-radius: 18px; text-align: center;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); }
  h1 { margin: 0 0 8px; font-size: 44px; letter-spacing: -0.02em; }
  p { margin: 0; font-size: 20px; color: #9fb3d1; }
</style></head><body>
  <div class="card"><h1>Live Capture Scene</h1><p>Captured HTML/CSS as native SVG</p></div>
</body></html>`;

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "domotion-storyboard-demo-"));
  writeFileSync(join(dir, "capture.html"), CAPTURE_HTML);

  const browser = await chromium.launch();
  try {
    // Scene 4 is a PRE-RENDERED svg — build it once from the `cta` template, so
    // the storyboard genuinely embeds an existing self-contained animated SVG
    // (not another live render), exercising the `svg` scene source.
    const cta = await renderTemplateToSvg(
      await loadTemplate("cta"),
      { headline: "Prebaked SVG", cta: "Ships as one file", width: W, height: H },
      { browser },
    );
    writeFileSync(join(dir, "prebaked.svg"), cta.svg);

    const config: StoryboardConfig = {
      width: W,
      height: H,
      background: "#0b1020",
      title: "Domotion storyboard demo",
      desc: "Four scenes — title card, live capture, kinetic text, and a prebaked SVG — sequenced into one animated SVG, with reveal transitions, per-scene overlays, and a scene-spanning cursor.",
      // DM-1554: one macOS pointer spanning the whole loop. It glides onto the
      // captured card during scene 2 (index 1) and clicks — canvas coordinates.
      cursor: {
        style: { scale: 1.1 },
        events: [
          { frame: 1, at: 300, type: "moveClick", to: { x: W / 2, y: H / 2 } },
          // Hide the pointer before the wipe so it doesn't linger into later scenes.
          { frame: 1, at: 2000, type: "hide" },
        ],
      },
      scenes: [
        {
          template: "title-card",
          params: { eyebrow: "DOMOTION", title: "Storyboard", subtitle: "distinct scenes into one animated SVG" },
          duration: 2600,
          transition: { type: "crossfade", duration: 400 },
        },
        {
          capture: { file: "capture.html" },
          duration: 2400,
          // DM-1552: a clip-path `wipe` reveal between scenes (was `push-left`).
          transition: { type: "wipe", duration: 500 },
          // DM-1554: per-scene overlays layered on top of the live capture — a
          // typed caption (with a blinking caret) and a tap ripple on the card.
          overlays: [
            { kind: "typing", text: "Overlays on a live capture", x: 300, y: 430, fontSize: 20, color: "#e6edf3", delay: 500, speed: 55, caret: true },
            { kind: "tap", x: W / 2, y: H / 2, delay: 1400 },
          ],
        },
        {
          template: "kinetic-text",
          params: { text: "Native. Crisp. Self-contained." },
          duration: 2600,
          // DM-1552: a `zoom-in` scale dolly hands off into the next scene.
          transition: { type: "zoom-in", duration: 500 },
        },
        {
          // `cta` plays for ~4000ms (reveal + pulse loop) — size the scene to it.
          svg: "prebaked.svg",
          duration: 4000,
          transition: { type: "cut", duration: 0 },
        },
      ],
    };

    const svg = await composeStoryboardConfig(browser, config, dir, (m) => console.log(m));
    writeFileSync(OUTPUT, svg);
    console.log(`Generated: ${OUTPUT} (${W}×${H}px, ${(svg.length / 1024).toFixed(1)} KB)`);
  } finally {
    await browser.close();
  }
}

void main();
