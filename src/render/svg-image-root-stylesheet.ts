/**
 * The root `<svg>`'s transform-family declarations that an `<img>` SVG
 * document's own `<style>` sheets cascade onto it, e.g.
 * `<style>svg { transform: rotate(10deg) }</style>` or
 * `:root { transform-origin: 0 0 }`.
 *
 * Blink cascades an SVG image document's author sheets onto its root like any
 * author rule (the root is an ordinary element of that document), so the
 * declared transform applies to the image. Domotion composes the root
 * transform itself, outside the nested viewport (see `imageRootTransform` in
 * `svg-inline.ts`), so it needs the cascaded values node-side.
 *
 * Only selectors that can be decided against the root exactly are resolved.
 * The root of an SVG image has no parent and no element siblings, so any
 * selector with a combinator can never match it. A combinator-free compound
 * is matched against the root's own tag, id, classes and attributes:
 * - a type (`svg`, `*`), `#id`, `.class` and `:root`;
 * - attribute selectors, with every operator and the `i` / `s` flags;
 * - `:not()`, `:is()` and `:where()` over such selectors, with their
 *   specificity rules;
 * - the dynamic pseudo-classes (`:hover`, `:focus`, `:target`, `:link`, ...),
 *   which never match in an image document: it receives no input, focus or
 *   navigation.
 *
 * Attribute values and ids / classes are compared as the DOM holds them:
 * CSS escapes in the selector are decoded, and the root's XML attribute values
 * are normalized with their character references and predefined entities
 * expanded (a DTD-defined entity leaves the answer undecided).
 *
 * Conditional groups:
 * - `@media` is evaluated against the image document (`evaluateMediaQueryList`).
 * - `@container` never matches the root: it has no ancestor container.
 * - `@layer` blocks and statements order the cascade (CSS Cascade 5), with
 *   unlayered rules last.
 * Anything else that could reach the root with a transform-family declaration
 * makes the result `unsupported`: a selector this module cannot decide (such
 * as `:has()`), an undecided media query, or another group rule (`@supports`,
 * `@scope`, `@starting-style`). The caller then keeps its previous output and
 * warns instead of painting a guess.
 *
 * The returned `source` rewrites the sheets so the inlined markup does not
 * apply those declarations a second time (an inlined `<style>` applies to the
 * whole output document, including the nested root `<svg>` and the outer
 * document's root). That is exact only when the matching selector cannot also
 * reach another element of the image: `:root` and the root's `#id` always
 * qualify; `svg` qualifies when the image has no nested `<svg>`, and `.class`
 * when no other element carries the class. A matching selector that does not
 * qualify (including `*`) keeps its transform family for the other elements as
 * `selector:not([data-domotion-image-root])`; the inlined root carries that
 * attribute whenever the image has a sheet (see `svg-image-style-scope.ts`).
 */
import { evaluateMediaQueryList, type ImageMediaEnv } from "./svg-image-media.js";
import { anPlusBMatches, IMAGE_ROOT_ATTR } from "./svg-image-style-scope.js";

/** The CSS properties that make up the root's transform. */
export const ROOT_TRANSFORM_PROPERTIES: ReadonlySet<string> = new Set([
  "transform",
  "transform-origin",
  "translate",
  "rotate",
  "scale",
]);

export interface CascadedDeclaration {
  value: string;
  important: boolean;
  /** `[ids, classes + pseudo-classes, types]`. */
  specificity: [number, number, number];
  /** Source order across all of the document's sheets. */
  order: number;
  /** The declaration's cascade layer rank (unlayered is highest). */
  layerRank?: number;
}

export interface RootStylesheetTransform {
  /** Winning sheet declaration per transform-family property. */
  declarations: Map<string, CascadedDeclaration>;
  /** The SVG source with the applied declarations removed from its sheets. */
  source: string;
}

interface SimpleCompound {
  type: string | null; // lowercased tag, "*" or null
  ids: string[];
  classes: string[];
  root: boolean;
  /** Attribute selectors and pseudo-classes, already decided against the root. */
  extraMatch: boolean;
  extraSpec: [number, number, number];
}

/** Pseudo-classes that never match in an SVG image document: it receives no
 *  input, focus or navigation, and its root is not a link. */
const NEVER_MATCHING_PSEUDOS = new Set([
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
  "target",
  "target-within",
  "link",
  "visited",
  "any-link",
  "-webkit-any-link",
]);

