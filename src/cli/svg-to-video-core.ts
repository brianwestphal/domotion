/**
 * `svg-to-video` core — render an animated SVG to a video file.
 *
 * The hard part of SVG→video is sampling the animation at exact times rather
 * than racing the wall clock. We render the SVG in Playwright Chromium (so the
 * output stays pixel-faithful to Chromium, the same engine Domotion captures
 * with), pause every animation, and step `currentTime` per frame:
 *   - CSS / Web-Animations: `document.getAnimations()` → `pause()` + set
 *     `currentTime` (ms). This is what `domotion animate` SVGs use.
 *   - SMIL (`<animate>`): `svg.pauseAnimations()` + `svg.setCurrentTime(s)`.
 *   - JS / requestAnimationFrame-driven animation is out of scope (it can't be
 *     stepped without clock virtualization).
 * Frames are piped to ffmpeg (image2pipe) and encoded; ffmpeg is a hard runtime
 * requirement (not bundled). See docs/47-svg-to-video.md.
 *
 * This module holds the orchestration plus pure helpers (`fitContain`,
 * `resolveDurationMs`, `resolveFormat`, `buildFfmpegArgs`, `findFfmpeg`,
 * `checkDiskSpace`) that are unit-tested without spawning Chromium/ffmpeg.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Browser } from "@playwright/test";

export interface SvgToVideoOptions {
  input: string;
  output: string;
  width?: number;
  height?: number;
  fps: number;
  durationSec?: number;
  format: string;
  container?: string;
  scale: number;
  background: string;
  music?: string;
  audio?: string;
  audioOffsetSec?: number;
  captions?: string;
  burnCaptions: boolean;
  keepFrames?: string;
  ffmpegPath: string;
  quiet: boolean;
  log: (msg: string) => void;
  /** Injected so tests / callers can supply their own Chromium bring-up. */
  launchBrowser: () => Promise<Browser>;
}

// ── pure helpers ────────────────────────────────────────────────────────────

/** Round up to the nearest even integer ≥ 2 (h264 yuv420p needs even W/H). */
function toEven(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r % 2 === 0 ? r : r + 1;
}

/**
 * Fit a natural size inside an optional max box, preserving aspect ratio
 * (CSS `contain`). With neither bound given, the natural size is used. Result
 * dimensions are forced to even integers.
 */
export function fitContain(
  naturalW: number,
  naturalH: number,
  maxW?: number,
  maxH?: number,
): { width: number; height: number } {
  if (!(naturalW > 0) || !(naturalH > 0)) {
    throw new Error(`SVG has no intrinsic size (got ${naturalW}×${naturalH}); pass --width/--height.`);
  }
  let w = naturalW;
  let h = naturalH;
  if (maxW != null || maxH != null) {
    const sw = maxW != null ? maxW / naturalW : Infinity;
    const sh = maxH != null ? maxH / naturalH : Infinity;
    const s = Math.min(sw, sh);
    w = naturalW * s;
    h = naturalH * s;
  }
  return { width: toEven(w), height: toEven(h) };
}

/**
 * Read the intrinsic size from SVG markup: `viewBox` width/height preferred
 * (the true coordinate extent), else the `width`/`height` attributes with units
 * stripped. Returns null when neither is present (caller then requires explicit
 * --width/--height).
 */
