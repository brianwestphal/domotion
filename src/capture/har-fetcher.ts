/**
 * Serve webfont-discovery fetches from a HAR archive.
 *
 * `discoverAndRegisterWebfonts` downloads font bytes and cross-origin
 * stylesheet text Node-side. Its default getter is Playwright's
 * `APIRequestContext`, which `BrowserContext.routeFromHAR` does NOT intercept:
 * routes apply only to requests the page makes. During a HAR replay
 * (`domotion capture page.har`, and the real-world regression suite) Chrome
 * therefore painted fonts from the archive while discovery re-downloaded them
 * from the live network, which fails once a deployment URL is gone (resend.com's
 * `_next/static/media/*.woff2?dpl=…` faces now 404) and can silently return
 * different bytes than the ones Chrome painted.
 *
 * This module answers those fetches from the archive itself, using the same
 * lookup and body-loading procedure as Playwright's HAR router
 * (`playwright-core/lib/server/harBackend.js`, `HarBackend._harFindResponse` /
 * `_loadContent`), so discovery sees exactly the bytes the replayed page saw:
 *
 * - an entry matches on an exact request URL and method; with several
 *   candidates Playwright scores them by matching request headers, which a
 *   Node-side fetch does not have, so the first candidate wins (Playwright's
 *   tie result as well);
 * - a 3xx entry with a `Location` header is followed (relative to the
 *   requested URL), with a redirect-cycle guard;
 * - a body comes from the `_file` sidecar (resolved against the HAR's
 *   directory, where Playwright writes it for a `.har` path), else from
 *   `content.text`, base64-decoded when `content.encoding === "base64"`.
 *
 * The request URL is matched with its fragment removed, because a fragment is
 * never part of a network request and so never appears in a recorded entry.
 * When no entry matches, `notFound` decides like `routeFromHAR`'s option of the
 * same name: `"abort"` fails the fetch, `"fallback"` hands it to `fallback`.
 */
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FontHttpGetter } from "./font-source-bytes.js";

interface HarHeader {
  name: string;
  value: string;
}

interface HarContent {
  text?: string;
  encoding?: string;
  _file?: string;
}

export interface HarEntry {
  request: { url: string; method: string };
  response: { status: number; headers?: HarHeader[]; content?: HarContent };
}

export interface HarArchive {
  /** Directory `_file` sidecars resolve against. */
  baseDir: string;
  entries: HarEntry[];
}

/** HTTP status codes Playwright's HAR router treats as redirects. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function isHarEntry(value: unknown): value is HarEntry {
  if (value == null || typeof value !== "object") return false;
  const { request, response } = value as { request?: unknown; response?: unknown };
  if (request == null || typeof request !== "object" || response == null || typeof response !== "object") {
    return false;
  }
  const { url, method } = request as { url?: unknown; method?: unknown };
  return (
    typeof url === "string" &&
    typeof method === "string" &&
    typeof (response as { status?: unknown }).status === "number"
  );
}

/** Parse HAR JSON text into an archive. Entries without a usable request or
 *  response are dropped rather than failing the whole archive. */
export function parseHarArchive(jsonText: string, baseDir: string): HarArchive {
  const har = JSON.parse(jsonText) as { log?: { entries?: unknown } };
  const raw = har?.log?.entries;
  const entries = Array.isArray(raw) ? raw.filter(isHarEntry) : [];
  return { baseDir, entries };
}

/** Read and parse a `.har` file; `_file` sidecars resolve against its directory. */
export function loadHarArchive(harPath: string): HarArchive {
  return parseHarArchive(readFileSync(harPath, "utf8"), path.dirname(path.resolve(harPath)));
}

function stripFragment(url: string): string {
  const hash = url.indexOf("#");
  return hash >= 0 ? url.slice(0, hash) : url;
}

/**
 * Find the entry Playwright's HAR router would serve for `url`, following
 * recorded redirects. Returns null when nothing matches. Throws on a redirect
 * cycle, as Playwright does.
 */
export function findHarEntry(archive: HarArchive, url: string, method = "GET"): HarEntry | null {
  let current = stripFragment(url);
  let currentMethod = method.toUpperCase();
  const visited = new Set<HarEntry>();
  for (;;) {
    const entry = archive.entries.find((e) => e.request.url === current && e.request.method === currentMethod);
    if (entry == null) return null;
    if (visited.has(entry)) throw new Error(`Found redirect cycle for ${url}`);
    visited.add(entry);
    const status = entry.response.status;
    const location = entry.response.headers?.find((h) => h.name.toLowerCase() === "location");
    if (REDIRECT_STATUS.has(status) && location != null) {
      current = new URL(location.value, current).toString();
      if (
        ((status === 301 || status === 302) && currentMethod === "POST") ||
        (status === 303 && currentMethod !== "GET" && currentMethod !== "HEAD")
      ) {
        currentMethod = "GET";
      }
      continue;
    }
    return entry;
  }
}

/** Load an entry's response body: the `_file` sidecar, else `content.text`. */
export async function loadHarEntryBody(archive: HarArchive, entry: HarEntry): Promise<Buffer> {
  const content = entry.response.content ?? {};
  if (content._file != null && content._file !== "") {
    return readFile(path.resolve(archive.baseDir, content._file));
  }
  return Buffer.from(content.text ?? "", content.encoding === "base64" ? "base64" : "utf-8");
}

export interface HarHttpGetterOptions {
  /** What to do when the archive has no entry: mirrors `routeFromHAR`'s `notFound`. */
  notFound: "abort" | "fallback";
  /** The getter used for unmatched URLs when `notFound` is `"fallback"`. */
  fallback?: FontHttpGetter;
}

/**
 * A `FontHttpGetter` that serves `discoverAndRegisterWebfonts` fetches from
 * `archive`. A matched entry is served with its recorded status; an unmatched
 * URL either rejects (like a request `routeFromHAR` aborts) or goes to
 * `fallback`. Discovery records a rejection as that candidate's error.
 */
export function createHarHttpGetter(archive: HarArchive, options: HarHttpGetterOptions): FontHttpGetter {
  return async (url) => {
    const entry = findHarEntry(archive, url);
    if (entry == null) {
      if (options.notFound === "fallback" && options.fallback != null) return options.fallback(url);
      throw new Error(`not in HAR archive: ${url}`);
    }
    const body = await loadHarEntryBody(archive, entry);
    const status = entry.response.status;
    return { ok: () => status >= 200 && status <= 299, status: () => status, body: () => Promise.resolve(body) };
  };
}
