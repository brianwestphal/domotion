/**
 * Keep an inlined SVG image's CSS-wide names inside its former document.
 *
 * The image was a separate Blink Document while it lived in `<img>`. Moving
 * its sheets into the output SVG joins the output's keyframe, font-face,
 * registered-property and counter-style name tables. Prefix definitions and
 * references together, including presentation and inline-style attributes.
 */
import postcss, { type AtRule, type Declaration, type Root } from "postcss";
import { serializeJoinedCdata } from "./svg-image-cdata.js";
import { renderWarn } from "./render-warn.js";
import { parseImageFontShorthand } from "./svg-image-font-shorthand.js";
import { resolveImageCssVariables } from "./svg-image-css-variables.js";

interface ImageNames {
  keyframes: Set<string>;
  fonts: Set<string>;
  properties: Set<string>;
  counters: Set<string>;
}

interface ParsedSheet {
  prefix: string;
  suffix: string;
  root: Root | null;
  original: string;
}

const STYLE_TAG = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const ANIMATION_KEYWORDS = new Set([
  "none",
  "infinite",
  "normal",
  "reverse",
  "alternate",
  "alternate-reverse",
  "forwards",
  "backwards",
  "both",
  "running",
  "paused",
  "ease",
  "linear",
  "ease-in",
  "ease-out",
  "ease-in-out",
  "step-start",
  "step-end",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
]);
const LIST_STYLE_KEYWORDS = new Set([
  "none",
  "inside",
  "outside",
  "disc",
  "circle",
  "square",
  "decimal",
  "disclosure-open",
  "disclosure-closed",
  "initial",
  "inherit",
  "unset",
  "revert",
  "revert-layer",
]);

/** A CSS name's lookup spelling; hex escapes and ordinary escapes are equivalent. */
function nameKey(raw: string, insensitive = false): string {
  const text = raw.trim();
  const unquoted =
    text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0] ? text.slice(1, -1) : text;
  const decoded = unquoted
    .replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?/g, (_full, hex: string) => {
      const codepoint = parseInt(hex, 16);
      return String.fromCodePoint(codepoint === 0 || codepoint > 0x10ffff ? 0xfffd : codepoint);
    })
    .replace(/\\([^\r\n\f])/g, "$1")
    .replace(/\s+/g, " ");
  return insensitive ? decoded.toLowerCase() : decoded;
}

/** Insert the prefix inside a quoted name, or before an unquoted name. */
function prefixed(raw: string, scope: string): string {
  const text = raw.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
    return `${text[0]}${scope}${text.slice(1)}`;
  }
  return scope + text;
}

/** Split at top-level commas/whitespace without splitting functions or strings. */
function splitOutside(text: string, separator: (ch: string) => boolean): Array<{ value: string; after: string }> {
  const out: Array<{ value: string; after: string }> = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && separator(ch)) {
      let j = i;
      while (j + 1 < text.length && separator(text[j + 1])) j++;
      out.push({ value: text.slice(start, i), after: text.slice(i, j + 1) });
      start = j + 1;
      i = j;
    }
  }
  out.push({ value: text.slice(start), after: "" });
  return out;
}

function renameList(value: string, names: Set<string>, scope: string, insensitive = false): string {
  return splitOutside(value, (ch) => ch === ",")
    .map(({ value: part, after }) => {
      const lead = /^\s*/.exec(part)?.[0] ?? "";
      const tail = /\s*$/.exec(part)?.[0] ?? "";
      const name = part.trim();
      return `${lead}${names.has(nameKey(name, insensitive)) ? prefixed(name, scope) : name}${tail}${after}`;
    })
    .join("");
}

function renameShorthand(value: string, names: Set<string>, scope: string, keywords: Set<string>): string {
  return splitOutside(value, (ch) => ch === ",")
    .map(
      ({ value: item, after }) =>
        splitOutside(item, (ch) => /\s/.test(ch))
          .map(({ value: token, after: space }) => {
            const key = nameKey(token);
            return `${names.has(key) && !keywords.has(key.toLowerCase()) ? prefixed(token, scope) : token}${space}`;
          })
          .join("") + after,
    )
    .join("");
}