/**
 * A parameterless structural pseudo-class decided for the image root, or null
 * when `name` is not one. The root is the document element and has no
 * element siblings, so `IsFirstChild` / `IsLastChild` / the `-of-type` forms
 * all hold (`core/css/selector_checker.cc:476-486, 2348-2420`); `:scope` in
 * a document-scoped sheet is the document element (`CheckPseudoScope`,
 * selector_checker.cc:3644-3654); `:empty` asks whether the root has no
 * element child and no non-whitespace text (selector_checker.cc:2310),
 * chromium 7d859f27.
 */
function rootStructuralPseudo(name: string, root: RootFacts): boolean | null {
  if (/^(?:first|last|only)-(?:child|of-type)$/.test(name) || name === "scope") return true;
  if (name === "empty") {
    const close = root.body.toLowerCase().lastIndexOf("</svg>");
    const content = (close >= 0 ? root.body.slice(0, close) : root.body)
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\?[\s\S]*?\?>/g, "");
    if (/<[a-zA-Z]/.test(content)) return false;
    return !/\S/.test(content.replace(/<!\[CDATA\[|\]\]>/g, ""));
  }
  return null;
}

/** Index of the `)` matching the `(` at `open`, respecting strings, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

// CSS Syntax §4.3.7: an escape is `\` + 1-6 hex digits (+ one whitespace), or
// `\` + any other non-newline code point.
const ESCAPE = "\\\\(?:[0-9a-fA-F]{1,6}[ \\t\\n\\r\\f]?|[^\\n\\r\\f0-9a-fA-F])";
const IDENT = `-?(?:[_a-zA-Z]|[^\\x00-\\x7f]|${ESCAPE})(?:[-_a-zA-Z0-9]|[^\\x00-\\x7f]|${ESCAPE})*`;

/** Decode CSS escapes (CSS Syntax §4.3.7 "consume an escaped code point";
 *  §4.3.5: an escaped newline inside a string is a line continuation). */
export function cssUnescape(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_m, hex: string | undefined, newline: string | undefined, ch: string | undefined) => {
      if (hex != null) {
        const cp = parseInt(hex, 16);
        return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
      }
      return newline != null ? "" : (ch ?? "");
    },
  );
}

const XML_PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Expand character references and the predefined entities in XML text;
 *  null when the text references any other entity, which only a DTD could
 *  define, or a code point XML does not allow. */
export function expandXmlReferences(text: string): string | null {
  let undecidable = false;
  const out = text.replace(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z_][\w.-]*));/g,
    (whole: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name != null) {
        if (Object.hasOwn(XML_PREDEFINED, name)) return XML_PREDEFINED[name];
        undecidable = true;
        return whole;
      }
      const cp = dec != null ? Number(dec) : parseInt(hex ?? "", 16);
      if (!(cp >= 1 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) {
        undecidable = true; // not well-formed: no document at all
        return whole;
      }
      return String.fromCodePoint(cp);
    },
  );
  return undecidable ? null : out;
}

/**
 * An XML attribute value as the parser hands it to the DOM (XML 1.0 §2.11,
 * §3.3.3; libxml2 for an `image/svg+xml` document): line ends normalized, each
 * literal whitespace character replaced by a space, then references expanded
 * (see {@link expandXmlReferences}).
 */
export function decodeXmlAttributeValue(raw: string): string | null {
  return expandXmlReferences(raw.replace(/\r\n?/g, "\n").replace(/[\t\n]/g, " "));
}

/** ASCII case folding, as Blink's case-insensitive attribute matching uses. */
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// `[ns|name op value flag]`; the name may carry an XML prefix (`xlink:href`).
const ATTR_NAME = `${IDENT}(?::${IDENT})?`;
const ATTR_RE = new RegExp(
  `^\\[\\s*(?:(?:\\*|${IDENT})?\\|)?(${ATTR_NAME})\\s*` +
    `(?:([~|^$*]?=)\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|(${IDENT}))\\s*([iIsS])?\\s*)?\\]`,
);

