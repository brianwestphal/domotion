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
 * An `@media` block is evaluated against the image viewport (see
 * `evaluateMediaQueryList`). Anything else that could reach the root with a
 * transform-family declaration makes the result `unsupported`: a structural
 * pseudo-class, or another conditional group such as `@supports` or
 * `@container`. The caller then keeps its previous output and warns instead
 * of painting a guess.
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
import { evaluateMediaQueryList } from "./svg-image-media.js";
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

const IDENT = "-?(?:[_a-zA-Z]|[^\\x00-\\x7f])(?:[-_a-zA-Z0-9]|[^\\x00-\\x7f])*";

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
): boolean {
  const actual = root.attributes.get(name);
  if (actual == null) return false;
  if (op == null) return true;
  const fold = flag?.toLowerCase() === "i";
  const a = fold ? actual.toLowerCase() : actual;
  const v = fold ? value.toLowerCase() : value;
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
    if (c == null) return null;
    out.push({ match: compoundMatchesRoot(c, root), spec: SPECIFICITY(c) });
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
      const value = m[3] ?? m[4] ?? m[5] ?? "";
      if (/\\/.test(value)) return null; // CSS escapes in the value: not decoded here
      if (!attributeMatches(m[1], m[2], value, m[6], root)) out.extraMatch = false;
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
      out.type = m[1].toLowerCase();
    } else if (m[2] != null) out.ids.push(m[2]);
    else if (m[3] != null) out.classes.push(m[3]);
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
  id: string | null;
  classes: Set<string>;
  /** The root's attributes, by exact (case-sensitive, XML) name. */
  attributes: Map<string, string>;
  /** The image body (everything after the root's opening tag). */
  body: string;
}

function compoundMatchesRoot(c: SimpleCompound, root: RootFacts): boolean {
  if (c.type != null && c.type !== "*" && c.type !== root.tag) return false;
  if (c.ids.some((id) => id !== root.id)) return false;
  if (c.classes.some((cls) => !root.classes.has(cls))) return false;
  return c.extraMatch;
}

/** Whether a root-matching compound cannot also match another element of the image. */
function compoundIsRootExclusive(c: SimpleCompound, root: RootFacts): boolean {
  if (c.root || c.ids.length > 0) return true;
  const bodyTags = root.body.match(/<([a-zA-Z][-\w:.]*)/g) ?? [];
  if (c.type === "svg" && !bodyTags.some((t) => /^<(?:[\w.-]+:)?svg$/i.test(t))) return true;
  if (c.classes.length > 0) {
    const used = [...root.body.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].flatMap((m) =>
      (m[1] ?? m[2] ?? "").split(/\s+/),
    );
    if (!c.classes.some((cls) => used.includes(cls))) return true;
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
): RootStylesheetTransform | null | "unsupported" {
  const body = svgText.slice(rootTagEnd);
  if (!/<style[\s>]/i.test(body)) return null;
  const facts: RootFacts = {
    tag: root.tag.toLowerCase(),
    id: root.id,
    classes: new Set((root.className ?? "").split(/\s+/).filter((c) => c !== "")),
    attributes: new Map(root.attributes ?? []),
    body,
  };
  const declarations = new Map<string, CascadedDeclaration>();
  let order = 0;
  let unsupported = false;
  let changed = false;

  // Rewrite `[start, end)` of a sheet. `active` is false inside an `@media`
  // block whose query does not match the image viewport: its rules do not
  // apply to the root, but their root-matching transform declarations are
  // still removed, since the inlined sheet would otherwise evaluate the query
  // against the output document's viewport.
  const processRange = (css: string, clean: string, start: number, stop: number, active: boolean): string => {
    let out = "";
    let cursor = start;
    let i = start;
    while (i < stop) {
      const brace = clean.indexOf("{", i);
      const semi = clean.indexOf(";", i);
      if (brace < 0 || brace >= stop) break;
      const preludeRaw = clean.slice(i, brace);
      if (preludeRaw.trim().startsWith("@") && semi >= 0 && semi < brace) {
        i = semi + 1; // a block-less at-rule (@import / @charset / @namespace)
        continue;
      }
      const end = matchBrace(clean, brace);
      if (end < 0) break;
      const prelude = preludeRaw.trim();
      const block = clean.slice(brace + 1, end);
      if (prelude.startsWith("@")) {
        const media = /^@media\b([\s\S]*)$/i.exec(prelude);
        const touchesTransform = /(?:^|[;{}])\s*(?:transform|transform-origin|translate|rotate|scale)\s*:/i.test(block);
        if (media != null && touchesTransform) {
          const matches = viewport == null ? null : evaluateMediaQueryList(media[1], viewport);
          if (matches == null) unsupported = true;
          else {
            out += css.slice(cursor, brace + 1) + processRange(css, clean, brace + 1, end, active && matches) + "}";
            cursor = end + 1;
          }
        } else if (touchesTransform) {
          // Another conditional group (@supports / @layer / @container …).
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
      for (const selector of selectors) {
        if (hasCombinator(selector)) {
          keepForOthers.push(selector);
          continue;
        }
        const compound = parseCompound(selector, facts);
        if (compound == null) {
          unsupported = true;
          keepForOthers.push(selector);
          continue;
        }
        if (!compoundMatchesRoot(compound, facts)) {
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
          const candidate: CascadedDeclaration = {
            value: d.value,
            important: d.important,
            specificity: matchedSpec,
            order: current,
          };
          const previous = declarations.get(d.name);
          if (previous == null || compareCascade(candidate, previous) > 0) declarations.set(d.name, candidate);
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
    (_whole, open: string, css: string, closeTag: string) =>
      open + processRange(css, blankNoise(css), 0, css.length, true) + closeTag,
  );

  if (unsupported) return "unsupported";
  if (declarations.size === 0 && !changed) return null;
  return {
    declarations,
    source: changed ? svgText.slice(0, rootTagEnd) + rewrittenBody : svgText,
  };
}

function compareSpec(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function compareCascade(a: CascadedDeclaration, b: CascadedDeclaration): number {
  if (a.important !== b.important) return a.important ? 1 : -1;
  return compareSpec(a.specificity, b.specificity) || a.order - b.order;
}
