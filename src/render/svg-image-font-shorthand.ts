/** Balanced font shorthand boundaries shared by SVG root metrics and name isolation. */
import { blankImageCssNoise } from "./svg-image-cdata.js";
import { imageCssEscapeEnd, parseImageFontFamilyTail } from "./svg-image-font-family.js";
import { imageRootFontSizeLength } from "./svg-image-root-transform.js";

const LINE_HEIGHT_UNIT =
  /^(?:%|px|pt|pc|in|cm|mm|q|r?em|r?ex|r?ch|r?cap|r?ic|r?lh|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))$/i;

/** ConsumeLineHeight accepts a nonnegative number/length/percentage. Math
 * outside the existing typed length evaluator remains unresolved. */
function validLineHeight(value: string): boolean {
  if (/^normal$/i.test(value)) return true;
  const simple = /^([-+]?(?:\d+\.?\d*|\.\d+))(%|[a-z]+)?$/i.exec(value);
  if (simple != null) return Number(simple[1]) >= 0 && (simple[2] == null || LINE_HEIGHT_UNIT.test(simple[2]));
  return /^(?:calc|min|max|clamp)\(/i.test(value) && imageRootFontSizeLength(value, 16) != null;
}
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
function tokens(value: string): Array<{ value: string; start: number; end: number }> | null {
  const out: Array<{ value: string; start: number; end: number }> = [];
  value = blankImageCssNoise(value, false);
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let i = 0; i <= value.length; i++) {
    const ch = value[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === "\\") {
      const end = imageCssEscapeEnd(value, i);
      if (end == null) return null;
      i = end - 1;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      if (--depth < 0) return null;
    } else if (depth === 0 && (ch == null || /[ \t\n\r\f]/.test(ch) || ch === "/")) {
      if (i > start) out.push({ value: value.slice(start, i), start, end: i });
      if (ch === "/") out.push({ value: ch, start: i, end: i + 1 });
      start = i + 1;
    }
  }
  return depth === 0 && quote === "" ? out : null;
}

export function parseImageFontShorthand(value: string): ImageFontShorthand | null {
  if (value.length > 65536) return null;
  const parts = tokens(value);
  if (parts == null) return null;
  let weight = "normal",
    style = "normal",
    stretch = "normal",
    variant = "normal";
  let optionalCount = 0;
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
        const part = parts[++familyIndex];
        lineHeight = part == null ? "" : value.slice(part.start, part.end);
        if (!validLineHeight(lineHeight)) return null;
        familyIndex++;
      }
      if (parts[familyIndex] == null || parts[familyIndex].value === "/") return null;
      const familyStart = parts[familyIndex].start;
      const families = parseImageFontFamilyTail(value.slice(familyStart));
      if (families == null) return null;
      return {
        // Keep size math raw: inserting whitespace where comments occurred
        // must not turn invalid operator spacing into a valid expression.
        size: value.slice(parts[i].start, parts[i].end),
        family: families.map((family) => family.css).join(", "),
        familyStart,
        lineHeight,
        weight,
        style,
        stretch,
        variant,
      };
    }
    // ConsumeFont permits at most four optional components, including each
    // normal placeholder (shorthands_custom.cc:3100–3157, Chromium7d859f27).
    if (++optionalCount > 4) return null;
    if (lower === "normal") continue;
    if ((lower === "italic" || lower === "oblique") && style === "normal") {
      style = lower;
      if (lower === "oblique" && /^[-+]?(?:\d+\.?\d*|\.\d+)deg$/i.test(parts[i + 1]?.value ?? "")) {
        if (Math.abs(parseFloat(parts[i + 1].value)) > 90) return null;
        style += ` ${parts[++i].value}`;
      }
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
