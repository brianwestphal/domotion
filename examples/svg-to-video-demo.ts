/**
 * Example: convert a domotion-animated SVG to an mp4 with `svg-to-video`.
 *
 * Renders the showcase-transitions animated SVG (produced by
 * `showcase-transitions.ts`) to an h264/mp4 by stepping its CSS-keyframe
 * timeline frame by frame through Chromium and piping to ffmpeg.
 *
 * Requires ffmpeg on PATH; if it's missing this demo skips cleanly (so it can
 * sit in the `demos:examples` chain without breaking dev machines without it).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { launchChromium } from "../src/index.js";
import { runSvgToVideo } from "../src/cli/svg-to-video-core.js";

const OUT_DIR = resolve("examples/output");
const INPUT = resolve(OUT_DIR, "showcase-transitions.svg");
const OUTPUT = resolve(OUT_DIR, "showcase-transitions.mp4");

async function main(): Promise<void> {
  if (spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status !== 0) {
    console.log("[svg-to-video-demo] ffmpeg not found — skipping. Install it to run this demo: brew / apt-get / winget install ffmpeg.");
    return;
  }
  if (!existsSync(INPUT)) {
    console.log(`[svg-to-video-demo] ${INPUT} not found — run showcase-transitions.ts first (it's earlier in the demos:examples chain).`);
    return;
  }

  await runSvgToVideo({
    input: INPUT,
    output: OUTPUT,
    width: 640, // contained to 640px wide; height follows the SVG aspect
    fps: 30,
    format: "h264",
    container: "mp4",
    scale: 2, // supersample for crisper text, downscaled by ffmpeg
    background: "#0d1117", // match the showcase canvas
    burnCaptions: false,
    ffmpegPath: "ffmpeg",
    quiet: false,
    log: (m) => console.log(`[svg-to-video-demo] ${m}`),
    launchBrowser: () => launchChromium(),
  });
  console.log(`[svg-to-video-demo] wrote ${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
