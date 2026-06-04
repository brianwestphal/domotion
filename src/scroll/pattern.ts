/**
 * Scroll-pattern grammar — parser.
 *
 * Pure parser. Input string → AST. Does NOT evaluate `selector(...)` against
 * a DOM, nor execute the scroll plan — that's the responsibility of
 * `src/scroll/executor.ts`.
 *
 * **Canonical grammar reference: `docs/37-scroll-pattern-grammar.md`.** That
 * doc carries the full EBNF, axis-resolution rules, `until` semantics, speed
 * / duration / easing handling, and worked examples. When changing this file
 * (tokenizer, parser, AST shape, error reporting) update doc 37 in the same
 * commit so the surface stays in sync.
 *
 * Key rules in brief:
 *
 *   pattern        = top-segment { "," top-segment }
 *   top-segment    = "(" pattern ")" [until]
 *                  | flat-segment
 *   flat-segment   = action { "," action } [until]
 *   action         = [direction-prefix] scroll-target [duration-suffix] [easing-suffix]
 *                  | ["pause:"] duration
 *   scroll-target  = signed-length          (delta)
 *                  | anchored-expr          (absolute)
 *   anchored-expr  = anchor[.x|.y] { ("+"|"-") length }
 *   until          = "until" (anchored-expr | <n> "times")
 *
 * Key parser invariant: an `until` clause TERMINATES the current flat-segment.
 * The subsequent top-level `,` begins a new top-segment. Multi-group patterns
 * without `until` between groups MUST use parens to disambiguate.
 */

// ── AST types ───────────────────────────────────────────────────────────────

export interface ScrollPattern {
  segments: ScrollPatternSegment[];
}

export type ScrollPatternSegment = BracketedSegment | FlatSegment;

export interface BracketedSegment {
  kind: "bracketed";
  pattern: ScrollPattern;
  until?: UntilClause;
}

export interface FlatSegment {
  kind: "flat";
  actions: ScrollPatternAction[];
  until?: UntilClause;
}

export type ScrollPatternAction = ScrollAction | PauseAction;

export interface ScrollAction {
  kind: "scroll";
  /** Explicit direction prefix; absent when the action's direction is implied. */
  direction?: "up" | "down" | "left" | "right";
  target: ScrollTarget;
  /**
   * From the `/<duration>` suffix, in milliseconds. Absent → derived from
   * speed (either `speedPxPerSec` below, or the executor's inherited
   * `defaultSpeed`). Mutually exclusive with `speedPxPerSec` at parse time.
   */
  durationMs?: number;
  /**
   * From the `@<n>pxps` suffix, in pixels-per-second. Overrides the
   * executor's inherited `defaultSpeed` for THIS action only. Mutually
   * exclusive with `durationMs` at parse time — the grammar accepts either
   * `/<duration>` OR `@<speed>` on a single action, not both.
   */
  speedPxPerSec?: number;
  /** From the `[easing-name]` suffix. Absent → the composer's `linear` default
   *  (DM-1076 applies this as a per-keyframe `animation-timing-function`); an
   *  opinionated `ease-out` default is intentionally NOT applied, since it would
   *  change the feel of every existing scroll. */
  easing?: Easing;
}

export interface PauseAction {
  kind: "pause";
  /** From the duration token (`2s` → 2000). */
  durationMs: number;
}

export type ScrollTarget = DeltaTarget | AbsoluteTarget;

export interface DeltaTarget {
  kind: "delta";
  signedLength: SignedLength;
}

export interface AbsoluteTarget {
  kind: "absolute";
  anchor: Anchor;
  /** Explicit `.x`/`.y` axis suffix on the anchor; absent → `.y` default. */
  axisSuffix?: "x" | "y";
  /** Trailing `+/-` arithmetic; empty when the anchor is bare (e.g. `top`). */
  offsets: Array<{ op: "+" | "-"; length: Length }>;
}

export type Anchor = NamedAnchor | SelectorAnchor;

export interface NamedAnchor {
  kind: "named";
  name: "top" | "bottom" | "left" | "right" | "start" | "end";
}

export interface SelectorAnchor {
  kind: "selector";
  /** The inner CSS selector, stripped of its surrounding quotes. */
  cssSelector: string;
}

export interface SignedLength {
  sign: 1 | -1;
  value: number;
  unit: "px" | "%";
}

export interface Length {
  value: number;
  unit: "px" | "%";
}

export type Easing =
  | { kind: "named"; name: "linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out" }
  | { kind: "cubic-bezier"; values: [number, number, number, number] };

export type UntilClause = PositionUntil | CountUntil;

