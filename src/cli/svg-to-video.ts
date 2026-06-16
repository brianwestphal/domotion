#!/usr/bin/env node
/**
 * svg-to-video — render an animated SVG to a video file.
 *
 * A standalone CLI (its own `bin`, sibling to `domotion`) that loads an
 * animated SVG in Playwright Chromium, steps the animation timeline frame by
 * frame at a precise frame rate, and pipes the frames to ffmpeg. Built for
 * SVGs produced by `domotion animate`, but works on any SVG whose animation is
 * CSS / Web-Animations or SMIL driven.
 *
 * ffmpeg is a hard runtime requirement (shelled out, not bundled). Run
 * `svg-to-video --help` for options.
 */

import { parseArgs } from "node:util";
import { launchChromium } from "../index.js";
import { cliFail, makeLogger, parsePositiveFloat, parsePositiveInt } from "./common.js";
import { runSvgToVideo, type SvgToVideoOptions } from "./svg-to-video-core.js";

const HELP = `svg-to-video — render an animated SVG to a video

Usage:
  svg-to-video <input.svg> -o <output> [options]
  svg-to-video --help

Arguments:
  <input.svg>              Animated SVG to render (e.g. a domotion animate output).

Options:
  -o, --output <path>      Output video path (required). Extension may imply the
                           container (e.g. .mp4 / .webm / .mov).
      --width <px>         Target width; contains within, preserving aspect ratio.
      --height <px>        Target height; contains within, preserving aspect ratio.
                           Give either or both; omitted → the SVG's intrinsic size.
      --fps <n>            Frame rate (default 30).
      --duration <s>       Render this many seconds. Default: one full animation
                           loop, derived from the SVG. Required for SMIL-only SVGs
                           or animations with no derivable cycle.
      --format <codec>     Output format: h264 (default), hevc, vp9, vp8, av1,
                           prores (ProRes 4444 .mov), or the animated images
                           gif / apng (no audio).
      --container <ext>    Container override (default follows --format:
                           h264/hevc/av1 → mp4, vp9/vp8 → webm, prores → mov).
                           Ignored for gif/apng.
      --scale <n>          Supersample render factor for crisper output
                           (default 2; ffmpeg downscales to the target size).
      --background <css>   Page background behind the SVG (default "#ffffff").
                           "transparent" / "none" / a zero-alpha color emits an
                           alpha channel on vp9/vp8/prores/apng/gif; h264/hevc/
                           av1 can't carry alpha and composite onto white.
      --music <path>       Background music; looped + trimmed to the video length.
      --audio <path>       Foreground audio; mixed over the music if both given.
      --audio-offset <s>   Delay the foreground audio by this many seconds.
      --captions <path>    Caption file (.srt / .vtt); soft-muxed by default.
      --burn-captions      Burn the captions into the picture instead of muxing.
      --keep-frames <dir>  Also write the PNG frame sequence here (debugging).
      --ffmpeg <path>      ffmpeg binary (default: $FFMPEG_PATH or "ffmpeg").
      --quiet              Suppress per-phase progress on stderr.
  -h, --help               Show this help.

Examples:
  # A domotion animate SVG to a 1280-wide mp4 at 30fps.
  svg-to-video demo.svg -o demo.mp4 --width 1280

  # 60fps webm (VP9), 2× supersampled, with looping background music.
  svg-to-video demo.svg -o demo.webm --format vp9 --fps 60 --scale 2 --music bed.mp3

  # Burn in captions and add a voiceover that starts 0.5s in.
  svg-to-video demo.svg -o demo.mp4 --captions demo.srt --burn-captions \\
    --audio vo.m4a --audio-offset 0.5

  # An animated GIF (palette-optimized); use an fps that divides 100 for exact timing.
  svg-to-video demo.svg -o demo.gif --format gif --fps 25

Requires ffmpeg on PATH (brew / apt / dnf / winget install ffmpeg).
`;

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Phase 1 — parse + validate args. Any failure here is a usage error (exit 2).
  let opts: SvgToVideoOptions;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: "string", short: "o" },
        width: { type: "string" },
        height: { type: "string" },
        fps: { type: "string" },
        duration: { type: "string" },
        format: { type: "string" },
        container: { type: "string" },
        scale: { type: "string" },
        background: { type: "string" },
        music: { type: "string" },
        audio: { type: "string" },
        "audio-offset": { type: "string" },
        captions: { type: "string" },
        "burn-captions": { type: "boolean" },
        "keep-frames": { type: "string" },
        ffmpeg: { type: "string" },
        quiet: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });

    if (values.help) {
      process.stdout.write(HELP);
      process.exit(0);
    }

    const input = positionals[0];
    if (!input) throw new Error("missing <input.svg> argument");
    if (positionals.length > 1) throw new Error(`unexpected extra argument: ${positionals[1]}`);
    if (!values.output) throw new Error("missing required -o/--output");

    const quiet = values.quiet ?? false;
    opts = {
      input,
      output: values.output,
      width: parsePositiveInt(values.width, "width"),
      height: parsePositiveInt(values.height, "height"),
      fps: parsePositiveInt(values.fps, "fps") ?? 30,
      durationSec: parsePositiveFloat(values.duration, "duration"),
      format: values.format ?? "h264",
      container: values.container,
      scale: parsePositiveInt(values.scale, "scale") ?? 2,
      background: values.background ?? "#ffffff",
      music: values.music,
      audio: values.audio,
      audioOffsetSec: parsePositiveFloat(values["audio-offset"], "audio-offset"),
      captions: values.captions,
      burnCaptions: values["burn-captions"] ?? false,
      keepFrames: values["keep-frames"],
      ffmpegPath: values.ffmpeg ?? process.env.FFMPEG_PATH ?? "ffmpeg",
      quiet,
      log: makeLogger(quiet),
      launchBrowser: () => launchChromium(),
    };
  } catch (err) {
    cliFail("svg-to-video", err instanceof Error ? err.message : String(err), "usage");
  }

  // Phase 2 — do the work. A failure here is a runtime error (exit 1).
  try {
    await runSvgToVideo(opts);
  } catch (err) {
    cliFail("svg-to-video", err instanceof Error ? err.message : String(err), "runtime");
  }
}

