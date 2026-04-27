#!/usr/bin/env node
/**
 * Domotion CLI — DOM-to-animated-SVG renderer.
 *
 * Two commands:
 *   domotion capture  <input> [options]   single-frame capture
 *   domotion animate  <config.json>       multi-frame animated capture
 *
 * `<input>` for `capture` may be:
 *   - a URL (`https://...`, `http://...`)
 *   - a local HTML file path
 *   - `-` to read HTML from stdin
 *
 * Run `domotion --help` for the full option list.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { Page } from "@playwright/test";
import {
  captureElementTree,
  elementTreeToSvg,
  wrapSvg,
  wrapWithChrome,
  generateAnimatedSvg,
  optimizeSvg,
  launchChromium,
  logCaptureWarnings,
  type AnimationFrame,
  type DeviceChromeConfig,
  type DeviceChromeKind,
} from "./index.js";

const VERSION = "0.1.0";

const HELP = `domotion ${VERSION} — DOM-to-animated-SVG renderer

Usage:
  domotion capture <input> [options]
  domotion animate <config.json>
  domotion --help | --version

Commands:
  capture   Capture a single frame from a URL or HTML file as SVG.
  animate   Capture multiple frames described by a JSON config and stitch
            them into one animated SVG with CSS keyframe transitions.

capture options:
  -o, --output <path>      Output SVG path (default: stdout, or <input>.svg
                           when input is a file).
      --width <n>          Viewport width in CSS pixels (default 800).
      --height <n>         Viewport height in CSS pixels (default 600).
      --selector <css>     Element selector to capture (default "body").
      --clip <x,y,w,h>     Capture only this region (default: full viewport).
      --scroll <x,y>       Scroll the page to this offset before capturing.
      --wait <ms>          Sleep this long after the page settles (default 200).
      --wait-for <css>     Wait for this selector to appear before capturing.
      --no-fonts-ready     Skip the document.fonts.ready wait (default: wait).
      --optimize           Run output through SVGO.
      --warnings           Log capture warnings to stderr after capture.
      --chrome <kind>      Wrap the SVG in device chrome:
                             "terminal" — macOS-style terminal window.
                             "browser"  — browser window (use --chrome-url).
                             "phone"    — iPhone-style phone frame.
      --chrome-url <url>   URL displayed in the address bar for browser chrome.
      --chrome-title <t>   Title displayed in the title bar / tab.

animate config (JSON):
  {
    "width":  800,
    "height": 400,
    "output": "demo.svg",
    "optimize": true,
    "frames": [
      {
        "input":      "./frames/start.html",        // or a URL
        "duration":   1500,                         // ms held on screen
        "transition": { "type": "crossfade", "duration": 300 },
        "selector":   "body",                       // optional
        "wait":       200,                          // optional ms
        "waitFor":    ".ready",                     // optional CSS selector
        "scroll":     [0, 0],                       // optional [x, y]
        "actions": [                                // optional, run before capture
          { "type": "click",     "selector": ".btn" },
          { "type": "fill",      "selector": "input", "value": "hi" },
          { "type": "press",     "key": "Enter" },
          { "type": "scroll",    "y": 200 },
          { "type": "hover",     "selector": ".tooltip" },
          { "type": "wait",      "ms": 300 }
        ],
        "overlays": [                               // see Overlay types
          { "kind": "tap",    "x": 100, "y": 50 },
          { "kind": "typing", "text": "Hello", "x": 20, "y": 40 }
        ]
      }
    ]
  }

  Transition types: "crossfade" | "push-left" | "scroll".
  Paths in "input" are resolved relative to the config file's directory.

Examples:
  # Capture the front page of example.com at 1280×720.
  domotion capture https://example.com --width 1280 --height 720 -o demo.svg

  # Capture a local HTML file, optimised, only the .hero region.
  domotion capture ./hero.html --selector ".hero" --optimize -o hero.svg

  # Capture HTML piped on stdin.
  cat my.html | domotion capture - -o out.svg

  # Build a 3-frame animated demo from a config.
  domotion animate ./demo.json
`;

void main();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  try {
    if (cmd === "capture") {
      await runCapture(rest);
    } else if (cmd === "animate") {
      await runAnimate(rest);
    } else {
      process.stderr.write(`domotion: unknown command "${cmd}"\n\n`);
      process.stderr.write(HELP);
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`domotion: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

interface CaptureFlags {
  output?: string;
  width: number;
  height: number;
  selector: string;
  clip?: [number, number, number, number];
  scroll?: [number, number];
  wait: number;
  waitFor?: string;
  fontsReady: boolean;
  optimize: boolean;
  warnings: boolean;
  chrome?: DeviceChromeConfig;
}

async function runCapture(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output:        { type: "string", short: "o" },
      width:         { type: "string" },
      height:        { type: "string" },
      selector:      { type: "string" },
      clip:          { type: "string" },
      scroll:        { type: "string" },
      wait:          { type: "string" },
      "wait-for":    { type: "string" },
      "no-fonts-ready": { type: "boolean" },
      optimize:      { type: "boolean" },
      warnings:      { type: "boolean" },
      chrome:        { type: "string" },
      "chrome-url":  { type: "string" },
      "chrome-title": { type: "string" },
      help:          { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(HELP); process.exit(0); }
  if (positionals.length === 0) throw new Error("capture: missing <input> (URL, path, or '-')");
  if (positionals.length > 1) throw new Error(`capture: unexpected extra argument "${positionals[1]}"`);

  const input = positionals[0];
  const flags: CaptureFlags = {
    output:      values.output,
    width:       parseIntFlag(values.width, "width", 800),
    height:      parseIntFlag(values.height, "height", 600),
    selector:    values.selector ?? "body",
    clip:        values.clip != null ? parseTuple(values.clip, 4, "clip") as [number, number, number, number] : undefined,
    scroll:      values.scroll != null ? parseTuple(values.scroll, 2, "scroll") as [number, number] : undefined,
    wait:        parseIntFlag(values.wait, "wait", 200),
    waitFor:     values["wait-for"],
    fontsReady:  values["no-fonts-ready"] !== true,
    optimize:    values.optimize === true,
    warnings:    values.warnings === true,
    chrome:      values.chrome != null
      ? { type: parseChromeKind(values.chrome), url: values["chrome-url"] ?? input, title: values["chrome-title"] }
      : undefined,
  };

  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: flags.width, height: flags.height } });
    const page = await ctx.newPage();

    await loadInputIntoPage(page, input);
    await applyReadyWaits(page, flags);

    const clip = flags.clip ?? [0, 0, flags.width, flags.height];
    const tree = await captureElementTree(page, flags.selector, {
      x: clip[0], y: clip[1], width: clip[2], height: clip[3],
    });
    const inner = elementTreeToSvg(tree, clip[2], clip[3]);
    let svg = flags.chrome != null
      ? wrapWithChrome(inner, clip[2], clip[3], flags.chrome)
      : wrapSvg(inner, clip[2], clip[3]);
    if (flags.optimize) svg = optimizeSvg(svg);

    if (flags.warnings) logCaptureWarnings("capture");

    const outPath = resolveOutputPath(flags.output, input, ".svg");
    if (outPath === null) {
      process.stdout.write(svg);
    } else {
      writeFileSync(outPath, svg);
      process.stderr.write(`Wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB)\n`);
    }
  } finally {
    await browser.close();
  }
}

interface AnimateConfig {
  width: number;
  height: number;
  output?: string;
  optimize?: boolean;
  chrome?: DeviceChromeConfig;
  frames: AnimateFrameConfig[];
}

interface AnimateFrameConfig {
  input: string;
  duration: number;
  transition?: { type: "crossfade" | "push-left" | "scroll"; duration: number };
  selector?: string;
  wait?: number;
  waitFor?: string;
  scroll?: [number, number];
  actions?: AnimateAction[];
  // Overlays passed through verbatim — typed as unknown[] here, validated by AnimationFrame at runtime.
  overlays?: unknown[];
}

type AnimateAction =
  | { type: "click";  selector: string }
  | { type: "fill";   selector: string; value: string }
  | { type: "press";  key: string }
  | { type: "scroll"; x?: number; y?: number }
  | { type: "hover";  selector: string }
  | { type: "wait";   ms: number };

async function runAnimate(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output:   { type: "string", short: "o" },
      optimize: { type: "boolean" },
      help:     { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) { process.stdout.write(HELP); process.exit(0); }
  if (positionals.length === 0) throw new Error("animate: missing <config.json>");
  if (positionals.length > 1) throw new Error(`animate: unexpected extra argument "${positionals[1]}"`);

  const configPath = resolve(positionals[0]);
  if (!existsSync(configPath)) throw new Error(`animate: config not found: ${configPath}`);

  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as AnimateConfig;
  validateAnimateConfig(cfg);
  const configDir = dirname(configPath);

  const browser = await launchChromium();
  try {
    const ctx = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height } });
    const page = await ctx.newPage();
    const frames: AnimationFrame[] = [];

    for (let i = 0; i < cfg.frames.length; i++) {
      const fc = cfg.frames[i];
      const input = resolveFrameInput(fc.input, configDir);
      await loadInputIntoPage(page, input);
      await applyReadyWaits(page, {
        wait: fc.wait ?? 200,
        waitFor: fc.waitFor,
        fontsReady: true,
      });
      if (fc.scroll != null) {
        const sx = fc.scroll[0], sy = fc.scroll[1];
        await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [sx, sy]);
      }
      if (fc.actions != null) await runActions(page, fc.actions);

      const tree = await captureElementTree(page, fc.selector ?? "body", {
        x: 0, y: 0, width: cfg.width, height: cfg.height,
      });
      const svgContent = elementTreeToSvg(tree, cfg.width, cfg.height, `f${i}-`);
      frames.push({
        svgContent,
        duration: fc.duration,
        transition: fc.transition,
        // Overlays pass through; AnimationFrame typing is enforced when generateAnimatedSvg consumes it.
        overlays: fc.overlays as AnimationFrame["overlays"],
      });
    }

    let svg = generateAnimatedSvg({ width: cfg.width, height: cfg.height, frames, chrome: cfg.chrome });
    const optimize = values.optimize === true || cfg.optimize === true;
    if (optimize) svg = optimizeSvg(svg);

    const outPath = resolveOutputPath(values.output ?? cfg.output, configPath, ".svg");
    if (outPath === null) {
      process.stdout.write(svg);
    } else {
      writeFileSync(outPath, svg);
      process.stderr.write(`Wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB, ${cfg.frames.length} frames)\n`);
    }
  } finally {
    await browser.close();
  }
}

async function runActions(page: Page, actions: AnimateAction[]): Promise<void> {
  for (const a of actions) {
    if (a.type === "click")       await page.click(a.selector);
    else if (a.type === "fill")   await page.fill(a.selector, a.value);
    else if (a.type === "press")  await page.keyboard.press(a.key);
    else if (a.type === "scroll") await page.evaluate((coords: number[]) => window.scrollTo(coords[0], coords[1]), [a.x ?? 0, a.y ?? 0]);
    else if (a.type === "hover")  await page.hover(a.selector);
    else if (a.type === "wait")   await page.waitForTimeout(a.ms);
    else throw new Error(`animate: unknown action type "${(a as { type: string }).type}"`);
  }
}

async function loadInputIntoPage(page: Page, input: string): Promise<void> {
  if (input === "-") {
    const html = readFileSync(0, "utf8"); // stdin
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return;
  }
  if (/^https?:\/\//i.test(input)) {
    await page.goto(input, { waitUntil: "networkidle" });
    return;
  }
  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`input file not found: ${path}`);
  await page.goto(pathToFileURL(path).href, { waitUntil: "networkidle" });
}

async function applyReadyWaits(page: Page, flags: { wait: number; waitFor?: string; fontsReady: boolean }): Promise<void> {
  if (flags.fontsReady) {
    await page.evaluate(() => document.fonts.ready);
  }
  if (flags.waitFor != null) {
    await page.waitForSelector(flags.waitFor, { state: "visible" });
  }
  if (flags.wait > 0) {
    await page.waitForTimeout(flags.wait);
  }
}

function validateAnimateConfig(cfg: AnimateConfig): void {
  if (typeof cfg.width !== "number" || typeof cfg.height !== "number") {
    throw new Error("animate: config requires numeric width and height");
  }
  if (!Array.isArray(cfg.frames) || cfg.frames.length === 0) {
    throw new Error("animate: config.frames must be a non-empty array");
  }
  for (let i = 0; i < cfg.frames.length; i++) {
    const f = cfg.frames[i];
    if (typeof f.input !== "string") throw new Error(`animate: frames[${i}].input must be a string`);
    if (typeof f.duration !== "number") throw new Error(`animate: frames[${i}].duration must be a number`);
  }
}

function resolveFrameInput(input: string, configDir: string): string {
  if (input === "-") return input;
  if (/^https?:\/\//i.test(input)) return input;
  return resolve(configDir, input);
}

function parseIntFlag(value: string | undefined, name: string, def: number): number {
  if (value == null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) {
    throw new Error(`--${name} expects a positive integer, got "${value}"`);
  }
  return n;
}

function parseChromeKind(value: string): DeviceChromeKind {
  if (value === "terminal" || value === "browser" || value === "phone") return value;
  throw new Error(`--chrome expects one of "terminal", "browser", "phone"; got "${value}"`);
}

function parseTuple(value: string, len: number, name: string): number[] {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== len) throw new Error(`--${name} expects ${len} comma-separated numbers, got "${value}"`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`--${name} contains a non-numeric component: "${value}"`);
  return nums;
}

function resolveOutputPath(output: string | undefined, input: string, ext: string): string | null {
  if (output === "-") return null;
  if (output != null) return resolve(output);
  if (input === "-" || /^https?:\/\//i.test(input)) return null; // stream to stdout
  // Local file → write next to it with the same basename.
  const stem = basename(input).replace(/\.[^.]+$/, "");
  return resolve(dirname(input), `${stem}${ext}`);
}
