/**
 * Fetch the bytes of one discovered webfont source URL.
 *
 * Playwright's `APIRequestContext.get` only speaks `http:` / `https:`; it throws
 * `Protocol "data:" not supported` for a `data:` URL and the same for `file:`.
 * Before this module every `@font-face { src: url(data:font/ttf;base64,…) }`
 * face — the normal way self-contained HTML embeds a font — was reported
 * `ok: false` and never registered, so the render fell back to the system
 * chain while Chrome painted the webfont.
 *
 * - `data:` is decoded locally with the fetch spec's data: URL processor
 *   (percent-decode the body, then forgiving-base64 when the media type ends in
 *   `;base64`), which is the procedure Chrome's loader runs for these sources.
 * - `file:` is read from disk, but only for a `file:` page: Chrome loads a
 *   `file:` font from a `file:` document and blocks it from any other origin,
 *   so reading it for an `http:` page would register a face Chrome never paints.
 * - Everything else goes through the browser context's request API, so
 *   cookies / auth follow whatever the browser is using.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type FontSourceResult = { ok: true; body: Buffer } | { ok: false; error: string };

/** Minimal slice of Playwright's `APIRequestContext` used here. */
export type FontHttpGetter = (
  url: string,
) => Promise<{ ok: () => boolean; status: () => number; body: () => Promise<Buffer> }>;

const ASCII_WS = /[\t\n\f\r ]/g;

/** Percent-decode a string to bytes (WHATWG URL "percent-decode"): `%XX` with
 *  two hex digits becomes that byte, every other code point its UTF-8 bytes. */
function percentDecodeToBytes(input: string): Buffer {
  const utf8 = Buffer.from(input, "utf8");
  const out: number[] = [];
  const isHex = (b: number | undefined): boolean =>
    b != null && ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66));
  for (let i = 0; i < utf8.length; i++) {
    const b = utf8[i];
    if (b === 0x25 && isHex(utf8[i + 1]) && isHex(utf8[i + 2])) {
      out.push(parseInt(String.fromCharCode(utf8[i + 1], utf8[i + 2]), 16));
      i += 2;
    } else {
      out.push(b);
    }
  }
  return Buffer.from(out);
}

/** WHATWG "forgiving-base64 decode"; null on failure. */
function forgivingBase64Decode(input: string): Buffer | null {
  let data = input.replace(ASCII_WS, "");
  if (data.length % 4 === 0) data = data.replace(/={1,2}$/, "");
  if (data.length % 4 === 1) return null;
  if (!/^[A-Za-z0-9+/]*$/.test(data)) return null;
  return Buffer.from(data, "base64");
}

/**
 * The fetch spec's data: URL processor, body only. Returns null when `url` is
 * not a valid data: URL (no comma, or an undecodable base64 payload), which
 * Chrome treats as a network error for the source.
 */
export function decodeDataUrl(url: string): Buffer | null {
  if (!/^data:/i.test(url)) return null;
  // The processor runs on the URL serialized with its fragment excluded.
  const hash = url.indexOf("#");
  const input = (hash >= 0 ? url.slice(0, hash) : url).slice("data:".length);
  const comma = input.indexOf(",");
  if (comma < 0) return null;
  const mimeType = input.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
  const body = percentDecodeToBytes(input.slice(comma + 1));
  if (/;[ ]*base64$/i.test(mimeType)) return forgivingBase64Decode(body.toString("latin1"));
  return body;
}

export async function fetchFontSourceBytes(
  url: string,
  httpGet: FontHttpGetter,
  pageUrl: string,
): Promise<FontSourceResult> {
  if (/^data:/i.test(url)) {
    const body = decodeDataUrl(url);
    return body == null ? { ok: false, error: "invalid data: URL" } : { ok: true, body };
  }
  if (/^file:/i.test(url)) {
    if (!/^file:/i.test(pageUrl)) return { ok: false, error: "file: source blocked for a non-file: page" };
    try {
      return { ok: true, body: await readFile(fileURLToPath(url)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const resp = await httpGet(url);
  if (!resp.ok()) return { ok: false, error: `HTTP ${resp.status()}` };
  return { ok: true, body: Buffer.from(await resp.body()) };
}