/** In a font shorthand the family list follows the size and optional line height. */
function renameFontShorthand(value: string, names: Set<string>, scope: string): string | null {
  const parsed = parseImageFontShorthand(value);
  if (parsed == null)
    return /^(?:caption|icon|menu|message-box|small-caption|status-bar|initial|inherit|unset|revert|revert-layer)$/i.test(
      value.trim(),
    )
      ? value
      : null;
  const offset = parsed.familyStart;
  return value.slice(0, offset) + renameList(value.slice(offset), names, scope, true);
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The second argument of counter(), or third of counters(), names a style. */
function renameCounterFunctions(value: string, names: Set<string>, scope: string): string {
  let out = "";
  let cursor = 0;
  let scanned = 0;
  let quote = "";
  const re = /\bcounters?\(/gi;
  for (let match = re.exec(value); match != null; match = re.exec(value)) {
    for (let i = scanned; i < match.index; i++) {
      if (value[i] === "\\" && i + 1 < match.index) i++;
      else if (quote !== "" && value[i] === quote) quote = "";
      else if (quote === "" && (value[i] === '"' || value[i] === "'")) quote = value[i];
    }
    scanned = match.index;
    if (quote !== "") continue;
    const open = match.index + match[0].length - 1;
    const close = matchingParen(value, open);
    if (close < 0) break;
    const args = splitOutside(value.slice(open + 1, close), (ch) => ch === ",");
    const styleIndex = match[0].toLowerCase() === "counter(" ? 1 : 2;
    if (args[styleIndex] != null) args[styleIndex].value = renameList(args[styleIndex].value, names, scope);
    out += value.slice(cursor, open + 1) + args.map(({ value: part, after }) => part + after).join("") + ")";
    cursor = close + 1;
    scanned = cursor;
    re.lastIndex = cursor;
  }
  return out + value.slice(cursor);
}

/** Replace registered custom-property tokens, leaving strings and URLs alone. */
function renameProperties(value: string, names: Set<string>, scope: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < value.length;) {
    const ch = value[i];
    if (quote !== "") {
      out += ch;
      if (ch === "\\" && i + 1 < value.length) out += value[++i];
      else if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (value.startsWith("/*", i)) {
      const end = value.indexOf("*/", i + 2);
      const next = end < 0 ? value.length : end + 2;
      out += value.slice(i, next);
      i = next;
      continue;
    }
    if (/^url\(/i.test(value.slice(i))) {
      const close = matchingParen(value, i + 3);
      if (close >= 0) {
        out += value.slice(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    const match = /^--(?:[-_a-zA-Z0-9]|\\(?:[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?|[^\r\n\f]))+/.exec(value.slice(i));
    if (match != null && (i === 0 || !/[-_a-zA-Z0-9\\]/.test(value[i - 1]))) {
      out += names.has(nameKey(match[0])) ? `--${scope}${match[0].slice(2)}` : match[0];
      i += match[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function rewriteDeclaration(
  decl: Declaration,
  names: ImageNames,
  scope: string,
  variableCounts: ReadonlyMap<string, number>,
): boolean {
  const prop = decl.prop.toLowerCase();
  if (names.properties.has(nameKey(decl.prop))) decl.prop = `--${scope}${decl.prop.slice(2)}`;
  let value = decl.value;
  if ((prop === "font" || prop === "font-family") && names.fonts.size > 0) {
    const expanded = resolveImageCssVariables(value, (name) => {
      // Only a sole definition in this exact declaration block is provably
      // constant for every element to which this font declaration applies.
      // null is absent (var fallback is valid); undefined is an undecidable
      // value whose fallback must not be mistaken for the actual value.
      if (names.properties.has(nameKey(name))) return undefined;
      if (!variableCounts.has(name)) return null;
      if (variableCounts.get(name) !== 1) return undefined;
      const local = decl.parent?.nodes?.find((node) => node.type === "decl" && node.prop === name);
      return local?.type === "decl" ? local.value : undefined;
    });
    if (expanded == null) return false;
    const renamed =
      prop === "font"
        ? renameFontShorthand(expanded, names.fonts, scope)
        : renameList(expanded, names.fonts, scope, true);
    if (renamed == null) return false;
    value = renamed;
  } else if (prop === "animation-name" || prop === "-webkit-animation-name") {
    value = renameList(value, names.keyframes, scope);
  } else if (prop === "animation" || prop === "-webkit-animation") {
    value = renameShorthand(value, names.keyframes, scope, ANIMATION_KEYWORDS);
  } else if (prop === "list-style-type") value = renameList(value, names.counters, scope);
  else if (prop === "list-style") value = renameShorthand(value, names.counters, scope, LIST_STYLE_KEYWORDS);
  else if (prop === "content") value = renameCounterFunctions(value, names.counters, scope);
  else if (prop === "fallback" || prop === "speak-as") value = renameList(value, names.counters, scope);
  else if (prop === "system")
    value = value.replace(/^(\s*extends\s+)(\S+)/i, (_full, head: string, name: string) =>
      names.counters.has(nameKey(name)) ? head + prefixed(name, scope) : head + name,
    );
  decl.value = renameProperties(value, names.properties, scope);
  return true;
}

function rewriteAtRule(rule: AtRule, names: ImageNames, scope: string): void {
  const name = rule.name.toLowerCase();
  if (name === "keyframes" || name === "-webkit-keyframes") {
    if (names.keyframes.has(nameKey(rule.params))) rule.params = prefixed(rule.params, scope);
  } else if (name === "property") {
    if (names.properties.has(nameKey(rule.params))) rule.params = `--${scope}${rule.params.trim().slice(2)}`;
  } else if (name === "counter-style") {
    if (names.counters.has(nameKey(rule.params))) rule.params = prefixed(rule.params, scope);
  } else rule.params = renameProperties(rule.params, names.properties, scope);
}

/** CDATA / HTML comment wrappers are legal in SVG styles but not PostCSS input. */
function parseSheet(css: string): ParsedSheet {
  const wrapped = /^(\s*(?:<!\[CDATA\[|<!--)\s*)([\s\S]*?)(\s*(?:\]\]>|-->)\s*)$/.exec(css);
  const prefix = wrapped?.[1] ?? "";
  const suffix = wrapped?.[3] ?? "";
  const body = wrapped?.[2] ?? css;
  // A CSS string/comment may contain ]]>; XML represents it with adjacent
  // CDATA sections. Feed PostCSS the DOM text, then restore safe boundaries.
  const content = prefix.includes("<![CDATA[") ? body.replaceAll("]]><![CDATA[", "") : body;
  try {
    return { prefix, suffix, root: postcss.parse(content), original: css };
  } catch {
    renderWarn(
      "svg-image-global-css-names",
      "<img> svg stylesheet cannot be parsed for global name isolation",
      "<img> svg",
    );
    return { prefix, suffix, root: null, original: css };
  }
}

function collectNames(sheets: ParsedSheet[]): ImageNames {
  const names: ImageNames = { keyframes: new Set(), fonts: new Set(), properties: new Set(), counters: new Set() };
  for (const sheet of sheets) {
    sheet.root?.walkAtRules((rule) => {
      const name = rule.name.toLowerCase();
      if (name === "keyframes" || name === "-webkit-keyframes") names.keyframes.add(nameKey(rule.params));
      else if (name === "property") names.properties.add(nameKey(rule.params));
      else if (name === "counter-style") names.counters.add(nameKey(rule.params));
      else if (name === "font-face") {
        rule.walkDecls(/^font-family$/i, (decl) => {
          names.fonts.add(nameKey(decl.value, true));
        });
      }
    });
  }
  return names;
}

/** Rewrite inline style and SVG presentation attributes outside `<style>`. */
function rewriteAttributes(
  markup: string,
  names: ImageNames,
  scope: string,
  variableCounts: ReadonlyMap<string, number>,
  unsafe: () => void,
): string {
  return markup.replace(/<[^>]+>/g, (tag) =>
    tag.replace(
      /(\s)(style|font-family|animation-name|list-style-type)\s*=\s*(["'])([\s\S]*?)\3/gi,
      (full, space: string, attr: string, quote: string, value: string) => {
        let next = value;
        if (attr.toLowerCase() === "style") {
          try {
            const root = postcss.parse(`x{${value}}`);
            root.walkDecls((decl) => {
              if (!rewriteDeclaration(decl, names, scope, variableCounts)) unsafe();
            });
            next = root.toString().slice(2, -1);
          } catch {
            return full;
          }
        } else if (attr.toLowerCase() === "font-family" && names.fonts.size > 0) {
          const expanded = resolveImageCssVariables(value, (name) =>
            variableCounts.has(name) || names.properties.has(nameKey(name)) ? undefined : null,
          );
          if (expanded == null) {
            unsafe();
            return full;
          }
          next = renameList(expanded, names.fonts, scope, true);
        } else if (attr.toLowerCase() === "font-family") next = value;
        else if (attr.toLowerCase() === "animation-name") next = renameList(value, names.keyframes, scope);
        else next = renameList(value, names.counters, scope);
        return `${space}${attr}=${quote}${next}${quote}`;
      },
    ),
  );
}

/** Prefix each CSS-wide name declared by this image and every local reference. */
export function namespaceImageStyleNames(markup: string, scope: string): string | null {
  const sheets: ParsedSheet[] = [];
  for (const match of markup.matchAll(STYLE_TAG)) sheets.push(parseSheet(match[2]));
  if (sheets.length === 0) return markup;
  const names = collectNames(sheets);
  if (![names.keyframes, names.fonts, names.properties, names.counters].some((set) => set.size > 0)) return markup;
  let index = 0;
  const variableCounts = new Map<string, number>();
  const count = (decl: Declaration): void => {
    if (decl.prop.startsWith("--")) variableCounts.set(decl.prop, (variableCounts.get(decl.prop) ?? 0) + 1);
  };
  for (const sheet of sheets) sheet.root?.walkDecls(count);
  for (const tag of markup.replace(STYLE_TAG, "").matchAll(/<[^>]+>/g)) {
    const style = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag[0]);
    if (style != null) {
      try {
        postcss.parse(`x{${style[2]}}`).walkDecls(count);
      } catch {
        /* left unchanged below */
      }
    }
  }
  let unsafe = false;
  const rewritten = markup.replace(STYLE_TAG, (_full, open: string, _css: string, close: string) => {
    const sheet = sheets[index++];
    if (sheet.root == null) return open + sheet.original + close;
    sheet.root.walkAtRules((rule) => rewriteAtRule(rule, names, scope));
    sheet.root.walkDecls((decl) => {
      if (!rewriteDeclaration(decl, names, scope, variableCounts)) unsafe = true;
    });
    const css = sheet.root.toString();
    const serialized = sheet.prefix.includes("<![CDATA[")
      ? serializeJoinedCdata(css, sheet)
      : sheet.prefix + css + sheet.suffix;
    return open + serialized + close;
  });
  const result = rewriteAttributes(rewritten, names, scope, variableCounts, () => {
    unsafe = true;
  });
  return unsafe ? null : result;
}
