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
 * position) across the target's text runs concatenated in reading order.
 * `xOffsets` arrays are per UTF-16 code unit (a surrogate pair carries two
 * entries at the same painted x), so the engine converts code-point offsets to
 * UTF-16 indices per run before reading them. Because each run carries its OWN
 * text + xOffsets, this per-run conversion composes correctly even when
 * consecutive runs come from DIFFERENT captured elements (mixed content).
 *
 * **Mixed content (DM-1756).** The address resolves over the target's whole
 * SUBTREE, not just its own text nodes: `<p>plain <b>bold</b> tail</p>` (or a
 * syntax-highlighted code line tokenized into `<span>`s) is one logical string
 * whose `charOffset` spans the children. The captured tree stores a parent's
 * own text segments (`el.textSegments`) and its child elements (`el.children`)
 * SEPARATELY — the DOM interleave order between them is not preserved — so the
 * engine reconstructs reading order from Chromium's painted geometry: runs are
 * grouped into lines by baseline (a `<sub>`/`<sup>` stays on its line; a wrapped
 * or `display:block` child starts a new line) and ordered left-to-right by
 * captured `x` within each line. For horizontal LTR inline flow that visual
 * order equals DOM/logical order (see `src/render/paint-order.ts` for the
 * distinct element z-order paint sort — reading order here is a separate,
 * text-flow concern). Each descendant run keeps ITS OWN font metrics /
 * baseline / xOffsets, so the per-run geometry is exact across child boundaries.
 * Whitespace is taken verbatim from what Chromium captured — the leading /
 * trailing spaces inside a text run (`"plain "`, `" tail"`) are preserved; the
 * engine never synthesizes a space at a child boundary. (Consequence: a
 * pure-whitespace text node between two inline children is dropped at capture —
 * all-whitespace segments aren't emitted — so it isn't part of the addressed
 * string; see the Limits section of docs/101.)
 *
 * **Regression safety.** When the target has no descendant element that
 * contributes any run (the single-element and input-value cases), the engine
 * returns the target's own runs in captured order UNCHANGED — the paint-order
 * merge only runs for genuinely mixed content, so existing single-element /
 * bidi-fragment / input behavior is byte-for-byte preserved.
 *
 * **Bidi / RTL (logical-order addressing).** Capture keeps a run's characters in
 * DOM/LOGICAL order while `xOffsets[i]` is the char's VISUAL painted x (see
 * `src/capture/script/walker/text-segments.ts`), so `charOffset` already counts
 * logical positions — but the GEOMETRY has to be read through the bidi levels:
 * inside an RTL run the position "before code point N" is that character's RIGHT
 * edge, not its left, and a logical range covers one visually-separate rectangle
 * per bidi level run. Levels come from `bidi-js`'s `getEmbeddingLevels` over the
 * element's concatenated logical text with the element's CSS `direction` as the
 * paragraph direction — the same library and whole-paragraph resolution the
 * renderer's paired-bracket mirroring uses (`applyBidi` / `applyBidiAt` in
 * `src/render/text.ts`). Verified against Chromium: the level runs bidi-js
 * resolves reproduce Chrome's own `Range.getClientRects()` fragmentation of a
 * mixed Hebrew/Latin line exactly. Pure-LTR runs skip the whole path and keep
 * their previous geometry byte-for-byte.
 *
 * **Fallback.** When a run has no captured `xOffsets` (e.g. some input paths),
 * per-character advances come from fontkit via the same
 * resolve-key → font-instance path the typing overlay's `overlayAdvances`
 * uses, anchored at the run's captured `x`.
 */

import bidiFactory from "bidi-js";
import type { CapturedElement, TextSegment } from "../capture/types.js";
import { getFontInstance, resolveFontKey } from "../render/font-resolution.js";

const _bidi = bidiFactory();

/** Any RTL code point (Hebrew + Arabic + Syriac + Thaana + presentation forms).
 *  A local copy of the renderer's `_RTL_RE` gate (`src/render/text.ts`) so the
 *  addressing engine can decide whether a run needs bidi handling without
 *  importing the render module. */