/** Match an attribute selector (Selectors 4 §6) against the root's attributes. */
function attributeMatches(
  name: string,
  op: string | undefined,
  value: string,
  flag: string | undefined,
  root: RootFacts,
): boolean | null {
  if (!root.attributes.has(name)) return false;
  if (op == null) return true;
  const actual = root.attributes.get(name);
  if (actual == null) return null; // a DTD-defined entity: the DOM value is unknown
  // The `i` flag folds ASCII case only (Blink's EqualIgnoringAsciiCase).
  const fold = flag?.toLowerCase() === "i";
  const a = fold ? asciiLower(actual) : actual;
  const v = fold ? asciiLower(value) : value;
  switch (op) {
    case "=":
      return a === v;
    case "~=":
      return v !== "" && !/\s/.test(v) && a.split(/[ \t\n\f\r]+/).includes(v);
    case "|=":
      return a === v || a.startsWith(`${v}-`);
    case "^=":
      return v !== "" && a.startsWith(v);
    case "$=":
      return v !== "" && a.endsWith(v);
    case "*=":
      return v !== "" && a.includes(v);
    default:
      return false;
  }
}

/** Decide a selector list argument (of `:is()` / `:not()` / `:where()`)
 *  against the root: per selector, whether it matches and its specificity.
 *  Null when any selector is undecidable. */
function decideSelectorArgs(
  list: string,
  root: RootFacts,
): Array<{ match: boolean; spec: [number, number, number] }> | null {
  const out: Array<{ match: boolean; spec: [number, number, number] }> = [];
  for (const selector of splitSelectorList(list)) {
    if (selector === "") return null;
    if (hasCombinator(selector)) {
      // Never matches the parentless root; specificity still counts for :is/:not.
      out.push({ match: false, spec: [0, 0, 0] });
      continue;
    }
    const c = parseCompound(selector, root);
    const match = c == null ? null : compoundMatchesRoot(c, root);
    if (c == null || match == null) return null;
    out.push({ match, spec: SPECIFICITY(c) });
  }
  return out;
}

const maxSpec = (specs: Array<[number, number, number]>): [number, number, number] =>
  specs.reduce<[number, number, number]>((best, s) => (compareSpec(s, best) > 0 ? s : best), [0, 0, 0]);

const COMPOUND_TOKEN_RE = new RegExp(`(\\*|${IDENT})|#(${IDENT})|\\.(${IDENT})|(:root)\\b`, "y");

/** Parse a combinator-free compound selector, or null when it uses anything
 *  beyond a type / universal, ids, classes and `:root`. */
