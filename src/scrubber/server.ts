/**
 * DM-1040: `animated-svg-scrubber` HTTP server.
 *
 * Serves a single-page web UI (`/` shell + `/client.js` bundle) for loading an
 * animated SVG and giving it video-style transport — play / pause / speed /
 * manual scrub / range-select + loop. Two operations need a real Chromium and
 * so run server-side here (the user picked pixel-faithful, server-side export):
 *
 *   - `POST /export-frame` { svg, timeMs, width, height } → a PNG of the SVG
 *     paused-and-seeked to `timeMs`, rendered through the SAME Playwright
 *     seek+screenshot path `svg-to-video` uses (so a grabbed frame is identical
 *     to the corresponding video frame and to Chromium's own paint).
 *   - `POST /timing` { svg } → the resolved single-loop duration (ms) +
 *     intrinsic size, so the client's timeline matches what the exporter sees.
 *   - `POST /trim` { svg, startMs, endMs } → a new animated SVG re-timed to the
 *     window (see `trim.ts`).
 *
 * One Chromium is launched lazily and reused across requests; the CLI closes it
 * on shutdown.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Browser, Page } from "@playwright/test";
import { htmlWrapper, seekTo, screenshot, parseSvgIntrinsicSize, resolveDurationMs, findFfmpeg, resolveFormat, buildFfmpegArgs, fitContain, type AnimTiming } from "../cli/svg-to-video-core.js";
import { trimAnimatedSvg } from "./trim.js";
import { clampCrop, cropSvgViewBox, type CropRect } from "./crop.js";
import { SCRUBBER_CLIENT_JS } from "./client.bundle.generated.js";

/** Round DOWN to the nearest even integer ≥ 2 — H.264 yuv420p needs even W/H.
 *  The direction is in the name to avoid confusing it with `evenCeil`
 *  (svg-to-video): a crop box rounds down to stay inside the source. */
function evenFloor(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** Fixed export frame rate (DM-1042 — per requested design). */
const EXPORT_FPS = 30;

/** Output dimension clamp — guards `setViewportSize` against absurd values. */
const MAX_DIM = 10_000;

// DM-1065: every POST body is untrusted external input, so validate it at the
// boundary with zod (mirroring `animate.ts`) before any value reaches Chromium /
// ffmpeg / `trimAnimatedSvg`. A failure is a 400 (client error), not a 500.
const svgField = z.string().min(1, "must be a non-empty SVG string");
const finite = z.number().refine(Number.isFinite, "must be a finite number");
const timeMs = finite.refine((n) => n >= 0, "must be ≥ 0");
const dim = finite.refine((n) => n > 0 && n <= MAX_DIM, `must be in (0, ${MAX_DIM}]`);
// DM-1104: optional crop rect (in the SVG's user-space / viewBox units). The
// PNG / MP4 exports crop the raster output to it; the SVG export rewrites the
// root viewBox (vector crop). Clamped to the frame server-side via `clampCrop`.
const CROP = z
  .object({ x: finite.refine((n) => n >= 0, "must be ≥ 0"), y: finite.refine((n) => n >= 0, "must be ≥ 0"), w: dim, h: dim })
  .optional();
const TIMING_BODY = z.object({ svg: svgField });
const TRIM_BODY = z.object({
  svg: svgField,
  startMs: timeMs,
  endMs: timeMs,
  periodMs: finite.refine((n) => n > 0, "must be > 0"),
  crop: CROP,
});
const FRAME_BODY = z.object({ svg: svgField, timeMs, width: dim, height: dim, crop: CROP });
const RANGE_VIDEO_BODY = z.object({ svg: svgField, startMs: timeMs, endMs: timeMs, width: dim, height: dim, crop: CROP });

/** A request-level error carrying the HTTP status to return (e.g. a 400). */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Read + JSON-parse + zod-validate a request body, or throw an `HttpError(400)`. */
async function parseBody<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const raw = await readBody(req);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new HttpError(400, "invalid JSON body"); }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(400, `invalid request: ${msg}`);
  }
  return result.data;
}

/**
 * Render the `[t0, t1]` window of `svg` to an MP4 (H.264) and return the bytes.
 * Reuses the `svg-to-video` machinery — Playwright seek+screenshot per frame
 * piped to ffmpeg — but, unlike the SVG trim, this naturally isolates exactly
 * the selected window (frame i is sampled at `t0 + i/fps`). Throws (with install
 * guidance) when ffmpeg is missing. Runs on the caller's serialized Chromium
 * page.
 */
