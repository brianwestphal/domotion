import postcss, { type AtRule, type Root } from "postcss";

const MAX_IMPORT_DEPTH = 4;
const MAX_CSS_BYTES = 256_000;

function dataCss(url: string): string | null {
  const match = /^data:([^,]*),(.*)$/is.exec(url);
  if (match == null) return null;
  const parts = match[1].split(";");
  if (parts[0].toLowerCase() !== "text/css") return null;
  const base64 = parts.at(-1)?.toLowerCase() === "base64";
  if (parts.some((part) => /^charset=/i.test(part) && !/^charset=utf-8$/i.test(part))) return null;
  try {
    const css = base64 ? Buffer.from(match[2], "base64").toString("utf8") : decodeURIComponent(match[2]);
    // This text is inserted into XML character data in the inlined SVG.
    return css.length <= MAX_CSS_BYTES && !/[<&]/.test(css) ? css : null;
  } catch {
    return null;
  }
}

function parenthesized(text: string, start: number): { content: string; end: number } | null {
  if (text[start] !== "(") return null;
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) {
      return { content: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

interface ImportSpec {
  url: string;
  layer: string | null;
  supports: string | null;
  media: string | null;
}

function importSpec(params: string): ImportSpec | null {
  const match = /^\s*(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|"([^"]*)"|'([^']*)')([\s\S]*)$/i.exec(params);
  if (match == null) return null;
  let rest = match[6].trim();
  let layer: string | null = null;
  if (/^layer(?:\s|\(|$)/i.test(rest)) {
    rest = rest.slice(5).trimStart();
    if (rest.startsWith("(")) {
      const arg = parenthesized(rest, 0);
      if (arg == null) return null;
      layer = arg.content.trim();
      rest = rest.slice(arg.end).trimStart();
    } else {
      layer = "";
    }
  }
  let supports: string | null = null;
  if (/^supports\(/i.test(rest)) {
    const arg = parenthesized(rest, 8);
    if (arg == null) return null;
    supports = arg.content.trim();
    rest = rest.slice(arg.end).trimStart();
  }
  return { url: match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5], layer, supports, media: rest || null };
}

function expandCss(css: string, depth: number): string | null {
  if (depth > MAX_IMPORT_DEPTH || css.length > MAX_CSS_BYTES) return null;
  let root: Root;
  try {
    root = postcss.parse(css);
  } catch {
    return null;
  }
  // A data-imported sheet can contain another resource URL. In SVG image mode
  // that resource may be blocked, whereas the inlined host document could load
  // it. Keep the original image raster when that distinction matters.
  let hasResourceValue = false;
  root.walkDecls((declaration) => {
    if (/\burl\s*\(/i.test(declaration.value)) hasResourceValue = true;
  });
  if (hasResourceValue) return null;
  let importsAllowed = true;
  for (const node of [...root.nodes]) {
    if (node.type !== "atrule" || node.name.toLowerCase() !== "import") {
      if (
        node.type !== "comment" &&
        !(node.type === "atrule" && node.name.toLowerCase() === "charset") &&
        !(node.type === "atrule" && node.name.toLowerCase() === "layer" && node.nodes == null)
      )
        importsAllowed = false;
      continue;
    }
    const spec = importSpec(node.params);
    if (!importsAllowed) {
      node.remove(); // Blink ignores an @import after a style rule.
      continue;
    }
    if (spec == null) return null;
    // CSS escapes or XML entities may change the URL scheme after parsing.
    // Keep the original image when we cannot classify its resource safely.
    if (/[\\&]/.test(spec.url)) return null;
    if (!spec.url.toLowerCase().startsWith("data:")) {
      node.remove(); // External loads are disabled in SVG image documents.
      continue;
    }
    const decoded = dataCss(spec.url);
    if (decoded == null) return null;
    const nested = expandCss(decoded, depth + 1);
    if (nested == null) return null;
    let inserted = nested;
    if (spec.media != null) inserted = `@media ${spec.media} { ${inserted} }`;
    if (spec.supports != null) {
      const condition = /^(?:\(|not\b|selector\()/i.test(spec.supports) ? spec.supports : `(${spec.supports})`;
      inserted = `@supports ${condition} { ${inserted} }`;
    }
    if (spec.layer != null) inserted = `@layer ${spec.layer} { ${inserted} }`;
    let replacement: Root;
    try {
      replacement = postcss.parse(inserted);
    } catch {
      return null;
    }
    (node as AtRule).replaceWith(...replacement.nodes);
  }
  return root.toString();
}

/** Resolve image-allowed data CSS imports and remove blocked external imports. */
export function resolveSvgImageCssImports(svgText: string): string | null {
  if (!/@import\b/i.test(svgText)) return svgText;
  let unresolved = false;
  const out = svgText.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_whole, open: string, css: string, close: string) => {
      if (!/@import\b/i.test(css)) return open + css + close;
      const expanded = expandCss(css, 0);
      if (expanded == null) {
        unresolved = true;
        return open + css + close;
      }
      return open + expanded + close;
    },
  );
  return unresolved ? null : out;
}
