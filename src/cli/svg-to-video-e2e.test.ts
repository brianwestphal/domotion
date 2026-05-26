import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchChromium } from "../index.js";
import { runSvgToVideo } from "./svg-to-video-core.js";

// DM-882: end-to-end coverage for the svg-to-video render path (Playwright
// frame-stepping → ffmpeg), complementing the pure-helper unit tests. Gated on
// ffmpeg being installed — skips cleanly otherwise (like the glyph-helper tests
// skip when their binary is absent), so it's inert on machines/CI without it.

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const describeE2E = ffmpegAvailable ? describe : describe.skip;

// A tiny CSS-keyframe-animated SVG: a square slides left→right over 1s. Stepping
// the timeline must produce genuinely different frames (the regression we guard:
// Playwright's screenshot `animations:"disabled"` would freeze every frame).
const ANIMATED_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">` +
  `<style>@keyframes slide { from { transform: translateX(0) } to { transform: translateX(60px) } }` +
  `.box { animation: slide 1s linear infinite }</style>` +
  `<rect class="box" x="0" y="35" width="30" height="30" fill="#e91e63"/>` +
  `</svg>`;

function ffprobe(file: string): Record<string, string> {
  const p = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0",
     "-show_entries", "stream=codec_name,width,height,nb_read_frames",
     "-count_frames", "-of", "default=noprint_wrappers=1", file],
    { encoding: "utf-8" },
  );
  const out: Record<string, string> = {};
  for (const line of p.stdout.split("\n")) {
    const [k, v] = line.split("=");
    if (k && v != null) out[k.trim()] = v.trim();
  }
  return out;
}

describeE2E("svg-to-video end-to-end (ffmpeg present)", () => {
  it("renders an animated SVG to an mp4 with the right geometry and genuinely-differing frames", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.mp4");
    const framesDir = path.join(dir, "frames");
    writeFileSync(input, ANIMATED_SVG);

    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1, // 4 frames
        format: "h264",
        scale: 1,
        background: "#ffffff",
        burnCaptions: false,
        keepFrames: framesDir,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: () => {},
        launchBrowser: () => launchChromium(),
      });

      // ffprobe: h264, 100×100, 4 frames.
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("h264");
      expect(Number(meta.width)).toBe(100);
      expect(Number(meta.height)).toBe(100);
      expect(Number(meta.nb_read_frames)).toBe(4);

      // The kept PNG sequence must contain ≥2 distinct frames — proves the
      // animation timeline was actually stepped (not frozen by the screenshot).
      const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png"));
      expect(frames.length).toBe(4);
      const hashes = new Set(frames.map((f) => createHash("md5").update(readFileSync(path.join(framesDir, f))).digest("hex")));
      expect(hashes.size).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("fails with install guidance when ffmpeg is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-"));
    const input = path.join(dir, "anim.svg");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await expect(
        runSvgToVideo({
          input,
          output: path.join(dir, "out.mp4"),
          fps: 4,
          durationSec: 1,
          format: "h264",
          scale: 1,
          background: "#ffffff",
          burnCaptions: false,
          ffmpegPath: "/nonexistent/ffmpeg-xyz",
          quiet: true,
          log: () => {},
          launchBrowser: () => launchChromium(),
        }),
      ).rejects.toThrow(/ffmpeg not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
