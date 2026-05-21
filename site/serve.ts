/**
 * Tiny static file server for previewing the built manual.
 *
 * Run: `npx tsx site/serve.ts` (after `npx tsx site/build.ts`).
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(SITE_DIR, "dist");

function mimeFor(p: string): string {
  const ext = extname(p).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css")  return "text/css; charset=utf-8";
  if (ext === ".js")   return "text/javascript; charset=utf-8";
  if (ext === ".svg")  return "image/svg+xml";
  if (ext === ".png")  return "image/png";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

const port = parseInt(process.env.PORT ?? "4180", 10);

const server = createServer((req, res) => {
  if (req.url == null) { res.statusCode = 400; res.end(); return; }
  let pathname = decodeURIComponent(req.url.split("?")[0]);
  if (pathname.includes("..")) { res.statusCode = 400; res.end("bad path"); return; }
  let filePath = resolve(DIST_DIR, "." + pathname);
  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = resolve(filePath, "index.html");
  }
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end(`not found: ${pathname}`);
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", mimeFor(filePath));
  res.end(readFileSync(filePath));
});

server.listen(port, () => {
  console.log(`Manual preview: http://localhost:${port}/`);
});
