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
  const hasTextareaValue = tag === 'textarea' && el.value;
  const hasNonHorizontalText = cs.writingMode
    && cs.writingMode !== 'horizontal-tb'
    && (el.textContent || '').trim() !== '';
  // DM-628: `<input type="text" | "search" | "email" | "tel" | "url" |
  // "password" | "number">` text shaped via fontkit doesn't match
  // Chromium's painted glyph widths (different system Arial / fallback),
  // producing visible glyph overdraw. Screenshot the input's content
  // box so the rasterized output stamps Chromium's actual paint.
  // Scoped to inputs with either a placeholder or a value; checkboxes /
  // radios / range / color etc. are skipped (no text to raster). Skip
  // when the input is a sub-pixel size or has display:none — captureInner
  // already excludes those earlier.
  const isTextInput = tag === 'input' && (
    el.type === 'text' || el.type === 'search' || el.type === 'email'
    || el.type === 'tel' || el.type === 'url' || el.type === 'password'
    || el.type === 'number' || el.type === '' || el.type == null
  );
  const hasInputText = isTextInput && (el.value || (el.getAttribute && el.getAttribute('placeholder')));
  if (!hasTextareaValue && !hasNonHorizontalText && !hasInputText) return undefined;
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pr = parseFloat(cs.paddingRight) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const bl = parseFloat(cs.borderLeftWidth) || 0;
  const br = parseFloat(cs.borderRightWidth) || 0;
  const bt = parseFloat(cs.borderTopWidth) || 0;
  const bb = parseFloat(cs.borderBottomWidth) || 0;
  return {
    x: rect.left - vp.x + bl + pl,
    y: rect.top - vp.y + bt + pt,
    width: Math.max(1, rect.width - bl - br - pl - pr),
    height: Math.max(1, rect.height - bt - bb - pt - pb),
  };
};

export const createTextSegmentsHandler = ({ vp, measureFontMetrics, needsRaster }) => {
  const captureTextSegments = (el, cs) => {
    const textSegments = [];
    let text = '';
    let minLeft = Infinity;
    let minTop = Infinity;
    let maxRight = -Infinity;
    let maxBottom = -Infinity;

    // ::first-letter detection (SK-1114). Compare the pseudo's computed
    // font-size against the element's own — when they differ the author
    // has styled ::first-letter (drop-cap pattern) and we raster the
    // very first visible char as a glyph image. Other delta signals
    // (color, weight, etc.) come along for free since the screenshot
    // captures whatever Chrome painted.
    const flStyle = window.getComputedStyle(el, '::first-letter');
    const elFsRaw = parseFloat(cs.fontSize) || 0;
    const flFsRaw = parseFloat(flStyle.fontSize) || 0;
    const firstLetterStyled = flFsRaw > 0 && Math.abs(flFsRaw - elFsRaw) > 0.5;
    let firstCharSeen = false;

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
      // The block is dense: 25 codepoints for Α (U+0391) through Ω (U+03A9),
      // skipping nothing in the source range.
      if (code >= 0x0391 && code <= 0x03A9) return String.fromCodePoint(0x1D6E2 + (code - 0x0391));
      // Greek Mathematical Italic Small α..ω = U+1D6FC..U+1D71B.
      // U+03C2 (final sigma ς) maps to the regular U+1D70D position; the
      // block is contiguous.
      if (code >= 0x03B1 && code <= 0x03C9) return String.fromCodePoint(0x1D6FC + (code - 0x03B1));
      // Greek symbol variants — these alternate forms get their own italic
      // codepoints at the tail of the lowercase Greek block.
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
        const charRec = { ch, left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom };
        if (cur == null || Math.abs(cr.top - cur.top) > 1) {
          if (cur != null) lines.push(cur);
          cur = { chars: [charRec], top: cr.top, bottom: cr.bottom, left: cr.left, right: cr.right };
        } else {
          cur.chars.push(charRec);
          cur.left = Math.min(cur.left, cr.left);
          cur.right = Math.max(cur.right, cr.right);
          cur.bottom = Math.max(cur.bottom, cr.bottom);
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
        const rasterGlyphs = [];
        let utf16Idx = 0;
        for (let ci = 0; ci < line.chars.length; ci++) {
          const cRec = line.chars[ci];
          const cp = cRec.ch.codePointAt(0);
          const nextCh = ci + 1 < line.chars.length ? line.chars[ci + 1].ch : '';
          const nextCp = nextCh ? nextCh.codePointAt(0) : 0;
          const isFirstLetter = firstLetterStyled && !firstCharSeen && /\S/.test(cRec.ch);
          if (isFirstLetter) firstCharSeen = true;
          if ((cp != null && needsRaster(cp, nextCp)) || isFirstLetter) {
            rasterGlyphs.push({
              charIndex: utf16Idx,
              rect: {
                x: cRec.left - vp.x,
                y: cRec.top - vp.y,
                width: cRec.right - cRec.left,
                height: cRec.bottom - cRec.top,
              },
              // ::first-letter drop caps: suppress the path glyph so
              // only the rasterized big letter paints (DM-439).
              suppressGlyph: isFirstLetter ? true : undefined,
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

    // ::first-line overrides (DM-294).
    if (textSegments.length > 0) {
      const flLineStyle = window.getComputedStyle(el, '::first-line');
      const firstSeg = textSegments[0];
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
