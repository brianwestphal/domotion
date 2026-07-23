/**
 * Captured-text addressing engine (docs/101, the caret + selection track's
 * geometry source; designed in docs/100 "Primitive 2").
 *
 * Resolves a `{ target, charOffset }` address — and `charStart`/`charEnd`
 * ranges — NODE-SIDE against a captured element tree. The captured
 * `TextSegment`s carry per-UTF-16-code-unit `xOffsets` (Chromium's painted x,
 * subpixel, viewport-absolute) and a line-box top `y`; the element carries
 * `fontAscent` / `fontDescent` (Chrome's own `measureText` metrics). So a caret
 * lands on *Chromium's* painted x with no live-page probe and no hand-tuned
 * `dy ≈ ascent` constant.
 *
 * **Target resolution (design decision).** A captured tree has no CSS-selector
 * engine, so selectors are resolved at CAPTURE time by stamping
 * `data-domotion-anim="<id>"` on the matching element — the exact mechanism
 * intra-frame animations already use (`src/cli/animate.ts` tags the live DOM,
 * CAPTURE_SCRIPT lifts the attribute into `CapturedElement.animId`). This
 * engine then finds the element by `animId`. That is the least-new-machinery
 * path: zero new capture code, and authors writing raw HTML fixtures can stamp
 * the attribute themselves. A `match` predicate is the programmatic escape
 * hatch for callers holding the tree (tests, imperative pipelines). The
 * declarative config surface maps `selector` → stamped animId at capture time.
 *
 * **Indexing.** Addresses count Unicode CODE POINTS (an astral pair is one
 * position) across the element's own text runs concatenated in captured order.
 * `xOffsets` arrays are per UTF-16 code unit (a surrogate pair carries two
 * entries at the same painted x), so the engine converts code-point offsets to
 * UTF-16 indices per run before reading them.
 *
 * **Fallback.** When a run has no captured `xOffsets` (e.g. some input paths),
 * per-character advances come from fontkit via the same
 * resolve-key → font-instance path the typing overlay's `overlayAdvances`
 * uses, anchored at the run's captured `x`.
 */

import type { CapturedElement, TextSegment } from "../capture/types.js";
import { getFontInstance, resolveFontKey } from "../render/font-resolution.js";

/** How the addressed element is located in the captured tree. See the module
 *  header: `animId` (the capture-side `data-domotion-anim` stamp) is the
 *  selector-shaped path; `match` is the programmatic escape hatch. Exactly one
 *  should be provided (when both are, `animId` wins). */
export interface TextAddressTarget {
  /** Match the element whose `data-domotion-anim` stamp captured as this id. */
  animId?: string;
  /** Programmatic predicate over captured elements (first DFS match wins). */
  match?: (el: CapturedElement) => boolean;
}

/** A resolved caret position: everything `caretShapeRect` needs, in viewport
 *  (= SVG root) coordinates. */
export interface CaretPoint {
  /** Caret x — the addressed code point's left edge (or the right edge of the
   *  final character for `charOffset === length`). Subpixel, Chromium's paint. */
  x: number;
  /** Text baseline y (run top + ascent). */
  baselineY: number;
  ascentPx: number;
  descentPx: number;
  fontSize: number;
  /** Advance of the insertion cell — the character AT the offset, or the space
   *  advance at end-of-text (the block/underscore caret width). */
  cellWidthPx: number;
}

/** One selection rectangle covering (part of) a range within a single text
 *  run, plus the per-character sweep geometry inside it. */
export interface SelectionRectPlan {
  /** Left edge of the covered span (first covered char's painted x). */
  x: number;
  /** Top of the run's font box (baseline − ascent). */
  y: number;
  /** ascent + descent — the font-box height, what Blink highlights. */
  height: number;
  /** Full width of the covered span (last covered char's right edge − x). */
  width: number;
  /** Successive right-edge x positions after each covered character, in sweep
   *  order (length = covered char count). `edges[k] − x` is the rect width
   *  once `k + 1` characters are swept; the last entry equals `x + width`. */
  edges: number[];
}

/** A resolved range: one rect plan per covered text run (a range spanning
 *  wrapped lines / styled segments yields one rect per run). */
export interface RangeRects {
  rects: SelectionRectPlan[];
  /** Total covered code points (the sweep distributes `sweepMs` across these). */
  charCount: number;
}

/** Depth-first search for the addressed element. `animId` wins over `match`. */
export function findAddressedElement(roots: CapturedElement[], target: TextAddressTarget): CapturedElement | null {
  const want = target.animId;
  const pred = want != null ? (el: CapturedElement): boolean => el.animId === want : target.match;
  if (pred == null) return null;
  const stack: CapturedElement[] = [...roots].reverse();
  while (stack.length > 0) {
    const el = stack.pop();
    if (el == null) continue;
    if (pred(el)) return el;
    for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]);
  }
  return null;
}

/** One addressable text run: a captured segment (or the synthesized input-value
 *  run), normalized to the fields the geometry math needs. */