function parseCompound(selector: string, root: RootFacts): SimpleCompound | null {
  const s = selector.trim();
  if (s === "") return null;
  const out: SimpleCompound = {
    type: null,
    ids: [],
    classes: [],
    root: false,
    extraMatch: true,
    extraSpec: [0, 0, 0],
  };
  const addSpec = (spec: [number, number, number]): void => {
    out.extraSpec = [out.extraSpec[0] + spec[0], out.extraSpec[1] + spec[1], out.extraSpec[2] + spec[2]];
  };
  let i = 0;
  let firstToken = true;
  while (i < s.length) {
    if (s[i] === "[") {
      const m = ATTR_RE.exec(s.slice(i));
      if (m == null) return null;
      const value = cssUnescape(m[3] ?? m[4] ?? m[5] ?? "");
      const matched = attributeMatches(cssUnescape(m[1]), m[2], value, m[6], root);
      if (matched == null) return null;
      if (!matched) out.extraMatch = false;
      addSpec([0, 1, 0]);
      i += m[0].length;
      firstToken = false;
      continue;
    }
    const pseudo = /^:([-a-zA-Z]+)(\()?/.exec(s.slice(i));
    if (pseudo != null && pseudo[1].toLowerCase() !== "root") {
      const name = pseudo[1].toLowerCase();
      if (pseudo[2] == null) {
        const structural = rootStructuralPseudo(name, root);
        if (structural == null && !NEVER_MATCHING_PSEUDOS.has(name)) return null;
        if (structural !== true) out.extraMatch = false;
        addSpec([0, 1, 0]);
        i += pseudo[0].length;
        firstToken = false;
        continue;
      }
      const open = i + pseudo[0].length - 1;
      const close = matchParen(s, open);
      if (close < 0) return null;
      if (/^nth-(?:last-)?(?:child|of-type)$/.test(name)) {
        // The root is child index 1 among no element siblings
        // (`NthIndexCache::NthChildIndex`, core/dom/nth_index_cache.cc:148).
        const inner = s.slice(open + 1, close);
        const ofMatch = /^([\s\S]*?)\s+of\s+([\s\S]+)$/i.exec(inner);
        if (ofMatch != null && !name.endsWith("child")) return null;
        const first = anPlusBMatches((ofMatch?.[1] ?? inner).trim(), 1);
        if (first == null) return null;
        let spec: [number, number, number] = [0, 1, 0];
        let ofMatches = true;
        if (ofMatch != null) {
          const ofArgs = decideSelectorArgs(ofMatch[2], root);
          if (ofArgs == null) return null;
          ofMatches = ofArgs.some((a) => a.match);
          const inner2 = maxSpec(ofArgs.map((a) => a.spec));
          spec = [inner2[0], inner2[1] + 1, inner2[2]];
        }
        if (!first || !ofMatches) out.extraMatch = false;
        addSpec(spec);
        i = close + 1;
        firstToken = false;
        continue;
      }
      const args = decideSelectorArgs(s.slice(open + 1, close), root);
      if (args == null) return null;
      const any = args.some((a) => a.match);
      if (name === "not") {
        if (any) out.extraMatch = false;
        addSpec(maxSpec(args.map((a) => a.spec)));
      } else if (name === "is" || name === "matches" || name === "where") {
        if (!any) out.extraMatch = false;
        if (name !== "where") addSpec(maxSpec(args.map((a) => a.spec)));
      } else return null;
      i = close + 1;
      firstToken = false;
      continue;
    }
    COMPOUND_TOKEN_RE.lastIndex = i;
    const m = COMPOUND_TOKEN_RE.exec(s);
    if (m == null) return null;
    if (m[1] != null) {
      if (!firstToken) return null; // a type selector only leads a compound
      out.type = m[1] === "*" ? "*" : asciiLower(cssUnescape(m[1]));
    } else if (m[2] != null) out.ids.push(cssUnescape(m[2]));
    else if (m[3] != null) out.classes.push(cssUnescape(m[3]));
    else out.root = true;
    i = COMPOUND_TOKEN_RE.lastIndex;
    firstToken = false;
  }
  return out;
}

/** Whether a selector has a combinator (whitespace, `>`, `+`, `~`) outside
 *  brackets / parentheses / strings, so it can never match a parentless root. */
function hasCombinator(selector: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  const s = selector.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      // An escape, including the whitespace that ends a hex escape.
      const hex = /^[0-9a-fA-F]{1,6}(?:\r\n|[ \t\n\r\f])?/.exec(s.slice(i + 1));
      i += hex != null ? hex[0].length : 1;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ">" || ch === "+" || ch === "~" || /\s/.test(ch))) return true;
  }
  return false;
}

/** Split a selector list on top-level commas. */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i <= prelude.length; i++) {
    const ch = prelude[i];
    if (i < prelude.length) {
      if (quote != null) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      if (ch !== "," || depth > 0) continue;
    }
    parts.push(prelude.slice(start, i).trim());
    start = i + 1;
  }
  return parts;
}

/** Split a declaration block on top-level semicolons into `[name, value, important]`. */
function parseDeclarations(block: string): Array<{ name: string; value: string; important: boolean; raw: string }> {
  const out: Array<{ name: string; value: string; important: boolean; raw: string }> = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i <= block.length; i++) {
    const ch = block[i];
    if (i < block.length) {
      if (quote != null) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch !== ";" || depth > 0) continue;
    }
    const raw = block.slice(start, i);
    start = i + 1;
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    const name = raw.slice(0, colon).trim().toLowerCase();
    let value = raw.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    if (name !== "" && value !== "") out.push({ name, value, important, raw });
  }
  return out;
}

