/**
 * Per-line, order-preserving glyph alignment for the frame-sequence compressor
 * (docs/100, Primitive 1).
 *
 * Given the glyph sequences of the SAME visual line in two adjacent captured
 * states (each glyph = one code point with its captured painted x, resolved
 * fill, and a font-identity style key), produce the identity pairing the
 * compressor threads across states:
 *
 *   - **Order-preserving LCS**, not greedy/multiset matching. The measured
 *     evaluation behind docs/100 showed a greedy matcher mispairing repeated
 *     characters (a `,` matched across the line reads as a comma sliding
 *     through static text); a monotonic alignment cannot cross-pair.
 *   - Match predicate is (char, styleKey) — **fill is deliberately ignored**
 *     and diffed into a recolor flag, because re-tokenization (syntax
 *     colorize-on-completion) destroys element identity while glyph identity
 *     survives byte-exact at the same painted position.
 *   - Among equal-length alignments, exact-position pairs win (a small DP
 *     bonus for |dx| below {@link POSITION_EPSILON_PX}), so the alignment
 *     preserving captured positions is chosen over an equally long one that
 *     would report spurious shifts.
 *   - **Re-emit on any doubt**: after alignment, pairs are broken into
 *     diagonal runs (consecutive in BOTH sequences) and each run into
 *     uniform-shift sub-runs. A sub-run of a single glyph claiming a non-zero
 *     shift is dropped (demoted to unpaired = death + birth) — a lone glyph
 *     moving by itself is either kerning fallout around an edit or a mispair,
 *     and re-emitting it is always pixel-correct. Because every track the
 *     compressor emits is step-end (layout SNAPS at state boundaries), pairing
 *     affects only output size and motion bookkeeping, never rendered pixels —
 *     but the drop rule keeps the identity model honest.
 */

/** One glyph in a line's sequence, in visual (x-ascending) order. */
export interface AlignGlyph {
  /** One Unicode code point. */
  ch: string;
  /** Captured painted left x (viewport px, subpixel). */
  x: number;
  /** Resolved fill (ignored for pairing; diffed into `recolored`). */
  fill: string;
  /** Font-identity key (family|size|weight|style|variants…); glyphs only pair
   *  within the same key — a weight or size change reshapes the glyph, so it
   *  re-emits rather than pairing. */
  styleKey: string;
}

export interface AlignedPair {
  prevIndex: number;
  nextIndex: number;
  /** next.x − prev.x. */
  dx: number;
  /** Fill differs between the paired glyphs (same char, same position class). */
  recolored: boolean;
}

export interface LineAlignment {
  /** Kept pairs, ascending in both indices. */
  pairs: AlignedPair[];
  /** prev indices with no surviving pair (glyph dies at the boundary). */
  unpairedPrev: number[];
  /** next indices with no surviving pair (glyph is born at the boundary). */
  unpairedNext: number[];
}

/** Positions within this tolerance are "the same painted x" (captured xOffsets
 *  are subpixel; measured cross-capture jitter on a static page is 0.00 px, so
 *  this is slack for float formatting, not for layout wobble). */
export const POSITION_EPSILON_PX = 0.11;

/**
 * Align one line's glyphs between two adjacent states. See the module header
 * for the model. O(prev.length × next.length) — lines are short.
 */
export function alignLineGlyphs(prev: AlignGlyph[], next: AlignGlyph[]): LineAlignment {
  const n = prev.length;
  const m = next.length;
  if (n === 0 || m === 0) {
    return {
      pairs: [],
      unpairedPrev: prev.map((_, i) => i),
      unpairedNext: next.map((_, i) => i),
    };
  }

  // DP: maximize pair count; tie-break toward exact-position pairs via a bonus
  // strictly smaller than 1/(pairs possible), so count always dominates.
  const bonus = 1 / (2 * (n + m + 2));
  const width = m + 1;
  const score = new Float64Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const pg = prev[i - 1];
    for (let j = 1; j <= m; j++) {
      const ng = next[j - 1];
      let best = Math.max(score[(i - 1) * width + j], score[i * width + (j - 1)]);
      if (pg.ch === ng.ch && pg.styleKey === ng.styleKey) {
        const w = 1 + (Math.abs(ng.x - pg.x) <= POSITION_EPSILON_PX ? bonus : 0);
        const diag = score[(i - 1) * width + (j - 1)] + w;
        if (diag > best) best = diag;
      }
      score[i * width + j] = best;
    }
  }

  // Backtrack (prefer diagonal when it achieves the cell's score).
  const raw: AlignedPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const cur = score[i * width + j];
    const pg = prev[i - 1];
    const ng = next[j - 1];
    if (pg.ch === ng.ch && pg.styleKey === ng.styleKey) {
      const w = 1 + (Math.abs(ng.x - pg.x) <= POSITION_EPSILON_PX ? bonus : 0);
      if (Math.abs(score[(i - 1) * width + (j - 1)] + w - cur) < 1e-9) {
        raw.push({ prevIndex: i - 1, nextIndex: j - 1, dx: ng.x - pg.x, recolored: pg.fill !== ng.fill });
        i--;
        j--;
        continue;
      }
    }
    if (score[(i - 1) * width + j] >= score[i * width + (j - 1)]) i--;
    else j--;
  }
  raw.reverse();

  // Post-filter: diagonal runs → uniform-dx sub-runs → drop lone non-zero
  // shifts (re-emit on doubt).
  const kept: AlignedPair[] = [];
  let runStart = 0;
  const flushDiagonal = (start: number, end: number): void => {
    // [start, end) is one diagonal run; split into uniform-dx sub-runs.
    let subStart = start;
    for (let k = start + 1; k <= end; k++) {
      const boundary = k === end || Math.abs(raw[k].dx - raw[subStart].dx) > POSITION_EPSILON_PX;
      if (!boundary) continue;
      const len = k - subStart;
      const dx = raw[subStart].dx;
      if (len > 1 || Math.abs(dx) <= POSITION_EPSILON_PX) {
        for (let p = subStart; p < k; p++) kept.push(raw[p]);
      }
      subStart = k;
    }
  };
  for (let k = 1; k <= raw.length; k++) {
    const diagonalBreak =
      k === raw.length ||
      raw[k].prevIndex !== raw[k - 1].prevIndex + 1 ||
      raw[k].nextIndex !== raw[k - 1].nextIndex + 1;
    if (diagonalBreak) {
      flushDiagonal(runStart, k);
      runStart = k;
    }
  }

  const pairedPrev = new Set(kept.map((p) => p.prevIndex));
  const pairedNext = new Set(kept.map((p) => p.nextIndex));
  return {
    pairs: kept,
    unpairedPrev: prev.map((_, idx) => idx).filter((idx) => !pairedPrev.has(idx)),
    unpairedNext: next.map((_, idx) => idx).filter((idx) => !pairedNext.has(idx)),
  };
}
