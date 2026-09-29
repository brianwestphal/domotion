// @ts-nocheck
//
// Native-control appearance ownership, closed-shadow decoration parts, the closed <select> display
// text geometry and the <input type=file> button/status capture — the form-control decision blocks
// extracted from the capture script's `captureInner`. Part of the page-`evaluate`d CAPTURE_SCRIPT
// bundle — self-contained, page globals only.

import {
  appearanceNeedsAuthorStyleFacts,
  autoAppearanceForControl,
  effectiveAppearanceForControl,
} from "../../effective-appearance.js";
import { nativeControlDecorationKinds } from "../../native-control-decoration.js";
import { normalizePseudoShadowPhase } from "./capture-phases.js";

export const createNativeControlsHandler = (ctx) => {
  const {
    args,
    vp,
    warn,
    normColor,
    captureTextSegments,
    _effectiveZoomFor,
    _fontFamilyStackFor,
    _measureFontMetrics,
  } = ctx;
  const captureNativeControlState = ({ el, cs, tag, sel, _pseudoFragmentFacts }) => {
    const _nativeControlTag =
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "button" ||
      tag === "progress" ||
      tag === "meter";
    const _specifiedAppearance = cs.webkitAppearance || cs.appearance || "auto";
    const _autoAppearanceDescriptor = {
      tag,
      type: tag === "input" ? el.type || "text" : undefined,
      multiple: tag === "select" ? !!el.multiple : undefined,
      selectSize: tag === "select" ? +el.size : undefined,
      selectHasSizeAttribute: tag === "select" ? el.hasAttribute("size") : undefined,
    };
    const _appearanceFacts =
      typeof args.effectiveAppearancePropertyKey === "string" && args.effectiveAppearancePropertyKey !== ""
        ? el[args.effectiveAppearancePropertyKey]
        : undefined;
    const _effectiveAppearance = _nativeControlTag
      ? effectiveAppearanceForControl(
          _specifiedAppearance,
          _autoAppearanceDescriptor,
          _appearanceFacts,
          cs.boxShadow != null && cs.boxShadow !== "" && cs.boxShadow !== "none",
        )
      : "none";
    const _nativeDecorationRefs =
      typeof args.nativeDecorationPropertyKey === "string" &&
      args.nativeDecorationPropertyKey !== "" &&
      Array.isArray(el[args.nativeDecorationPropertyKey])
        ? el[args.nativeDecorationPropertyKey]
        : [];
    // A closed select's displayed option is not a source-DOM text node. Blink
    // paints it through `-internal-select-inner-element` in the UA shadow
    // tree (MenuListSelectType::UpdateTextStyleAndContent). Its line box can
    // have UA-controlled line-height and alignment, so host padding/font-box
    // arithmetic cannot reconstruct its baseline faithfully. The CDP prepass
    // has retained that exact node for every select; read its Range geometry
    // while the source page is still live and let the renderer reuse it.
    let _selectDisplayTextGeometry;
    if (tag === "select" && el.size <= 1 && !el.multiple) {
      for (let _sdi = 0; _sdi < _nativeDecorationRefs.length; _sdi++) {
        const _entry = _nativeDecorationRefs[_sdi];
        const _inner = _entry != null && _entry.kind === "select-inner" ? _entry.node : null;
        if (!(_inner instanceof Element) || !_inner.isConnected) continue;
        try {
          const _range = document.createRange();
          _range.selectNodeContents(_inner);
          const _textRect = _range.getBoundingClientRect();
          if (_textRect.width > 0 && _textRect.height > 0) {
            const _innerMetrics = _measureFontMetrics(window.getComputedStyle(_inner));
            if (isFinite(_innerMetrics.ascent) && _innerMetrics.ascent > 0) {
              _selectDisplayTextGeometry = {
                x: _textRect.left - vp.x,
                y: _textRect.top - vp.y,
                fontAscent: _innerMetrics.ascent,
              };
              break;
            }
          }
        } catch (_e) {
          /* Missing/empty UA shadow text falls back below. */
        }
      }
    }
    let _fileSelectorButtonAppearance;
    for (let _fri = 0; _fri < _nativeDecorationRefs.length; _fri++) {
      const _fileRef = _nativeDecorationRefs[_fri];
      if (_fileRef == null || _fileRef.kind !== "file-selector-button") continue;
      _fileSelectorButtonAppearance = _fileRef.ownership == null ? null : _fileRef.ownership.effectiveAppearance;
      break;
    }
    const _nativeDecorationKinds = _nativeControlTag
      ? nativeControlDecorationKinds(
          _autoAppearanceDescriptor,
          _effectiveAppearance,
          tag === "input" && el.type === "file" ? _fileSelectorButtonAppearance : undefined,
        )
      : [];
    const {
      nativeDecorationParts: _nativeDecorationParts,
      missingNativeDecorationKinds: _missingNativeDecorationKinds,
      nativeDecorationUnavailableReason: _nativeDecorationUnavailableReason,
    } = normalizePseudoShadowPhase({
      el,
      pseudoFragmentFacts: _pseudoFragmentFacts,
      fontFamilyStackFor: _fontFamilyStackFor,
      nativeDecorationRefs: _nativeDecorationRefs,
      nativeDecorationKinds: _nativeDecorationKinds,
    });
    // FileInputType's button and filename are real closed-shadow children.
    // Preserve their source layout/text facts independently of whether the
    // button's own EffectiveAppearance selects native pixels or author paint.
    // This keeps localized/multiple/long status text structural and gives the
    // author-owned pseudo route the same physical rect as Blink.
    let _fileSelectorCapture;
    if (tag === "input" && el.type === "file") {
      let _buttonNode;
      let _statusNode;
      for (let _fri = 0; _fri < _nativeDecorationRefs.length; _fri++) {
        const _entry = _nativeDecorationRefs[_fri];
        if (_entry == null || !(_entry.node instanceof Element)) continue;
        if (_entry.kind === "file-selector-button") _buttonNode = _entry.node;
        else if (_entry.kind === "file-selector-status") _statusNode = _entry.node;
      }
      const _paintScale = _effectiveZoomFor(el);
      const _buttonRect = _buttonNode && _buttonNode.getBoundingClientRect();
      const _buttonStyle = _buttonNode && getComputedStyle(_buttonNode);
      const _buttonMetrics = _buttonStyle && _measureFontMetrics(_buttonStyle);
      let _buttonTextWidth = 0;
      if (_buttonNode && _buttonStyle) {
        try {
          const _buttonCanvas = document.createElement("canvas");
          const _buttonCtx = _buttonCanvas.getContext("2d");
          if (_buttonCtx) {
            _buttonCtx.font = _buttonStyle.font;
            _buttonTextWidth =
              _buttonCtx.measureText(_buttonNode.value || _buttonNode.getAttribute("value") || "").width * _paintScale;
          }
        } catch (_e) {}
      }
      const _statusRect = _statusNode && _statusNode.getBoundingClientRect();
      const _statusStyle = _statusNode && getComputedStyle(_statusNode);
      const _statusText = _statusNode && captureTextSegments(_statusNode, _statusStyle);
      if (_statusText && Array.isArray(_statusText.textSegments)) {
        for (let _fsi = 0; _fsi < _statusText.textSegments.length; _fsi++) {
          const _seg = _statusText.textSegments[_fsi];
          if (_seg.fontAscent != null) _seg.fontAscent *= _paintScale;
          if (_seg.fontDescent != null) _seg.fontDescent *= _paintScale;
          if (_seg.fontSize != null) _seg.fontSize *= _paintScale;
          if (Array.isArray(_seg.verticalNaturalWidths)) {
            _seg.verticalNaturalWidths = _seg.verticalNaturalWidths.map((_width) => _width * _paintScale);
          }
        }
      }
      _fileSelectorCapture = {
        fileSelectorButton:
          _buttonRect && _buttonStyle && _buttonMetrics
            ? {
                x: _buttonRect.left - vp.x,
                y: _buttonRect.top - vp.y,
                width: _buttonRect.width,
                height: _buttonRect.height,
                text: _buttonNode.value || _buttonNode.getAttribute("value") || "",
                textWidth: _buttonTextWidth,
                fontSize: (parseFloat(_buttonStyle.fontSize) || 0) * _paintScale,
                fontFamily: _buttonStyle.fontFamily,
                fontFamilyStack: _fontFamilyStackFor(el, _buttonStyle.fontFamily, "::file-selector-button"),
                fontWeight: _buttonStyle.fontWeight,
                fontStyle: _buttonStyle.fontStyle,
                fontAscent: _buttonMetrics.ascent * _paintScale,
                fontDescent: _buttonMetrics.descent * _paintScale,
                color: normColor(_buttonStyle.color),
                boxShadow: _buttonStyle.boxShadow,
                borderRadius: _buttonStyle.borderRadius,
                writingMode: _buttonStyle.writingMode,
                textOrientation: _buttonStyle.textOrientation,
                direction: _buttonStyle.direction,
              }
            : undefined,
        fileSelectorStatus:
          _statusRect && _statusStyle && _statusText
            ? {
                x: _statusRect.left - vp.x,
                y: _statusRect.top - vp.y,
                width: _statusRect.width,
                height: _statusRect.height,
                text: _statusText.text || _statusNode.textContent || "",
                textSegments: _statusText.textSegments,
                fontSize: (parseFloat(_statusStyle.fontSize) || 0) * _paintScale,
                fontFamily: _statusStyle.fontFamily,
                fontFamilyStack: _fontFamilyStackFor(el, _statusStyle.fontFamily, "::file-selector-status"),
                fontWeight: _statusStyle.fontWeight,
                fontStyle: _statusStyle.fontStyle,
                fontAscent: (_statusText.fontAscent || 0) * _paintScale,
                fontDescent: (_statusText.fontDescent || 0) * _paintScale,
                color: normColor(_statusStyle.color),
                writingMode: _statusStyle.writingMode,
                textOrientation: _statusStyle.textOrientation,
                direction: _statusStyle.direction,
              }
            : undefined,
      };
    }
    if (_nativeControlTag && _effectiveAppearance == null) {
      const _autoAppearance =
        _specifiedAppearance === "auto" ? autoAppearanceForControl(_autoAppearanceDescriptor) : _specifiedAppearance;
      if (appearanceNeedsAuthorStyleFacts(_autoAppearance)) {
        const _reason =
          _appearanceFacts && _appearanceFacts.reason
            ? _appearanceFacts.reason
            : args.effectiveAppearanceSetupFailure || "no correlated Chromium matched-style facts";
        warn(
          sel,
          "effective-appearance-cascade",
          "author background/border origin unavailable (" +
            _reason +
            "); preserving a conservative Chromium host raster",
        );
      }
    }
    return {
      _effectiveAppearance,
      _fileSelectorCapture,
      _missingNativeDecorationKinds,
      _nativeControlTag,
      _nativeDecorationKinds,
      _nativeDecorationParts,
      _nativeDecorationUnavailableReason,
      _selectDisplayTextGeometry,
    };
  };
  return { captureNativeControlState };
};