/** Index of the `}` closing the block opened at `open`, or -1. */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < css.length; i++) {
    const ch = css[i];
    if (quote != null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Blank out CSS comments and CDATA markers with spaces (same length), so
 *  parsing positions index the original text. */
function blankNoise(css: string): string {
  const blank = (m: string): string => " ".repeat(m.length);
  return css
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!\[CDATA\[|\]\]>/g, blank)
    .replace(/<!--|-->/g, blank);
}

interface RootFacts {
  tag: string;
  /** Null without an id; undefined when a DTD entity leaves it unknown. */
  id: string | null | undefined;
  /** Null when a DTD entity leaves the class list unknown. */
  classes: Set<string> | null;
  /** The root's attributes, by exact (case-sensitive, XML) name, with their
   *  DOM values (null when a DTD entity leaves the value unknown). */
  attributes: Map<string, string | null>;
  /** The image body (everything after the root's opening tag). */
  body: string;
}

function compoundMatchesRoot(c: SimpleCompound, root: RootFacts): boolean | null {
  if (c.type != null && c.type !== "*" && c.type !== root.tag) return false;
  if (c.ids.length > 0 && root.id === undefined) return null;
  if (c.ids.some((id) => id !== root.id)) return false;
  if (c.classes.length > 0 && root.classes == null) return null;
  if (c.classes.some((cls) => !root.classes!.has(cls))) return false;
  return c.extraMatch;
}

/** Whether a root-matching compound cannot also match another element of the image. */
function compoundIsRootExclusive(c: SimpleCompound, root: RootFacts): boolean {
  if (c.root || c.ids.length > 0) return true;
  const bodyTags = root.body.match(/<([a-zA-Z][-\w:.]*)/g) ?? [];
  if (c.type === "svg" && !bodyTags.some((t) => /^<(?:[\w.-]+:)?svg$/i.test(t))) return true;
  if (c.classes.length > 0) {
    const lists = [...root.body.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) =>
      decodeXmlAttributeValue(m[1] ?? m[2] ?? ""),
    );
    // A class list a DTD entity leaves unknown might carry any class.
    if (lists.every((list) => list != null)) {
      const used = lists.flatMap((list) => list!.split(/[ \t\n\f\r]+/));
      if (!c.classes.some((cls) => used.includes(cls))) return true;
    }
  }
  return bodyTags.length === 0;
}

const SPECIFICITY = (c: SimpleCompound): [number, number, number] => [
  c.ids.length + c.extraSpec[0],
  c.classes.length + (c.root ? 1 : 0) + c.extraSpec[1],
  (c.type != null && c.type !== "*" ? 1 : 0) + c.extraSpec[2],
];

/**
 * Cascade the image's `<style>` sheets onto its root. `svgText` is the whole
 * SVG source, `rootTagEnd` the offset just past the root's opening tag, and
 * `rootAttrs` its parsed `id` / `class`. Returns null when no sheet reaches
 * the root's transform, `"unsupported"` when one might in a way this module
 * cannot decide or neutralize exactly.
 */
