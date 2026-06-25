/**
 * Shared CLI helpers used by both `capture` and `animate` subcommands.
 *
 * Argument parsers (`parseIntFlag`, `parseTuple`, `parseColorScheme`),
 * page bring-up (`loadInputIntoPage`, `applyReadyWaits`), output writers
 * (`resolveOutputPath`, `writeOutput`, `isSvgzPath`), and progress logging
 * (`makeLogger`, `timed`).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { gzipSvg } from "../index.js";

const execFileP = promisify(execFile);

export function parseIntFlag(value: string | undefined, name: string, def: number): number {
  if (value == null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n <= 0) {
    throw new Error(`--${name} expects a positive integer, got "${value}"`);
  }
  return n;
}

/** Parse an OPTIONAL positive-integer flag — `undefined` when absent (no
 *  default), unlike `parseIntFlag`. Shared by the `svg-to-video` bin. */
export function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} expects a positive integer, got "${value}"`);
  return n;
}

/** Parse an OPTIONAL `--port` flag — a positive integer in the valid TCP range
 *  (1..65535), or `undefined` when absent. Builds on `parsePositiveInt` (which
 *  rejects NaN / non-integers / values ≤ 0) and adds the upper bound so a bad
 *  port fails at the CLI boundary instead of inside `server.listen`. Shared by
 *  the server-backed bins (`svg-review`, `animated-svg-scrubber`). */
export function parsePort(value: string | undefined): number | undefined {
  const n = parsePositiveInt(value, "port");
  if (n != null && n > 65535) throw new Error(`--port expects a value in 1..65535, got "${value}"`);
  return n;
}

/** Parse an OPTIONAL positive-float flag — `undefined` when absent. */
export function parsePositiveFloat(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} expects a positive number, got "${value}"`);
  return n;
}

