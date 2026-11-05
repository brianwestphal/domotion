/**
 * The one Node-side `data:` URL decoder. Several call sites used to hand-roll
 * their own and disagreed: one accepted `;base64` only immediately after the
 * mime type (so `data:image/svg+xml;charset=utf-8;base64,…` failed), one
 * accepted base64 only, and the percent-decoding ones threw on a stray `%`.
 *
 * Semantics follow the Fetch Standard's data: URL processor
 * (https://fetch.spec.whatwg.org/#data-url-processor). Chromium's own decoder
 * (`net/base/data_url.cc`) is outside the local checkout's sparse set, so this
 * is transcribed from the standard, not from Chromium:
 *
 * - everything before the first `,` is the metadata, the rest is the body;
 * - the body is percent-decoded byte-wise, leaving a `%` that does not begin a
 *   valid `%XX` escape as-is (never throws);
 * - the metadata is base64 when its LAST `;`-separated piece, trimmed, is
 *   `base64` (ASCII case-insensitive); the body is then forgiving-base64
 *   decoded (ASCII whitespace ignored);
 * - the remaining metadata is the media type; empty means
 *   `text/plain;charset=US-ASCII`.
 */
export interface ParsedDataUri {
  /** Lowercased media-type essence (`type/subtype`), e.g. `image/svg+xml`. */
  mime: string;
  /** The media-type parameters after the essence, trimmed, e.g. `["charset=utf-8"]`. */
  params: string[];
  /** Whether the body was base64-encoded. */
  base64: boolean;
  /** The decoded body bytes. */
  bytes: Buffer;
}

const DEFAULT_MEDIA_TYPE = "text/plain;charset=US-ASCII";
const BASE64_ALPHABET = /^[A-Za-z0-9+/]*$/;

/** Percent-decode a string byte-wise (URL Standard "percent-decode"). */
function percentDecode(input: string): Buffer {
  const bytes = Buffer.from(input, "utf8");
  const out = Buffer.alloc(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0x25 && i + 2 < bytes.length) {
      const hex = String.fromCharCode(bytes[i + 1], bytes[i + 2]);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out[n++] = parseInt(hex, 16);
        i += 2;
        continue;
      }
    }
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/** Parse a `data:` URL; `null` when `uri` is not one or its base64 body is invalid. */
export function parseDataUri(uri: string): ParsedDataUri | null {
  if (!/^data:/i.test(uri)) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  let metadata = uri.slice(5, comma).trim();
  const body = uri.slice(comma + 1);
  const lastSemicolon = metadata.lastIndexOf(";");
  const base64 =
    lastSemicolon >= 0 &&
    metadata
      .slice(lastSemicolon + 1)
      .trim()
      .toLowerCase() === "base64";
  if (base64) metadata = metadata.slice(0, lastSemicolon).trim();
  if (metadata.startsWith(";")) metadata = `text/plain${metadata}`;
  const mediaType = metadata === "" ? DEFAULT_MEDIA_TYPE : metadata;
  const [essence, ...rawParams] = mediaType.split(";");
  const mime = essence.trim().toLowerCase() || "text/plain";
  const params = rawParams.map((param) => param.trim()).filter((param) => param !== "");

  const decoded = percentDecode(body);
  if (!base64) return { mime, params, base64, bytes: decoded };
  let text = decoded.toString("latin1").replace(/[\t\n\f\r ]/g, "");
  if (text.length % 4 === 0) text = text.replace(/={1,2}$/, "");
  // Forgiving-base64 (https://infra.spec.whatwg.org/#forgiving-base64-decode):
  // padding is only allowed to complete a multiple of 4, which was stripped above.
  if (text.length % 4 === 1 || !BASE64_ALPHABET.test(text)) return null;
  return { mime, params, base64, bytes: Buffer.from(text, "base64") };
}

/** A `data:` URL's body decoded as UTF-8 text, or `null` (see `parseDataUri`). */
export function decodeDataUriText(uri: string): string | null {
  const parsed = parseDataUri(uri);
  return parsed == null ? null : parsed.bytes.toString("utf8");
}