const RTL_RE = /[֐-ࣿיִ-ﻼ]/;

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
   *  final character for `charOffset === length`). Subpixel, Chromium's paint.
   *  For a `vertical` point this is the COLUMN's left edge instead. */
  x: number;
  /** The caret's position along the FLOW axis: the text baseline y for
   *  horizontal writing, and the top of the addressed character's column cell
   *  for `vertical` writing (where there is no horizontal baseline). */
  baselineY: number;
  ascentPx: number;
  descentPx: number;
  fontSize: number;
  /** Extent of the insertion cell ALONG THE FLOW AXIS — the advance of the
   *  character at the offset (or the space advance at end-of-text) for
   *  horizontal writing, and the cell's height down the column for `vertical`.
   *  This is the block / underscore caret's length. */
  cellWidthPx: number;
  /** True when the addressed character sits on an RTL bidi level: `x` is then
   *  the cell's RIGHT edge and the insertion cell extends LEFT from it (a block
   *  / underscore caret covers `[x − cellWidthPx, x]`). Absent/false for the
   *  left-to-right case, which keeps its previous geometry exactly. Not set for
   *  `vertical` points (the column's flow axis is y). */
  rtl?: boolean;
  /** The captured `writing-mode` when the addressed text stacks down a COLUMN
   *  (`vertical-rl` / `vertical-lr` / `sideways-rl` / `sideways-lr`). The caret
   *  then runs ACROSS the column: `x` is the column's left edge, `baselineY` the
   *  along-column position, `cellWidthPx` the cell's height, and
   *  {@link CaretPoint.columnWidthPx} the column's cross extent. */
  vertical?: string;
  /** Cross-axis extent of the column (`vertical` points only) — what a bar
   *  caret spans and a block caret's width. */
  columnWidthPx?: number;
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
  /** Successive painted edge x positions after each covered character, in
   *  LOGICAL sweep order (length = covered char count). For a left-to-right
   *  rect these are the successive RIGHT edges: `edges[k] − x` is the rect
   *  width once `k + 1` characters are swept and the last entry equals
   *  `x + width`. For an `rtl` rect they are the successive LEFT edges, growing
   *  leftward: the width after `k + 1` characters is `(x + width) − edges[k]`
   *  and the last entry equals `x`. */
  edges: number[];
  /** True when this rect covers an RTL bidi level run — the logical sweep grows
   *  from the rect's RIGHT edge leftward (see {@link SelectionRectPlan.edges}).
   *  Absent/false for the left-to-right case. */
  rtl?: boolean;
  /** True when this rect covers VERTICAL-writing text: the flow axis is y, so
   *  `x` / `width` are the column's fixed cross extent, `y` / `height` are the
   *  swept span DOWN the column, and `edges` are the successive BOTTOM edges
   *  (`edges[k] − y` is the rect height once `k + 1` characters are swept). The
   *  sweep grows via `height` keyframes instead of `width`. */
  vertical?: boolean;
}

/** A resolved range: one rect plan per covered text run — and, within a run,
 *  one per bidi level run, matching how Chromium fragments its own selection
 *  rects (a logical range over mixed-direction text is visually discontiguous).
 *  Rects are ordered LOGICALLY, so the sweep runs in reading order. */
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
  /** Captured line-box height (viewport px). Only used by the paint-order merge
   *  (mixed content) for line banding; undefined for the input-value run. */
  lineHeight?: number;
  /** Per-UTF-16-code-unit painted x (viewport-absolute), when captured. */
  xOffsets?: number[];
  fontSize: number;
  ascentPx: number;
  descentPx: number;
  fontFamily: string;
  fontWeight: string;
  /** The owning element's CSS `direction` — the paragraph direction bidi level
   *  resolution runs under. `"ltr"` unless the capture said otherwise. */
  dir: "ltr" | "rtl";
  /**
   * Vertical writing mode (`vertical-rl` / `vertical-lr` / `sideways-rl` /
   * `sideways-lr`) when this run stacks DOWN A COLUMN instead of across a line.
   * The along-flow axis is then y, not x, so the geometry reads
   * `yOffsets` / `verticalAdvances` / `columnLength` instead of
   * `xOffsets` / `width`, and `x` / `width` describe the column's CROSS extent.
   */
  vertical?: string;
  /** Per-UTF-16-code-unit painted y (vertical runs) — `xOffsets`' along-axis
   *  twin. */
  yOffsets?: number[];
  /** Per-UTF-16-code-unit advance DOWN the column (vertical runs). */
  verticalAdvances?: number[];
  /** Captured column length (vertical runs): the column's bottom edge is
   *  `y + columnLength`, the end-of-text caret position. */
  columnLength?: number;
}

