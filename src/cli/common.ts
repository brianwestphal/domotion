/**
 * Shared CLI helpers used by both `capture` and `animate` subcommands.
 *
 * Argument parsers (`parseIntFlag`, `parseTuple`, `parseColorScheme`),
 * page bring-up (`loadInputIntoPage`, `applyReadyWaits`), output writers
 * (`resolveOutputPath`, `writeOutput`, `isSvgzPath`), and progress logging
 * (`makeLogger`, `timed`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "@playwright/test";
import { gzipSvg } from "../index.js";

export function parseIntFlag(value: string | undefined, name: string, def: number): number {
  if (value == null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) {
    throw new Error(`--${name} expects a positive integer, got "${value}"`);
  }
  return n;
}

export function parseColorScheme(value: string | undefined): "light" | "dark" | "no-preference" | undefined {
  if (value == null) return undefined;
  if (value === "light" || value === "dark" || value === "no-preference") return value;
  throw new Error(`--color-scheme expects one of "light", "dark", "no-preference"; got "${value}"`);
}

export function parseTuple(value: string, len: number, name: string): number[] {
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length !== len) throw new Error(`--${name} expects ${len} comma-separated numbers, got "${value}"`);
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`--${name} contains a non-numeric component: "${value}"`);
  return nums;
}

export async function loadInputIntoPage(page: Page, input: string): Promise<void> {
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

export async function applyReadyWaits(page: Page, flags: { wait: number; waitFor?: string; fontsReady: boolean }): Promise<void> {
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

export function resolveOutputPath(output: string | undefined, input: string, ext: string): string | null {
  if (output === "-") return null;
  if (output != null) return resolve(output);
  if (input === "-" || /^https?:\/\//i.test(input)) return null; // stream to stdout
  // Local file → write next to it with the same basename.
  const stem = basename(input).replace(/\.[^.]+$/, "");
  return resolve(dirname(input), `${stem}${ext}`);
}

/** True iff the path's extension is `.svgz` (case-insensitive). */
export function isSvgzPath(path: string | undefined): boolean {
  return path != null && path !== "-" && /\.svgz$/i.test(path);
}

/**
 * Build a one-line stderr logger. When `quiet` is true, returns a no-op.
 * The logger is passed to the scroll executor for per-segment progress and
 * is also called directly from the CLI around each major phase (load,
 * webfont registration, capture, cull, compose, optimize).
 */
export function makeLogger(quiet: boolean): (message: string) => void {
  if (quiet) return (_msg: string): void => { /* silent */ };
  return (msg: string): void => { process.stderr.write(`${msg}\n`); };
}

/**
 * Wrap an async operation with a "label … (N ms)" log on completion. The
 * label is the FINAL message — useful when the phase already announced
 * itself with a "Loading…" or "Capturing…" intro and we just want the
 * timing on the completion line.
 */
export async function timed<T>(log: (msg: string) => void, label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const out = await fn();
  log(`${label} (${Date.now() - start} ms)`);
  return out;
}

/**
 * Write the SVG out — gzip-compressed when `svgz` is true (always Buffer),
 * raw text otherwise. Stdout gets the same payload kind. `extraInfo` is
 * appended to the "Wrote ..." stderr line (e.g. frame count for animate).
 */
export function writeOutput(svg: string, outPath: string | null, svgz: boolean, extraInfo: string = ""): void {
  if (svgz) {
    const buf = gzipSvg(svg);
    if (outPath === null) {
      process.stdout.write(buf);
    } else {
      writeFileSync(outPath, buf);
      process.stderr.write(`Wrote ${outPath} (${(buf.length / 1024).toFixed(1)} KB svgz${extraInfo})\n`);
    }
    return;
  }
  if (outPath === null) {
    process.stdout.write(svg);
  } else {
    writeFileSync(outPath, svg);
    process.stderr.write(`Wrote ${outPath} (${(svg.length / 1024).toFixed(1)} KB${extraInfo})\n`);
  }
}