async function renderRangeVideo(page: Page, svg: string, t0: number, t1: number, width: number, height: number, crop?: CropRect): Promise<Buffer> {
  const ffmpeg = findFfmpeg(process.env.FFMPEG_PATH || "ffmpeg"); // throws if absent
  const fmt = resolveFormat("h264"); // → mp4 / yuv420p (needs even W/H)
  const { width: outW, height: outH } = fitContain(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  const frameCount = Math.max(1, Math.round(((t1 - t0) / 1000) * EXPORT_FPS));

  await page.setViewportSize({ width: outW, height: outH });
  await page.setContent(htmlWrapper(svg, "#0000"), { waitUntil: "load" });

  // DM-1104: crop each frame to the requested rect via Playwright `clip`. Round
  // the clip to integer px inside the viewport and the dims down to even values
  // (yuv420p). The encoder frame size becomes the cropped size.
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  let frameW = outW, frameH = outH;
  if (crop != null) {
    const c = clampCrop(crop, outW, outH);
    if (c != null) {
      const cx = Math.min(Math.floor(c.x), outW - 2);
      const cy = Math.min(Math.floor(c.y), outH - 2);
      const cw = evenFloor(Math.min(c.w, outW - cx));
      const ch = evenFloor(Math.min(c.h, outH - cy));
      clip = { x: cx, y: cy, width: cw, height: ch };
      frameW = cw; frameH = ch;
    }
  }

  const dir = mkdtempSync(join(tmpdir(), "scrubber-mp4-"));
  const outPath = join(dir, "range.mp4");
  const args = buildFfmpegArgs({ fps: EXPORT_FPS, frameWidth: frameW, frameHeight: frameH, outWidth: frameW, outHeight: frameH, fmt, output: outPath, burnCaptions: false });
  const ff = spawn(ffmpeg, args, { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ff.stderr?.on("data", (d: Buffer) => { ffErr += d.toString(); if (ffErr.length > 8192) ffErr = ffErr.slice(-8192); });
  const ffDone = new Promise<void>((resolve, reject) => {
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(-400)}`))));
  });
  const writeFrame = (buf: Buffer): Promise<void> =>
    new Promise((res, rej) => ff.stdin!.write(buf, (err) => (err ? rej(err) : res())));
  try {
    for (let i = 0; i < frameCount; i++) {
      await seekTo(page, t0 + (i * 1000) / EXPORT_FPS);
      const shot = clip != null
        ? await page.screenshot({ type: "png", scale: "device", clip })
        : await screenshot(page);
      await writeFrame(shot);
    }
    ff.stdin!.end();
    await ffDone;
    return readFileSync(outPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ScrubberServerInputs {
  port?: number;
  /** optional SVG markup to preload into the UI on first paint */
  initialSvg?: string;
  initialName?: string;
  launchBrowser: () => Promise<Browser>;
  log?: (msg: string) => void;
}

export interface ScrubberServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const SHELL = (bootstrap: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>animated-svg-scrubber</title>
</head><body>
<div id="app"></div>
<script>window.__SCRUBBER_BOOTSTRAP__ = ${bootstrap};</script>
<script src="/client.js"></script>
</body></html>`;

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const buf = Buffer.from(JSON.stringify(obj), "utf-8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": buf.length });
  res.end(buf);
}

/** Read the SVG's WAAPI timings in a Chromium page, then resolve a single-loop
 *  duration with the same logic the video exporter uses. */
async function deriveTiming(page: Page, svg: string): Promise<{ durationMs: number | null; width: number; height: number }> {
  await page.setContent(htmlWrapper(svg, "#fff"), { waitUntil: "load" });
  const anims: AnimTiming[] = await page.evaluate(() => {
    const out: { duration: number; iterations: number; endTime: number }[] = [];
    const list = typeof document.getAnimations === "function" ? document.getAnimations() : [];
    for (const a of list) {
      const eff = a.effect;
      if (!eff) continue;
      try {
        const ct = eff.getComputedTiming();
        out.push({ duration: Number(ct.duration), iterations: Number(ct.iterations), endTime: Number(ct.endTime) });
      } catch { /* skip unreadable */ }
    }
    return out;
  });
  let durationMs: number | null = null;
  try { durationMs = resolveDurationMs(anims); } catch { durationMs = null; }
  const size = parseSvgIntrinsicSize(svg) ?? { w: 800, h: 600 };
  return { durationMs, width: size.w, height: size.h };
}

export async function startScrubberServer(inputs: ScrubberServerInputs): Promise<ScrubberServerHandle> {
  const log = inputs.log ?? (() => {});
  let browser: Browser | null = null;
  let pagePromise: Promise<Page> | null = null;
  // Serialize Chromium work — one reused page, one request at a time.
  let queue: Promise<unknown> = Promise.resolve();

  const getPage = async (): Promise<Page> => {
    if (browser == null) browser = await inputs.launchBrowser();
    if (pagePromise == null) {
      pagePromise = browser.newContext({ deviceScaleFactor: 1 }).then((ctx) => ctx.newPage());
    }
    return pagePromise;
  };
  const withChromium = <T>(fn: (page: Page) => Promise<T>): Promise<T> => {
    const run = queue.then(() => getPage().then(fn));
    queue = run.catch(() => {});
    // DM-1065: if the reused page/context (or the browser) died — Chromium OOM
    // on a huge SVG, a crashed renderer, a closed context — discard the memoized
    // handle so the NEXT request rebuilds it instead of reusing a dead page
    // forever. Page/context death only needs a fresh page; browser death needs a
    // relaunch (next getPage() re-invokes launchBrowser).
    run.catch((err: unknown) => {
      const msg = String(err instanceof Error ? err.message : err);
      if (/\b(closed|crashed|disconnected|Target (?:page|closed)|browser has been closed)\b/i.test(msg)) {
        pagePromise = null;
        if (/browser/i.test(msg)) browser = null;
      }
    });
    return run;
  };

  const bootstrap = JSON.stringify({ svg: inputs.initialSvg ?? null, name: inputs.initialName ?? null });
  const shellHtml = SHELL(bootstrap);

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        const buf = Buffer.from(shellHtml, "utf-8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": buf.length });
        res.end(buf);
        return;
      }
      if (req.method === "GET" && url === "/client.js") {
        const buf = Buffer.from(SCRUBBER_CLIENT_JS, "utf-8");
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": buf.length });
        res.end(buf);
        return;
      }
      if (req.method === "POST" && url === "/timing") {
        const { svg } = await parseBody(req, TIMING_BODY);
        const t = await withChromium((page) => deriveTiming(page, svg));
        sendJson(res, 200, t);
        return;
      }
      if (req.method === "POST" && url === "/trim") {
        const { svg, startMs, endMs, periodMs, crop } = await parseBody(req, TRIM_BODY);
        const r = trimAnimatedSvg(svg, startMs, endMs, periodMs);
        // DM-1104: vector crop — rewrite the trimmed SVG's root viewBox. Clamp
        // to the frame's intrinsic size; a degenerate / off-canvas crop is
        // ignored (returns the un-cropped trim).
        let outSvg = r.svg;
        if (crop != null) {
          const size = parseSvgIntrinsicSize(outSvg) ?? parseSvgIntrinsicSize(svg);
          const c = size != null ? clampCrop(crop, size.w, size.h) : null;
          if (c != null) outSvg = cropSvgViewBox(outSvg, c);
        }
        sendJson(res, 200, { svg: outSvg, slicedCss: r.slicedCss, slicedSmil: r.slicedSmil, shiftedCss: r.shiftedCss, shiftedSmil: r.shiftedSmil });
        return;
      }
      if (req.method === "POST" && url === "/export-frame") {
        const { svg, timeMs, width, height, crop } = await parseBody(req, FRAME_BODY);
        const png = await withChromium(async (page) => {
          const vw = Math.max(1, Math.round(width)), vh = Math.max(1, Math.round(height));
          await page.setViewportSize({ width: vw, height: vh });
          await page.setContent(htmlWrapper(svg, "#0000"), { waitUntil: "load" });
          await seekTo(page, timeMs);
          // DM-1104: crop the raster output. width/height === the SVG's natural
          // size, so the crop's user-units map 1:1 to viewport px.
          const c = crop != null ? clampCrop(crop, vw, vh) : null;
          return c != null
            ? page.screenshot({ type: "png", scale: "device", clip: { x: c.x, y: c.y, width: c.w, height: c.h } })
            : screenshot(page);
        });
        res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
        res.end(png);
        return;
      }
      if (req.method === "POST" && url === "/export-range-video") {
        const { svg, startMs, endMs, width, height, crop } = await parseBody(req, RANGE_VIDEO_BODY);
        const t0 = Math.max(0, Math.min(startMs, endMs));
        const t1 = Math.max(startMs, endMs);
        if (!(t1 - t0 >= 1)) { sendJson(res, 400, { error: "empty range — set an in/out window first" }); return; }
        const mp4 = await withChromium((page) => renderRangeVideo(page, svg, t0, t1, width, height, crop));
        res.writeHead(200, { "content-type": "video/mp4", "content-length": mp4.length });
        res.end(mp4);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${url}`);
    } catch (err) {
      // A validation / bad-input failure is the client's fault (4xx); everything
      // else is a genuine server fault (5xx). DM-1065.
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  };

  const server: Server = createServer((req, res) => { void handler(req, res); });
  const port: number = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(inputs.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr != null ? addr.port : (inputs.port ?? 0));
    });
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: async () => {
      // `server.close()` stops accepting NEW connections but waits for every
      // existing socket to go idle before firing the callback; a keep-alive
      // client (Node's `fetch`/undici pools a socket) can delay that by tens of
      // seconds — undesirable on Ctrl-C. Drop idle sockets so it fires promptly.
      await new Promise<void>((r) => { server.close(() => r()); server.closeIdleConnections(); });
      if (browser != null) { await browser.close().catch(() => {}); browser = null; }
    },
  };
}
