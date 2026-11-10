/**
 * A small selector engine over an `<img>` SVG document's own element tree.
 *
 * The root-transform cascade (`svg-image-root-stylesheet.ts`) decides most
 * selectors against the image root alone, because the root has no parent and
 * no element siblings. `:has()` is different: its argument is a relative
 * selector matched against the root's descendants (`SelectorChecker::CheckPseudoHas`,
 * core/css/selector_checker.cc:2111-2273, chromium 7d859f27), so deciding it
 * needs the image DOM. This module parses the image's XML into an element
 * tree and matches parsed selectors against it, right to left, with every
 * combinator.
 *
 * Supported simple selectors: type / universal (case-sensitive, as in an XML
 * document), `#id`, `.class`, attribute selectors (every operator and the
 * `i` / `s` flags), `:root`, `:scope`, `:not()` / `:is()` / `:where()`, the
 * structural pseudo-classes against real sibling indices (`:first-child`,
 * `:last-child`, `:only-child`, the `-of-type` forms, `:nth-*()` with `of S`,
 * `:empty`), the dynamic pseudo-classes, which never match in an image
 * document, and `:has()` itself. Anything else (pseudo-elements, namespace
 * prefixes, other pseudo-classes) makes the parse return null, and a value a
 * DTD entity leaves unknown makes the match return null: the caller then
 * leaves the answer undecided.
 */

/** `[ids, classes + attributes + pseudo-classes, types]`. */
export type Specificity = [number, number, number];

// CSS Syntax §4.3.7: an escape is `\` + 1-6 hex digits (+ one whitespace), or
// `\` + any other non-newline code point.
export const CSS_ESCAPE = "\\\\(?:[0-9a-fA-F]{1,6}[ \\t\\n\\r\\f]?|[^\\n\\r\\f0-9a-fA-F])";
export const CSS_IDENT = `-?(?:[_a-zA-Z]|[^\\x00-\\x7f]|${CSS_ESCAPE})(?:[-_a-zA-Z0-9]|[^\\x00-\\x7f]|${CSS_ESCAPE})*`;

/** Decode CSS escapes (CSS Syntax §4.3.7 "consume an escaped code point";
 *  §4.3.5: an escaped newline inside a string is a line continuation). */
