import { gzipSync } from "node:zlib";

/**
 * Gzip-compress an SVG string for `.svgz` output. Browsers transparently
 * decompress `.svgz` when served with `Content-Encoding: gzip` (or, in
 * many cases, by sniffing the magic bytes). The resulting payload is
 * typically 3–5× smaller than the equivalent svgo'd `.svg` and 10–20×
 * smaller than the unoptimized text.
 *
 * Returns a `Buffer` because the bytes are not valid UTF-8.
 */
export function gzipSvg(svg: string): Buffer {
  return gzipSync(svg);
}
