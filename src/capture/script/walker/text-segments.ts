// @ts-nocheck
//
// Text-node walker: builds the per-line `textSegments` array from the host
// element's child text nodes by walking each character's
// `Range.getBoundingClientRect()` and grouping runs with matching
// `rect.top` into separate segments. The output drives the renderer's
// per-line `<text>` / path emission and carries enough metadata to
// reconstruct Chrome's painted layout pixel-faithfully.
//
// Pipeline per text node:
//
//   1. **`text-transform`**: Chrome paints transformed glyphs at the
//      transformed advance, so we mirror `uppercase` / `lowercase` /
//      `capitalize` on `node.textContent` before measuring — otherwise
//      our captured `text` and the rect positions would disagree.
//      `capitalize` uses an ASCII word-boundary heuristic.
//
//   2. **Per-character Range rects**: walk one code point at a time
//      (surrogate-pair-aware so a supplementary-plane emoji gets one
//      rect, not two tofu rects). Skip whitespace chars Chrome collapsed
//      away (`rect.width === 0`) but keep zero-width combining marks
//      like the acute on `é` — they pair with the preceding base.
//
//   3. **Line grouping**: chars with the same `rect.top` (±1px) merge
//      into one line.
//
//   4. **BiDi visual-fragment splitting** (DM-323): when a DOM text node
//      lands inside a `dir=rtl` paragraph Chrome can split it into
//      visually-separate chunks — most commonly trailing punctuation
//      reorders to the visual-left while the rest paints on the visual-
//      right. We detect xOffset discontinuities >80px between
//      consecutive chars and split the line, so each fragment renders
//      at its own anchor. Without this `min(xOffsets)` for the whole
//      line would collapse the rightmost run onto the leftmost char's x
//      and the chars would overlap.
//
//   5. **Logical-order preservation**: chars stay in DOM/logical order
//      (which equals visual order for LTR, but not for RTL). The
//      renderer uses per-char anchoring to place each shaped glyph at
//      its captured `xOffset`. Keeping logical order lets bidi-js's
//      paired-bracket mirroring find matching pairs (BD16 needs to see
//      openers before closers).
//
//   6. **`rasterGlyphs`** (SK-1090): emoji / color-bitmap codepoints
//      mid-run are recorded with their viewport-relative rects so
//      `rasterizeBitmapGlyphs` can fill in `dataUri` post-capture and
//      the renderer can stamp an `<image>` over the char's `xOffset`.
//      `charIndex` is a UTF-16 position so `text.codePointAt(charIndex)`
//      resolves correctly for surrogate-paired emoji.
//
//   7. **`::first-letter` styling** (SK-1114 + DM-439): when the pseudo
//      sets a different font-size than the host (drop-cap pattern),
//      flag the first visible char as a rasterGlyph with
//      `suppressGlyph: true` so only the rasterized big letter paints —
//      the path glyph is suppressed.
//
//   8. **`::first-line` overrides** (DM-294): the first visual line can
//      carry pseudo-overridden font-variant / color / font-weight /
//      font-style / font-size. Chrome's `getComputedStyle(el,
//      '::first-line')` resolves these for us — when they differ from
//      the element's base, attach the overrides to `textSegments[0]`
//      so the renderer applies them only there. Letter-spacing already
//      comes through the captured `xOffsets`.
//
//   9. **Bounds**: track `min/max` of all char rects and return them as
//      `textLeft / textTop / textWidth / textHeight` (viewport-relative)
//      plus `fontAscent / fontDescent` from `measureFontMetrics(cs)`.
//      `text` returns trimmed (the per-node concatenation appends a
//      trailing space).
//
// Returns `applied: false` when the element has no usable text nodes
// (all whitespace / no rects). captureInner reads `applied` to decide
// whether to keep the rect-based defaults its text-shaping locals were
// initialised with.

// `elementRaster`: textarea soft-wrap and writing-mode != horizontal-tb
// both fall outside our path-mode rendering contract. Rather than
// reimplement Chrome's word-wrap (font metrics + kerning + break
// opportunities + CSS wrap=hard/soft) or vertical-text rotation, stamp
// the element's painted pixels by screenshotting its content box (minus
// border + padding). Scoped to textareas with a non-empty value (so
// short / empty ones keep the cleaner path pipeline — SK-1108) and to
// any element with `writing-mode != horizontal-tb` that carries text
// content (SK-1128).
//
// Returns the content-box rect viewport-relative or `undefined` when
// the host doesn't qualify.

export const computeElementRaster = (el, cs, tag, rect, vp) => {
  // DM-991: `<textarea>` content path now uses native SVG; DM-990:
  // vertical writing-mode path now uses native SVG too. The element-
  // raster path no longer triggers for any captured case — kept as a
  // stub returning `undefined` so the call site in script/index.ts
  // compiles unchanged. If a future CSS feature surfaces that requires
  // screenshotting an element wholesale, restore the rect-math here.
  void el; void cs; void tag; void rect; void vp;
  return undefined;
};

// DM-747 / DM-791: map a single Latin/Greek token char to its Mathematical
// Italic alphabet codepoint (MathML 4 mathvariant=italic). Chrome paints a
// single-token `<mi>` with these (`<mi>a</mi>` → U+1D44E 𝑎); the computed
// `font-style` stays `normal` and `font-family` stays `math`, so we can't detect
// it through CSS and apply the mapping ourselves at capture time. Pure codepoint
// math + the alternate-Greek-symbol tail. Hoisted to module scope from inside
// createTextSegmentsHandler (DM-1087) — it closes over nothing.
const mathItalicChar = (ch) => {
  const code = ch.codePointAt(0);
  if (code == null) return ch;
  // Latin Mathematical Italic Capital A..Z = U+1D434..U+1D44D.
  if (code >= 0x41 && code <= 0x5A) return String.fromCodePoint(0x1D434 + (code - 0x41));
  // Latin Mathematical Italic Small a..z = U+1D44E..U+1D467, except
  // U+1D455 ("h") is reserved — Chrome paints U+210E (ℎ, PLANCK CONSTANT).
  if (code >= 0x61 && code <= 0x7A) {
    if (code === 0x68) return 'ℎ';
    return String.fromCodePoint(0x1D44E + (code - 0x61));
  }
  // Greek Mathematical Italic Capital Α..Ω = U+1D6E2..U+1D6FA.
  if (code >= 0x0391 && code <= 0x03A9) return String.fromCodePoint(0x1D6E2 + (code - 0x0391));
  // Greek Mathematical Italic Small α..ω = U+1D6FC..U+1D71B.
  if (code >= 0x03B1 && code <= 0x03C9) return String.fromCodePoint(0x1D6FC + (code - 0x03B1));
  // Greek symbol variants — alternate forms get their own italic codepoints at
  // the tail of the lowercase Greek block.
  switch (code) {
    case 0x2202: return String.fromCodePoint(0x1D715); // ∂ → italic partial differential
    case 0x03F5: return String.fromCodePoint(0x1D716); // ϵ (lunate) → italic epsilon symbol
    case 0x03D1: return String.fromCodePoint(0x1D717); // ϑ (theta sym) → italic theta symbol
    case 0x03F0: return String.fromCodePoint(0x1D718); // ϰ (kappa sym) → italic kappa symbol
    case 0x03D5: return String.fromCodePoint(0x1D719); // ϕ (phi sym) → italic phi symbol
    case 0x03F1: return String.fromCodePoint(0x1D71A); // ϱ (rho sym) → italic rho symbol
    case 0x03D6: return String.fromCodePoint(0x1D71B); // ϖ (pi sym) → italic pi symbol
    case 0x2207: return String.fromCodePoint(0x1D6FB); // ∇ (nabla) → italic nabla (upper-block tail)
    default: return ch;
  }
};