/** True for the CSS `writing-mode` values that stack text down a column. */
function isVerticalMode(mode: string | undefined): boolean {
  return mode != null && mode !== "" && mode !== "horizontal-tb";
}

/**
 * One captured element's OWN addressable text runs, in captured order (NOT
 * descending into children). Sources, in preference order:
 *  1. `textSegments` — the normal path (block text, wrapped lines, styled
 *     segments; textarea lines also land here). A vertical-writing segment
 *     becomes a VERTICAL run: same shape, but the along-flow axis is y, so it
 *     carries `yOffsets` / `verticalAdvances` / `columnLength` and its `x` /
 *     `width` describe the column's cross extent.
 *  2. The input-value synthesis — single-line `<input>` captures carry
 *     `text` + `inputXOffsets` + `textLeft`/`textTop` instead of segments.
 * Returns an empty array when the element has no addressable text OF ITS OWN.
 */
function elementOwnRuns(el: CapturedElement): TextRun[] {
  const fontSize = parseFloat(el.styles.fontSize) || 14;
  const fontFamily = el.styles.fontFamily;
  const fontWeight = el.styles.fontWeight;
  const metrics = fallbackMetrics(fontFamily, fontWeight, fontSize);
  const ascentOf = (seg?: TextSegment): number =>
    seg?.fontAscent ?? el.fontAscent ?? metrics.ascentPx ?? fontSize * 0.8;
  const descent = el.fontDescent ?? metrics.descentPx ?? fontSize * 0.2;
  const dir: "ltr" | "rtl" = el.styles.direction === "rtl" ? "rtl" : "ltr";

  if (el.textSegments != null && el.textSegments.length > 0) {
    return el.textSegments
      .filter((seg) => seg.text.length > 0)
      .map((seg) => ({
        text: seg.text,
        x: seg.x,
        y: seg.y,
        width: seg.width,
        lineHeight: seg.height,
        xOffsets: seg.xOffsets,
        fontSize: seg.fontSize ?? fontSize,
        ascentPx: ascentOf(seg),
        descentPx: descent,
        fontFamily: seg.fontFamily ?? fontFamily,
        fontWeight: seg.fontWeight ?? fontWeight,
        dir,
        ...(seg.verticalWritingMode != null
          ? {
            vertical: seg.verticalWritingMode,
            yOffsets: seg.yOffsets,
            verticalAdvances: seg.verticalAdvances,
            columnLength: seg.height,
          }
          : {}),
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
      lineHeight: el.textHeight,
      xOffsets: el.inputXOffsets,
      fontSize,
      ascentPx: ascentOf(),
      descentPx: descent,
      fontFamily,
      fontWeight,
      dir,
    }];
  }
  return [];
}

/** DFS pre-order collection of every DESCENDANT element's own runs (the target
 *  itself is excluded — its own runs are gathered separately). Order among the
 *  collected runs is not relied upon: `orderRunsByPaint` re-sorts by geometry. */
function collectDescendantRuns(el: CapturedElement, out: TextRun[]): void {
  for (const child of el.children) {
    for (const run of elementOwnRuns(child)) out.push(run);
    collectDescendantRuns(child, out);
  }
}

/**
 * Reading-order sort of a merged run list gathered across a subtree (mixed
 * content). Reconstructs Chromium's visual reading order from painted geometry
 * — the captured tree does not retain the DOM interleave between a parent's own
 * text and its child elements, so position is the source of truth:
 *
 *  1. Group runs into LINES by baseline (`y + ascentPx`). A new line starts
 *     when a run's baseline sits more than ~0.6em below the current line's
 *     baseline — a full line-height gap (wrapped line / `display:block` child)
 *     breaks; a small sub/sup shift does not.
 *  2. Within a line, order by captured `x` — left-to-right in an LTR paragraph,
 *     RIGHT-to-left when the addressed element's CSS `direction` is `rtl`,
 *     since that is the reading order of the boxes on an RTL line.
 *  3. Emit lines top-to-bottom.
 *
 * Array sort is stable (ES2019+), so equal keys keep capture order. For
 * horizontal inline flow that box order equals DOM/logical order. Bidi WITHIN a
 * run is handled separately (see `runCharBoxes`); what stays approximate is a
 * line whose child boxes themselves reorder bidirectionally (an LTR `<span>`
 * embedded mid-line in an RTL paragraph) — those boxes order by x under the
 * paragraph direction, not by resolved level. See the Limits section of
 * docs/101.
 */
function orderRunsByPaint(runs: TextRun[], dir: "ltr" | "rtl"): TextRun[] {
  const baselineOf = (r: TextRun): number => r.y + r.ascentPx;
  // Stable sort by baseline first (capture order breaks ties).
  const byBaseline = [...runs].sort((a, b) => baselineOf(a) - baselineOf(b));
  const ordered: TextRun[] = [];
  let line: TextRun[] = [];
  let lineBaseline = 0;
  const flush = (): void => {
    // Stable sort within the line by x (reading order for the paragraph).
    line.sort((a, b) => (dir === "rtl" ? b.x - a.x : a.x - b.x));
    for (const r of line) ordered.push(r);
    line = [];
  };
  for (const r of byBaseline) {
    const bl = baselineOf(r);
    if (line.length === 0) {
      lineBaseline = bl;
    } else if (bl - lineBaseline > 0.6 * r.fontSize) {
      flush();
      lineBaseline = bl;
    }
    line.push(r);
  }
  flush();
  return ordered;
}

/**
 * The vertical-writing twin of {@link orderRunsByPaint}: reading order for a
 * subtree whose runs stack down COLUMNS. The line band becomes a COLUMN band,
 * and the two axes swap roles:
 *
 *  1. Group runs into COLUMNS by their cross-axis center (`x + width / 2`). A
 *     new column starts when a run's center sits more than ~0.6em away from the
 *     current column's — the same relative tolerance the horizontal bander uses
 *     for a baseline, so a slightly narrower styled run stays in its column
 *     while a wrapped column starts a new one.
 *  2. Within a column, order TOP-to-bottom by captured `y` (the flow axis runs
 *     downward in every CSS vertical writing mode).
 *  3. Emit columns in block-flow order: RIGHT-to-left for `vertical-rl` /
 *     `sideways-rl`, left-to-right for `vertical-lr` / `sideways-lr`.
 */
function orderRunsByColumn(runs: TextRun[], mode: string): TextRun[] {
  const rightToLeft = mode === "vertical-rl" || mode === "sideways-rl";
  const centerOf = (r: TextRun): number => r.x + (r.width ?? 0) / 2;
  const byColumn = [...runs].sort((a, b) => (rightToLeft ? centerOf(b) - centerOf(a) : centerOf(a) - centerOf(b)));
  const ordered: TextRun[] = [];
  let column: TextRun[] = [];
  let columnCenter = 0;
  const flush = (): void => {
    column.sort((a, b) => a.y - b.y);
    for (const r of column) ordered.push(r);
    column = [];
  };
  for (const r of byColumn) {
    const c = centerOf(r);
    if (column.length === 0) {
      columnCenter = c;
    } else if (Math.abs(c - columnCenter) > 0.6 * r.fontSize) {
      flush();
      columnCenter = c;
    }
    column.push(r);
  }
  flush();
  return ordered;
}

/**
 * The target's addressable text runs in reading order, gathered across its
 * whole SUBTREE (mixed content — DM-1756). When no descendant element
 * contributes a run, the target's own runs are returned in captured order
 * unchanged (exact single-element / input-value behavior). Otherwise the
 * target's own runs and every descendant's runs are merged and re-ordered by
 * painted geometry — `orderRunsByPaint` for horizontal flow, its column-banding
 * twin `orderRunsByColumn` for vertical.
 *
 * **One writing axis per address.** An address resolves over the runs sharing
 * the TARGET's own writing axis; a descendant with the OPPOSITE axis (a
 * `writing-mode: vertical-rl` block nested in horizontal prose, or vice versa)
 * contributes no runs. Its flow is a different reading order that cannot be
 * interleaved into one offset space — address it with its own target instead.
 */
function elementTextRuns(el: CapturedElement): TextRun[] {
  const own = elementOwnRuns(el);
  const descendant: TextRun[] = [];
  collectDescendantRuns(el, descendant);
  if (descendant.length === 0) return own;
  // The target's axis: its own runs when it has any, else its computed
  // writing-mode (a wrapper element with no text of its own).
  const wantVertical = own.length > 0 ? own[0].vertical != null : isVerticalMode(el.styles.writingMode);
  const axis = [...own, ...descendant].filter((r) => (r.vertical != null) === wantVertical);
  if (axis.length === 0) return own;
  return wantVertical
    ? orderRunsByColumn(axis, axis[0].vertical ?? el.styles.writingMode ?? "vertical-rl")
    : orderRunsByPaint(axis, el.styles.direction === "rtl" ? "rtl" : "ltr");
}

/**
 * Per-code-point painted boxes for a run, with each character's bidi level.
 *
 * Captured `xOffsets` give each character's painted LEFT edge in DOM/LOGICAL
 * order, so a character's RIGHT edge is the left edge of whichever character
 * paints next VISUALLY (and the run's right edge for the visually-last one).
 * Sorting by painted x recovers that neighbor for both directions at once; for a
 * pure-LTR run the visual order IS the logical order, so `right` comes out as
 * `xOffsets[nextCodePoint]` exactly as before.
 *
 * `levels` is the slice of the element-wide bidi embedding levels covering this
 * run (per UTF-16 code unit), or null when the element has no RTL content — in
 * which case every box is left-to-right.
 */
interface CharBox {
  /** UTF-16 index of the code point's first unit within the run. */
  utf16: number;
  /** Painted left edge. */
  left: number;
  /** Painted right edge. */
  right: number;
  /** True when the character resolved to an odd (RTL) bidi embedding level. */
  rtl: boolean;
}

function runCharBoxes(run: TextRun, xs: number[], levels: number[] | null): CharBox[] {
  const boxes: CharBox[] = [];
  let u = 0;
  for (const ch of run.text) {
    boxes.push({ utf16: u, left: xs[u], right: xs[u], rtl: levels != null && (levels[u] ?? 0) % 2 === 1 });
    u += ch.length;
  }
  if (boxes.length === 0) return boxes;
  const rightEdge = runRightEdge(run, xs);
  // Visual order = ascending painted x (stable on ties, so zero-width combining
  // marks stay behind their base and keep a zero-width cell).
  const visual = boxes.map((_, i) => i).sort((a, b) => boxes[a].left - boxes[b].left || a - b);
  for (let k = 0; k < visual.length; k++) {
    const box = boxes[visual[k]];
    const next = k + 1 < visual.length ? boxes[visual[k + 1]].left : rightEdge;
    box.right = next > box.left ? next : box.left;
  }
  return boxes;
}

/**
 * Bidi embedding levels for an element's runs, resolved over the CONCATENATED
 * logical text of every run rather than per run — the whole-paragraph
 * resolution the renderer's paired-bracket mirroring uses (`applyBidiAt` in
 * `src/render/text.ts`), which matters because capture splits a bidi line into
 * visual fragments and soft-wrapped lines into separate segments; resolving a
 * fragment in isolation would misclassify neutrals at its edges.
 *
 * Returns null when no run carries RTL content and the paragraph direction is
 * `ltr` — the signal for callers to take the untouched left-to-right path.
 */
function runBidiLevels(runs: TextRun[]): Array<number[] | null> | null {
  const dir = runs.find((r) => r.dir === "rtl") != null ? "rtl" : "ltr";
  if (dir !== "rtl" && !runs.some((r) => RTL_RE.test(r.text))) return null;
  const full = runs.map((r) => r.text).join("");
  const levels = _bidi.getEmbeddingLevels(full, dir).levels;
  const out: Array<number[] | null> = [];
  let base = 0;
  for (const run of runs) {
    const slice: number[] = [];
    for (let i = 0; i < run.text.length; i++) slice.push(levels[base + i] ?? 0);
    out.push(slice);
    base += run.text.length;
  }
  return out;
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

/**
 * Per-code-unit y offsets for a VERTICAL run — captured when available, else
 * accumulated from the captured `verticalAdvances` (or the font size, the
 * natural upright CJK cell) from the column's top. `yOffsets` is `xOffsets`'
 * along-axis twin: one entry per UTF-16 code unit, viewport-absolute, and a
 * surrogate pair repeats the same y.
 */
function runYOffsets(run: TextRun): number[] {
  if (run.yOffsets != null && run.yOffsets.length >= run.text.length) return run.yOffsets;
  const ys: number[] = [];
  let y = run.y;
  let u = 0;
  for (const ch of run.text) {
    for (let k = 0; k < ch.length; k++) ys.push(y);
    y += run.verticalAdvances?.[u] ?? run.fontSize;
    u += ch.length;
  }
  return ys;
}

/** The vertical run's BOTTOM edge — the captured column length when present,
 *  else the last character's y + its advance. The end-of-text caret parks here,
 *  matching Chromium's own collapsed-range y past the final character. */
function runBottomEdge(run: TextRun, ys: number[]): number {
  if (run.columnLength != null && run.columnLength > 0) return run.y + run.columnLength;
  if (run.text.length === 0) return run.y;
  const chars = [...run.text];
  const lastU = run.text.length - chars[chars.length - 1].length;
  return ys[lastU] + (run.verticalAdvances?.[lastU] ?? run.fontSize);
}

/**
 * Per-code-point cells for a VERTICAL run: each character's `top` / `bottom`
 * along the column. The flow axis runs downward in every CSS vertical writing
 * mode, so captured order IS painted order and a cell's bottom is simply the
 * next character's top (the column's bottom edge for the last one). No bidi
 * reordering applies along the column — a bidi run inside vertical text
 * reorders WITHIN its rotated line box, which capture flattens into these same
 * downward offsets (see the Limits section of docs/101).
 */
interface VerticalCell {
  utf16: number;
  top: number;
  bottom: number;
}

function runVerticalCells(run: TextRun, ys: number[]): VerticalCell[] {
  const cells: VerticalCell[] = [];
  let u = 0;
  for (const ch of run.text) {
    cells.push({ utf16: u, top: ys[u], bottom: 0 });
    u += ch.length;
  }
  const bottomEdge = runBottomEdge(run, ys);
  for (let i = 0; i < cells.length; i++) {
    const next = i + 1 < cells.length ? cells[i + 1].top : bottomEdge;
    cells[i].bottom = next > cells[i].top ? next : cells[i].top;
  }
  return cells;
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
 *
 * **Bidi.** Inside an RTL level run the caret sits on the addressed
 * character's RIGHT edge (`rtl: true` on the result, with the insertion cell
 * extending left from it); at end-of-text it sits on the last character's
 * trailing edge, which is its LEFT edge when that character is RTL. Chromium
 * agrees exactly at every position except the two-sided ones — an offset that
 * falls exactly ON a bidi level-run boundary has two legitimate visual caret
 * positions and the one shown depends on caret affinity (Blink implements the
 * choice in `third_party/blink/renderer/core/editing/bidi_adjustment.cc`). This
 * engine always takes the DOWNSTREAM side — the leading edge of the character
 * the offset names — so a `block` / `underscore` caret's cell (and the `invert`
 * option's glyph repaint) always covers the character the address refers to.
 *
 * **Vertical writing.** For a column-stacked run the flow axis is y: `x` is the
 * COLUMN's left edge, `baselineY` the top of the addressed character's cell
 * (`yOffsets[u]` — Chromium's painted y), `cellWidthPx` the cell's extent DOWN
 * the column, and `columnWidthPx` the column's cross extent. `charOffset ===
 * length` parks the caret at the column's bottom edge, which is exactly where
 * Chromium's own collapsed range lands past the final character.
 */
export function resolveCaretPoint(roots: CapturedElement[], target: TextAddressTarget, charOffset: number): CaretPoint | null {
  const el = findAddressedElement(roots, target);
  if (el == null) return null;
  const runs = elementTextRuns(el);
  const loc = locateOffset(runs, charOffset);
  if (loc == null) return null;
  const run = runs[loc.runIndex];
  const atEnd = loc.utf16 >= run.text.length;
  if (run.vertical != null) {
    // Vertical writing: the flow axis is y. Caret x/width come from the COLUMN,
    // the caret's position and cell extent from the column cells.
    const ys = runYOffsets(run);
    const cells = runVerticalCells(run, ys);
    const cell = atEnd ? cells[cells.length - 1] : cells.find((c) => c.utf16 === loc.utf16);
    if (cell == null) return null;
    const alongY = atEnd ? runBottomEdge(run, ys) : cell.top;
    let extent = atEnd ? run.fontSize : cell.bottom - cell.top;
    if (!(extent > 0)) extent = run.fontSize;
    return {
      x: run.x,
      baselineY: alongY,
      ascentPx: run.ascentPx,
      descentPx: run.descentPx,
      fontSize: run.fontSize,
      cellWidthPx: extent,
      vertical: run.vertical,
      columnWidthPx: run.width != null && run.width > 0 ? run.width : run.fontSize,
    };
  }
  const xs = runXOffsets(run);
  const levels = runBidiLevels(runs);
  const spaceAdvance = (): number => fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize).advOf(" ");

  let x: number;
  let cellWidthPx: number;
  let rtl = false;
  if (levels != null) {
    const boxes = runCharBoxes(run, xs, levels[loc.runIndex]);
    // At end-of-text the caret parks after the LAST logical character, on its
    // trailing edge (left for RTL, right for LTR); otherwise it sits on the
    // leading edge of the character the offset names.
    const box = atEnd ? boxes[boxes.length - 1] : boxes.find((b) => b.utf16 === loc.utf16);
    if (box == null) return null;
    rtl = box.rtl;
    x = atEnd ? (box.rtl ? box.left : box.right) : (box.rtl ? box.right : box.left);
    cellWidthPx = atEnd ? spaceAdvance() : box.right - box.left;
    if (!(cellWidthPx > 0)) {
      const nextU = loc.utf16 + codePointLengthAt(run.text, loc.utf16);
      cellWidthPx = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize).advOf(run.text.slice(loc.utf16, nextU));
    }
  } else {
    x = atEnd ? runRightEdge(run, xs) : xs[loc.utf16];
    // Insertion-cell width: the char at the offset (next-x − x within the run,
    // right edge for the final char); at end-of-text, the space advance — the
    // natural "empty cell" block/underscore carets use (see caret-metrics.ts).
    if (atEnd) {
      cellWidthPx = spaceAdvance();
    } else {
      const chLen = codePointLengthAt(run.text, loc.utf16);
      const nextU = loc.utf16 + chLen;
      cellWidthPx = (nextU < run.text.length ? xs[nextU] : runRightEdge(run, xs)) - x;
      if (!(cellWidthPx > 0)) {
        const { advOf } = fallbackMetrics(run.fontFamily, run.fontWeight, run.fontSize);
        cellWidthPx = advOf(run.text.slice(loc.utf16, nextU));
      }
    }
  }
  return {
    x,
    baselineY: run.y + run.ascentPx,
    ascentPx: run.ascentPx,
    descentPx: run.descentPx,
    fontSize: run.fontSize,
    cellWidthPx,
    ...(rtl ? { rtl: true } : {}),
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
 *
 * **Bidi.** A logical range over mixed-direction text is visually
 * DISCONTIGUOUS, so a covered run additionally splits at every bidi level
 * change: one rect per level run, each carrying its own sweep direction
 * (`rtl` grows right-to-left). Rects stay in LOGICAL order, so the sweep runs in
 * reading order regardless of where the pieces land on screen. This reproduces
 * Chromium's own selection fragmentation — measured against
 * `Range.getClientRects()` on mixed Hebrew/Latin lines in both LTR and RTL
 * paragraphs, the rect boundaries agree exactly.
 *
 * **Vertical writing.** A covered vertical run yields a rect spanning the
 * COLUMN's cross extent and growing DOWN it: `edges` are the successive bottom
 * edges and the emission steps `height` where the horizontal path steps `width`.
 */
export function resolveRangeRects(roots: CapturedElement[], target: TextAddressTarget, charStart: number, charEnd: number): RangeRects | null {
  const el = findAddressedElement(roots, target);
  if (el == null || charEnd <= charStart || charStart < 0) return null;
  const runs = elementTextRuns(el);
  if (runs.length === 0) return null;
  const levels = runBidiLevels(runs);

  const rects: SelectionRectPlan[] = [];
  let cp = 0; // running code-point index across runs
  let covered = 0;
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    if (run.vertical != null) {
      // Vertical writing: one rect per covered column stretch, spanning the
      // column's cross extent and growing DOWN it. `edges` are the successive
      // bottom edges, so the sweep steps `height` the way the horizontal path
      // steps `width`.
      const ys = runYOffsets(run);
      const cells = runVerticalCells(run, ys);
      const colWidth = run.width != null && run.width > 0 ? run.width : run.fontSize;
      let plan: SelectionRectPlan | null = null;
      for (const cell of cells) {
        if (cp >= charStart && cp < charEnd) {
          if (plan == null) {
            plan = { x: run.x, y: cell.top, width: colWidth, height: 0, edges: [], vertical: true };
            rects.push(plan);
          }
          plan.edges.push(cell.bottom);
          plan.height = cell.bottom - plan.y;
          covered++;
        }
        cp++;
      }
      continue;
    }
    const xs = runXOffsets(run);
    // Run top = the font-box top (baseline − ascent); height spans the font box
    // (ascent + descent), matching what Blink highlights.
    const height = Math.round(run.ascentPx + run.descentPx);
    if (levels == null) {
      let utf16 = 0;
      let plan: SelectionRectPlan | null = null;
      for (const ch of run.text) {
        if (cp >= charStart && cp < charEnd) {
          const left = xs[utf16];
          const nextU = utf16 + ch.length;
          const right = nextU < run.text.length ? xs[nextU] : runRightEdge(run, xs);
          if (plan == null) {
            plan = { x: left, y: run.y, height, width: 0, edges: [] };
            rects.push(plan);
          }
          plan.edges.push(right);
          plan.width = right - plan.x;
          covered++;
        }
        cp++;
        utf16 += ch.length;
      }
      continue;
    }
    // Bidi run: break the covered stretch at every level change, so each rect
    // covers one visually-contiguous level run and sweeps in its own direction.
    const boxes = runCharBoxes(run, xs, levels[ri]);
    let plan: SelectionRectPlan | null = null;
    let planRtl = false;
    for (const box of boxes) {
      if (cp >= charStart && cp < charEnd) {
        if (plan == null || planRtl !== box.rtl) {
          plan = { x: box.left, y: run.y, height, width: box.right - box.left, edges: [], ...(box.rtl ? { rtl: true } : {}) };
          planRtl = box.rtl;
          rects.push(plan);
        }
        // The level run is visually contiguous: extend the rect over the box and
        // record the trailing edge the sweep steps to (right for LTR, left for
        // RTL — the sweep grows away from the rect's leading edge).
        const right = Math.max(plan.x + plan.width, box.right);
        const left = Math.min(plan.x, box.left);
        plan.x = left;
        plan.width = right - left;
        plan.edges.push(box.rtl ? box.left : box.right);
        covered++;
      } else if (plan != null) {
        plan = null; // a gap in coverage starts a fresh rect
      }
      cp++;
    }
  }
  if (covered === 0) return null;
  return { rects, charCount: covered };
}