export interface PositionUntil {
  kind: "position";
  target: AbsoluteTarget;
}

export interface CountUntil {
  kind: "count";
  count: number;
}

// ── Error type ──────────────────────────────────────────────────────────────

export class ScrollPatternError extends Error {
  public readonly position: number;
  public readonly source: string;
  constructor(message: string, source: string, position: number) {
    super(`${message} (at position ${position}: ${formatSourceContext(source, position)})`);
    this.name = "ScrollPatternError";
    this.position = position;
    this.source = source;
  }
}

function formatSourceContext(source: string, position: number): string {
  const start = Math.max(0, position - 20);
  const end = Math.min(source.length, position + 20);
  const slice = source.slice(start, end);
  const marker = " ".repeat(position - start) + "^";
  return `"${slice}" ${marker}`;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

type TokenKind =
  | "lparen"
  | "rparen"
  | "comma"
  | "colon"
  | "slash"
  | "at"         // @ — introduces a `speed-suffix` (e.g. `@800pxps`)
  | "lbracket"
  | "rbracket"
  | "plus"
  | "minus"
  | "dot"
  | "ident"      // identifier — direction names, anchor names, keywords, easing names
  | "length"     // <n>px | <n>%
  | "duration"   // <n>s | <n>ms
  | "speed"      // <n>pxps (px/s; per-action speed override)
  | "number"     // bare number, used for `<n> times`
  | "string"     // "..."
  | "eof"
  ;

interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** For `length`/`duration`/`number`: the numeric value. */
  num?: number;
  /** For `length`: "px"|"%"; for `duration`: "s"|"ms". */
  unit?: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    // Single-char punctuation
    if (ch === "(") { tokens.push({ kind: "lparen",   text: "(", start: i, end: i + 1 }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen",   text: ")", start: i, end: i + 1 }); i++; continue; }
    if (ch === ",") { tokens.push({ kind: "comma",    text: ",", start: i, end: i + 1 }); i++; continue; }
    if (ch === ":") { tokens.push({ kind: "colon",    text: ":", start: i, end: i + 1 }); i++; continue; }
    if (ch === "/") { tokens.push({ kind: "slash",    text: "/", start: i, end: i + 1 }); i++; continue; }
    if (ch === "@") { tokens.push({ kind: "at",       text: "@", start: i, end: i + 1 }); i++; continue; }
    if (ch === "[") { tokens.push({ kind: "lbracket", text: "[", start: i, end: i + 1 }); i++; continue; }
    if (ch === "]") { tokens.push({ kind: "rbracket", text: "]", start: i, end: i + 1 }); i++; continue; }
    if (ch === "+") { tokens.push({ kind: "plus",     text: "+", start: i, end: i + 1 }); i++; continue; }
    if (ch === "-") { tokens.push({ kind: "minus",    text: "-", start: i, end: i + 1 }); i++; continue; }
    if (ch === ".") { tokens.push({ kind: "dot",      text: ".", start: i, end: i + 1 }); i++; continue; }
    // String literal: "..."
    if (ch === "\"") {
      const start = i;
      i++;
      const valueStart = i;
      while (i < len && source[i] !== "\"") i++;
      if (i >= len) {
        throw new ScrollPatternError("Unterminated string literal", source, start);
      }
      const text = source.slice(valueStart, i);
      i++; // consume closing quote
      tokens.push({ kind: "string", text, start, end: i });
      continue;
    }
    // Number → length / duration / bare number
    if (isDigit(ch)) {
      const numStart = i;
      while (i < len && (isDigit(source[i]) || source[i] === ".")) i++;
      const numText = source.slice(numStart, i);
      const num = Number(numText);
      if (!Number.isFinite(num)) {
        throw new ScrollPatternError(`Invalid number "${numText}"`, source, numStart);
      }
      // Peek for unit suffix. `%` is special-cased as a single-char unit; the
      // alphabetic units (`px`, `s`, `ms`) are read as letter runs.
      const unitStart = i;
      let unit: string;
      if (i < len && source[i] === "%") {
        unit = "%";
        i++;
      } else {
        while (i < len && isLetter(source[i])) i++;
        unit = source.slice(unitStart, i);
      }
      if (unit === "px" || unit === "%") {
        tokens.push({ kind: "length", text: numText + unit, num, unit, start: numStart, end: i });
      } else if (unit === "s" || unit === "ms") {
        tokens.push({ kind: "duration", text: numText + unit, num, unit, start: numStart, end: i });
      } else if (unit === "pxps") {
        // <n>pxps — per-action speed (pixels per second). Only valid after
        // the `@` speed-suffix marker; the parser enforces that placement.
        tokens.push({ kind: "speed", text: numText + unit, num, unit, start: numStart, end: i });
      } else if (unit === "") {
        tokens.push({ kind: "number", text: numText, num, start: numStart, end: i });
      } else {
        throw new ScrollPatternError(`Unknown unit "${unit}" after number "${numText}"`, source, unitStart);
      }
      continue;
    }
    // Identifier: letters / digits / hyphens (for easing names like `ease-in-out`)
    if (isLetter(ch) || ch === "_") {
      const start = i;
      while (i < len && (isLetter(source[i]) || isDigit(source[i]) || source[i] === "-" || source[i] === "_")) i++;
      const text = source.slice(start, i);
      tokens.push({ kind: "ident", text, start, end: i });
      continue;
    }
    throw new ScrollPatternError(`Unexpected character ${JSON.stringify(ch)}`, source, i);
  }
  tokens.push({ kind: "eof", text: "", start: len, end: len });
  return tokens;
}

