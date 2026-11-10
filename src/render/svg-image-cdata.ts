/** Join adjacent CDATA sections before a CSS parser sees their DOM text.
 * The common single-section path keeps its original bytes and offsets. */
export function joinedCdata(css: string): { prefix: string; content: string; suffix: string } | null {
  if (!css.includes("]]><![CDATA[")) return null;
  const wrapped = /^(\s*<!\[CDATA\[)([\s\S]*)(\]\]>\s*)$/.exec(css);
  return wrapped == null
    ? null
    : { prefix: wrapped[1], content: wrapped[2].replaceAll("]]><![CDATA[", ""), suffix: wrapped[3] };
}

export function serializeJoinedCdata(css: string, wrapper: { prefix: string; suffix: string }): string {
  return wrapper.prefix + css.replaceAll("]]>", "]]]]><![CDATA[>") + wrapper.suffix;
}

/** Preserve quoted CSS data while masking real comments/XML wrappers at the
 * same offsets. A literal ]]> inside a selector or family name is data. */
export function blankImageCssNoise(css: string, xmlWrappers = true): string {
  let out = "",
    start = 0;
  let quote: string | null = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    let end: number | undefined;
    if (css.startsWith("/*", i)) {
      const close = css.indexOf("*/", i + 2);
      end = close < 0 ? css.length : close + 2;
    } else if (xmlWrappers) {
      const marker = ["<![CDATA[", "]]>", "<!--", "-->"].find((value) => css.startsWith(value, i));
      if (marker != null) end = i + marker.length;
    }
    if (end == null) continue;
    out += css.slice(start, i) + " ".repeat(end - i);
    i = end - 1;
    start = end;
  }
  return out + css.slice(start);
}
