// Linear-time scanners for flat CSS rule blocks (`prelude { body }`).
//
// DM-NEV5JJ: several call sites split CSS with regexes of the shape
// `/([^{}]*)(\{[^{}]*\})/g` or `/([^{}]+)\{([^{}]*)\}/g`. When a long run of
// brace-free text is NOT the body of a flat block (text after the last rule, a
// prelude in front of a nested `{`, or an unterminated block), the regex engine
// retries the whole run from every starting offset, which is quadratic in the
// run's length: 40 KB of such text took 5-6 s per call. These helpers return
// exactly what those regexes' global scans return, in one pass. They are pure
// (no imports, no closures over module state), so the in-page capture script
// bundle can use them too.

/** One match of the flat-block scan: `prelude` is the text in front of the
 *  block, `body` the text between its braces, `[start, end)` the matched span
 *  (prelude through the closing `}`). */
export interface FlatCssBlock {
  prelude: string;
  body: string;
  start: number;
  end: number;
}

function nextBrace(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x7b /* { */ || code === 0x7d /* } */) return index;
  }
  return -1;
}

/**
 * The matches, in order, of `/([^{}]*)\{([^{}]*)\}/g` over `text` — or, with
 * `nonEmptyPrelude`, of `/([^{}]+)\{([^{}]*)\}/g`, which skips a block that has
 * no text in front of it.
 */
export function flatCssBlocks(text: string, options: { nonEmptyPrelude?: boolean } = {}): FlatCssBlock[] {
  const requirePrelude = options.nonEmptyPrelude === true;
  const blocks: FlatCssBlock[] = [];
  // `start` is where the regex would try its next match; `brace` is the first
  // brace at or after it. Every match attempt from `start` up to `brace` sees
  // the same maximal brace-free run ending at `brace`, so they share one fate.
  let start = 0;
  let brace = nextBrace(text, 0);
  while (brace >= 0) {
    if (text.charCodeAt(brace) === 0x7d /* } */) {
      start = brace + 1;
      brace = nextBrace(text, start);
      continue;
    }
    const close = nextBrace(text, brace + 1);
    if (close < 0) break;
    if (text.charCodeAt(close) === 0x7d && (!requirePrelude || brace > start)) {
      blocks.push({ prelude: text.slice(start, brace), body: text.slice(brace + 1, close), start, end: close + 1 });
      start = close + 1;
      brace = nextBrace(text, start);
      continue;
    }
    // No flat block opens here; the next attempt starts just past this `{`.
    start = brace + 1;
    brace = close;
  }
  return blocks;
}

/**
 * Equivalent to `text.replace(/([^{}]*)(\{[^{}]*\})/g, (_m, prelude, block) =>
 * replace(prelude, block))`, where `block` includes its braces.
 */
export function replaceFlatCssBlocks(text: string, replace: (prelude: string, block: string) => string): string {
  let out = "";
  let last = 0;
  for (const block of flatCssBlocks(text)) {
    out += text.slice(last, block.start) + replace(block.prelude, `{${block.body}}`);
    last = block.end;
  }
  return out + text.slice(last);
}