function isDigit(ch: string): boolean { return ch >= "0" && ch <= "9"; }
function isLetter(ch: string): boolean { return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"); }

// ── Parser ──────────────────────────────────────────────────────────────────

const ANCHOR_NAMES = new Set(["top", "bottom", "left", "right", "start", "end"]);
const DIRECTION_NAMES = new Set(["up", "down", "left", "right"]);
const EASING_NAMES = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[], private readonly source: string) {}

  parse(): ScrollPattern {
    const pattern = this.parsePattern();
    this.expect("eof");
    return pattern;
  }

  // ── grammar productions ──

  private parsePattern(): ScrollPattern {
    const segments: ScrollPatternSegment[] = [this.parseTopSegment()];
    while (this.peek().kind === "comma") {
      this.consume("comma");
      segments.push(this.parseTopSegment());
    }
    return { segments };
  }

  private parseTopSegment(): ScrollPatternSegment {
    if (this.peek().kind === "lparen") {
      return this.parseBracketedSegment();
    }
    return this.parseFlatSegment();
  }

  private parseBracketedSegment(): BracketedSegment {
    this.consume("lparen");
    const inner = this.parsePattern();
    this.expect("rparen");
    this.consume("rparen");
    const until = this.tryParseUntilClause();
    return { kind: "bracketed", pattern: inner, until };
  }

  private parseFlatSegment(): FlatSegment {
    const actions: ScrollPatternAction[] = [this.parseAction()];
    // Greedily consume more actions until we either:
    //  - hit the end of the segment (next thing is `until` or `)` or `eof`),
    //  - or hit a `,` followed by another action.
    // A `,` followed by `(` does NOT extend this flat-segment — that's the
    // next top-segment (a bracketed one). Same when followed by `until` (which
    // can only legally start the until-clause of THIS segment, so we keep it).
    while (this.peek().kind === "comma") {
      const after = this.peekAhead(1);
      if (after.kind === "lparen") break;       // next top-segment is bracketed
      this.consume("comma");
      actions.push(this.parseAction());
    }
    const until = this.tryParseUntilClause();
    return { kind: "flat", actions, until };
  }

  private parseAction(): ScrollPatternAction {
    const tok = this.peek();
    // `pause:` prefix (`pause` ident followed by `:`).
    if (tok.kind === "ident" && tok.text === "pause" && this.peekAhead(1).kind === "colon") {
      this.consume("ident");
      this.consume("colon");
      return this.parsePauseAction();
    }
    // Bare duration → pause.
    if (tok.kind === "duration") {
      return this.parsePauseAction();
    }
    // Otherwise: scroll action (with optional direction prefix).
    return this.parseScrollAction();
  }

  private parsePauseAction(): PauseAction {
    const tok = this.consume("duration");
    return { kind: "pause", durationMs: durationToMs(tok) };
  }

  private parseScrollAction(): ScrollAction {
    let direction: ScrollAction["direction"];
    // direction-prefix: ident `:` (only when ident is a direction name).
    const tok = this.peek();
    if (tok.kind === "ident" && DIRECTION_NAMES.has(tok.text) && this.peekAhead(1).kind === "colon") {
      direction = tok.text as ScrollAction["direction"];
      this.consume("ident");
      this.consume("colon");
    }
    const target = this.parseScrollTarget();
    let durationMs: number | undefined;
    let speedPxPerSec: number | undefined;
    let easing: Easing | undefined;
    // Duration suffix (`/<duration>`) and speed suffix (`@<n>pxps`) are
    // mutually exclusive on a single action — either pin the action's time,
    // or pin its speed, not both. The order in which they're tried doesn't
    // matter since the OTHER branch fires an explicit error if it's seen.
    if (this.peek().kind === "slash") {
      this.consume("slash");
      const dur = this.consume("duration");
      durationMs = durationToMs(dur);
      if (this.peek().kind === "at") {
        const conflict = this.peek();
        throw new ScrollPatternError(
          "Scroll action cannot carry both a `/<duration>` and `@<speed>` suffix",
          this.source, conflict.start,
        );
      }
    } else if (this.peek().kind === "at") {
      this.consume("at");
      const sp = this.consume("speed");
      if (!(sp.num != null && sp.num > 0)) {
        throw new ScrollPatternError(
          `Speed must be a positive number of px/s (got "${sp.text}")`,
          this.source, sp.start,
        );
      }
      speedPxPerSec = sp.num;
    }
    if (this.peek().kind === "lbracket") {
      easing = this.parseEasingSuffix();
    }
    return { kind: "scroll", direction, target, durationMs, speedPxPerSec, easing };
  }

  private parseScrollTarget(): ScrollTarget {
    const tok = this.peek();
    // delta-target: signed-length (a length OR `-` followed by a length).
    if (tok.kind === "length") {
      this.consume("length");
      const sl = lengthTokenToSignedLength(tok, 1);
      return { kind: "delta", signedLength: sl };
    }
    if (tok.kind === "minus" && this.peekAhead(1).kind === "length") {
      this.consume("minus");
      const lt = this.consume("length");
      const sl = lengthTokenToSignedLength(lt, -1);
      return { kind: "delta", signedLength: sl };
    }
    // absolute-target: anchored-expr.
    return { kind: "absolute", ...this.parseAnchoredExprBody() };
  }

  /** Parses the body of an anchored-expr: anchor[.x|.y] (op length)*. */
  private parseAnchoredExprBody(): { anchor: Anchor; axisSuffix?: "x" | "y"; offsets: Array<{ op: "+" | "-"; length: Length }> } {
    const anchor = this.parseAnchor();
    let axisSuffix: "x" | "y" | undefined;
    if (this.peek().kind === "dot") {
      this.consume("dot");
      const sfx = this.consume("ident");
      if (sfx.text !== "x" && sfx.text !== "y") {
        throw new ScrollPatternError(`Expected axis suffix .x or .y, got ".${sfx.text}"`, this.source, sfx.start);
      }
      axisSuffix = sfx.text;
    }
    const offsets: Array<{ op: "+" | "-"; length: Length }> = [];
    while (this.peek().kind === "plus" || this.peek().kind === "minus") {
      const op = this.peek().kind === "plus" ? "+" : "-";
      this.consume(this.peek().kind);
      const lt = this.consume("length");
      offsets.push({ op, length: lengthTokenToLength(lt) });
    }
    return { anchor, axisSuffix, offsets };
  }

  private parseAnchor(): Anchor {
    const tok = this.peek();
    if (tok.kind !== "ident") {
      throw new ScrollPatternError(`Expected an anchor name or selector(...), got ${describeToken(tok)}`, this.source, tok.start);
    }
    if (tok.text === "selector") {
      // selector("css-selector")
      this.consume("ident");
      this.expect("lparen");
      this.consume("lparen");
      const strTok = this.consume("string");
      this.expect("rparen");
      this.consume("rparen");
      return { kind: "selector", cssSelector: strTok.text };
    }
    if (ANCHOR_NAMES.has(tok.text)) {
      this.consume("ident");
      return { kind: "named", name: tok.text as NamedAnchor["name"] };
    }
    throw new ScrollPatternError(
      `Expected anchor name (top|bottom|left|right|start|end) or selector("..."), got "${tok.text}"`,
      this.source, tok.start,
    );
  }

  private parseEasingSuffix(): Easing {
    this.consume("lbracket");
    const tok = this.consume("ident");
    if (tok.text === "cubic-bezier") {
      // [cubic-bezier(a, b, c, d)]
      this.expect("lparen");
      this.consume("lparen");
      const a = this.parseSignedNumberLiteral();
      this.expect("comma"); this.consume("comma");
      const b = this.parseSignedNumberLiteral();
      this.expect("comma"); this.consume("comma");
      const c = this.parseSignedNumberLiteral();
      this.expect("comma"); this.consume("comma");
      const d = this.parseSignedNumberLiteral();
      this.expect("rparen"); this.consume("rparen");
      this.expect("rbracket"); this.consume("rbracket");
      return { kind: "cubic-bezier", values: [a, b, c, d] };
    }
    if (!EASING_NAMES.has(tok.text)) {
      throw new ScrollPatternError(
        `Unknown easing "${tok.text}" (expected one of ${[...EASING_NAMES].join(", ")} or cubic-bezier(...))`,
        this.source, tok.start,
      );
    }
    this.expect("rbracket"); this.consume("rbracket");
    return { kind: "named", name: tok.text as ("linear" | "ease" | "ease-in" | "ease-out" | "ease-in-out") };
  }

  private parseSignedNumberLiteral(): number {
    let sign = 1;
    if (this.peek().kind === "minus") { this.consume("minus"); sign = -1; }
    else if (this.peek().kind === "plus") { this.consume("plus"); }
    const tok = this.peek();
    if (tok.kind === "number") { this.consume("number"); return sign * (tok.num as number); }
    if (tok.kind === "length" && tok.unit === "px") { this.consume("length"); return sign * (tok.num as number); }
    throw new ScrollPatternError(`Expected a number, got ${describeToken(tok)}`, this.source, tok.start);
  }

  private tryParseUntilClause(): UntilClause | undefined {
    const tok = this.peek();
    if (tok.kind === "ident" && tok.text === "until") {
      this.consume("ident");
      return this.parseUntilCondition();
    }
    return undefined;
  }

  private parseUntilCondition(): UntilClause {
    // Either a position expression or `<n> times`.
    const tok = this.peek();
    // count-condition: number `times`
    if (tok.kind === "number") {
      const numTok = this.consume("number");
      const timesTok = this.peek();
      if (timesTok.kind !== "ident" || timesTok.text !== "times") {
        throw new ScrollPatternError(`Expected "times" after number in until clause, got ${describeToken(timesTok)}`, this.source, timesTok.start);
      }
      this.consume("ident");
      const count = numTok.num as number;
      if (!Number.isInteger(count) || count <= 0) {
        throw new ScrollPatternError(`Count in "until ${count} times" must be a positive integer`, this.source, numTok.start);
      }
      return { kind: "count", count };
    }
    // Otherwise: position (anchored-expr).
    const body = this.parseAnchoredExprBody();
    return { kind: "position", target: { kind: "absolute", ...body } };
  }

  // ── token helpers ──

  private peek(): Token { return this.tokens[this.pos]; }
  private peekAhead(n: number): Token { return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)]; }
  private consume(kind: TokenKind): Token {
    const tok = this.tokens[this.pos];
    if (tok.kind !== kind) {
      throw new ScrollPatternError(`Expected ${kind}, got ${describeToken(tok)}`, this.source, tok.start);
    }
    this.pos++;
    return tok;
  }
  private expect(kind: TokenKind): void {
    const tok = this.tokens[this.pos];
    if (tok.kind !== kind) {
      throw new ScrollPatternError(`Expected ${kind}, got ${describeToken(tok)}`, this.source, tok.start);
    }
  }
}