/** Parse an OPTIONAL non-negative-float flag (0 allowed) — `undefined` when absent. */
export function parseNonNegativeFloat(value: string | undefined, name: string): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} expects a number >= 0, got "${value}"`);
  return n;
}

/**
 * Open a URL in the user's default browser WITHOUT a shell, so the URL can't be
 * interpreted as shell syntax (argv form via `execFile`). Best-effort: failures
 * are swallowed because the caller has already printed the URL for copy-paste.
 * Shared by the `svg-review` and `animated-svg-scrubber` bins.
 */
export async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "darwin") await execFileP("open", [url]);
    else if (process.platform === "win32") await execFileP("cmd", ["/c", "start", "", url]);
    else await execFileP("xdg-open", [url]);
  } catch { /* user can copy-paste the printed URL */ }
}

/**
 * Print a CLI error to stderr with the bin's `name:` prefix and exit. The
 * exit-code convention shared across all four bins (DM-1071): `2` = usage /
 * argument error (bad flags, missing input, file-not-found before any work),
 * `1` = runtime failure (something went wrong while doing the work).
 */
export function cliFail(name: string, message: string, kind: "usage" | "runtime"): never {
  process.stderr.write(`${name}: ${message}\n`);
  process.exit(kind === "usage" ? 2 : 1);
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

/** True when the input is an HTTP-Archive file (auto-detected by extension,
 *  like `.svgz` output). DM-889. */
export function isHarPath(input: string): boolean {
  return input !== "-" && /\.har$/i.test(input);
}

/**
 * Infer the main-document URL to navigate to when capturing from a HAR. Prefers
 * `log.pages[0].title` when it's a URL (some recorders set it), else the first
 * 2xx `text/html` entry's request URL, else the first entry's URL. Throws when
 * none can be found (caller should require `--url`). DM-889.
 */
export function inferHarPageUrl(harPath: string): string {
  let har: unknown;
  try {
    har = JSON.parse(readFileSync(harPath, "utf8"));
  } catch (e) {
    throw new Error(`could not read HAR file ${harPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const log = (har as { log?: { pages?: Array<{ title?: string }>; entries?: Array<{ request?: { url?: string }; response?: { status?: number; content?: { mimeType?: string } } }> } })?.log;
  const pageTitle = log?.pages?.[0]?.title;
  if (typeof pageTitle === "string" && /^https?:\/\//i.test(pageTitle)) return pageTitle;
  const entries = Array.isArray(log?.entries) ? log!.entries! : [];
  const htmlEntry = entries.find((e) => {
    const status = e?.response?.status;
    const mime = e?.response?.content?.mimeType ?? "";
    return typeof status === "number" && status >= 200 && status < 300 && /text\/html/i.test(mime);
  });
  const url = htmlEntry?.request?.url ?? entries[0]?.request?.url;
  if (typeof url !== "string" || url === "") {
    throw new Error(`could not infer a page URL from ${harPath} (no usable entries) — pass --url <url>`);
  }
  return url;
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

/**
 * Frame-level readiness waits. Order: fonts → `waitFor` (selector visible) →
 * the richer condition waits (DM-860: `waitForText` / `waitForGone` /
 * `waitForCount`) → the fixed `wait` settle delay. The condition waits poll in
 * page context (Playwright `waitForFunction`, page default timeout = 90 s); on
 * timeout they throw a message naming the unmet condition + frame index.
 */
export interface ReadyWaitFlags {
  wait: number;
  waitFor?: string;
  fontsReady: boolean;
  /** Frame index, for error messages. */
  frameIndex?: number;
  waitForText?: { selector: string; equals?: string; contains?: string };
  /** Selector that must be gone — removed from the DOM, or all matches not visible. */
  waitForGone?: string;
  waitForCount?: { selector: string; equals?: number; atLeast?: number; atMost?: number };
}

export async function applyReadyWaits(page: Page, flags: ReadyWaitFlags): Promise<void> {
  if (flags.fontsReady) {
    await page.evaluate(() => document.fonts.ready);
  }
  if (flags.waitFor != null) {
    await page.waitForSelector(flags.waitFor, { state: "visible" });
  }
  const where = flags.frameIndex != null ? `frames[${flags.frameIndex}]` : "frame";

  if (flags.waitForText != null) {
    const w = flags.waitForText;
    try {
      await page.waitForFunction((a) => {
        const el = document.querySelector(a.selector);
        if (el == null) return false;
        const t = el.textContent ?? "";
        if (a.equals != null) return t.trim() === a.equals;
        if (a.contains != null) return t.includes(a.contains);
        return false;
      }, w);
    } catch {
      const cond = w.equals != null ? `equal "${w.equals}"` : `contain "${w.contains ?? ""}"`;
      throw new Error(`animate: ${where}.waitForText timed out — "${w.selector}" text never came to ${cond}`);
    }
  }

  if (flags.waitForGone != null) {
    const sel = flags.waitForGone;
    try {
      await page.waitForFunction((s) => {
        const els = document.querySelectorAll(s);
        if (els.length === 0) return true;
        return Array.from(els).every((e) => {
          const cs = getComputedStyle(e);
          const rect = e.getBoundingClientRect();
          return cs.display === "none" || cs.visibility === "hidden" || (rect.width === 0 && rect.height === 0);
        });
      }, sel);
    } catch {
      throw new Error(`animate: ${where}.waitForGone timed out — "${sel}" never went away (still present and visible)`);
    }
  }

  if (flags.waitForCount != null) {
    const w = flags.waitForCount;
    try {
      await page.waitForFunction((a) => {
        const n = document.querySelectorAll(a.selector).length;
        if (a.equals != null && n !== a.equals) return false;
        if (a.atLeast != null && n < a.atLeast) return false;
        if (a.atMost != null && n > a.atMost) return false;
        return true;
      }, w);
    } catch {
      throw new Error(`animate: ${where}.waitForCount timed out — "${w.selector}" count never satisfied the condition`);
    }
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
