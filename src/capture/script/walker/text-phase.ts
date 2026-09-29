// @ts-nocheck
//
// The text-bearing phase of an element's capture: ::before/::after generated content, input/textarea
// value or text-node segments, pseudo-segment injection and per-segment computed-size metrics — extracted
// from the capture script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained,
// page globals only; stable services come through the factory argument.

export const createTextPhaseHandler = (ctx) => {
  const {
    capturePseudoContent,
    _counterSnapshot,
    captureInputValue,
    captureTextSegments,
    injectPseudoSegments,
    _effectiveZoomFor,
    _measureFontMetrics,
  } = ctx;
  const captureTextPhase = ({ el, cs, tag, rect, _contentVisHidden, _pseudoFragmentFacts }) => {
    let isPlaceholderCapture;
    let text = "";

    let textTop = 0;
    let textLeft = 0;
    let textHeight = 0;
    let textWidth = 0;
    let fontAscent = 0;
    let fontDescent = 0;
    let inputXOffsets;
    let placeholderColor;
    let placeholderFontStyle;
    let placeholderFontWeight;
    let placeholderFontFamily;
    let placeholderFontFamilyStack;
    let lineClampTextFragments = false;
    const textSegments = [];
    // ::before / ::after generated content — capture each matched pseudo as
    // a TextSegment (or image pseudo) positioned relative to the host's
    // padding box. The downstream text-segments assembler re-anchors
    // seg.x/y against the captured text once shaping completes. See
    // walker/pseudo-content.ts.
    // DM-750: content-visibility:hidden hides the host's subtree, which
    // includes generated content from ::before / ::after. Skip the pseudo
    // capture too so the placeholder host is just an empty rect.
    const _pcResult =
      _contentVisHidden || Array.isArray(_pseudoFragmentFacts)
        ? { pseudoSegments: [], pseudoBoxes: [] }
        : capturePseudoContent(el, cs, rect, _counterSnapshot);
    const pseudoSegments = _pcResult.pseudoSegments;
    const pseudoBoxes = _pcResult.pseudoBoxes;

    // Skip text capture for elements where the child text is fallback content
    // hidden by the browser's shadow-DOM rendering (meter, progress, datalist,
    // option). These fall back to their text only when the element fails to
    // render; on a healthy browser the text is invisible but Range.getClientRects
    // still reports a rect at (0, 0) which would place a stray label at the top
    // of the page.
    // option/optgroup text is hidden by Chrome's UA shadow DOM at every level
    // we can probe — neither closed dropdowns nor listbox-mode selects expose
    // a usable getBoundingClientRect on the option children. Closed dropdowns
    // synthesize the selected option text via styles.selectDisplayText
    // (DM-246); listbox-mode selects synthesize all rows via
    // styles.selectListboxOptions (DM-282).
    const textIsHiddenFallback =
      tag === "meter" || tag === "progress" || tag === "datalist" || tag === "option" || tag === "optgroup";
    if (tag !== "svg" && tag !== "img" && !textIsHiddenFallback && !_contentVisHidden) {
      // Input / textarea value capture (incl. placeholder fallback, password
      // masking, sub-pixel inputXOffsets probe, text-align shift). See
      // walker/input-value.ts. When the handler `applied`, copy its locals
      // out and skip the text-node walker for this element.
      const _iv = captureInputValue(el, cs, tag, rect);
      isPlaceholderCapture = false;
      if (_iv.applied) {
        text = _iv.text;
        textLeft = _iv.textLeft;
        textTop = _iv.textTop;
        textHeight = _iv.textHeight;
        textWidth = _iv.textWidth;
        fontAscent = _iv.fontAscent;
        fontDescent = _iv.fontDescent;
        inputXOffsets = _iv.inputXOffsets;
        // DM-991: textareas return per-line textSegments[] alongside the
        // single-line top-level locals; the multi-line text path consumes
        // them just like text-segments.ts emits them for regular text.
        if (_iv.textSegments != null) for (const seg of _iv.textSegments) textSegments.push(seg);
        isPlaceholderCapture = _iv.isPlaceholderCapture;
        placeholderColor = _iv.placeholderColor;
        placeholderFontStyle = _iv.placeholderFontStyle;
        placeholderFontWeight = _iv.placeholderFontWeight;
        placeholderFontFamily = _iv.placeholderFontFamily;
        placeholderFontFamilyStack = _iv.placeholderFontFamilyStack;
      } else {
        // Text-node walker — per-line textSegments via per-character
        // getClientRects, BiDi visual-fragment splitting, rasterGlyph
        // detection, ::first-letter / ::first-line overrides. See
        // walker/text-segments.ts.
        const _ts = captureTextSegments(el, cs);
        text = _ts.text;
        lineClampTextFragments = _ts.lineClampTextFragments === true;
        for (const seg of _ts.textSegments) textSegments.push(seg);
        if (_ts.textLeft != null) {
          textLeft = _ts.textLeft;
          textTop = _ts.textTop;
          textWidth = _ts.textWidth;
          textHeight = _ts.textHeight;
          fontAscent = _ts.fontAscent;
          fontDescent = _ts.fontDescent;
        }
      }
    }
    // Inject pseudo-element segments now that the main text boundaries
    // are known. See walker/pseudo-inject.ts. Mutates textSegments in
    // place; returns the new pseudoImages + updated text-shaping locals
    // (pseudos can override the host's textLeft/Top/Width/Height when
    // they're the only segment — DM-495).
    const _pi = Array.isArray(_pseudoFragmentFacts)
      ? { pseudoImages: [], text, textLeft, textTop, textWidth, textHeight, fontAscent }
      : injectPseudoSegments(el, pseudoSegments, textSegments, {
          text,
          textLeft,
          textTop,
          textWidth,
          textHeight,
          fontAscent,
        });
    const pseudoImages = _pi.pseudoImages;
    text = _pi.text;
    textLeft = _pi.textLeft;
    textTop = _pi.textTop;
    textWidth = _pi.textWidth;
    textHeight = _pi.textHeight;
    fontAscent = _pi.fontAscent;

    // DM-2448: text emission prefers per-segment metrics over the host-level
    // fallback, so carry the same logical → computed → paint size separation
    // into ordinary, first-line, pseudo, and input segments. Preserve bespoke
    // metrics (initial-letter and other synthetic rows) when their logical-size
    // value does not match the segment's own canvas face.
    var _segmentZoom = _effectiveZoomFor(el);
    for (const _seg of textSegments) {
      var _segLogicalSize = _seg.fontSize ?? parseFloat(cs.fontSize);
      if (!isFinite(_segLogicalSize) || _segLogicalSize <= 0) continue;
      var _segMetricStyle = {
        fontStyle: _seg.fontStyle ?? cs.fontStyle,
        fontWeight: _seg.fontWeight ?? cs.fontWeight,
        fontSize: _segLogicalSize + "px",
        fontFamily: _seg.fontFamily ?? cs.fontFamily,
      };
      var _segLogicalMetrics = _measureFontMetrics(_segMetricStyle);
      var _segComputedMetrics = _measureFontMetrics(
        _segMetricStyle,
        (_segLogicalSize * _segmentZoom).toFixed(4) + "px",
      );
      if (_seg.fontAscent === _segLogicalMetrics.ascent) _seg.fontAscent = _segComputedMetrics.ascent;
      if (_seg.fontDescent === _segLogicalMetrics.descent) _seg.fontDescent = _segComputedMetrics.descent;
      if (_seg.fontSize != null) _seg.fontSize = _segLogicalSize * _segmentZoom;
    }

    return {
      text,
      textTop,
      textLeft,
      textHeight,
      textWidth,
      fontAscent,
      fontDescent,
      inputXOffsets,
      placeholderColor,
      placeholderFontStyle,
      placeholderFontWeight,
      placeholderFontFamily,
      placeholderFontFamilyStack,
      lineClampTextFragments,
      textSegments,
      pseudoBoxes,
      pseudoImages,
      isPlaceholderCapture,
    };
  };
  return { captureTextPhase };
};