export const createTextSegmentsHandler = ({ vp, measureFontMetrics, needsRaster, normColor }) => {
  // DM-990: Unicode `Vertical_Orientation` property (UAX #50) for
  // `text-orientation: mixed`. Hardcoded table covering the codepoint
  // ranges that paint upright in vertical text: CJK ideographs, CJK
  // symbols/punctuation, kana, Hangul, fullwidth/halfwidth forms,
  // bopomofo, lisu, hexagrams, mahjong/domino tiles, vertical-form
  // punctuation, vertical-presentation forms. Everything else (Latin,
  // Greek, Cyrillic, Arabic, Hebrew, common ASCII punctuation, …)
  // defaults to ROTATED in vertical text. Derived from the UAX #50
  // VerticalOrientation.txt table (Unicode 16, 2024).
  const UPRIGHT_RANGES = [
    [0x1100, 0x11FF],   // Hangul Jamo
    [0x2E80, 0x2EFF],   // CJK Radicals Supplement
    [0x2F00, 0x2FDF],   // Kangxi Radicals
    [0x2FF0, 0x2FFF],   // Ideographic Description Characters
    [0x3000, 0x303E],   // CJK Symbols and Punctuation (mostly upright; some exceptions)
    [0x3041, 0x309F],   // Hiragana
    [0x30A0, 0x30FF],   // Katakana
    [0x3100, 0x312F],   // Bopomofo
    [0x3130, 0x318F],   // Hangul Compatibility Jamo
    [0x3190, 0x319F],   // Kanbun
    [0x31A0, 0x31BF],   // Bopomofo Extended
    [0x31C0, 0x31EF],   // CJK Strokes
    [0x31F0, 0x31FF],   // Katakana Phonetic Extensions
    [0x3200, 0x32FF],   // Enclosed CJK Letters and Months
    [0x3300, 0x33FF],   // CJK Compatibility
    [0x3400, 0x4DBF],   // CJK Unified Ideographs Extension A
    [0x4E00, 0x9FFF],   // CJK Unified Ideographs
    [0xA000, 0xA48F],   // Yi Syllables
    [0xA490, 0xA4CF],   // Yi Radicals
    [0xA960, 0xA97F],   // Hangul Jamo Extended-A
    [0xAC00, 0xD7AF],   // Hangul Syllables
    [0xD7B0, 0xD7FF],   // Hangul Jamo Extended-B
    [0xF900, 0xFAFF],   // CJK Compatibility Ideographs
    [0xFE30, 0xFE4F],   // CJK Compatibility Forms
    [0xFF00, 0xFFEF],   // Halfwidth and Fullwidth Forms (mostly upright, ASCII range is per-glyph but treat as upright for fixture coverage)
    [0x1B000, 0x1B0FF], // Kana Supplement
    [0x1B100, 0x1B12F], // Kana Extended-A
    [0x1B130, 0x1B16F], // Small Kana Extension
    [0x1F200, 0x1F2FF], // Enclosed Ideographic Supplement
    [0x20000, 0x2FFFF], // CJK Extensions B-G (supplementary plane)
  ];
  const isUpright = (cp) => {
    if (cp == null) return false;
    for (const [lo, hi] of UPRIGHT_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
    return false;
  };
  // Resolve per-char orientation given the parent's text-orientation
  // computed value. Per CSS Writing Modes 3:
  //   - upright  → all chars upright
  //   - mixed    → use UAX #50 (upright for CJK / kana / Hangul; rotated for others)
  //   - sideways → all chars rotated 90°CW
  const resolveCharOrientation = (ch, textOrientation) => {
    if (textOrientation === 'upright') return 'upright';
    if (textOrientation === 'sideways') return 'rotated';
    const cp = ch.codePointAt(0);
    return isUpright(cp) ? 'upright' : 'rotated';
  };

  // DM-990: vertical writing-mode capture. Returns the same shape as
  // `captureTextSegments` ({applied, text, textSegments, ...}) but each
  // segment represents ONE COLUMN of vertical text (grouped by matching
  // `left` ±1 px, since chars in a vertical column share x). Each
  // segment carries `verticalWritingMode`, `verticalOrientations[]`, and
  // `yOffsets[]` (per char) so the renderer can emit each char at its
  // captured position, wrapping rotated chars in a `<g transform=
  // "rotate(90, …)">`.
  const captureVerticalTextSegments = (el, cs) => {
    const wm = cs.writingMode;
    const textOrientation = cs.textOrientation || 'mixed';
    // Sideways-* modes are equivalent to text-orientation: sideways
    // applied on top of vertical-lr / vertical-rl. Per CSS Writing
    // Modes 4 (and what Chrome paints), `sideways-rl` paints chars
    // rotated 90° CW with columns flowing right-to-left, exactly like
    // `vertical-rl` + `text-orientation: sideways`.
    const isSideways = wm === 'sideways-rl' || wm === 'sideways-lr';
    const effectiveTextOrientation = isSideways ? 'sideways' : textOrientation;
    const textSegments = [];
    let text = '';
    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;
    // Canvas-probed natural width per char, used by the renderer to
    // center upright glyphs in their column (DM-996). For rotated chars
    // the natural width equals the captured `verticalAdvance` (=
    // Range.height post-rotation) so we don't need a separate probe;
    // for upright chars Range.height ≈ font-size doesn't tell us the
    // glyph's actual horizontal advance, so we probe via canvas.
    const _vertCanvas = document.createElement('canvas');
    const _vertCtx = _vertCanvas.getContext('2d');
    _vertCtx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '400'} ${cs.fontSize} ${cs.fontFamily}`;
    const measureNaturalWidth = (ch) => _vertCtx.measureText(ch).width;
    const allChars = []; // {ch, x, y, w, h, naturalW} viewport-page coords (NOT yet vp-adjusted)
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      let raw = node.textContent || '';
      const tt = cs.textTransform;
      if (tt === 'uppercase') raw = raw.toUpperCase();
      else if (tt === 'lowercase') raw = raw.toLowerCase();
      else if (tt === 'capitalize') raw = raw.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
      if (!raw.trim()) continue;
      text += raw.trim() + ' ';
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF && i + 1 < raw.length;
        const step = isHighSurrogate ? 2 : 1;
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + step);
        const cr = r.getBoundingClientRect();
        const ch = raw.slice(i, i + step);
        const isWs = step === 1 && /\s/.test(raw[i]);
        // Skip whitespace with zero bbox (collapsed whitespace).
        if (cr.height === 0 && (cr.width === 0 || isWs)) { i += step - 1; continue; }
        allChars.push({ ch, x: cr.left, y: cr.top, w: cr.width, h: cr.height, naturalW: measureNaturalWidth(ch) });
        i += step - 1;
      }
    }
    if (allChars.length === 0) {
      return { applied: true, text: text.trim(), textSegments };
    }
    // DM-1032: tate-chu-yoko (`text-combine-upright`). When the element
    // combines its run upright-and-horizontal into one ~1em cell, the chars
    // share a column Y but spread along X (different `x`), so the column
    // grouping below would split "31" into two single-char columns and rotate
    // each. Detect the combine here and emit ONE combined segment instead,
    // anchoring each glyph at its CAPTURED per-char x (Chrome's painted
    // positions, including any sub-1em condensing). `all` combines the whole
    // run; `digits[ N]` only combines when the run is entirely ASCII digits
    // (the common authored case — a span wrapping just the digits) — a mixed
    // `digits` run with non-digit chars falls through to normal column flow.
    const tcu = cs.textCombineUpright || cs.webkitTextCombine || '';
    const isCombineAll = tcu === 'all';
    const allDigits = allChars.every((c) => c.ch.length === 1 && c.ch >= '0' && c.ch <= '9');
    const isCombineDigits = (tcu.indexOf('digits') === 0) && allDigits;
    if (isCombineAll || isCombineDigits) {
      const metricsC = measureFontMetrics(cs);
      // Shared cell top/height (all combined chars sit in one column cell), and
      // the horizontal span of the combined glyphs (Chrome's painted extent).
      let cellTop = Infinity, cellBot = -Infinity, minX = Infinity, maxX = -Infinity;
      for (const c of allChars) {
        cellTop = Math.min(cellTop, c.y);
        cellBot = Math.max(cellBot, c.y + c.h);
        minX = Math.min(minX, c.x);
        maxX = Math.max(maxX, c.x + c.w);
      }
      const combinedText = allChars.map((c) => c.ch).join('').replace(/[\t\n\r]/g, ' ');
      const xOffsets = allChars.map((c) => c.x - minX);
      textSegments.push({
        text: combinedText,
        x: minX - vp.x,
        y: cellTop - vp.y,
        width: maxX - minX,
        height: cellBot - cellTop,
        verticalWritingMode: wm,
        verticalCombineUpright: true,
        verticalCombineXOffsets: xOffsets,
      });
      return {
        applied: true,
        text: combinedText,
        textSegments,
        textLeft: minX - vp.x,
        textTop: cellTop - vp.y,
        textWidth: maxX - minX,
        textHeight: cellBot - cellTop,
        fontAscent: metricsC.ascent,
        fontDescent: metricsC.descent,
      };
    }
    // Group chars by COLUMN — matching `x` ±1 px. Within each column,
    // chars stack top-to-bottom in increasing `y` (their natural source
    // order, since Range follows DOM order).
    const columns = [];
    let curCol = null;
    for (const c of allChars) {
      if (curCol == null || Math.abs(c.x - curCol.x) > 1) {
        if (curCol != null) columns.push(curCol);
        curCol = { x: c.x, width: c.w, chars: [c] };
      } else {
        curCol.chars.push(c);
      }
    }
    if (curCol != null) columns.push(curCol);
    // Emit one segment per column.
    const metrics = measureFontMetrics(cs);
    for (const col of columns) {
      const colTop = col.chars[0].y;
      const colBot = col.chars[col.chars.length - 1].y + col.chars[col.chars.length - 1].h;
      const visualText = col.chars.map((c) => c.ch).join('').replace(/[\t\n\r]/g, ' ');
      if (visualText.replace(/\s/g, '') === '') continue;
      const yOffsets = [];
      const verticalOrientations = [];
      const verticalAdvances = [];
      const verticalNaturalWidths = [];
      for (const c of col.chars) {
        for (let k = 0; k < c.ch.length; k++) {
          yOffsets.push(c.y - vp.y);
          verticalOrientations.push(resolveCharOrientation(c.ch, effectiveTextOrientation));
          verticalAdvances.push(c.h);
          verticalNaturalWidths.push(c.naturalW);
        }
      }
      textSegments.push({
        text: visualText,
        x: col.x - vp.x,
        y: colTop - vp.y,
        width: col.width,
        height: colBot - colTop,
        verticalWritingMode: wm,
        verticalOrientations,
        yOffsets,
        verticalAdvances,
        verticalNaturalWidths,
      });
      minLeft = Math.min(minLeft, col.x);
      minTop = Math.min(minTop, colTop);
      maxRight = Math.max(maxRight, col.x + col.width);
      maxBottom = Math.max(maxBottom, colBot);
    }
    return {
      applied: true,
      text: text.trim(),
      textSegments,
      textLeft: minLeft - vp.x,
      textTop: minTop - vp.y,
      textWidth: maxRight - minLeft,
      textHeight: maxBottom - minTop,
      fontAscent: metrics.ascent,
      fontDescent: metrics.descent,
    };
  };

  // DM-989: build the styled ::first-letter TextSegment from the chars selected
  // during the per-character loop (firstLetterChars) — pseudo font / color /
  // pseudoBox, with `initial-letter` cap-height equalisation when present.
  // Returns the segment plus its bounding box; the caller unshifts the segment,
  // sets the emit flag, and folds the box into the host's text envelope. Closes
  // over the factory's vp / measureFontMetrics / normColor. From captureTextSegments (DM-1093).
  const buildFirstLetterSegment = (firstLetterChars, flStyle, hasInitialLetter, el, cs) => {
      const styledText = firstLetterChars.map((c) => c.ch).join('');
      const minL = Math.min(...firstLetterChars.map((c) => c.left));
      const maxR = Math.max(...firstLetterChars.map((c) => c.right));
      const minT = Math.min(...firstLetterChars.map((c) => c.top));
      const maxB = Math.max(...firstLetterChars.map((c) => c.bottom));
      // Per-char xOffsets in viewport-relative coords (one entry per UTF-16
      // unit, matching the convention in the body segments).
      const xoff = [];
      for (const c of firstLetterChars) {
        for (let k = 0; k < c.ch.length; k++) xoff.push(c.left - vp.x);
      }
      // Measure pseudo font ascent so the renderer baselines the glyph
      // inside the styled segment correctly (`fontBoundingBoxAscent`
      // mirrors the canvas measurement the regular-text path uses).
      const flMetrics = measureFontMetrics(flStyle);
      // DM-989: `initial-letter: N [M]` cap-height equalisation. Chrome
      // internally scales the first-letter glyph to a larger font-size
      // than `getComputedStyle().fontSize` reports — per Blink's
      // `initial_letter_utils.cc::ComputeInitialLetterBoxBlockOffset`, the
      // glyph is sized so its cap-height equals N × the parent's
      // line-height. The naive theoretical formula `effectiveFs =
      // (N × parentLineHeight) / capHeightRatio(font)` overshoots Chrome
      // empirically (gave 202 px for drop-5 where Chrome paints ~171 px);
      // probably Chrome's internal cap-height target uses (N-1)*line-height
      // + body-line-height-leading or similar nuance buried in the layout
      // code. Side-step the formula and derive `effectiveFs` from Chrome's
      // *computed pseudo width* — `flStyle.width` is the content-box width
      // Chrome already sized the pseudo to, which equals the glyph's
      // painted extent. Probe the chars' natural width at 100 px via
      // canvas, scale: `effectiveFs = 100 × paintedGlyphWidth /
      // naturalWidthAt100`. Same approach for `effectiveAscent` — read
      // `fontBoundingBoxAscent` from the probe-rendered font and scale.
      let effectiveFs = parseFloat(flStyle.fontSize) || undefined;
      let effectiveAscent = flMetrics.ascent;
      let styledSegY = minT - vp.y;
      if (hasInitialLetter) {
        const probeCanvas = document.createElement('canvas');
        const probeCtx = probeCanvas.getContext('2d');
        probeCtx.font = `${flStyle.fontStyle || 'normal'} ${flStyle.fontWeight || '400'} 100px ${flStyle.fontFamily || 'serif'}`;
        const probeM = probeCtx.measureText(styledText);
        const naturalWidthAt100 = probeM.width;
        const ascentRatio = probeM.fontBoundingBoxAscent / 100;
        const padLForGlyph = parseFloat(flStyle.paddingLeft) || 0;
        const padRForGlyph = parseFloat(flStyle.paddingRight) || 0;
        const pseudoComputedW = parseFloat(flStyle.width);
        if (Number.isFinite(pseudoComputedW) && pseudoComputedW > 0 && naturalWidthAt100 > 0) {
          // `flStyle.width` is the pseudo's content-box width Chrome sized
          // the float to. Subtract padding to get the glyph's painted
          // extent (`paddingRight` for `:left`-float, `paddingLeft` for
          // `:right`-float — both sides for safety).
          void padLForGlyph; void padRForGlyph;
          const paintedGlyphW = pseudoComputedW;
          effectiveFs = 100 * paintedGlyphW / naturalWidthAt100;
          // DM-1120: for a floated drop cap with an explicit content-box HEIGHT
          // (Chrome sized the float box to the glyph's ink), size the glyph so
          // its INK fills that height. The width-derived size undersizes here
          // because the in-page canvas's Playfair metrics don't match the
          // renderer's font (canvas B-width ratio ≈0.62 vs the painted ≈0.54),
          // so the width quotient comes out ~15% small and the B doesn't fill
          // the box vertically. The glyph's own ink height (actualBoundingBox
          // ascent+descent) is the metric that maps to the captured content
          // height. Falls back to the width size when there's no usable height.
          const flFloatForSize = flStyle.float || flStyle.cssFloat || '';
          const pseudoComputedH = parseFloat(flStyle.height);
          const glyphInkH100 = (probeM.actualBoundingBoxAscent || 0) + (probeM.actualBoundingBoxDescent || 0);
          if ((flFloatForSize === 'left' || flFloatForSize === 'right')
              && Number.isFinite(pseudoComputedH) && pseudoComputedH > 0 && glyphInkH100 > 0) {
            effectiveFs = 100 * pseudoComputedH / glyphInkH100;
          }
          effectiveAscent = effectiveFs * ascentRatio;
          // Position the segment so the rendered baseline matches Chrome's
          // painted baseline. Chrome paints the first-letter with its
          // cap-top aligned to line-1's cap-top — i.e. the cap-top sits
          // at `minT` (Range.top of the painted glyph as captured here).
          // Use the H-probe cap-height ratio to derive baseline from
          // cap-top, then seg.y from baseline - effectiveAscent so the
          // renderer's `seg.y + segAscent = baseline` arithmetic
          // reconstructs the right paint position.
          const hM = probeCtx.measureText('H');
          const capHeightRatio = hM.actualBoundingBoxAscent / 100;
          if (capHeightRatio > 0) {
            const effectiveCapHeight = effectiveFs * capHeightRatio;
            const baseline = minT + effectiveCapHeight;
            styledSegY = baseline - effectiveAscent - vp.y;
          }
        }
      }
      // Compute the pseudo's painted padding-box. Reuses the rect-math
      // that the prior raster overlay used (DM-823 padding expansion for
      // non-floated; DM-931 paragraph-anchored origin for floats / drop
      // caps with `initial-letter: N`). The styled segment paints its
      // text in front; the renderer paints the pseudoBox (background +
      // border + border-radius) behind.
      const flFloat = flStyle.float || flStyle.cssFloat || '';
      const padT = parseFloat(flStyle.paddingTop) || 0;
      const padR = parseFloat(flStyle.paddingRight) || 0;
      const padB = parseFloat(flStyle.paddingBottom) || 0;
      const padL = parseFloat(flStyle.paddingLeft) || 0;
      let pboxL, pboxT, pboxW, pboxH;
      if (flFloat === 'left' || flFloat === 'right') {
        const pBox = el.getBoundingClientRect();
        const pPadT = parseFloat(cs.paddingTop) || 0;
        const pPadL = parseFloat(cs.paddingLeft) || 0;
        const pPadR = parseFloat(cs.paddingRight) || 0;
        const pBorT = parseFloat(cs.borderTopWidth) || 0;
        const pBorL = parseFloat(cs.borderLeftWidth) || 0;
        const pBorR = parseFloat(cs.borderRightWidth) || 0;
        const flMarT = parseFloat(flStyle.marginTop) || 0;
        const flMarL = parseFloat(flStyle.marginLeft) || 0;
        const flMarR = parseFloat(flStyle.marginRight) || 0;
        const cw = parseFloat(flStyle.width);
        const ch_ = parseFloat(flStyle.height);
        pboxW = (Number.isFinite(cw) && cw > 0 ? cw : (maxR - minL)) + padL + padR;
        pboxH = (Number.isFinite(ch_) && ch_ > 0 ? ch_ : (maxB - minT)) + padT + padB;
        pboxT = pBox.y + pBorT + pPadT + flMarT - vp.y;
        pboxL = (flFloat === 'left')
          ? pBox.x + pBorL + pPadL + flMarL - vp.x
          : pBox.x + pBox.width - pBorR - pPadR - flMarR - pboxW - vp.x;
      } else {
        pboxL = minL - vp.x - padL;
        pboxT = minT - vp.y - padT;
        pboxW = (maxR - minL) + padL + padR;
        pboxH = (maxB - minT) + padT + padB;
      }
      // DM-1120: for a FLOATED `initial-letter` drop cap inside a background
      // box, Chrome paints the glyph's INK to exactly fill the *content* box
      // (measured on the `.drop-fancy` B: cap-top = content-top, baseline =
      // content-bottom, and horizontally centered — all gaps ≈0). The earlier
      // `minT + Hcap-height` placement put the baseline ~22px too high (it keyed
      // off the padding-box top and the H cap-ratio, not the glyph's own ink in
      // its content box) and left the glyph ~6px too far left. Position the
      // styled segment straight from the captured content box instead: baseline
      // at the content-box bottom (a drop cap is a capital → ink-bottom =
      // baseline), and the glyph centered in the content box. The width-derived
      // `effectiveFs` already sizes the ink to the content box. The pixel probe
      // is skipped here — the content box IS the painted ink box, so there's
      // nothing left to refine and the probe's cap-height heuristic would
      // re-introduce the error.
      let flGlyphX = minL - vp.x;
      let flSkipProbe = false;
      const flIsFloat = flFloat === 'left' || flFloat === 'right';
      if (hasInitialLetter && effectiveFs != null && flIsFloat) {
        const contentBottom = pboxT + pboxH - padB;        // vp-relative
        styledSegY = contentBottom - effectiveAscent;
        const contentLeft = pboxL + padL;
        const contentW = pboxW - padL - padR;
        const glyphW = maxR - minL;
        flGlyphX = contentLeft + (contentW - glyphW) / 2;
        flSkipProbe = true;
      }
      // Borders — per-side widths + colors, with uniform shorthand when
      // all four sides match (same convention as pseudo-content.ts).
      const bwT = parseFloat(flStyle.borderTopWidth) || 0;
      const bwR_ = parseFloat(flStyle.borderRightWidth) || 0;
      const bwB = parseFloat(flStyle.borderBottomWidth) || 0;
      const bwL = parseFloat(flStyle.borderLeftWidth) || 0;
      const uniformBw = bwT > 0 && bwT === bwR_ && bwT === bwB && bwT === bwL;
      const bgRaw = flStyle.backgroundColor;
      const hasBg = bgRaw && bgRaw !== '' && bgRaw !== 'rgba(0, 0, 0, 0)' && bgRaw !== 'transparent';
      const bgImgRaw = flStyle.backgroundImage;
      const hasBgImg = bgImgRaw && bgImgRaw !== '' && bgImgRaw !== 'none';
      const brad = parseFloat(flStyle.borderRadius) || 0;
      const hasAnyBox = hasBg || hasBgImg || brad > 0 || bwT > 0 || bwR_ > 0 || bwB > 0 || bwL > 0;
      const pseudoBox = hasAnyBox ? {
        x: pboxL, y: pboxT, width: pboxW, height: pboxH,
        backgroundColor: hasBg ? normColor(bgRaw) : undefined,
        backgroundImage: hasBgImg ? bgImgRaw : undefined,
        borderRadius: brad > 0 ? brad : undefined,
        borderWidth: uniformBw ? bwT : undefined,
        borderColor: uniformBw ? normColor(flStyle.borderTopColor) : undefined,
        borL: bwL, borR: bwR_, borT: bwT, borB: bwB,
        borderTopColor: !uniformBw && bwT > 0 ? normColor(flStyle.borderTopColor) : undefined,
        borderRightColor: !uniformBw && bwR_ > 0 ? normColor(flStyle.borderRightColor) : undefined,
        borderBottomColor: !uniformBw && bwB > 0 ? normColor(flStyle.borderBottomColor) : undefined,
        borderLeftColor: !uniformBw && bwL > 0 ? normColor(flStyle.borderLeftColor) : undefined,
      } : undefined;
      // `text-shadow` carries from pseudo onto the styled segment when the
      // pseudo's value differs from the host's; the renderer reads
      // `seg.textShadow` and emits the matching SVG `<filter>` or stacked
      // `<text>` siblings (whichever path the regular text renderer uses).
      const flTextShadow = (flStyle.textShadow !== '' && flStyle.textShadow !== 'none' && flStyle.textShadow !== cs.textShadow)
        ? flStyle.textShadow
        : undefined;
      // DM-994 capture-time pixel probe for `initial-letter` cases. The
      // CSS-derived placement (`styledSegY` above) is within ±12 px of
      // Chrome's painted cap-top on the 24-deep-initial-letter fixtures
      // — the residual diff is real fragment-state from Blink's inline
      // layout that doesn't surface in `getComputedStyle`. Tag the
      // styled seg with a probe rect so the Node-side post-pass can
      // pixel-walk Chrome's screenshot to find the actual painted ink
      // top and refine `seg.y` accordingly. Cap-height + ascent travel
      // alongside so the post-pass can solve `seg.y = chromeInkTop −
      // ascent + capHeight` without re-deriving font metrics.
      let initialLetterProbe;
      if (hasInitialLetter && effectiveFs != null) {
        const capHeightForProbe = effectiveFs * 0.6929; // fallback ratio; overridden below when we have ratios
        // Compute the actual cap-height ratio inline so the probe carries
        // the value matching what we used to derive styledSegY above.
        const _probeCanvas2 = document.createElement('canvas');
        const _probeCtx2 = _probeCanvas2.getContext('2d');
        _probeCtx2.font = `${flStyle.fontStyle || 'normal'} ${flStyle.fontWeight || '400'} 100px ${flStyle.fontFamily || 'serif'}`;
        const _hMetrics2 = _probeCtx2.measureText('H');
        const _capRatio = _hMetrics2.actualBoundingBoxAscent / 100;
        const realCapHeight = _capRatio > 0 ? effectiveFs * _capRatio : capHeightForProbe;
        // Probe rect: cover the full Range area plus generous margin for
        // raise cases (cap may overflow well above Range.top) and sink
        // cases (descenders may extend below Range.bottom). The Node
        // post-pass thresholds at > 8 dark pixels per row, which filters
        // out section-header text and body-text wrapping that the rect
        // may also catch.
        // Probe rect margins scale with effectiveFs so smaller drop caps
        // (clustered together like the `T A T` multi-row) don't catch
        // neighboring drop caps' ink — only enough margin to cover the
        // raise overflow above and the sink overflow below for this
        // particular drop cap. Large drop caps (W at 185 px) need more
        // upward margin to catch raised caps; small ones (T multi at
        // 56 px) need tight bounds.
        const upMargin = Math.min(100, Math.max(15, effectiveFs * 0.4));
        const downMargin = Math.min(120, Math.max(20, effectiveFs * 0.5));
        initialLetterProbe = {
          rect: {
            x: minL - vp.x - 5,
            y: minT - vp.y - upMargin,
            width: (maxR - minL) + 10,
            height: (maxB - minT) + upMargin + downMargin,
          },
          capHeight: realCapHeight,
          ascent: effectiveAscent,
        };
      }
      const styledSeg = {
        text: styledText,
        x: flGlyphX,
        y: styledSegY,
        width: maxR - minL,
        height: maxB - minT,
        xOffsets: xoff,
        color: normColor(flStyle.color),
        fontFamily: flStyle.fontFamily,
        fontSize: effectiveFs,
        fontWeight: flStyle.fontWeight !== cs.fontWeight ? flStyle.fontWeight : undefined,
        fontStyle: flStyle.fontStyle !== cs.fontStyle ? flStyle.fontStyle : undefined,
        fontVariant: flStyle.fontVariant !== cs.fontVariant ? flStyle.fontVariant : undefined,
        fontAscent: effectiveAscent,
        textShadow: flTextShadow,
        pseudoBox,
        _initialLetterProbe: flSkipProbe ? undefined : initialLetterProbe,
      };
    return { seg: styledSeg, minL, maxR, minT, maxB };
  };

  const captureTextSegments = (el, cs) => {
    // DM-990: dispatch vertical writing-mode elements to the column-
    // grouping capture path. The horizontal walker below groups chars
    // by `top` which puts every char of a vertical column into a
    // separate "line" — wrong shape entirely for the renderer.
    const wm = cs.writingMode;
    if (wm === 'vertical-rl' || wm === 'vertical-lr' || wm === 'sideways-rl' || wm === 'sideways-lr') {
      return captureVerticalTextSegments(el, cs);
    }
    const textSegments = [];
    let text = '';
    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;

    // ::first-letter detection (SK-1114). Compare the pseudo's computed
    // font-size against the element's own — when they differ the author
    // has styled ::first-letter (drop-cap pattern). DM-989: emit the
    // styled run as its own native-SVG TextSegment carrying the pseudo's
    // font + color + pseudoBox (background / border / border-radius),
    // and suppress the body-text glyphs for the selected chars so the
    // styled segment is the only paint. Previously these chars were
    // routed through the rasterGlyph image-overlay pipeline (DM-439).
    const flStyle = window.getComputedStyle(el, '::first-letter');
    const elFsRaw = parseFloat(cs.fontSize) || 0;
    const flFsRaw = parseFloat(flStyle.fontSize) || 0;
    // `initial-letter: N [M]` (CSS Inline 3) drives Chromium to scale the
    // first-letter glyph internally so its cap-height equals N × the
    // parent's line-height (per Blink's
    // `initial_letter_utils.cc::ComputeInitialLetterBoxBlockOffset`).
    // `getComputedStyle(el, '::first-letter').fontSize` returns the
    // SPECIFIED value (e.g. `4em`), NOT the effective one Chrome paints
    // at. To render the W faithfully we derive the effective font-size at
    // capture time below by reading the font's cap-height ratio from a
    // canvas `measureText('H').actualBoundingBoxAscent` probe (DM-989).
    const flInitialLetterRaw = (flStyle.initialLetter || flStyle.webkitInitialLetter || '').trim();
    const hasInitialLetter = flInitialLetterRaw !== '' && flInitialLetterRaw !== 'normal' && flInitialLetterRaw !== 'auto';
    // Trigger: ANY pseudo-vs-host computed-style delta the path renderer
    // can carry on a TextSegment — font-size, color, font-weight,
    // font-family, font-style, text-shadow, or `initial-letter`. The
    // pre-DM-989 gate was font-size only (the raster pipeline needed a
    // visible size delta to screenshot meaningfully); the native-SVG
    // styled-segment path can express color-only changes too, so widen
    // the trigger to catch `.fl-color`, etc.
    const firstLetterStyled = (
      (flFsRaw > 0 && Math.abs(flFsRaw - elFsRaw) > 0.5) ||
      (flStyle.color !== '' && flStyle.color !== cs.color) ||
      (flStyle.fontWeight !== '' && flStyle.fontWeight !== cs.fontWeight) ||
      (flStyle.fontFamily !== '' && flStyle.fontFamily !== cs.fontFamily) ||
      (flStyle.fontStyle !== '' && flStyle.fontStyle !== cs.fontStyle) ||
      (flStyle.textShadow !== '' && flStyle.textShadow !== 'none' && flStyle.textShadow !== cs.textShadow) ||
      hasInitialLetter
    );
    // Chrome's selection rule (per Blink `first_letter_pseudo_element.cc`
    // and CSS Pseudo-Elements 4): skip leading whitespace, include any
    // leading punctuation (Unicode general-category P*), include ONE
    // letter (or precomposed letter codepoint + following combining
    // marks — \p{M}), then include any trailing punctuation. Probed
    // empirically against Chrome 130 on the html-test fixtures: `"This…`
    // selects `"T`; `'s-Gravenhage` selects `'s`; `Évidemment` and
    // `Ñoño` each select one precomposed codepoint. Digraphs are NOT
    // combined — `Dž` selects only `D` (matches Chrome).
    const isFirstLetterPunct = (ch) => /\p{P}/u.test(ch);
    const isCombiningMark = (ch) => /\p{M}/u.test(ch);
    const selectFirstLetter = (chars) => {
      let i = 0;
      while (i < chars.length && /\s/.test(chars[i].ch)) i++;
      const start = i;
      while (i < chars.length && isFirstLetterPunct(chars[i].ch)) i++;
      if (i < chars.length && !/\s/.test(chars[i].ch) && !isFirstLetterPunct(chars[i].ch)) {
        i++;
        while (i < chars.length && isCombiningMark(chars[i].ch)) i++;
      }
      while (i < chars.length && isFirstLetterPunct(chars[i].ch)) i++;
      return { start, end: i };
    };
    let firstLetterChars = null; // collected cRec records for the styled segment, filled during loop 4 on line 0
    let firstLetterStartIdx = -1;
    let firstLetterEndIdx = -1;
    let didEmitStyledFirstLetter = false;

    // DM-747 / DM-791: MathML `<mi>` with a single token character is
    // automatically painted with the Mathematical Italic alphabet (the
    // mathvariant=italic mapping from MathML 4 / Core). Chrome paints
    // `<mi>a</mi>` using U+1D44E (𝑎), `<mi>α</mi>` using U+1D6FC (𝛼), etc.
    // The computed `font-style` stays `normal` and `font-family` stays
    // `math`, so we can't detect this through CSS — we apply the mapping
    // ourselves at capture time so the downstream text-shaping pipeline
    // picks up the right glyphs from whatever math font the system has.
    const elTag = el.tagName != null ? el.tagName.toLowerCase() : '';
    const _miText = (el.textContent || '').trim();
    const mathItalicizeMi = elTag === 'mi'
      && [..._miText].length === 1
      && /^[a-zA-ZΑ-ΩΆΈΉΊΌΎΏα-ωϐϑϕϖϗϰϱϵ∂∇]$/u.test(_miText);

    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      // text-transform — see header comment.
      let raw = node.textContent || '';
      const tt = cs.textTransform;
      if (tt === 'uppercase') raw = raw.toUpperCase();
      else if (tt === 'lowercase') raw = raw.toLowerCase();
      else if (tt === 'capitalize') raw = raw.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
      if (!raw.trim()) continue;
      // DM-747: when `<mi>` math-italic substitution applies, the element's
      // aggregate `text` field should carry the substituted codepoint too —
      // it's used for aria-label / accessibility and matches the painted
      // glyph. The per-character ranges still measure against the original
      // textContent (see below).
      const rawForText = mathItalicizeMi ? mathItalicChar(raw.trim()) : raw.trim();
      text += rawForText + ' ';

      // Group characters by their laid-out line (matching rect.top).
      const lines = [];
      let cur = null;
      for (let i = 0; i < raw.length; i++) {
        const code = raw.charCodeAt(i);
        const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF && i + 1 < raw.length;
        const step = isHighSurrogate ? 2 : 1;
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + step);
        const cr = r.getBoundingClientRect();
        const isWs = step === 1 && /\s/.test(raw[i]);
        if (cr.width === 0 && (cr.height === 0 || isWs)) { i += step - 1; continue; }
        let ch = raw.slice(i, i + step);
        // DM-747: see `mathItalicizeMi` block above — apply the mathvariant=
        // italic substitution AFTER the Range-based measurement so the Range
        // offsets stay valid against the original textContent (`a`, 1 code
        // unit) while the captured glyph string carries the surrogate-pair
        // math-italic codepoint (`𝑎`, 2 code units) that the downstream
        // shaping pipeline picks up.
        if (mathItalicizeMi) ch = mathItalicChar(ch);
        // DM-942: when a character is the FIRST glyph of a wrapped line
        // immediately after a soft-hyphen or hyphenation break, Chrome's
        // Range.getBoundingClientRect() returns a UNION rect spanning both
        // lines (top = previous line's top, bottom = next line's bottom,
        // height ≈ 2 × normalCharHeight, width ≈ entire wrap region). The
        // glyph itself paints at the START of the next line. If we trust
        // cr.top, the char gets bucketed into the previous line and the
        // wrapped line silently loses its first character. Detect the
        // anomaly (height significantly larger than the current line's
        // chars) and synthesise the correct per-glyph top/left/right from
        // the next char (peek ahead) — or, when no next char exists, use
        // cr.bottom minus a normal char height.
        let topForGroup = cr.top;
        let leftForGroup = cr.left;
        let rightForGroup = cr.right;
        let bottomForGroup = cr.bottom;
        if (cur != null && cur.chars.length > 0) {
          const refH = (cur.bottom - cur.top) || 16;
          if (cr.height > refH * 1.5 && cr.bottom > cur.bottom + refH * 0.5) {
            // Peek ahead one char to get the actual line-2 top/x.
            const peekI = i + step;
            if (peekI < raw.length) {
              const pr = document.createRange();
              pr.setStart(node, peekI);
              pr.setEnd(node, peekI + 1);
              const pcr = pr.getBoundingClientRect();
              if (pcr.height > 0 && pcr.height < refH * 1.5) {
                topForGroup = pcr.top;
                bottomForGroup = pcr.bottom;
                // The first char's left/right are unknown from cr (it's a
                // union spanning both lines). Place it just before the
                // peeked char, with width = (peek.left - cr-leftmost-of-line-2).
                // The peek's left is line 2's second char; estimate this
                // char's right edge at the peek's left, and its left at
                // cr.left (which IS the line-2 leftmost x when the union
                // spans into line 2).
                leftForGroup = cr.left;
                rightForGroup = pcr.left;
              }
            } else {
              // No next char — derive the next-line top from cr.bottom.
              topForGroup = cr.bottom - refH;
            }
          }
        }
        const charRec = { ch, left: leftForGroup, top: topForGroup, right: rightForGroup, bottom: bottomForGroup };
        if (cur == null || Math.abs(topForGroup - cur.top) > 1) {
          if (cur != null) lines.push(cur);
          cur = { chars: [charRec], top: topForGroup, bottom: bottomForGroup, left: leftForGroup, right: rightForGroup };
        } else {
          cur.chars.push(charRec);
          cur.left = Math.min(cur.left, leftForGroup);
          cur.right = Math.max(cur.right, rightForGroup);
          cur.bottom = Math.max(cur.bottom, bottomForGroup);
        }
        i += step - 1;
      }
      if (cur != null) lines.push(cur);

      // BiDi visual-fragment splitting (DM-323).
      const fragmentedLines = [];
      for (const ln of lines) {
        if (ln.chars.length <= 1) { fragmentedLines.push(ln); continue; }
        let frag = { chars: [ln.chars[0]], top: ln.top, bottom: ln.bottom };
        const fragments = [frag];
        for (let ci = 1; ci < ln.chars.length; ci++) {
          const prev = ln.chars[ci - 1];
          const cc = ln.chars[ci];
          const leftJump = cc.left < prev.left - 80;
          const rightJump = cc.left > prev.right + 80;
          if (leftJump || rightJump) {
            frag = { chars: [cc], top: ln.top, bottom: ln.bottom };
            fragments.push(frag);
          } else {
            frag.chars.push(cc);
          }
        }
        for (const f of fragments) {
          let l = Infinity;
          let r = -Infinity;
          for (const c of f.chars) {
            if (c.left < l) l = c.left;
            if (c.right > r) r = c.right;
          }
          f.left = l;
          f.right = r;
          fragmentedLines.push(f);
        }
      }
      lines.length = 0;
      for (const fl of fragmentedLines) lines.push(fl);

      // Build text + xOffsets per line, preserving logical order.
      for (const ln of lines) {
        ln.text = ln.chars.map((c) => c.ch).join('');
        const xo = [];
        for (const c of ln.chars) {
          for (let k = 0; k < c.ch.length; k++) xo.push(c.left);
        }
        ln.xOffsets = xo;
      }

      for (const line of lines) {
        const visualText = line.text.replace(/[\t\n\r]/g, ' ');
        if (visualText.replace(/\s/g, '') === '') continue;
        // ::first-letter selection runs ONLY on the very first non-empty
        // line of the very first text node that produces visible chars.
        // Compute the exclusive end index once; subsequent lines and
        // subsequent text nodes keep `firstLetterEndIdx = -1` so none of
        // their chars get suppressed. `firstLetterChars` doubles as a
        // sentinel — `null` means "not yet computed", `[]` means "computed,
        // possibly empty (no selection)".
        const isFirstStyledLine = firstLetterStyled && firstLetterChars == null;
        if (isFirstStyledLine) {
          const sel = selectFirstLetter(line.chars);
          firstLetterStartIdx = sel.start;
          firstLetterEndIdx = sel.end;
          firstLetterChars = [];
        }
        const rasterGlyphs = [];
        let utf16Idx = 0;
        for (let ci = 0; ci < line.chars.length; ci++) {
          const cRec = line.chars[ci];
          const cp = cRec.ch.codePointAt(0);
          const nextCh = ci + 1 < line.chars.length ? line.chars[ci + 1].ch : '';
          const nextCp = nextCh ? nextCh.codePointAt(0) : 0;
          const isFirstLetterChar = isFirstStyledLine && ci >= firstLetterStartIdx && ci < firstLetterEndIdx;
          if (isFirstLetterChar) {
            // DM-989: capture the char's per-char rect for later segment
            // build, AND emit a zero-rect rasterGlyph entry purely to
            // suppress the body-text glyph at this charIndex (so the body
            // pipeline doesn't double-paint underneath the styled segment).
            // `capture/emoji.ts::rasterizeBitmapGlyphs` skips entries with
            // zero-area rects so no screenshot is taken.
            firstLetterChars.push(cRec);
            rasterGlyphs.push({
              charIndex: utf16Idx,
              rect: { x: 0, y: 0, width: 0, height: 0 },
              suppressGlyph: true,
            });
          } else if (cp != null && needsRaster(cp, nextCp, cs.fontFamily)) {
            // Color-bitmap codepoint (emoji etc.) — record the painted rect
            // so post-capture rasterization can fill in the dataUri and the
            // renderer can stamp an `<image>` over the path-mode emit.
            rasterGlyphs.push({
              charIndex: utf16Idx,
              rect: {
                x: cRec.left - vp.x,
                y: cRec.top - vp.y,
                width: cRec.right - cRec.left,
                height: cRec.bottom - cRec.top,
              },
              // DM-905: the embedded-font default path emits the codepoint
              // as a PUA `<text>` against the system fallback subset font
              // where it lands as the font's .notdef tofu — peeking out
              // past the rasterGlyph overlay's edges. Suppressing the glyph
              // replaces the codepoint with ZWSP before the emit so only
              // the raster image paints.
              suppressGlyph: true,
            });
          }
          utf16Idx += cRec.ch.length;
        }
        textSegments.push({
          text: visualText,
          x: line.left - vp.x,
          y: line.top - vp.y,
          width: line.right - line.left,
          height: line.bottom - line.top,
          xOffsets: line.xOffsets.map((v) => v - vp.x),
          rasterGlyphs: rasterGlyphs.length > 0 ? rasterGlyphs : undefined,
        });
        minLeft = Math.min(minLeft, line.left);
        minTop = Math.min(minTop, line.top);
        maxRight = Math.max(maxRight, line.right);
        maxBottom = Math.max(maxBottom, line.bottom);
      }
    }

    // DM-989: emit the captured ::first-letter chars as their own styled
    // TextSegment with pseudo font / color / pseudoBox (background / border
    // / border-radius). Inserted at index 0 so the renderer paints it
    // first; the body segment(s) still own the same UTF-16 char indices
    // but their glyphs are suppressed via the zero-rect rasterGlyph
    // entries pushed above. Replaces the prior page.screenshot raster
    // overlay (DM-439, DM-823, DM-931).
    if (firstLetterChars != null && firstLetterChars.length > 0) {
      const fl = buildFirstLetterSegment(firstLetterChars, flStyle, hasInitialLetter, el, cs);
      textSegments.unshift(fl.seg);
      didEmitStyledFirstLetter = true;
      // Fold the styled run into the host's textLeft/Top/Width/Height envelope
      // (drop-cap floats often paint outside the host's text envelope).
      minLeft = Math.min(minLeft, fl.minL);
      minTop = Math.min(minTop, fl.minT);
      maxRight = Math.max(maxRight, fl.maxR);
      maxBottom = Math.max(maxBottom, fl.maxB);
    }

    // ::first-line overrides (DM-294). When DM-989's styled ::first-letter
    // segment was inserted at index 0, skip past it so the first-line
    // overrides land on the first BODY line (textSegments[1]) instead of
    // clobbering the styled first-letter's own font/color overrides.
    const flLineTargetIdx = didEmitStyledFirstLetter ? 1 : 0;
    if (textSegments.length > flLineTargetIdx) {
      const flLineStyle = window.getComputedStyle(el, '::first-line');
      const firstSeg = textSegments[flLineTargetIdx];
      if (flLineStyle.fontVariant !== '' && flLineStyle.fontVariant !== cs.fontVariant) {
        firstSeg.fontVariant = flLineStyle.fontVariant;
      }
      if (flLineStyle.color !== '' && flLineStyle.color !== cs.color) {
        firstSeg.color = flLineStyle.color;
      }
      if (flLineStyle.fontWeight !== '' && flLineStyle.fontWeight !== cs.fontWeight) {
        firstSeg.fontWeight = flLineStyle.fontWeight;
      }
      if (flLineStyle.fontStyle !== '' && flLineStyle.fontStyle !== cs.fontStyle) {
        firstSeg.fontStyle = flLineStyle.fontStyle;
      }
      const flFs = parseFloat(flLineStyle.fontSize);
      const elFs2 = parseFloat(cs.fontSize);
      if (flFs > 0 && Math.abs(flFs - elFs2) > 0.1) {
        firstSeg.fontSize = flFs;
      }
    }

    text = text.trim();
    if (minLeft < Infinity) {
      const metrics = measureFontMetrics(cs);
      return {
        applied: true,
        text,
        textSegments,
        textLeft: minLeft - vp.x,
        textTop: minTop - vp.y,
        textWidth: maxRight - minLeft,
        textHeight: maxBottom - minTop,
        fontAscent: metrics.ascent,
        fontDescent: metrics.descent,
      };
    }
    return { applied: true, text, textSegments };
  };

  return { captureTextSegments };
};
