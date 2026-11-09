/** Balanced font shorthand boundaries shared by SVG root metrics and name isolation. */
export interface ImageFontShorthand {
  size: string;
  family: string;
  familyStart: number;
  lineHeight: string;
  weight: string;
  style: string;
  stretch: string;
  variant: string;
}

/** CSS functions and quoted names remain single tokens, including nested math. */
function tokens(value: string): Array<{ value: string; start: number }> | null {
  const out: Array<{ value: string; start: number }> = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i <= value.length; i++) {
    const ch = value[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (--depth < 0) return null;
    } else if (depth === 0 && (ch == null || /\s/.test(ch) || ch === "/")) {
      if (i > start) out.push({ value: value.slice(start, i), start });
      if (ch === "/") out.push({ value: ch, start: i });
      start = i + 1;
    }
  }
  return depth === 0 && quote === "" ? out : null;
}

export function parseImageFontShorthand(value: string): ImageFontShorthand | null {
  const parts = tokens(value);
  if (parts == null) return null;
  let weight = "normal",
    style = "normal",
    stretch = "normal",
    variant = "normal";
  for (let i = 0; i < parts.length; i++) {
    const token = parts[i].value;
    const lower = token.toLowerCase();
    const size =
      /^(?:calc|min|max|clamp)\(/i.test(token) ||
      /^(?:[-+]?(?:\d+\.?\d*|\.\d+)(?:px|pt|pc|in|cm|mm|q|em|rem|ex|rex|cap|rcap|ch|rch|ic|ric|lh|rlh|vw|vh|vmin|vmax|%)|0|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|smaller|larger)$/i.test(
        token,
      );
    if (size) {
      let familyIndex = i + 1;
      let lineHeight = "normal";
      if (parts[familyIndex]?.value === "/") {
        lineHeight = parts[++familyIndex]?.value ?? "";
        if (
          !/^(?:normal|[-+]?(?:\d+\.?\d*|\.\d+)(?:%|[a-z]+)?)$/i.test(lineHeight) &&
          !/^(?:calc|min|max|clamp)\(/i.test(lineHeight)
        )
          return null;
        familyIndex++;
      }
      if (parts[familyIndex] == null || parts[familyIndex].value === "/") return null;
      const familyStart = parts[familyIndex].start;
      // A family tail is strings/identifiers, never another function or slash.
      if (
        parts
          .slice(familyIndex)
          .some((part) => part.value === "/" || (/^[^"']/.test(part.value) && /[():;]/.test(part.value)))
      )
        return null;
      return {
        size: token,
        family: value.slice(familyStart).trim(),
        familyStart,
        lineHeight,
        weight,
        style,
        stretch,
        variant,
      };
    }
    if (lower === "normal") continue;
    if ((lower === "italic" || lower === "oblique") && style === "normal") {
      style = lower;
      if (lower === "oblique" && /^[-+]?(?:\d+\.?\d*|\.\d+)deg$/i.test(parts[i + 1]?.value ?? ""))
        style += ` ${parts[++i].value}`;
    } else if (/^(?:bold|bolder|lighter|(?:[1-9]\d{0,2}|1000))$/.test(lower) && weight === "normal") weight = lower;
    else if (
      /^(?:ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/.test(
        lower,
      ) &&
      stretch === "normal"
    )
      stretch = lower;
    else if (lower === "small-caps" && variant === "normal") variant = lower;
    else return null;
  }
  return null;
}