export function cssUnescape(text: string): string {
  return text.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_m, hex: string | undefined, newline: string | undefined, ch: string | undefined) => {
      if (hex != null) {
        const cp = parseInt(hex, 16);
        return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "�" : String.fromCodePoint(cp);
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
export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Match one attribute selector (Selectors 4 §6) against a DOM value; null
 *  when the value is unknown. `actual` undefined means the attribute is absent. */
export function attributeValueMatches(
  actual: string | null | undefined,
  op: string | undefined,
  value: string,
  flag: string | undefined,
): boolean | null {
  if (actual === undefined) return false;
  if (op == null) return true;
  if (actual === null) return null; // a DTD-defined entity: the DOM value is unknown
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

// ---------------------------------------------------------------------------
// The element tree.

/** One element of the image document. */
export interface ImageElement {
  /** The qualified name as written (an XML document keeps its case). */
  name: string;
  /** Attributes by qualified name, with DOM values (null: a DTD entity leaves
   *  the value unknown). */
  attributes: Map<string, string | null>;
  /** Optional lexical evidence for resource admission, never inferred from
   * decoded DOM values. Duplicate attributes remain visible here. */
  sourceAttributes?: Array<{ name: string; value: string; syntax: string; start: number; end: number }>;
  sourceRange?: { start: number; openEnd: number; closeStart: number; end: number; selfClosing: boolean };
  parent: ImageElement | null;
  children: ImageElement[];
  /** Each text child's DOM data (CDATA sections included), null when a DTD
   *  entity leaves it unknown. */
  texts: Array<string | null>;
}

/**
 * Parse an SVG document's elements. Comments, processing instructions and the
 * doctype are skipped. Returns the document element, or null when the markup
 * is not a well-formed element tree this parser can read.
 */
export function parseImageElementTree(xml: string, recordAttributeSource = false): ImageElement | null {
  let root: ImageElement | null = null;
  let current: ImageElement | null = null;
  let i = 0;
  const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i && current != null) current.texts.push(expandXmlReferences(xml.slice(i, textEnd)));
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return null;
      i = end + 3;
    } else if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return null;
      if (current != null) current.texts.push(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) return null;
      i = end + 2;
    } else if (xml.startsWith("<!", lt)) {
      // A doctype, possibly with an internal subset in brackets.
      let depth = 0;
      let j = lt + 2;
      for (; j < xml.length; j++) {
        const ch = xml[j];
        if (ch === "[") depth++;
        else if (ch === "]") depth--;
        else if (ch === ">" && depth <= 0) break;
        else if (ch === '"' || ch === "'") {
          const close = xml.indexOf(ch, j + 1);
          if (close < 0) return null;
          j = close;
        }
      }
      i = j + 1;
    } else if (xml[lt + 1] === "/") {
      const end = xml.indexOf(">", lt);
      if (end < 0 || current == null) return null;
      const name = xml.slice(lt + 2, end).trim();
      if (name !== current.name) return null;
      if (current.sourceRange != null) {
        current.sourceRange.closeStart = lt;
        current.sourceRange.end = end + 1;
      }
      current = current.parent;
      i = end + 1;
    } else {
      const nameMatch = /^<([^\s/>]+)/.exec(xml.slice(lt, lt + 256));
      if (nameMatch == null) return null;
      if (root != null && current == null) return null; // a second document element
      const el: ImageElement = {
        name: nameMatch[1],
        attributes: new Map(),
        parent: current,
        children: [],
        texts: [],
      };
      if (recordAttributeSource) el.sourceAttributes = [];
      let j = lt + nameMatch[0].length;
      for (;;) {
        while (j < xml.length && /\s/.test(xml[j])) j++;
        if (xml[j] === ">" || xml.startsWith("/>", j)) break;
        attrRe.lastIndex = j;
        const m = attrRe.exec(xml);
        if (m == null) return null;
        el.sourceAttributes?.push({
          name: m[1],
          value: m[2] ?? m[3] ?? "",
          syntax: m[0],
          start: m.index,
          end: attrRe.lastIndex,
        });
        el.attributes.set(m[1], decodeXmlAttributeValue(m[2] ?? m[3] ?? ""));
        j = attrRe.lastIndex;
      }
      if (current != null) current.children.push(el);
      else root = el;
      const selfClosing = xml.startsWith("/>", j);
      if (recordAttributeSource)
        el.sourceRange = {
          start: lt,
          openEnd: j + (selfClosing ? 2 : 1),
          closeStart: j + (selfClosing ? 2 : 1),
          end: j + (selfClosing ? 2 : 1),
          selfClosing,
        };
      if (selfClosing) i = j + 2;
      else {
        current = el;
        i = j + 1;
      }
    }
  }
  return current == null ? root : null;
}

// ---------------------------------------------------------------------------
// Selectors.

type Combinator = " " | ">" | "+" | "~";

type Simple =
  | { k: "type"; name: string } // "*" for the universal selector
  | { k: "id"; value: string }
  | { k: "class"; value: string }
  | { k: "attr"; name: string; op?: string; value: string; flag?: string }
  | { k: "pseudo"; name: string }
  | { k: "nth"; name: string; anb: string; of: Complex[] | null }
  | { k: "logical"; name: "is" | "where" | "not"; list: Complex[] }
  | { k: "has"; list: Complex[] }
  | { k: "anchor" }; // `:has()`'s implicit relative anchor (kPseudoRelativeAnchor)

/** Compounds left to right; `combinators[i]` joins `compounds[i]` and `[i + 1]`. */
export interface Complex {
  compounds: Simple[][];
  combinators: Combinator[];
}

/** Pseudo-classes that never match in an SVG image document: it receives no
 *  input, focus or navigation, and its elements are not links. */
