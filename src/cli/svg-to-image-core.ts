/**
 * svg-to-image core — convert a (still or animated) SVG to a single image file:
 * PNG, JPEG, or PDF. The headless, one-shot counterpart to the scrubber's
 * interactive "Export frame" and the still analogue of `svg-to-video`.
 *
 * Reuses the seek + screenshot machinery from `svg-to-video-core` (so a grabbed
 * frame is pixel-identical to a video frame) and Chromium's `page.pdf()` for the
 * vector PDF path. Output format is inferred from the `-o` extension (or forced
 * with `--format`). Input is always an existing `.svg` file — for HTML/URL →
 * image, run `domotion capture … -o x.svg` first, then this on `x.svg`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import type { Browser } from "@playwright/test";
import { htmlWrapper, seekTo, screenshot, parseSvgIntrinsicSize } from "./svg-to-video-core.js";

export type ImageFormat = "png" | "jpeg" | "pdf";

export interface SvgToImageOptions {
  /** Path to the input `.svg` file. */
  input: string;
  /** Output path; its extension picks the format unless `format` is set. */
  output: string;
  /** Override the format inferred from the output extension. */
  format?: ImageFormat;
  /** Target width (px); contains within, preserving aspect ratio. */
  width?: number;
  /** Target height (px); contains within, preserving aspect ratio. */
  height?: number;
  /** Timeline position (ms) to sample for an animated SVG. Default 0 (first frame). */
  atMs?: number;
  /** Device-pixel-ratio / supersample factor for raster output (PNG/JPEG); output px = size × scale. Default 1. Ignored for PDF (vector). */
  scale?: number;
  /** Page background behind the SVG. Default "transparent": PNG keeps the SVG's own alpha; JPEG/PDF (no alpha) fall back to white. */
  background?: string;
  /** JPEG quality 0–100. Default 92. */
  quality?: number;
  quiet?: boolean;
  log: (msg: string) => void;
  launchBrowser: () => Promise<Browser>;
}

const EXT_FORMAT: Record<string, ImageFormat> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".pdf": "pdf",
};

/** A human-readable list of the supported output extensions. */
export const SUPPORTED_IMAGE_EXTS = ".png, .jpg/.jpeg, .pdf";

/** Resolve the output image format from an explicit override or the path extension. */
export function resolveImageFormat(outputPath: string, override?: string): ImageFormat {
  if (override != null && override !== "") {
    const o = override.toLowerCase();
    if (o === "png" || o === "jpeg" || o === "pdf") return o;
    if (o === "jpg") return "jpeg";
    throw new Error(`--format expects png | jpeg | pdf; got "${override}"`);
  }
  const ext = extname(outputPath).toLowerCase();
  const fmt = EXT_FORMAT[ext];
  if (fmt == null) {
    throw new Error(
      `cannot infer image format from output "${outputPath}" (extension "${ext || "(none)"}"). ` +
      `Use one of ${SUPPORTED_IMAGE_EXTS}, or pass --format.`,
    );
  }
  return fmt;
}

/** Whether a CSS background string carries no opaque color (so the output should be transparent). */
export function isTransparentBg(bg: string): boolean {
  const v = bg.trim().toLowerCase();
  return (
    v === "transparent" ||
    v === "none" ||
    v === "#0000" ||
    v === "#00000000" ||
    /^(?:rgba|hsla)\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(v)
  );
}

/**
 * Contain `natural` within `target`, preserving aspect ratio. Unlike
 * `fitContain` in svg-to-video-core (which rounds to even px for yuv420 video),
 * this preserves the intrinsic size exactly when no target is given — an image
 * doesn't need even dimensions, and the 1× output should match the SVG's box.
 */
export function containSize(
  nw: number,
  nh: number,
  tw?: number,
  th?: number,
): { width: number; height: number } {
  if (tw == null && th == null) return { width: Math.round(nw), height: Math.round(nh) };
  if (tw != null && th == null) return { width: tw, height: Math.max(1, Math.round((nh * tw) / nw)) };
  if (tw == null && th != null) return { width: Math.max(1, Math.round((nw * th) / nh)), height: th };
  const s = Math.min(tw! / nw, th! / nh);
  return { width: Math.max(1, Math.round(nw * s)), height: Math.max(1, Math.round(nh * s)) };
}

/** End-to-end: load the SVG, seek to `atMs`, and write a single PNG/JPEG/PDF. */
export async function runSvgToImage(
  opts: SvgToImageOptions,
): Promise<{ width: number; height: number; format: ImageFormat }> {
  const { log } = opts;
  const format = resolveImageFormat(opts.output, opts.format);
  const scale = opts.scale ?? 1;
  const atMs = opts.atMs ?? 0;
  const background = opts.background ?? "transparent";

  const svgMarkup = readFileSync(opts.input, "utf-8");
  const intrinsic = parseSvgIntrinsicSize(svgMarkup);
  let outWidth: number;
  let outHeight: number;
  if (intrinsic) {
    ({ width: outWidth, height: outHeight } = containSize(intrinsic.w, intrinsic.h, opts.width, opts.height));
  } else if (opts.width != null && opts.height != null) {
    outWidth = opts.width;
    outHeight = opts.height;
  } else {
    throw new Error("SVG has no viewBox/width/height; pass both --width and --height.");
  }

  const transparent = isTransparentBg(background);
  // JPEG and PDF can't carry an alpha channel — composite on white when no
  // opaque background was requested.
  const renderBackground = transparent && format !== "png" ? "#ffffff" : background;

  const browser = await opts.launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: outWidth, height: outHeight },
      // PDF is vector (resolution-independent); raster honors the supersample factor.
      deviceScaleFactor: format === "pdf" ? 1 : scale,
    });
    const page = await context.newPage();
    await page.setContent(htmlWrapper(svgMarkup, renderBackground), { waitUntil: "load" });
    // Let embedded webfonts (data-URI @font-face) finish loading before we shoot.
    await page
      .evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready)
      .catch(() => {});
    await seekTo(page, atMs);

    let buf: Buffer;
    if (format === "png") {
      buf = await screenshot(page, transparent);
    } else if (format === "jpeg") {
      buf = await page.screenshot({ type: "jpeg", quality: opts.quality ?? 92, scale: "device" });
    } else {
      // PDF — a single page sized to the SVG. Force `screen` media so a print
      // stylesheet can't change the paint, and print backgrounds so fills show.
      // `page.pdf()` requires headless Chromium (launchChromium is headless).
      await page.emulateMedia({ media: "screen" });
      buf = await page.pdf({
        width: `${outWidth}px`,
        height: `${outHeight}px`,
        printBackground: true,
        pageRanges: "1",
        margin: { top: "0", right: "0", bottom: "0", left: "0" },
      });
    }
    writeFileSync(opts.output, buf);
  } finally {
    await browser.close();
  }

  const pxDims = format === "pdf" ? `${outWidth}×${outHeight}` : `${outWidth * scale}×${outHeight * scale}`;
  const src = intrinsic ? `${intrinsic.w}×${intrinsic.h}` : "(unsized)";
  log(`SVG ${src} → ${format.toUpperCase()} ${pxDims}${atMs ? ` @ ${atMs}ms` : ""} → ${opts.output}`);
  return { width: outWidth, height: outHeight, format };
}
