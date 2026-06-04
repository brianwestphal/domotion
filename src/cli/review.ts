#!/usr/bin/env node
/**
 * `svg-review` CLI (DM-946).
 *
 * Opens a local web UI for comparing one Domotion-captured SVG against the
 * Chromium reference it was meant to reproduce, and emits a GitHub-issue-
 * ready Markdown snippet from the user's annotations.
 *
 * Usage:
 *   svg-review --expected expected.png --actual actual.svg [--port 3839]
 *
 * The actual argument can be a `.svg` (rasterised here via Playwright at 1×
 * before comparison) or a pre-rendered `.png`. The diff image is computed
 * on the fly using the same pixel-diff routine the in-repo regression
 * suites use (`src/review/compare-pngs.ts`), so what a consumer sees lines
 * up with what a maintainer would see if the fixture were in the suite.
 */

import { parseArgs } from "node:util";
import { resolve, extname, basename } from "node:path";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { comparePngs } from "../review/compare-pngs.js";
import { startReviewServer } from "../review/server.js";
import { cliFail, openInBrowser } from "./common.js";

const HELP = `svg-review — compare Domotion's actual.svg against expected.png

Usage:
  svg-review --expected <expected.png> --actual <actual.{svg,png}> [options]

Required:
      --expected <path>    PNG of what Chromium painted on the source page.
      --actual <path>      Domotion's captured SVG (rasterised here via
                           Playwright at 1×) or its pre-rendered PNG.

Options:
      --port <n>           Port to bind the local UI server on.
                           Defaults to an OS-assigned free port.
      --no-open            Print the URL but don't auto-open the browser.
      --help, -h           Show this help.

Output:
  Spins up a local HTTP server, opens a single-fixture review card in your
  default browser, and stays alive until you stop it with Ctrl-C. In the UI
  you can drag regions to mark visual differences, caption each region,
  then copy a GitHub-issue-ready Markdown block from the side panel. File
  the issue at https://github.com/brianwestphal/domotion/issues/new and
  attach the expected PNG + actual SVG so it can be reproduced.
`;

interface ReviewFlags {
  expected: string;
  actual: string;
  port?: number;
  open: boolean;
}

function parseFlags(argv: string[]): ReviewFlags | { help: true } {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      expected: { type: "string" },
      actual: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { help: true };
  if (values.expected == null || values.actual == null) {
    throw new Error("svg-review: --expected and --actual are required (use --help for usage)");
  }
  return {
    expected: resolve(values.expected),
    actual: resolve(values.actual),
    port: values.port != null ? Number(values.port) : undefined,
    open: !values["no-open"],
  };
}

async function rasteriseSvg(browser: Browser, svgPath: string, outPng: string): Promise<{ width: number; height: number }> {
  if (!existsSync(svgPath)) throw new Error(`svg-review: actual SVG not found: ${svgPath}`);
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  // Load the SVG inside a minimal HTML host so Chromium uses its native
  // SVG renderer (matches what consumers' browsers paint when the SVG is
  // embedded as <img> / inline). Resolve width/height from the SVG's
  // viewBox or width/height attributes so the screenshot rect matches.
  await page.goto(pathToFileURL(svgPath).href);
  const dims = await page.evaluate(() => {
    const svg = document.querySelector("svg");
    if (svg == null) return null;
    const vb = svg.getAttribute("viewBox");
    if (vb != null) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4) return { width: parts[2]!, height: parts[3]! };
    }
    const w = parseFloat(svg.getAttribute("width") ?? "");
    const h = parseFloat(svg.getAttribute("height") ?? "");
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) return { width: w, height: h };
    return null;
  });
  if (dims == null) {
    await ctx.close();
    throw new Error(`svg-review: couldn't determine SVG dimensions from ${svgPath}`);
  }
  await page.setViewportSize({ width: Math.ceil(dims.width), height: Math.ceil(dims.height) });
  await page.screenshot({ path: outPng, clip: { x: 0, y: 0, width: dims.width, height: dims.height }, omitBackground: false });
  await ctx.close();
  return dims;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let flags: ReviewFlags | { help: true };
  try {
    flags = parseFlags(argv);
  } catch (e) {
    cliFail("svg-review", (e as Error).message, "usage");
  }
  if ("help" in flags) {
    process.stdout.write(HELP);
    return;
  }
  if (!existsSync(flags.expected)) {
    cliFail("svg-review", `expected PNG not found: ${flags.expected}`, "usage");
  }
  if (!existsSync(flags.actual)) {
    cliFail("svg-review", `actual file not found: ${flags.actual}`, "usage");
  }

  const tmp = mkdtempSync(resolve(tmpdir(), "svg-review-"));
  const expectedPng = flags.expected;
  const ext = extname(flags.actual).toLowerCase();
  let actualPng: string;
  let actualSvg: string;

  const browser = await chromium.launch();
  try {
    if (ext === ".svg") {
      actualSvg = flags.actual;
      actualPng = resolve(tmp, "actual.png");
      process.stderr.write(`svg-review: rasterising ${basename(flags.actual)}…\n`);
      await rasteriseSvg(browser, flags.actual, actualPng);
    } else if (ext === ".png") {
      actualPng = flags.actual;
      // No source SVG — write a placeholder so the server has something
      // to serve at /actual.svg (the UI's "attach actual.svg" instruction
      // still surfaces the original file via the side-panel hint).
      actualSvg = resolve(tmp, "actual.svg");
      writeFileSync(actualSvg, `<!-- consumer supplied actual as PNG (${basename(flags.actual)}) — no source SVG -->`);
    } else {
      throw new Error(`svg-review: --actual must be .svg or .png (got ${ext || "no extension"})`);
    }

    const diffPng = resolve(tmp, "diff.png");
    process.stderr.write(`svg-review: computing diff…\n`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cmp = await comparePngs(page, expectedPng, actualPng, diffPng);
    await ctx.close();
    process.stderr.write(`svg-review: ${cmp.verdict} · ${cmp.regionCount} region(s) · ${cmp.coveragePct.toFixed(2)}% of image\n`);

    const server = await startReviewServer({
      expectedPng,
      actualPng,
      actualSvg,
      diffPng,
      label: basename(flags.actual),
      port: flags.port,
    });

    process.stdout.write(`svg-review: ${server.url}\n`);
    if (flags.open) await openInBrowser(server.url);

    // Stay alive until Ctrl-C.
    process.on("SIGINT", async () => {
      await server.close();
      await browser.close();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await server.close();
      await browser.close();
      process.exit(0);
    });
    // Keep the event loop busy — the server holds the loop open anyway,
    // but be explicit so the user can read the printed URL.
    await new Promise(() => { /* never resolves; SIGINT exits the process */ });
  } catch (e) {
    await browser.close().catch(() => { /* ignore */ });
    cliFail("svg-review", (e as Error).message, "runtime");
  }
}

main().catch((e) => {
  cliFail("svg-review", `fatal: ${(e as Error).message}`, "runtime");
});