interface TextRun {
  text: string;
  /** Left edge (viewport px) — the anchor `xOffsets` / fallback advances start from. */
  x: number;
  /** Line-box top (viewport px); baseline = y + ascent. */
  y: number;
  /** Captured painted width of the run (right edge = x + width) — Chromium's
   *  measured run extent, preferred over summed advances for end-of-run edges. */
  width?: number;
  /** Per-UTF-16-code-unit painted x (viewport-absolute), when captured. */
  xOffsets?: number[];
  fontSize: number;
  ascentPx: number;
  descentPx: number;
  fontFamily: string;
  fontWeight: string;
}

/**
 * The element's addressable text runs, in captured order. Sources, in
 * preference order:
 *  1. `textSegments` — the normal path (block text, wrapped lines, styled
 *     segments; textarea lines also land here). Vertical-writing segments are
 *     skipped (vertical caret geometry is out of scope for v1).
 *  2. The input-value synthesis — single-line `<input>` captures carry
 *     `text` + `inputXOffsets` + `textLeft`/`textTop` instead of segments.
 * Returns an empty array when the element has no addressable text.
 */
function elementTextRuns(el: CapturedElement): TextRun[] {
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const metrics = fallbackMetrics(fontFamily, fontWeight, fontSize);
  const ascentOf = (seg?: TextSegment): number =>
    seg?.fontAscent ?? el.fontAscent ?? metrics.ascentPx ?? fontSize * 0.8;
  const descent = el.fontDescent ?? metrics.descentPx ?? fontSize * 0.2;

  if (el.textSegments != null && el.textSegments.length > 0) {
    return el.textSegments
      .filter((seg) => seg.verticalWritingMode == null && seg.text.length > 0)
      .map((seg) => ({
        text: seg.text,
        x: seg.x,
        y: seg.y,
        width: seg.width,
        xOffsets: seg.xOffsets,
        fontSize: seg.fontSize ?? fontSize,
        ascentPx: ascentOf(seg),
        descentPx: descent,
        fontFamily: seg.fontFamily ?? fontFamily,
        fontWeight: seg.fontWeight ?? fontWeight,
      }));
  }
  if (el.text !== "" && (el.inputXOffsets != null || el.textLeft != null)) {
    // Input-value synthesis — mirrors `renderInputText`'s anchors: text starts
    // at `textLeft` (falling back to the content-box inset the renderer uses)
    // with the line-box top at `textTop`.
    return [{
      text: el.text,
      x: el.textLeft ?? el.x + 4,
      y: el.textTop ?? el.y,
      width: el.textWidth,
      xOffsets: el.inputXOffsets,
      fontSize,
      ascentPx: ascentOf(),
      descentPx: descent,
      fontFamily,
      fontWeight,
    }];
  }
  return [];
}

/** fontkit-measured fallback metrics + advances for a font, mirroring the
 *  typing overlay's `overlayAdvances` (animator.ts): resolve the family to a
 *  font key, load the instance, scale to px. All fields undefined / estimated
 *  when the face can't be resolved on this host. */
function fallbackMetrics(fontFamily: string, fontWeight: string, fontSize: number): {
  ascentPx?: number;
  descentPx?: number;
  advOf: (ch: string) => number;
  measured: boolean;
} {
  const estimate = fontSize * 0.6;
  let font: ReturnType<typeof getFontInstance> = null;
  try {
    font = getFontInstance(resolveFontKey(fontFamily), parseInt(fontWeight, 10) || 400, fontSize, 0);
  } catch {
    font = null;
  }
  if (font == null) return { advOf: () => estimate, measured: false };
  const scale = fontSize / font.unitsPerEm;
  return {
    ascentPx: font.ascent * scale,
    // fontkit descent is negative (hhea/OS-2); negate for the downward magnitude.
    descentPx: -font.descent * scale,
    advOf: (ch: string): number => {
      const cp = ch.codePointAt(0);
      if (cp == null) return estimate;
      const g = font.glyphForCodePoint(cp);
      const adv = (g?.advanceWidth ?? 0) * scale;
      return adv > 0 ? adv : estimate;
    },
    measured: true,
  };
}

/** Per-code-unit x offsets for a run — captured when available, else fontkit
 *  advances accumulated from the run's anchor (surrogate pairs share one x,
 *  matching the capture script's convention). */
function runXOffsets(run: TextRun): number[] {
  if (run.xOffsets != null && run.xOffsets.length >= run.text.length) return run.xOffsets;
  const { advOf } = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize);
  const xs: number[] = [];
  let x = run.x;
  for (const ch of run.text) {
    for (let k = 0; k < ch.length; k++) xs.push(x);
    x += advOf(ch);
  }
  return xs;
}

/** The run's right edge: the captured painted width when present, else the
 *  final char's x + its advance. */
function runRightEdge(run: TextRun, xs: number[]): number {
  if (run.width != null && run.width > 0) return run.x + run.width;
  if (run.text.length === 0) return run.x;
  const chars = [...run.text];
  const last = chars[chars.length - 1];
  const lastX = xs[run.text.length - last.length];
  const { advOf } = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize);
  return lastX + advOf(last);
}