export const NEVER_MATCHING_PSEUDOS: ReadonlySet<string> = new Set([
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

const STRUCTURAL = /^(?:first|last|only)-(?:child|of-type)$/;

const ATTR_RE = new RegExp(
  `^\\[\\s*(${CSS_IDENT}(?::${CSS_IDENT})?)\\s*` +
    `(?:([~|^$*]?=)\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|(${CSS_IDENT}))\\s*([iIsS])?\\s*)?\\]`,
);
const TOKEN_RE = new RegExp(`(\\*|${CSS_IDENT})|#(${CSS_IDENT})|\\.(${CSS_IDENT})`, "y");

/** Index of the `)` matching the `(` at `open`, respecting strings and escapes, or -1. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote != null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split on top-level commas, respecting strings, escapes and brackets. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote != null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

class Parser {
  constructor(private readonly insideHas: boolean) {}

  /** A selector list; null when any member cannot be parsed. */
  list(text: string, relative: boolean): Complex[] | null {
    const out: Complex[] = [];
    for (const part of splitList(text)) {
      const c = this.complex(part, relative);
      if (c == null) return null;
      out.push(c);
    }
    return out;
  }

  /** One complex selector. A relative one (a `:has()` argument) starts from
   *  the implicit anchor, joined by its leading combinator (descendant when
   *  absent; CSSSelectorParser::ConsumeRelativeSelector). */
  complex(text: string, relative: boolean): Complex | null {
    const s = text.trim();
    if (s === "") return null;
    const compounds: Simple[][] = [];
    const combinators: Combinator[] = [];
    let i = 0;
    if (relative) {
      compounds.push([{ k: "anchor" }]);
      const lead = /^([>+~])\s*/.exec(s);
      combinators.push(lead != null ? (lead[1] as Combinator) : " ");
      if (lead != null) i = lead[0].length;
    }
    for (;;) {
      const parsed = this.compound(s, i);
      if (parsed == null) return null;
      compounds.push(parsed.simples);
      i = parsed.end;
      if (i >= s.length) break;
      const comb = /^\s*([>+~])\s*|^\s+/.exec(s.slice(i));
      if (comb == null) return null;
      combinators.push(comb[1] != null ? (comb[1] as Combinator) : " ");
      i += comb[0].length;
      if (i >= s.length) return null;
    }
    return { compounds, combinators };
  }

  private compound(s: string, start: number): { simples: Simple[]; end: number } | null {
    const simples: Simple[] = [];
    let i = start;
    while (i < s.length && !/[\s>+~]/.test(s[i])) {
      if (s[i] === "[") {
        const m = ATTR_RE.exec(s.slice(i));
        if (m == null) return null;
        simples.push({
          k: "attr",
          name: cssUnescape(m[1]),
          op: m[2],
          value: cssUnescape(m[3] ?? m[4] ?? m[5] ?? ""),
          flag: m[6],
        });
        i += m[0].length;
        continue;
      }
      if (s[i] === ":") {
        if (s[i + 1] === ":") return null; // a pseudo-element
        const m = /^:([-a-zA-Z]+)(\()?/.exec(s.slice(i));
        if (m == null) return null;
        const name = m[1].toLowerCase();
        if (m[2] == null) {
          if (
            name !== "root" &&
            name !== "scope" &&
            name !== "empty" &&
            !STRUCTURAL.test(name) &&
            !NEVER_MATCHING_PSEUDOS.has(name)
          ) {
            return null;
          }
          simples.push({ k: "pseudo", name });
          i += m[0].length;
          continue;
        }
        const open = i + m[0].length - 1;
        const close = matchParen(s, open);
        if (close < 0) return null;
        const inner = s.slice(open + 1, close);
        if (/^nth-(?:last-)?(?:child|of-type)$/.test(name)) {
          const ofMatch = /^([\s\S]*?)\s+of\s+([\s\S]+)$/i.exec(inner);
          if (ofMatch != null && !name.endsWith("child")) return null;
          const anb = (ofMatch?.[1] ?? inner).trim();
          if (anPlusB(anb) == null) return null;
          const of = ofMatch != null ? this.list(ofMatch[2], false) : null;
          if (ofMatch != null && of == null) return null;
          simples.push({ k: "nth", name, anb, of });
        } else if (name === "is" || name === "matches" || name === "where" || name === "not") {
          const list = this.list(inner, false);
          if (list == null) return null;
          simples.push({ k: "logical", name: name === "matches" ? "is" : name, list });
        } else if (name === "has") {
          // `:has()` inside a `:has()` argument is a parse error
          // (IsPseudoClassValidWithinHasArgument,
          // core/css/parser/css_selector_parser.cc:1288-1296); its effect on
          // an enclosing forgiving list is not decided here.
          if (this.insideHas) return null;
          const list = new Parser(true).list(inner, true);
          if (list == null) return null;
          simples.push({ k: "has", list });
        } else return null;
        i = close + 1;
        continue;
      }
      TOKEN_RE.lastIndex = i;
      const m = TOKEN_RE.exec(s);
      if (m == null) return null;
      if (m[1] != null) {
        if (simples.length > 0) return null; // a type selector only leads a compound
        if (s[TOKEN_RE.lastIndex] === "|") return null; // a namespace prefix
        simples.push({ k: "type", name: m[1] === "*" ? "*" : cssUnescape(m[1]) });
      } else if (m[2] != null) simples.push({ k: "id", value: cssUnescape(m[2]) });
      else simples.push({ k: "class", value: cssUnescape(m[3]) });
      i = TOKEN_RE.lastIndex;
    }
    return simples.length > 0 ? { simples, end: i } : null;
  }
}

/** Parse a selector list (not relative), or null when any part is unsupported. */
export function parseSelectorList(text: string): Complex[] | null {
  return new Parser(false).list(text, false);
}

/** Parse a `:has()` argument (a relative selector list). */
export function parseRelativeSelectorList(text: string): Complex[] | null {
  return new Parser(true).list(text, true);
}

/** `[a, b]` of the An+B microsyntax, or null when it does not parse. */
function anPlusB(text: string): [number, number] | null {
  const t = text.replace(/\s+/g, "").toLowerCase();
  if (t === "odd") return [2, 1];
  if (t === "even") return [2, 0];
  const m = /^([-+]?\d*)n([-+]\d+)?$/.exec(t);
  if (m != null) {
    const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return [a, m[2] == null ? 0 : Number(m[2])];
  }
  return /^[-+]?\d+$/.test(t) ? [0, Number(t)] : null;
}

function anPlusBMatchesIndex(anb: string, index: number): boolean {
  const [a, b] = anPlusB(anb)!;
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return Number.isInteger(n) && n >= 0;
}

// ---------------------------------------------------------------------------
// Specificity (CSSSelector::Specificity, core/css/css_selector.cc:200-260,
// chromium 7d859f27).

const add = (a: Specificity, b: Specificity): Specificity => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const compare = (a: Specificity, b: Specificity): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The largest specificity of a list (`MaximumSpecificity`). */
export function maxSpecificity(list: Complex[]): Specificity {
  return list.map(complexSpecificity).reduce<Specificity>((best, s) => (compare(s, best) > 0 ? s : best), [0, 0, 0]);
}

export function complexSpecificity(c: Complex): Specificity {
  return c.compounds.flat().reduce<Specificity>((sum, s) => add(sum, simpleSpecificity(s)), [0, 0, 0]);
}

function simpleSpecificity(s: Simple): Specificity {
  switch (s.k) {
    case "type":
      return s.name === "*" ? [0, 0, 0] : [0, 0, 1];
    case "id":
      return [1, 0, 0];
    case "class":
    case "attr":
    case "pseudo":
      return [0, 1, 0];
    case "nth":
      // kPseudoNthChild / kPseudoNthLastChild: class-like plus the most
      // specific selector of `of S`.
      return s.of == null ? [0, 1, 0] : add([0, 1, 0], maxSpecificity(s.of));
    case "logical":
      return s.name === "where" ? [0, 0, 0] : maxSpecificity(s.list);
    case "has":
      return maxSpecificity(s.list);
    case "anchor":
      return [0, 0, 0]; // kPseudoRelativeAnchor
  }
}

// ---------------------------------------------------------------------------
// Matching.

/** Thrown when a match depends on a value only a DTD could define. */
class Undecided extends Error {}

interface MatchContext {
  /** The document element (`:root`, and `:scope` in a document-scoped sheet,
   *  CheckPseudoScope, selector_checker.cc:3644-3654). */
  root: ImageElement;
  /** The `:has()` anchor while matching its argument. */
  anchor: ImageElement | null;
}

const localName = (el: ImageElement): string => el.name.slice(el.name.indexOf(":") + 1);

function elementSiblings(el: ImageElement): ImageElement[] {
  return el.parent?.children ?? [el];
}

function matchesSimple(el: ImageElement, s: Simple, ctx: MatchContext): boolean {
  switch (s.k) {
    case "type":
      return s.name === "*" || s.name === localName(el);
    case "id": {
      const id = el.attributes.get("id");
      if (id === null) throw new Undecided();
      return id === s.value;
    }
    case "class": {
      const cls = el.attributes.get("class");
      if (cls === null) throw new Undecided();
      return cls != null && cls.split(/[ \t\n\f\r]+/).includes(s.value);
    }
    case "attr": {
      const result = attributeValueMatches(el.attributes.get(s.name), s.op, s.value, s.flag);
      if (result == null) throw new Undecided();
      return result;
    }
    case "pseudo":
      return matchesPseudo(el, s.name, ctx);
    case "nth": {
      const siblings = elementSiblings(el).filter((sib) =>
        s.name.endsWith("of-type")
          ? sib.name === el.name
          : s.of == null || s.of.some((c) => matchesComplex(sib, c, ctx)),
      );
      if (s.of != null && !siblings.includes(el)) return false;
      const pos = siblings.indexOf(el);
      const index = s.name.startsWith("nth-last") ? siblings.length - pos : pos + 1;
      return anPlusBMatchesIndex(s.anb, index);
    }
    case "logical": {
      const any = s.list.some((c) => matchesComplex(el, c, ctx));
      return s.name === "not" ? !any : any;
    }
    case "has":
      return matchesHas(el, s.list, ctx);
    case "anchor":
      return el === ctx.anchor;
  }
}

function matchesPseudo(el: ImageElement, name: string, ctx: MatchContext): boolean {
  if (name === "root" || name === "scope") return el === ctx.root;
  if (name === "empty") {
    // An element child, or any non-empty text child (whitespace included),
    // makes it non-empty (kPseudoEmpty, selector_checker.cc:2310-2335).
    if (el.children.length > 0) return false;
    if (el.texts.some((t) => t != null && t !== "")) return false;
    if (el.texts.some((t) => t == null)) throw new Undecided();
    return true;
  }
  if (STRUCTURAL.test(name)) {
    const siblings = elementSiblings(el).filter((sib) => !name.endsWith("of-type") || sib.name === el.name);
    const first = siblings[0] === el;
    const last = siblings[siblings.length - 1] === el;
    if (name.startsWith("first")) return first;
    if (name.startsWith("last")) return last;
    return first && last;
  }
  return false; // a dynamic pseudo-class
}

function matchesCompound(el: ImageElement, compound: Simple[], ctx: MatchContext): boolean {
  return compound.every((s) => matchesSimple(el, s, ctx));
}

/** Whether `el` is the subject of complex selector `c`, right to left. */
function matchesComplex(el: ImageElement, c: Complex, ctx: MatchContext, index = c.compounds.length - 1): boolean {
  if (!matchesCompound(el, c.compounds[index], ctx)) return false;
  if (index === 0) return true;
  const comb = c.combinators[index - 1];
  if (comb === ">") return el.parent != null && matchesComplex(el.parent, c, ctx, index - 1);
  if (comb === " ") {
    for (let p = el.parent; p != null; p = p.parent) if (matchesComplex(p, c, ctx, index - 1)) return true;
    return false;
  }
  if (el.parent == null) return false; // the document element has no element siblings
  const siblings = el.parent.children;
  const pos = siblings.indexOf(el);
  if (comb === "+") return pos > 0 && matchesComplex(siblings[pos - 1], c, ctx, index - 1);
  for (let k = pos - 1; k >= 0; k--) if (matchesComplex(siblings[k], c, ctx, index - 1)) return true;
  return false;
}

function allElements(root: ImageElement): ImageElement[] {
  const out: ImageElement[] = [];
  const visit = (el: ImageElement): void => {
    out.push(el);
    el.children.forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * `:has(<relative list>)` on `anchor`: some element of the document is the
 * subject of some argument whose leftmost compound is the anchor itself
 * (CheckPseudoHas traverses the anchor's descendants or following siblings
 * and matches each with `relative_anchor_element` set, selector_checker.cc:2163-2273,
 * 3214-3216). Testing every element is the same answer, since only those
 * positions can satisfy the anchor compound.
 */
function matchesHas(anchor: ImageElement, list: Complex[], ctx: MatchContext): boolean {
  const inner: MatchContext = { root: ctx.root, anchor };
  const candidates = allElements(ctx.root).filter((el) => el !== anchor);
  return list.some((c) => candidates.some((el) => matchesComplex(el, c, inner)));
}

/** Whether `el` matches any selector of `list` in the document rooted at
 *  `root`; null when a DTD-defined value leaves the answer unknown. */
export function matchesSelectorList(el: ImageElement, list: Complex[], root: ImageElement): boolean | null {
  try {
    return list.some((c) => matchesComplex(el, c, { root, anchor: null }));
  } catch (error) {
    if (error instanceof Undecided) return null;
    throw error;
  }
}

/** `:has(<argument>)` decided for `anchor`, with its specificity; null when
 *  the argument cannot be parsed or a DTD-defined value leaves it unknown. */
export function decideHas(
  argument: string,
  anchor: ImageElement,
  root: ImageElement,
): { match: boolean; specificity: Specificity } | null {
  const list = parseRelativeSelectorList(argument);
  if (list == null) return null;
  try {
    return { match: matchesHas(anchor, list, { root, anchor: null }), specificity: maxSpecificity(list) };
  } catch (error) {
    if (error instanceof Undecided) return null;
    throw error;
  }
}