export function parseSvgIntrinsicSize(markup: string): { w: number; h: number } | null {
  const open = markup.match(/<svg\b[^>]*>/i);
  const tag = open ? open[0] : markup;
  const viewBox = tag.match(/\bviewBox\s*=\s*["']\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s*["']/);
  if (viewBox) {
    const w = Number(viewBox[3]);
    const h = Number(viewBox[4]);
    if (w > 0 && h > 0) return { w, h };
  }
  const wAttr = tag.match(/\bwidth\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i);
  const hAttr = tag.match(/\bheight\s*=\s*["']\s*([\d.]+)\s*(?:px)?\s*["']/i);
  if (wAttr && hAttr) {
    const w = Number(wAttr[1]);
    const h = Number(hAttr[1]);
    if (w > 0 && h > 0) return { w, h };
  }
  return null;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}
function lcm(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs(a / gcd(a, b) * b);
}

export interface AnimTiming {
  /** single-iteration duration, ms */
  duration: number;
  /** iteration count (may be Infinity) */
  iterations: number;
  /** computed end time (delay + active + endDelay), ms; Infinity if infinite */
  endTime: number;
}

/**
 * Resolve how many milliseconds of timeline to render.
 *   - explicit `overrideSec` wins.
 *   - otherwise: the max finite end time, and for infinite (looping) animations
 *     the LCM of their iteration periods (one full cycle of the loop). For
 *     `domotion animate` SVGs every animation shares one period, so the LCM is
 *     just that period.
 * Throws (asking for --duration) when nothing finite can be derived or the
 * derived value exceeds `maxAutoMs` (incommensurate infinite periods).
 */
export function resolveDurationMs(
  anims: AnimTiming[],
  overrideSec?: number,
  maxAutoMs = 600_000,
): number {
  if (overrideSec != null) {
    if (!(overrideSec > 0)) throw new Error(`--duration must be positive, got ${overrideSec}`);
    return Math.round(overrideSec * 1000);
  }
  if (anims.length === 0) {
    throw new Error("No animations found in the SVG, and no --duration given — nothing to render. Pass --duration <seconds>.");
  }
  let finiteEnd = 0;
  const infinitePeriods: number[] = [];
  for (const a of anims) {
    if (!Number.isFinite(a.iterations)) {
      if (a.duration > 0) infinitePeriods.push(Math.round(a.duration));
    } else if (Number.isFinite(a.endTime)) {
      finiteEnd = Math.max(finiteEnd, a.endTime);
    }
  }
  let total = finiteEnd;
  if (infinitePeriods.length > 0) {
    let cycle = infinitePeriods[0];
    for (let i = 1; i < infinitePeriods.length; i++) cycle = lcm(cycle, infinitePeriods[i]);
    total = Math.max(total, cycle);
  }
  if (!(total > 0)) {
    throw new Error("Could not determine a finite animation duration — pass --duration <seconds>.");
  }
  if (total > maxAutoMs) {
    throw new Error(
      `Derived a ${(total / 1000).toFixed(1)}s loop (animations with incommensurate periods) which exceeds the ${(maxAutoMs / 1000) | 0}s auto cap — pass --duration <seconds> explicitly.`,
    );
  }
  return total;
}

export interface ResolvedFormat {
  videoCodec: string;
  container: string;
  pixFmt: string;
}

const FORMAT_MAP: Record<string, { codec: string; container: string; pixFmt: string }> = {
  h264: { codec: "libx264", container: "mp4", pixFmt: "yuv420p" },
  avc: { codec: "libx264", container: "mp4", pixFmt: "yuv420p" },
  hevc: { codec: "libx265", container: "mp4", pixFmt: "yuv420p" },
  h265: { codec: "libx265", container: "mp4", pixFmt: "yuv420p" },
  vp9: { codec: "libvpx-vp9", container: "webm", pixFmt: "yuv420p" },
  vp8: { codec: "libvpx", container: "webm", pixFmt: "yuv420p" },
  av1: { codec: "libaom-av1", container: "mp4", pixFmt: "yuv420p" },
  // Animated-image formats (DM-885). These take a distinct ffmpeg path in
  // `buildFfmpegArgs` (no audio/soft-caption track): GIF via a palette
  // filtergraph, APNG via the apng encoder. The `container` value `gif`/`apng`
  // is the branch discriminant. pixFmt is unused for gif (the palette graph
  // sets it); rgba for apng preserves the alpha the encoder supports.
  gif: { codec: "gif", container: "gif", pixFmt: "pal8" },
  apng: { codec: "apng", container: "apng", pixFmt: "rgba" },
};

/** True for the animated-image formats that take the palette/apng path. */
export function isAnimatedImageContainer(container: string): boolean {
  return container === "gif" || container === "apng";
}

/** Map a `--format` keyword to an ffmpeg codec + default container + pix_fmt. */
export function resolveFormat(format: string, containerOverride?: string): ResolvedFormat {
  const f = FORMAT_MAP[format.toLowerCase()];
  if (!f) {
    throw new Error(`Unsupported --format "${format}". Known: ${Object.keys(FORMAT_MAP).join(", ")}.`);
  }
  // A container override is meaningless for gif/apng (the format *is* the
  // container) — ignore it so `--format gif --container mp4` can't desync.
  const container = isAnimatedImageContainer(f.container) ? f.container : containerOverride ?? f.container;
  return { videoCodec: f.codec, container, pixFmt: f.pixFmt };
}

// ffmpeg's subtitles filter treats `\ : ' [ ] ,` specially in the path: `\` and
// `:` / `'` for the filter's own option parser, and `[ ] ,` for the surrounding
// filtergraph (where they delimit filter labels / options / chain entries). `\`
// must be escaped first so the later-added backslashes aren't doubled.
function escapeSubtitlesPath(p: string): string {
  return p
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,");
}

export interface FfmpegArgsInput {
  fps: number;
  /** raw piped-frame size (target × scale) */
  frameWidth: number;
  frameHeight: number;
  /** final video size */
  outWidth: number;
  outHeight: number;
  fmt: ResolvedFormat;
  output: string;
  music?: string;
  audio?: string;
  audioOffsetSec?: number;
  captions?: string;
  burnCaptions: boolean;
}

/**
 * Build the ffmpeg argv. Video frames arrive as a PNG stream on stdin
 * (image2pipe). Supersampled frames (scale > 1) are downscaled to the target
 * size with lanczos. Background music loops + trims to the video length;
 * foreground audio mixes over it; captions are soft-muxed (mov_text for mp4 /
 * native for webm) or burned in.
 */
export function buildFfmpegArgs(o: FfmpegArgsInput): string[] {
  // GIF / APNG take a distinct path — no audio track, no soft-muxed captions
  // (the format can't carry them); the caller warns when those flags are set.
  if (isAnimatedImageContainer(o.fmt.container)) return buildAnimatedImageArgs(o);

  const args: string[] = ["-y", "-hide_banner"];

  // input 0: the PNG frame stream
  args.push("-f", "image2pipe", "-framerate", String(o.fps), "-i", "-");

  let nextIndex = 1;
  let musicIndex = -1;
  let audioIndex = -1;
  let captionIndex = -1;
  if (o.music) {
    args.push("-stream_loop", "-1", "-i", o.music);
    musicIndex = nextIndex++;
  }
  if (o.audio) {
    if (o.audioOffsetSec && o.audioOffsetSec > 0) args.push("-itsoffset", String(o.audioOffsetSec));
    args.push("-i", o.audio);
    audioIndex = nextIndex++;
  }
  const softCaptions = o.captions != null && !o.burnCaptions;
  if (softCaptions) {
    args.push("-i", o.captions!);
    captionIndex = nextIndex++;
  }

  // ── video filter chain ──
  const vfilters: string[] = [];
  const needsDownscale = o.frameWidth !== o.outWidth || o.frameHeight !== o.outHeight;
  if (needsDownscale) vfilters.push(`scale=${o.outWidth}:${o.outHeight}:flags=lanczos`);
  if (o.captions != null && o.burnCaptions) vfilters.push(`subtitles=${escapeSubtitlesPath(o.captions)}`);
  if (vfilters.length > 0) args.push("-vf", vfilters.join(","));

  // ── audio graph ──
  const hasMusic = musicIndex >= 0;
  const hasAudio = audioIndex >= 0;
  if (hasMusic && hasAudio) {
    // mix both into one track, ending with the video (-shortest below).
    args.push(
      "-filter_complex",
      `[${musicIndex}:a][${audioIndex}:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]`,
      "-map", "0:v:0",
      "-map", "[aout]",
    );
  } else if (hasMusic) {
    args.push("-map", "0:v:0", "-map", `${musicIndex}:a:0`);
  } else if (hasAudio) {
    args.push("-map", "0:v:0", "-map", `${audioIndex}:a:0`);
  } else {
    args.push("-map", "0:v:0");
  }

  // ── video codec ──
  args.push("-c:v", o.fmt.videoCodec, "-pix_fmt", o.fmt.pixFmt, "-r", String(o.fps));

  // ── audio codec ──
  if (hasMusic || hasAudio) {
    args.push("-c:a", o.fmt.container === "webm" ? "libopus" : "aac");
    // trim audio to the (finite) video length
    args.push("-shortest");
  }

  // ── captions ──
  if (softCaptions) {
    args.push("-map", `${captionIndex}:0`, "-c:s", o.fmt.container === "webm" ? "webvtt" : "mov_text");
  }

  if (o.fmt.container === "mp4") args.push("-movflags", "+faststart");

  args.push("-f", containerToMuxer(o.fmt.container), o.output);
  return args;
}

/**
 * ffmpeg argv for the animated-image formats (GIF / APNG, DM-885). Frames
 * arrive on the same PNG `image2pipe` stdin. These carry no audio and can't
 * soft-mux captions, so only the shared video filters apply (lanczos downscale
 * when supersampled, burn-in subtitles when `--burn-captions`).
 *
 * GIF uses a single-invocation palette flow — `split` the filtered stream,
 * `palettegen` an optimal 256-color palette from one branch, `paletteuse` it on
 * the other. A naive single-pass GIF (no palettegen) is heavily banded; the
 * Bayer-dither + diff-mode settings here are the widely-used quality preset.
 * APNG is a straight encode through the `apng` encoder with `-plays 0` (loop).
 *
 * Frame-rate caveat: GIF frame delays are stored in centiseconds, so the
 * effective rate is `round(100 / fps) / 100` — fps values that divide 100
 * (50/25/20/10) are exact; others (e.g. 30 → 3 cs → 33.3fps) drift slightly.
 * The caller warns on a non-dividing fps; we don't silently snap it.
 */
function buildAnimatedImageArgs(o: FfmpegArgsInput): string[] {
  const args: string[] = ["-y", "-hide_banner"];
  args.push("-f", "image2pipe", "-framerate", String(o.fps), "-i", "-");

  // Shared video filters (same as the video path), composed into the graph.
  const base: string[] = [];
  if (o.frameWidth !== o.outWidth || o.frameHeight !== o.outHeight) {
    base.push(`scale=${o.outWidth}:${o.outHeight}:flags=lanczos`);
  }
  if (o.captions != null && o.burnCaptions) base.push(`subtitles=${escapeSubtitlesPath(o.captions)}`);

  if (o.fmt.container === "gif") {
    const pre = base.length > 0 ? base.join(",") + "," : "";
    args.push(
      "-filter_complex",
      `[0:v]${pre}split[s0][s1];` +
        `[s0]palettegen=stats_mode=diff[p];` +
        `[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[v]`,
      "-map", "[v]",
    );
  } else {
    // apng
    if (base.length > 0) args.push("-vf", base.join(","));
    args.push("-map", "0:v:0", "-c:v", "apng", "-pix_fmt", o.fmt.pixFmt, "-plays", "0");
  }

  args.push("-r", String(o.fps));
  args.push("-f", containerToMuxer(o.fmt.container), o.output);
  return args;
}

// Map a container name to the ffmpeg `-f <muxer>` value. Identity today —
// mp4 / mov / webm are all direct (the muxer name matches the container). Kept
// as a deliberate seam: it's the single place to add a remap if a future
// container's muxer name diverges from its name (e.g. `mkv` → `matroska`).
function containerToMuxer(container: string): string {
  return container;
}

/** Locate a usable ffmpeg; throws with per-platform install guidance if absent. */
export function findFfmpeg(ffmpegPath: string): string {
  const probe = spawnSync(ffmpegPath, ["-version"], { encoding: "utf-8" });
  if (probe.status === 0) return ffmpegPath;
  throw new Error(
    `ffmpeg not found (tried "${ffmpegPath}"). svg-to-video shells out to ffmpeg; install it and retry:\n` +
      "  macOS:          brew install ffmpeg\n" +
      "  Debian/Ubuntu:  sudo apt-get install -y ffmpeg\n" +
      "  Fedora:         sudo dnf install -y ffmpeg   (RPM Fusion)\n" +
      "  Arch:           sudo pacman -S ffmpeg\n" +
      "  Windows:        winget install ffmpeg   (or choco install ffmpeg)\n" +
      "Or point svg-to-video at a specific binary with --ffmpeg <path> (or the FFMPEG_PATH env var).",
  );
}

/**
 * Verify the target volume has room for the run. In pipe mode only the output
 * file lands on disk; with --keep-frames the PNG sequence does too. Estimates
 * from a real sample-frame size and aborts (rather than failing mid-encode) if
 * free space is short.
 */
export function checkDiskSpace(opts: {
  sampleFrameBytes: number;
  frameCount: number;
  outputDir: string;
  framesDir?: string;
}): { neededBytes: number; freeBytes: number } {
  const HEADROOM = 64 * 1024 * 1024; // 64 MB slack
  // h264 compresses the frame stream heavily; ~10% of the raw PNG bytes is a
  // safe over-estimate for the muxed output.
  const outputEstimate = Math.max(opts.sampleFrameBytes * opts.frameCount * 0.1, opts.sampleFrameBytes * 2);
  const framesEstimate = opts.framesDir ? opts.sampleFrameBytes * opts.frameCount : 0;
  const neededBytes = Math.ceil(outputEstimate + framesEstimate + HEADROOM);

  const target = opts.framesDir ?? opts.outputDir;
  const fs = statfsSync(target);
  const freeBytes = fs.bavail * fs.bsize;
  if (freeBytes < neededBytes) {
    throw new Error(
      `Not enough free disk space on the volume for ${target}: need ~${fmtBytes(neededBytes)}, ${fmtBytes(freeBytes)} free.`,
    );
  }
  return { neededBytes, freeBytes };
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function htmlWrapper(svgMarkup: string, background: string): string {
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\"><style>" +
    `html,body{margin:0;padding:0;background:${background}}` +
    "svg{display:block;width:100vw;height:100vh}" +
    "</style></head><body>" +
    svgMarkup +
    "</body></html>"
  );
}

/** End-to-end: load the SVG, step the animation, pipe frames to ffmpeg. */
export async function runSvgToVideo(opts: SvgToVideoOptions): Promise<void> {
  const { log } = opts;

  // Resolve ffmpeg up front so we fail fast with guidance before launching a browser.
  const ffmpeg = findFfmpeg(opts.ffmpegPath);

  if (!existsSync(opts.input)) throw new Error(`input SVG not found: ${opts.input}`);
  const svgMarkup = await readFile(opts.input, "utf-8");
  if (!/<svg[\s>]/i.test(svgMarkup)) throw new Error(`input does not look like an SVG: ${opts.input}`);

  // Intrinsic size from the markup (so we can size the browser context — and
  // therefore the supersampling DPR — before the first load).
  const intrinsic = parseSvgIntrinsicSize(svgMarkup);
  let outWidth: number;
  let outHeight: number;
  if (intrinsic) {
    ({ width: outWidth, height: outHeight } = fitContain(intrinsic.w, intrinsic.h, opts.width, opts.height));
  } else if (opts.width != null && opts.height != null) {
    outWidth = opts.width;
    outHeight = opts.height;
  } else {
    throw new Error("SVG has no viewBox/width/height; pass both --width and --height.");
  }

  const browser = await opts.launchBrowser();
  try {
    // Supersample by rendering the context at deviceScaleFactor = scale, then
    // letting ffmpeg downscale to the target size (crisper edges / text in the
    // lossy encode). deviceScaleFactor is fixed at context creation.
    const context = await browser.newContext({
      viewport: { width: outWidth, height: outHeight },
      deviceScaleFactor: opts.scale,
    });
    const page = await context.newPage();
    await page.setContent(htmlWrapper(svgMarkup, opts.background), { waitUntil: "load" });

    // Collect every CSS/Web-Animation's timing (and whether SMIL is present) so
    // we can derive the render duration. Runs in the page — no outer scope.
    const timings: { anims: AnimTiming[]; smil: boolean } = await page.evaluate(() => {
      const out: { duration: number; iterations: number; endTime: number }[] = [];
      const anims = typeof document.getAnimations === "function" ? document.getAnimations() : [];
      for (const a of anims) {
        const eff = a.effect;
        if (!eff) continue;
        try {
          const ct = eff.getComputedTiming();
          out.push({ duration: Number(ct.duration), iterations: Number(ct.iterations), endTime: Number(ct.endTime) });
        } catch {
          // skip animations whose timing can't be read
        }
      }
      let smil = false;
      document.querySelectorAll("svg").forEach((svg) => {
        if (typeof svg.pauseAnimations === "function" && svg.querySelector("animate, animateTransform, animateMotion, set")) {
          smil = true;
        }
      });
      return { anims: out, smil };
    });
    let durationMs: number;
    try {
      durationMs = resolveDurationMs(timings.anims, opts.durationSec);
    } catch (err) {
      // SMIL-only SVGs expose no WAAPI timings; require --duration explicitly.
      if (timings.smil && opts.durationSec == null) {
        throw new Error("This SVG uses SMIL animation, whose duration can't be auto-detected — pass --duration <seconds>.");
      }
      throw err;
    }

    const frameCount = Math.max(1, Math.round((durationMs / 1000) * opts.fps));
    const frameWidth = outWidth * opts.scale;
    const frameHeight = outHeight * opts.scale;
    const intrinsicDesc = intrinsic ? `${intrinsic.w}×${intrinsic.h}` : "(unsized)";
    log(`SVG ${intrinsicDesc} → video ${outWidth}×${outHeight} @ ${opts.fps}fps, ${(durationMs / 1000).toFixed(2)}s, ${frameCount} frames (render scale ${opts.scale}×)`);

    // Render frame 0 to size the disk-space estimate accurately.
    await seekTo(page, 0);
    const firstFrame = await screenshot(page);

    const outputDir = path.dirname(path.resolve(opts.output)) || ".";
    let framesDir: string | undefined;
    if (opts.keepFrames) {
      framesDir = path.resolve(opts.keepFrames);
      mkdirSync(framesDir, { recursive: true });
    }
    const disk = checkDiskSpace({ sampleFrameBytes: firstFrame.length, frameCount, outputDir, framesDir });
    log(`disk pre-flight: ~${fmtBytes(disk.neededBytes)} needed, ${fmtBytes(disk.freeBytes)} free — ok`);

    const fmt = resolveFormat(opts.format, opts.container);
    if (isAnimatedImageContainer(fmt.container)) {
      // GIF/APNG carry no audio and can't soft-mux captions — flag what's
      // dropped (burn-in captions still work; they go into the video filter).
      if (opts.music || opts.audio) {
        log(`note: ${fmt.container} has no audio track — ignoring --music/--audio`);
      }
      if (opts.captions && !opts.burnCaptions) {
        log(`note: ${fmt.container} can't soft-mux captions — pass --burn-captions to render them in`);
      }
      if (fmt.container === "gif" && 100 % opts.fps !== 0) {
        log(`note: GIF frame delays are centiseconds — fps ${opts.fps} doesn't divide 100, so timing is approximate (try 50/25/20/10)`);
      }
    }
    const ffArgs = buildFfmpegArgs({
      fps: opts.fps,
      frameWidth,
      frameHeight,
      outWidth,
      outHeight,
      fmt,
      output: opts.output,
      music: opts.music,
      audio: opts.audio,
      audioOffsetSec: opts.audioOffsetSec,
      captions: opts.captions,
      burnCaptions: opts.burnCaptions,
    });

    log(`ffmpeg ${ffArgs.join(" ")}`);
    const ff = spawn(ffmpeg, ffArgs, { stdio: ["pipe", "inherit", opts.quiet ? "pipe" : "inherit"] });
    const ffStdin = ff.stdin;
    if (!ffStdin) throw new Error("ffmpeg stdin pipe unavailable");
    const ffDone = new Promise<void>((resolve, reject) => {
      ff.on("error", reject);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });

    const writeFrame = (buf: Buffer): Promise<void> =>
      new Promise((resolve, reject) => {
        ffStdin.write(buf, (err) => (err ? reject(err) : resolve()));
      });

    // frame 0 (already rendered)
    if (framesDir) writeFileSync(path.join(framesDir, frameName(0)), firstFrame);
    await writeFrame(firstFrame);

    for (let i = 1; i < frameCount; i++) {
      const t = (i * 1000) / opts.fps;
      await seekTo(page, t);
      const buf = await screenshot(page);
      if (framesDir) writeFileSync(path.join(framesDir, frameName(i)), buf);
      await writeFrame(buf);
      if (!opts.quiet && (i % opts.fps === 0 || i === frameCount - 1)) {
        log(`  rendered ${i + 1}/${frameCount} frames`);
      }
    }

    ffStdin.end();
    await ffDone;
    log(`wrote ${opts.output}`);
  } finally {
    await browser.close();
  }
}

function frameName(i: number): string {
  return `frame_${String(i).padStart(6, "0")}.png`;
}

export async function seekTo(page: import("@playwright/test").Page, t: number): Promise<void> {
  // Pause every animation and seek it to t (ms). CSS/Web-Animations via the
  // WAAPI; SMIL via the SVG document timeline. Runs in the page — no outer scope.
  await page.evaluate((tMs) => {
    const anims = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    for (const a of anims) {
      try {
        a.pause();
        a.currentTime = tMs;
      } catch {
        // an animation may refuse seeking; ignore
      }
    }
    document.querySelectorAll("svg").forEach((svg) => {
      if (typeof svg.pauseAnimations === "function") {
        try {
          svg.pauseAnimations();
          svg.setCurrentTime(tMs / 1000);
        } catch {
          // ignore SVGs that don't support the SMIL timeline API
        }
      }
    });
  }, t);
  // Let the seeked state commit to a paint before we screenshot.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

export async function screenshot(page: import("@playwright/test").Page): Promise<Buffer> {
  // The context's deviceScaleFactor already supersamples; "device" captures at
  // that DPR (target × scale px). Crucially do NOT pass animations:"disabled" —
  // that fast-forwards/cancels animations for the shot, which would override our
  // per-frame currentTime seek and make every frame identical. We've already
  // paused + seeked, so the default ("allow") captures the exact seeked state.
  return page.screenshot({ type: "png", scale: "device" });
}
