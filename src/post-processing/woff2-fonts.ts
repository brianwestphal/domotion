// DM-1664: shrink the embedded fonts in a finished SVG by re-compressing the
// subsetted TTF `@font-face` data URIs to WOFF2 (Brotli). Embedded fonts are the
// #1 size source in text-heavy captures (~73% of a word demo), and WOFF2 cuts the
// font bytes ~40%.
//
// This is an ASYNC POST-PASS over the SVG string rather than a change to the
// (synchronous) render path, so `elementTreeToSvg` and its callers stay sync — a
// consumer that wants the smaller output awaits this on the result, exactly like
// the optional svgo `optimize()` pass. `getBuiltEmbeddedFontFaceCss()` emits
// `src: url("data:font/ttf;base64,…")`; this rewrites each to
// `url("data:font/woff2;base64,…") format("woff2")`.
//
// Determinism (DM-902): the TTF bytes are already timestamp-zeroed before base64,
// and `wawoff2.compress` (the reference WOFF2 encoder → Brotli) is deterministic,
// so the same SVG in → the same SVG out (verified in the unit test + the
// committed-demo zero-diff regeneration).

// wawoff2 is a WASM module with no .d.ts; the runtime export is `{ compress, decompress }`.
type Wawoff2 = { compress: (b: Uint8Array) => Promise<Uint8Array> };

// Matches `url(data:font/ttf;base64,X)` and the svgo-minified `url("…")` /
// `url('…')` variants, plus any existing `format(...)` hint after it. Group 2 is
// the TTF base64. Robust to whether this runs before or after the svgo pass.
const TTF_DATA_URI = /url\(\s*(["']?)data:font\/ttf;base64,([A-Za-z0-9+/=]+)\1\s*\)(\s*format\((?:"[^"]*"|'[^']*'|[^)]*)\))?/g;

/**
 * Re-compress every embedded TTF `@font-face` data URI in `svg` to WOFF2.
 * Returns the SVG unchanged when it embeds no TTF fonts (e.g. paths-mode output
 * or an all-raster capture). Identical TTF payloads are compressed once.
 */
export async function compressEmbeddedFontsToWoff2(svg: string): Promise<string> {
  const matches = [...svg.matchAll(TTF_DATA_URI)];
  if (matches.length === 0) return svg;

  const wawoff = (await import("wawoff2" as string)) as unknown as Wawoff2;
  const cache = new Map<string, string>(); // ttf-base64 → woff2-base64
  for (const m of matches) {
    const ttfB64 = m[2];
    if (cache.has(ttfB64)) continue;
    const ttf = Buffer.from(ttfB64, "base64");
    const woff2 = Buffer.from(await wawoff.compress(new Uint8Array(ttf)));
    cache.set(ttfB64, woff2.toString("base64"));
  }
  return svg.replace(TTF_DATA_URI, (_full, _q: string, ttfB64: string) =>
    `url("data:font/woff2;base64,${cache.get(ttfB64)}") format("woff2")`);
}