function describeToken(t: Token): string {
  if (t.kind === "eof") return "end of input";
  return `${t.kind} "${t.text}"`;
}

function durationToMs(t: Token): number {
  if (t.unit === "s") return (t.num as number) * 1000;
  if (t.unit === "ms") return (t.num as number);
  throw new ScrollPatternError(`Unknown duration unit "${t.unit}"`, "", t.start);
}

function lengthTokenUnit(t: Token): "px" | "%" {
  // The tokenizer at `tokenize()` only emits `kind: "length"` when unit is
  // exactly "px" or "%" — this check defends against tokenizer drift so a
  // future unit-set change can't silently slip through as an `unknown` unit.
  if (t.unit !== "px" && t.unit !== "%") {
    throw new ScrollPatternError(`Internal: length token has non-length unit "${String(t.unit)}"`, "", t.start);
  }
  return t.unit;
}

function lengthTokenNum(t: Token): number {
  if (typeof t.num !== "number" || !Number.isFinite(t.num)) {
    throw new ScrollPatternError(`Internal: length token missing numeric value`, "", t.start);
  }
  return t.num;
}

function lengthTokenToLength(t: Token): Length {
  return { value: lengthTokenNum(t), unit: lengthTokenUnit(t) };
}

function lengthTokenToSignedLength(t: Token, sign: 1 | -1): SignedLength {
  return { sign, value: lengthTokenNum(t), unit: lengthTokenUnit(t) };
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Parse a scroll pattern source string into an AST. Throws
 * `ScrollPatternError` on any tokenization or parse error, with `position`
 * pointing at the offending character in the source.
 */
export function parseScrollPattern(source: string): ScrollPattern {
  if (source.trim() === "") {
    throw new ScrollPatternError("Empty pattern", source, 0);
  }
  const tokens = tokenize(source);
  const parser = new Parser(tokens, source);
  return parser.parse();
}
