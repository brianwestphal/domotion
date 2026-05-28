/**
 * Single-fixture review server (DM-946).
 *
 * Spins up a tiny local HTTP server that serves a one-card review UI:
 * expected / actual / diff PNGs side-by-side, keyboard-driven lightbox
 * switching, draggable issue regions with captions, and a panel that
 * builds GitHub-issue-ready Markdown from the captured regions.
 *
 * Distilled from the maintainer-side `tests/review-server.tsx`. Differences:
 *   - one fixture per server, not a grid of suites
 *   - no Hot Sheet integration (consumers can't authenticate to a
 *     maintainer's project)
 *   - no live-SVG side-by-side toggle; the SVG is already rasterised
 *     before the server starts so what the user sees is the rendered
 *     PNG, matching the diff the in-repo regression suites use
 *
 * Usage from the CLI:
 *
 *   const server = await startReviewServer({
 *     expectedPng, actualPng, actualSvg, diffPng, port,
 *   });
 *   console.log(`open ${server.url}`);
 *   // server stays alive until Ctrl-C
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { REVIEW_CLIENT_JS } from "./client.bundle.generated.js";

export interface ReviewServerInputs {
  /** Absolute path to the PNG of what Chromium painted. */
  expectedPng: string;
  /** Absolute path to the PNG the renderer produced from the SVG. */
  actualPng: string;
  /** Absolute path to the source SVG (also served, used by the issue
   *  Markdown text + as an `<a download>` link in the UI). */
  actualSvg: string;
  /** Absolute path to the diff PNG produced by `comparePngs`. */
  diffPng: string;
  /** Human-readable fixture label (defaults to the basename of actualSvg). */
  label?: string;
  /** Port to bind. Falls back to the next free port if taken. */
  port?: number;
}

export interface ReviewServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function renderShell(label: string): string {
  const safeLabel = label.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  return `<!doctype html><html><head>
<meta charset="utf-8">
<title>svg-review · ${safeLabel}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  figure { margin: 0; position: relative; background: #161b22; border: 1px solid #30363d; padding: 8px; }
  figure img { display: block; width: 100%; height: auto; cursor: zoom-in; }
  figure figcaption { font-size: 12px; opacity: 0.7; margin-top: 6px; }
  #issue-panel { margin-top: 16px; }
  #issue-panel textarea { width: 100%; min-height: 120px; background: #0b0f14; color: #e6edf3; border: 1px solid #30363d; font: 12px/1.4 ui-monospace, monospace; padding: 8px; box-sizing: border-box; }
  #issue-panel button { background: #238636; color: white; border: 0; padding: 6px 12px; font: inherit; cursor: pointer; border-radius: 4px; }
  #issue-panel a { color: #58a6ff; }
  .hint { opacity: 0.7; font-size: 12px; }
  .region-list { margin-top: 12px; }
  .region-list .region-row { display: grid; grid-template-columns: 32px 1fr; gap: 8px; margin-bottom: 6px; }
  .region-list input[type="text"] { background: #0b0f14; color: #e6edf3; border: 1px solid #30363d; padding: 4px 6px; font: inherit; }

  /* Lightbox + region overlay (mirrored from tests/review.css). */
  #lightbox { position: fixed; inset: 0; background: rgba(0,0,0,0.92); z-index: 1000; display: none; align-items: flex-start; justify-content: center; overflow: auto; padding: 24px; }
  #lightbox.open { display: flex; }
  #lightbox img { max-width: none; max-height: none; user-select: none; cursor: zoom-out; }
  .region-overlay { position: absolute; inset: 0; pointer-events: auto; }
  .region-overlay rect { fill: rgba(255, 99, 132, 0.18); stroke: #ff6384; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
</style>
</head>
<body>
<h1>${safeLabel}</h1>
<p class="hint">Arrow keys cycle <kbd>expected</kbd> → <kbd>actual</kbd> → <kbd>diff</kbd> when an image is open. Drag on any image to mark a region; click inside a region to delete it. Press <kbd>Enter</kbd> in the caption to focus the issue text, then Cmd/Ctrl+C to copy.</p>
<div class="imgs">
  <figure class="card" data-role="expected"><img data-src="/expected.png" src="/expected.png"><figcaption>expected.png</figcaption></figure>
  <figure class="card" data-role="actual"><img data-src="/actual.png" src="/actual.png"><figcaption>actual.svg (rasterised)</figcaption></figure>
  <figure class="card" data-role="diff"><img data-src="/diff.png" src="/diff.png"><figcaption>diff.png</figcaption></figure>
</div>
<div id="lightbox"><div id="lightbox-inner"></div></div>
<div id="issue-panel">
  <h2 style="font-size: 14px; margin: 16px 0 6px;">Annotated regions</h2>
  <div class="region-list" id="region-list"><p class="hint">(none yet — drag on any image above)</p></div>
  <h2 style="font-size: 14px; margin: 16px 0 6px;">GitHub issue text <button id="copy-btn">Copy</button> <a id="file-link" href="https://github.com/brianwestphal/domotion/issues/new" target="_blank" rel="noopener">File at github.com →</a></h2>
  <textarea id="issue-text" readonly></textarea>
  <p class="hint">After clicking <em>File at github.com</em>, paste the text above into the issue body and attach <code>expected.png</code> and <code>actual.svg</code>.</p>
</div>
<script>window.__SVG_REVIEW__ = { label: ${JSON.stringify(label)} };</script>
<script src="/client.js"></script>
</body></html>`;
}

export async function startReviewServer(inputs: ReviewServerInputs): Promise<ReviewServer> {
  const label = inputs.label ?? inputs.actualSvg.split("/").pop() ?? "svg-review";
  const clientJs = REVIEW_CLIENT_JS;
  // Read the static images once at startup; they're snapshot files, not
  // mutating during the review session.
  for (const p of [inputs.expectedPng, inputs.actualPng, inputs.actualSvg, inputs.diffPng]) {
    if (!existsSync(p)) throw new Error(`svg-review: file not found: ${p}`);
  }
  const fileByRoute: Record<string, string> = {
    "/expected.png": inputs.expectedPng,
    "/actual.png":   inputs.actualPng,
    "/actual.svg":   inputs.actualSvg,
    "/diff.png":     inputs.diffPng,
  };

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      const html = renderShell(label);
      res.writeHead(200, { "content-type": MIME[".html"]! });
      res.end(html);
      return;
    }
    if (url === "/client.js") {
      res.writeHead(200, { "content-type": MIME[".js"]! });
      res.end(clientJs);
      return;
    }
    const filePath = fileByRoute[url];
    if (filePath != null) {
      const ext = extname(filePath).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end(`not found: ${url}`);
  };

  const server = createServer(handler);
  const port = await new Promise<number>((resolveFn, rejectFn) => {
    server.once("error", rejectFn);
    server.listen(inputs.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr != null && typeof addr === "object") resolveFn(addr.port);
      else rejectFn(new Error("svg-review: server.address() returned unexpected value"));
    });
  });
  const url = `http://127.0.0.1:${port}/`;
  const close = () => new Promise<void>((resolveFn) => server.close(() => resolveFn()));
  return { url, port, close };
}
