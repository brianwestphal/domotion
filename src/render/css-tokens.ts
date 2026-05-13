/**
 * CSS tokenization helpers used by the SVG renderer's CSS-string parsers.
 *
 *  - `parseCssUrl`           — extract the inner URL of a `url(...)` token.
 *  - `splitTopLevelCommas`   — split a comma-separated CSS list at top level
 *                              (respecting parentheses nesting).
 */

/**
 * Extract the URL string from a CSS `url(...)` token. Handles double-
 * quoted, single-quoted, and unquoted variants — including data: URLs whose
 * contents carry embedded `"` characters that the prior `[^"')]+` regex
 * tripped on. CSS escape sequences (`\"` → `"`, `\\` → `\`) are unescaped.
 * Returns null when the input isn't a `url(...)` token. (DM-308)
 */
export function parseCssUrl(token: string): string | null {
  const m = /^\s*url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)\s]+))\s*\)\s*$/.exec(token);
  if (m == null) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  if (raw == null) return null;
  return raw.replace(/\\(.)/g, "$1");
}

/**
 * Split a comma-separated list respecting parentheses nesting. Used to split
 * multiple CSS background layers like:
 *   'linear-gradient(red, blue), url("x.png")'
 */
export function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}