export function cascadeRootStylesheetTransform(
  svgText: string,
  rootTagEnd: number,
  root: { tag: string; id: string | null; className: string | null; attributes?: Array<[string, string]> },
  viewport: { w: number; h: number } | null = null,
  env: ImageMediaEnv = {},
): RootStylesheetTransform | null | "unsupported" {
  const body = svgText.slice(rootTagEnd);
  if (!/<style[\s>]/i.test(body)) return null;
  // The source carries raw attribute text; the DOM sees it decoded.
  const id = root.id == null ? null : (decodeXmlAttributeValue(root.id) ?? undefined);
  const className = root.className == null ? "" : decodeXmlAttributeValue(root.className);
  const facts: RootFacts = {
    tag: root.tag.toLowerCase(),
    id,
    // Class names split on ASCII whitespace (SpaceSplitString).
    classes: className == null ? null : new Set(className.split(/[ \t\n\f\r]+/).filter((c) => c !== "")),
    attributes: new Map((root.attributes ?? []).map(([name, value]) => [name, decodeXmlAttributeValue(value)])),
    body,
  };
  const candidates: Array<{ name: string; layer: string; declaration: CascadedDeclaration }> = [];
  const layers = new CascadeLayers();
  // CDATA sections of the sheet being processed (offsets into its text).
  let cdataRegions: Array<[number, number]> = [];
  let order = 0;
  let unsupported = false;
  let changed = false;

  // Rewrite `[start, end)` of a sheet. `active` is false inside an `@media`
  // block whose query does not match the image viewport: its rules do not
  // apply to the root, but their root-matching transform declarations are
  // still removed, since the inlined sheet would otherwise evaluate the query
  // against the output document's viewport.
  const processRange = (
    css: string,
    clean: string,
    start: number,
    stop: number,
    active: boolean,
    layer: string,
  ): string => {
    let out = "";
    let cursor = start;
    let i = start;
    while (i < stop) {
      const brace = clean.indexOf("{", i);
      const semi = clean.indexOf(";", i);
      if (brace < 0 || brace >= stop) break;
      const preludeRaw = clean.slice(i, brace);
      if (preludeRaw.trim().startsWith("@") && semi >= 0 && semi < brace) {
        // A block-less at-rule (@import / @charset / @namespace), or a
        // `@layer a, b;` statement, which fixes those layers' order.
        const statement = /^@layer\s+([\s\S]+)$/i.exec(clean.slice(i, semi).trim());
        if (statement != null) {
          for (const name of statement[1].split(",")) layers.declare(layer, name.trim());
        }
        i = semi + 1;
        continue;
      }
      const end = matchBrace(clean, brace);
      if (end < 0) break;
      const prelude = preludeRaw.trim();
      const block = clean.slice(brace + 1, end);
      if (prelude.startsWith("@")) {
        const name = /^@([-\w]+)/.exec(prelude)?.[1].toLowerCase() ?? "";
        const touchesTransform = /(?:^|[;{}])\s*(?:transform|transform-origin|translate|rotate|scale)\s*:/i.test(block);
        // The block's rules for the root: `true` / `false` to apply them or
        // not (their root transform declarations are removed either way, so
        // the inlined sheet does not decide them again), null to give up.
        let applies: boolean | null = null;
        let innerLayer = layer;
        if (name === "media") {
          applies = evaluateMediaQueryList(prelude.slice(6), viewport, env);
        } else if (name === "container") {
          // A container query looks for a container from the element's
          // flat-tree parent, or from the nearest size container among its
          // ancestors (ContainerQueryEvaluator::DetermineStartingElement);
          // the image root has neither, and no container means no match
          // (EvalAndAdd, core/css/container_query_evaluator.cc:138-203,
          // chromium 7d859f27).
          applies = false;
        } else if (name === "layer") {
          // `@layer name { … }` or an anonymous `@layer { … }`.
          const layerName = prelude.slice(6).trim();
          innerLayer = layers.declare(layer, layerName === "" ? null : layerName);
          applies = true;
        }
        if (applies != null) {
          if (touchesTransform) {
            const inner = processRange(css, clean, brace + 1, end, active && applies, innerLayer);
            out += css.slice(cursor, brace + 1) + inner + "}";
            cursor = end + 1;
          } else if (name === "layer") {
            // Register nested layer names in order even without transforms.
            processRange(css, clean, brace + 1, end, false, innerLayer);
          }
        } else if (touchesTransform) {
          // `@supports`, `@scope`, `@starting-style`, an undecided `@media` …
          unsupported = true;
        }
        i = end + 1;
        continue;
      }
      const decls = parseDeclarations(block);
      const transformDecls = decls.filter((d) => ROOT_TRANSFORM_PROPERTIES.has(d.name));
      if (transformDecls.length === 0) {
        order += decls.length;
        i = end + 1;
        continue;
      }
      const selectors = splitSelectorList(prelude);
      const keepForOthers: string[] = [];
      let matchedSpec: [number, number, number] | null = null;
      // Outside a CDATA section the sheet text is XML character data, so the
      // DOM's selector text has its references expanded (`&amp;` is `&`).
      const inCdata = cdataRegions.some(([from, to]) => i >= from && i < to);
      for (const selector of selectors) {
        const domSelector = inCdata ? selector : expandXmlReferences(selector);
        if (domSelector == null) {
          unsupported = true;
          keepForOthers.push(selector);
          continue;
        }
        if (hasCombinator(domSelector)) {
          keepForOthers.push(selector);
          continue;
        }
        const compound = parseCompound(domSelector, facts);
        if (compound == null) {
          unsupported = true;
          keepForOthers.push(selector);
          continue;
        }
        const rootMatch = compoundMatchesRoot(compound, facts);
        if (rootMatch !== true) {
          if (rootMatch == null) unsupported = true;
          keepForOthers.push(selector);
          continue;
        }
        if (!compoundIsRootExclusive(compound, facts)) {
          // The selector also reaches other elements of the image: keep its
          // transform family for them, excluding the marked root.
          keepForOthers.push(`${selector}:not([${IMAGE_ROOT_ATTR}])`);
        }
        const spec = SPECIFICITY(compound);
        if (matchedSpec == null || compareSpec(spec, matchedSpec) > 0) matchedSpec = spec;
      }
      if (matchedSpec != null) {
        for (const d of decls) {
          const current = order++;
          if (!active || !ROOT_TRANSFORM_PROPERTIES.has(d.name)) continue;
          candidates.push({
            name: d.name,
            layer,
            declaration: {
              value: inCdata ? d.value : (expandXmlReferences(d.value) ?? d.value),
              important: d.important,
              specificity: matchedSpec,
              order: current,
            },
          });
        }
        // Rebuild the rule: the other declarations for every selector, the
        // transform family only for selectors that do not reach the root.
        const others = decls.filter((d) => !ROOT_TRANSFORM_PROPERTIES.has(d.name)).map((d) => d.raw.trim());
        let rule = `${selectors.join(", ")} {${others.join("; ")}}`;
        if (keepForOthers.length > 0) {
          rule += ` ${keepForOthers.join(", ")} {${transformDecls.map((d) => d.raw.trim()).join("; ")}}`;
        }
        // Keep the original text before the selector (whitespace, but also a
        // CDATA opener or comment that the blanked copy hid).
        const lead = clean.slice(i, brace).match(/^\s*/)?.[0].length ?? 0;
        out += css.slice(cursor, i + lead) + rule;
        cursor = end + 1;
        changed = true;
      } else {
        order += decls.length;
      }
      i = end + 1;
    }
    return out + css.slice(cursor, stop);
  };

  const rewrittenBody = body.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_whole, open: string, css: string, closeTag: string) => {
      cdataRegions = [...css.matchAll(/<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)/g)].map((m): [number, number] => [
        m.index,
        m.index + m[0].length,
      ]);
      return open + processRange(css, blankNoise(css), 0, css.length, true, "") + closeTag;
    },
  );

  if (unsupported) return "unsupported";
  const declarations = new Map<string, CascadedDeclaration>();
  const rank = layers.ranks();
  for (const { name, layer, declaration } of candidates) {
    declaration.layerRank = rank.get(layer) ?? 0;
    const previous = declarations.get(name);
    if (previous == null || compareCascade(declaration, previous) > 0) declarations.set(name, declaration);
  }
  if (declarations.size === 0 && !changed) return null;
  return {
    declarations,
    source: changed ? svgText.slice(0, rootTagEnd) + rewrittenBody : svgText,
  };
}