/** Locate code-point offset `cpOffset` within the element's concatenated runs:
 *  the run index and the UTF-16 index inside it. An offset equal to the total
 *  code-point count maps to (lastRun, run.text.length) — the after-last-char
 *  caret slot. Returns null when out of range or the element has no text. */
function locateOffset(runs: TextRun[], cpOffset: number): { runIndex: number; utf16: number } | null {
  if (runs.length === 0 || cpOffset < 0) return null;
  let remaining = cpOffset;
  for (let ri = 0; ri < runs.length; ri++) {
    const text = runs[ri].text;
    let utf16 = 0;
    for (const ch of text) {
      if (remaining === 0) return { runIndex: ri, utf16 };
      remaining--;
      utf16 += ch.length;
    }
    // Offset lands exactly at this run's end: the caret sits after its last
    // char ONLY when this is the final run; otherwise position 0 of the next
    // run is the same logical slot and carries the next line's geometry.
    if (remaining === 0 && ri === runs.length - 1) return { runIndex: ri, utf16: text.length };
  }
  return null;
}

/** Total code points across the element's runs. */
export function addressableLength(roots: CapturedElement[], target: TextAddressTarget): number | null {
  const el = findAddressedElement(roots, target);
  if (el == null) return null;
  const runs = elementTextRuns(el);
  if (runs.length === 0) return null;
  let n = 0;
  for (const run of runs) n += [...run.text].length;
  return n;
}

/**
 * Resolve `{ target, charOffset }` to a caret point. `charOffset` counts code
 * points across the element's concatenated runs; `charOffset === length` is
 * the caret after the final character. Returns null when the target doesn't
 * resolve or the offset is out of range.
 */
export function resolveCaretPoint(roots: CapturedElement[], target: TextAddressTarget, charOffset: number): CaretPoint | null {
  const el = findAddressedElement(roots, target);
  if (el == null) return null;
  const runs = elementTextRuns(el);
  const loc = locateOffset(runs, charOffset);
  if (loc == null) return null;
  const run = runs[loc.runIndex];
  const xs = runXOffsets(run);
  const atEnd = loc.utf16 >= run.text.length;
  const x = atEnd ? runRightEdge(run, xs) : xs[loc.utf16];
  // Insertion-cell width: the char at the offset (next-x − x within the run,
  // right edge for the final char); at end-of-text, the space advance — the
  // natural "empty cell" block/underscore carets use (see caret-metrics.ts).
  let cellWidthPx: number;
  if (atEnd) {
    const { advOf } = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize);
    cellWidthPx = advOf(" ");
  } else {
    const chLen = codePointLengthAt(run.text, loc.utf16);
    const nextU = loc.utf16 + chLen;
    cellWidthPx = (nextU < run.text.length ? xs[nextU] : runRightEdge(run, xs)) - x;
    if (!(cellWidthPx > 0)) {
      const { advOf } = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize);
      cellWidthPx = advOf(run.text.slice(loc.utf16, nextU));
    }
  }
  return {
    x,
    baselineY: run.y + run.ascentPx,
    ascentPx: run.ascentPx,
    descentPx: run.descentPx,
    fontSize: run.fontSize,
    cellWidthPx,
  };
}

/** UTF-16 length of the code point starting at `u` (2 for a surrogate pair). */
function codePointLengthAt(text: string, u: number): number {
  const cp = text.codePointAt(u);
  return cp != null && cp > 0xffff ? 2 : 1;
}

/**
 * Resolve a code-point range `[charStart, charEnd)` to selection rectangles —
 * one per covered text run (so a range across wrapped lines or styled segments
 * yields a rect per line/segment) — with per-character sweep edges. Returns
 * null when the target doesn't resolve, the range is empty, or out of range.
 */
export function resolveRangeRects(roots: CapturedElement[], target: TextAddressTarget, charStart: number, charEnd: number): RangeRects | null {
  const el = findAddressedElement(roots, target);
  if (el == null || charEnd <= charStart || charStart < 0) return null;
  const runs = elementTextRuns(el);
  if (runs.length === 0) return null;

  const rects: SelectionRectPlan[] = [];
  let cp = 0; // running code-point index across runs
  let covered = 0;
  for (const run of runs) {
    const xs = runXOffsets(run);
    let utf16 = 0;
    let plan: SelectionRectPlan | null = null;
    for (const ch of run.text) {
      if (cp >= charStart && cp < charEnd) {
        const left = xs[utf16];
        const nextU = utf16 + ch.length;
        const right = nextU < run.text.length ? xs[nextU] : runRightEdge(run, xs);
        if (plan == null) {
          plan = {
            x: left,
            // Run top = the font-box top (baseline − ascent); height spans the
            // font box (ascent + descent), matching what Blink highlights.
            y: run.y,
            height: Math.round(run.ascentPx + run.descentPx),
            width: 0,
            edges: [],
          };
          rects.push(plan);
        }
        plan.edges.push(right);
        plan.width = right - plan.x;
        covered++;
      }
      cp++;
      utf16 += ch.length;
    }
  }
  if (covered === 0) return null;
  return { rects, charCount: covered };
}
