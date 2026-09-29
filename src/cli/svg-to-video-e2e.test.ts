import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,nb_read_frames,pix_fmt:stream_tags=alpha_mode",
      "-count_frames",
      "-of",
      "default=noprint_wrappers=1",
      file,
    ],
    { encoding: "utf-8" },
  );
  const out: Record<string, string> = {};
  for (const line of p.stdout.split("\n")) {
    const [k, v] = line.split("=");
    // ffprobe prints stream tags as `TAG:alpha_mode=1` — normalize to the bare key.
    if (k && v != null) out[k.trim().replace(/^TAG:/, "")] = v.trim();
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
      const hashes = new Set(
        frames.map((f) =>
          createHash("md5")
            .update(readFileSync(path.join(framesDir, f)))
            .digest("hex"),
        ),
      );
      expect(hashes.size).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders an animated GIF via the palette flow with the right geometry + frame count (DM-885)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-gif-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.gif");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1, // 4 frames; 4 divides 100 → exact GIF timing
        format: "gif",
        scale: 1,
        background: "#ffffff",
        burnCaptions: false,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: () => {},
        launchBrowser: () => launchChromium(),
      });
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("gif");
      expect(Number(meta.width)).toBe(100);
      expect(Number(meta.height)).toBe(100);
      expect(Number(meta.nb_read_frames)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("renders an animated APNG via the apng encoder (DM-885)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-apng-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.png");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1,
        format: "apng",
        scale: 1,
        background: "#ffffff",
        burnCaptions: false,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: () => {},
        launchBrowser: () => launchChromium(),
      });
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("apng");
      expect(Number(meta.width)).toBe(100);
      expect(Number(meta.height)).toBe(100);
      expect(Number(meta.nb_read_frames)).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // DM-1142: transparent-background / alpha output.
  it("emits an alpha channel for a transparent ProRes 4444 (.mov)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-prores-alpha-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.mov");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1,
        format: "prores",
        scale: 1,
        background: "transparent",
        burnCaptions: false,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: () => {},
        launchBrowser: () => launchChromium(),
      });
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("prores");
      // ProRes 4444 alpha pixel format (ffmpeg may widen 10le → 12le).
      expect(meta.pix_fmt).toMatch(/^yuva444p/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("tags a transparent VP9 webm with alpha_mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-vp9-alpha-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.webm");
    writeFileSync(input, ANIMATED_SVG);
    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1,
        format: "vp9",
        scale: 1,
        background: "transparent",
        burnCaptions: false,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: () => {},
        launchBrowser: () => launchChromium(),
      });
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("vp9");
      // The webm carries alpha via the Matroska alpha_mode tag (browsers render
      // it transparent; ffmpeg's own decode round-trip is lossy, so we assert the
      // container signaling rather than a decoded pixel).
      expect(meta.alpha_mode).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("warns + composites onto opaque white when a non-alpha format gets a transparent background", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-h264-alpha-"));
    const input = path.join(dir, "anim.svg");
    const output = path.join(dir, "out.mp4");
    writeFileSync(input, ANIMATED_SVG);
    const notes: string[] = [];
    try {
      await runSvgToVideo({
        input,
        output,
        width: 100,
        height: 100,
        fps: 4,
        durationSec: 1,
        format: "h264",
        scale: 1,
        background: "transparent",
        burnCaptions: false,
        ffmpegPath: "ffmpeg",
        quiet: true,
        log: (m: string) => notes.push(m),
        launchBrowser: () => launchChromium(),
      });
      const meta = ffprobe(output);
      expect(meta.codec_name).toBe("h264");
      expect(meta.pix_fmt).toBe("yuv420p"); // opaque — no alpha
      expect(notes.some((n) => /can't carry an alpha channel/.test(n))).toBe(true);
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

// A stub "ffmpeg" (a node script) answers `-version` so `findFfmpeg` accepts it, then
// misbehaves like a real ffmpeg that failed or flooded stderr. POSIX only: it relies on a
// shebang, and it needs Chromium but not a real ffmpeg.
const describeStub = process.platform === "win32" ? describe.skip : describe;

describeStub("svg-to-video with a misbehaving ffmpeg (stub)", () => {
  function stubFfmpeg(dir: string, body: string): string {
    const file = path.join(dir, "ffmpeg-stub.js");
    writeFileSync(
      file,
      `#!/usr/bin/env node\nif (process.argv.includes("-version")) { console.log("ffmpeg version stub"); process.exit(0); }\n${body}\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }

  async function run(ffmpegPath: string, dir: string): Promise<{ error: Error | undefined; browserClosed: boolean }> {
    const input = path.join(dir, "anim.svg");
    writeFileSync(input, ANIMATED_SVG);
    let browserClosed = false;
    try {
      await runSvgToVideo({
        input,
        output: path.join(dir, "out.mp4"),
        fps: 4,
        durationSec: 1,
        format: "h264",
        scale: 1,
        background: "#ffffff",
        burnCaptions: false,
        ffmpegPath,
        quiet: true,
        log: () => {},
        launchBrowser: async () => {
          const browser = await launchChromium();
          const close = browser.close.bind(browser);
          browser.close = async () => {
            browserClosed = true;
            await close();
          };
          return browser;
        },
      });
      return { error: undefined, browserClosed };
    } catch (error) {
      return { error: error as Error, browserClosed };
    }
  }

  it("surfaces ffmpeg's own exit error and still closes the browser when ffmpeg exits non-zero early", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-"));
    try {
      const stub = stubFfmpeg(dir, 'process.stderr.write("stub: unwritable output\\n"); process.exit(1);');
      const { error, browserClosed } = await run(stub, dir);
      expect(error?.message).toMatch(/ffmpeg exited 1: .*stub: unwritable output/s);
      expect(browserClosed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not hang when ffmpeg floods stderr in --quiet mode", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "svg2vid-"));
    try {
      // fs.writeSync blocks on a full pipe, so an undrained stderr pipe would stall the stub.
      const stub = stubFfmpeg(
        dir,
        'const fs = require("fs"); const chunk = "frame= 1 fps=1 size=0kB\\n".repeat(4000);' +
          "for (let i = 0; i < 20; i++) fs.writeSync(2, chunk);" +
          'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
      );
      const { error, browserClosed } = await run(stub, dir);
      expect(error).toBeUndefined();
      expect(browserClosed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