function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** CSS Cascade 5 §6.1 within the author origin: importance, then cascade
 *  layer (later layers win for normal declarations, earlier ones for
 *  `!important`), then specificity, then order of appearance. */
function compareCascade(a: CascadedDeclaration, b: CascadedDeclaration): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  const layer = (a.layerRank ?? 0) - (b.layerRank ?? 0);
  if (layer !== 0) return a.important ? -layer : layer;
  return compareSpec(a.specificity, b.specificity) || a.order - b.order;
}

/**
 * The image document's cascade layers, in Blink's order: each layer's
 * sublayers (in order of first declaration) come before the layer's own
 * rules, and unlayered rules come last (CSS Cascade 5 §6.4.3;
 * `CascadeLayer::ComputeLayerOrder` walks the layer tree in post-order,
 * core/css/cascade_layer.cc, chromium 7d859f27).
 */
class CascadeLayers {
  /** Child names per layer path ("" is the implicit outer, unlayered layer). */
  private readonly children = new Map<string, string[]>([["", []]]);
  private anonymous = 0;

  /** Declare `name` (dotted, or null for an anonymous layer) inside `parent`;
   *  returns the full path of the innermost layer. */
  declare(parent: string, name: string | null): string {
    const segments =
      name == null ? [`\u0000anon${this.anonymous++}`] : name.split(".").map((n) => cssUnescape(n.trim()));
    let path = parent;
    for (const segment of segments) {
      const child = path === "" ? segment : `${path}.${segment}`;
      const siblings = this.children.get(path)!;
      if (!siblings.includes(child)) {
        siblings.push(child);
        this.children.set(child, []);
      }
      path = child;
    }
    return path;
  }

  /** Rank per layer path: higher wins for normal declarations. */
  ranks(): Map<string, number> {
    const out = new Map<string, number>();
    const visit = (path: string): void => {
      for (const child of this.children.get(path) ?? []) visit(child);
      out.set(path, out.size);
    };
    visit("");
    return out;
  }
}
