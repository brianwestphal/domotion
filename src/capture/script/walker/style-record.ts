//
// The per-element `styles` record, extracted from the capture script's `captureInner`.
// Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals only.
// Stable orchestrator services come in through the factory argument; the per-element locals
// (`el`, `cs`, `tag`, ...) through the returned builder's argument.

import {
  physicalComputedGradientImage,
  physicalComputedTileSize as physicalComputedCssPixelTerms,
} from "./borders-backgrounds.js";
import { extractCssUrl } from "../utils.js";
import type { CapturedStyles } from "../../types.js";
import type { FontFeatureValueTables } from "../../../font-feature-values-cascade.js";

type WebkitStyle = CSSStyleDeclaration & {
  webkitBackdropFilter?: string;
  webkitMask?: string;
  webkitMaskImage?: string;
  webkitMaskSize?: string;
  webkitMaskPosition?: string;
  webkitMaskRepeat?: string;
  webkitMaskComposite?: string;
  webkitMaskOrigin?: string;
  webkitMaskClip?: string;
  webkitMaskBoxImageSource?: string;
  webkitMaskBoxImageSlice?: string;
  webkitMaskBoxImageWidth?: string;
  webkitMaskBoxImageOutset?: string;
  webkitMaskBoxImageRepeat?: string;
  webkitBoxReflect?: string;
  fontVariantEmoji?: string;
};

type StyleRecordScope = {
  el: HTMLElement;
  cs: WebkitStyle;
  tag: string;
  rect: DOMRect;
  frozenTransform?: string | null;
  frozenTransformOrigin?: string | null;
  isPlaceholderCapture?: boolean;
  _effectiveAppearance?: string | null;
  _selectDisplayTextGeometry?: CapturedStyles["selectDisplayTextGeometry"];
  _capturedFontFamilyStack: NonNullable<CapturedStyles["fontFamilyStack"]>;
  _fileSelectorCapture?: Partial<CapturedStyles>;
};

export const createStyleRecordBuilder = (ctx: {
  _backgroundAttachmentPaintScaleFor: (el: Element) => [number, number];
  captureFormControls: (el: HTMLElement, cs: CSSStyleDeclaration, tag: string) => Partial<CapturedStyles>;
  threadFrozenTransform: (
    cs: CSSStyleDeclaration,
    frozenTransform?: string | null,
    frozenTransformOrigin?: string | null,
  ) => Partial<CapturedStyles>;
  _effectiveZoomFor: (el: Element) => number;
  _fontFeatureValuesFor: (doc: Document) => FontFeatureValueTables;
  _resolveFontPalette: (el: Element, cs: CSSStyleDeclaration) => CapturedStyles["fontPaletteIdentity"];
  _resolveShadowFontPalettes: (el: Element) => CapturedStyles["shadowFontPaletteIdentities"];
  _transformRelatedBox: Map<Element, boolean>;
  captureBackgroundAttachment: (
    el: Element,
    cs: CSSStyleDeclaration,
    rect: DOMRect,
    scaleX: number,
    scaleY: number,
  ) => CapturedStyles["backgroundAttachmentGeometry"];
  captureBordersBackgrounds: (
    el: Element,
    cs: CSSStyleDeclaration,
    tag: string,
    rect: DOMRect,
    placeholder: boolean | undefined,
    zoom: number,
  ) => Partial<CapturedStyles>;
  computeMaskIntrinsic: (el: Element, cs: CSSStyleDeclaration) => CapturedStyles["maskIntrinsic"];
  isTableCellHiddenByEmptyCells: (el: Element, cs: CSSStyleDeclaration, tag: string) => boolean;
  normColor: (color: string) => string;
}) => {
  const {
    _backgroundAttachmentPaintScaleFor,
    captureFormControls,
    threadFrozenTransform,
    _effectiveZoomFor,
    _fontFeatureValuesFor,
    _resolveFontPalette,
    _resolveShadowFontPalettes,
    _transformRelatedBox,
    captureBackgroundAttachment,
    captureBordersBackgrounds,
    computeMaskIntrinsic,
    isTableCellHiddenByEmptyCells,
    normColor,
  } = ctx;
  return (scope: StyleRecordScope) => {
    const {
      el,
      cs,
      tag,
      rect,
      frozenTransform,
      frozenTransformOrigin,
      isPlaceholderCapture,
      _effectiveAppearance,
      _selectDisplayTextGeometry,
      _capturedFontFamilyStack,
      _fileSelectorCapture,
    } = scope;
    return {
      // Border + background + outline + box-shadow fields — see
      // walker/borders-backgrounds.ts. Includes the
      // backgroundColor placeholder-shown fallback (DM-283), %-resolved
      // corner radii (SK-1093), per-side color-input border tint
      // workaround (DM-434), frosted-bg fallback (DM-476), per-layer
      // background-image intrinsic dims (DM-308), and border-image
      // intrinsic dims.
      ...captureBordersBackgrounds(el, cs, tag, rect, isPlaceholderCapture, _effectiveZoomFor(el)),
      backgroundAttachmentGeometry: (function () {
        const _scale = _backgroundAttachmentPaintScaleFor(el);
        return captureBackgroundAttachment(el, cs, rect, _scale[0], _scale[1]);
      })(),
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      // DM-761: `overflow-clip-margin` extends the overflow clip outward
      // from a reference box (content / padding / border) by a length.
      // Blink serializes computed lengths before effective CSS zoom while
      // DOMRects are already physical. Cross that boundary once here; the
      // reference-box keyword is retained byte-for-byte.
      overflowClipMargin: cs.overflowClipMargin
        ? physicalComputedCssPixelTerms(cs.overflowClipMargin, _effectiveZoomFor(el))
        : undefined,
      scrollbarGutter: cs.scrollbarGutter || "auto",
      scrollWidth: el.scrollWidth,
      scrollHeight: el.scrollHeight,
      clientWidth: el.clientWidth,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      scrollLeft: el.scrollLeft,
      objectFit: cs.objectFit,
      objectPosition: cs.objectPosition,
      filter: cs.filter,
      backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || "",
      mixBlendMode: cs.mixBlendMode,
      clipPath: cs.clipPath,
      mask: cs.mask || cs.webkitMask || "",
      maskImage: physicalComputedGradientImage(cs.maskImage || cs.webkitMaskImage || "", _effectiveZoomFor(el)),
      maskMode: cs.maskMode || "match-source",
      // Computed mask lengths are exposed before effective zoom, while the
      // captured positioning rect is already in painted coordinates. Cross
      // that boundary once; percentages stay unresolved until Blink's
      // contain/cover tile has established the free space (DM-2379).
      maskSize: physicalComputedCssPixelTerms(cs.maskSize || cs.webkitMaskSize || "auto", _effectiveZoomFor(el)),
      maskPosition: physicalComputedCssPixelTerms(
        cs.maskPosition || cs.webkitMaskPosition || "0% 0%",
        _effectiveZoomFor(el),
      ),
      maskRepeat: cs.maskRepeat || cs.webkitMaskRepeat || "repeat",
      maskComposite: cs.maskComposite || cs.webkitMaskComposite || "add",
      maskIntrinsic: computeMaskIntrinsic(el, cs),
      maskOrigin: cs.maskOrigin || cs.webkitMaskOrigin || "border-box",
      maskClip: cs.maskClip || cs.webkitMaskClip || "border-box",
      // DM-2472: BackgroundImageGeometry contracts the HTML border box by
      // mask-origin independently from mask-clip. Computed padding/borders
      // are pre-zoom CSS px while `rect` is already physical, so cross the
      // effective-zoom boundary once at capture time.
      maskBoxInsets: (function () {
        var _maskImage = cs.maskImage || cs.webkitMaskImage || "";
        if (_maskImage === "" || _maskImage === "none") return undefined;
        var _zoom = _effectiveZoomFor(el);
        var _physical = function (value: string) {
          var _number = parseFloat(value || "0");
          return Number.isFinite(_number) ? _number * _zoom : 0;
        };
        return {
          border: {
            top: _physical(cs.borderTopWidth),
            right: _physical(cs.borderRightWidth),
            bottom: _physical(cs.borderBottomWidth),
            left: _physical(cs.borderLeftWidth),
          },
          padding: {
            top: _physical(cs.paddingTop),
            right: _physical(cs.paddingRight),
            bottom: _physical(cs.paddingBottom),
            left: _physical(cs.paddingLeft),
          },
        };
      })(),
      // DM-758: `mask-border-source` / legacy `-webkit-mask-box-image`. Chrome
      // exposes only the legacy webkit name; modern `maskBorderSource`
      // returns undefined. Capture source + slice / width / outset so the
      // renderer can decide whether to route through the simplified
      // full-element mask path (only safe when width / outset both `0`).
      maskBorderSource:
        cs.webkitMaskBoxImageSource && cs.webkitMaskBoxImageSource !== "none" ? cs.webkitMaskBoxImageSource : undefined,
      maskBorderSlice: cs.webkitMaskBoxImageSlice || undefined,
      maskBorderWidth: cs.webkitMaskBoxImageWidth || undefined,
      maskBorderOutset: cs.webkitMaskBoxImageOutset || undefined,
      // DM-793: legacy `-webkit-mask-box-image-repeat` keyword (stretch /
      // repeat / round / space) per axis. Mirrors `border-image-repeat`.
      maskBorderRepeat: cs.webkitMaskBoxImageRepeat || undefined,
      // DM-793: intrinsic dimensions of the mask-border-source raster /
      // SVG asset. Same probe pattern as `borderImageIntrinsic*` — a
      // detached `<img>` resolves the URL against the document base and
      // reports `naturalWidth` / `naturalHeight` for raster sources and
      // the `<svg width/height>` attributes (or viewBox-derived size) for
      // SVG sources. Captured at capture time so the renderer can compute
      // 9-slice source rects without re-fetching the asset.
      maskBorderIntrinsicWidth: (function () {
        var _url = extractCssUrl(cs.webkitMaskBoxImageSource || "");
        if (_url == null) return undefined;
        var _img = new Image();
        _img.src = _url;
        return _img.naturalWidth || undefined;
      })(),
      maskBorderIntrinsicHeight: (function () {
        var _url = extractCssUrl(cs.webkitMaskBoxImageSource || "");
        if (_url == null) return undefined;
        var _img = new Image();
        _img.src = _url;
        return _img.naturalHeight || undefined;
      })(),
      listStyleType: cs.listStyleType,
      listStyleImage: cs.listStyleImage,
      display: cs.display,
      listStylePosition: cs.listStylePosition,
      paddingTop: cs.paddingTop,
      paddingRight: cs.paddingRight,
      paddingBottom: cs.paddingBottom,
      paddingLeft: cs.paddingLeft,
      marginTop: cs.marginTop,
      marginRight: cs.marginRight,
      marginBottom: cs.marginBottom,
      marginLeft: cs.marginLeft,
      zIndex: cs.zIndex,
      position: cs.position,
      float: cs.float,
      // DM-1742: `pointer-events: none` makes an element transparent to
      // cursor hit-testing (the auto cursor-overlay glyph picker). Captured
      // only when `none` — the property inherits, so descendants report it
      // themselves; every other value hit-tests normally.
      pointerEvents: cs.pointerEvents === "none" ? "none" : undefined,
      order: cs.order,
      flexDirection: cs.flexDirection,
      emptyCellsHidden: isTableCellHiddenByEmptyCells(el, cs, tag),
      // Form-control fields — input / progress / meter / select / details
      // + ::-webkit-* pseudos for slider track/thumb, color swatch, number
      // spin button, search cancel, file-selector button. See
      // walker/form-controls.ts. Input value-capture-as-text and color-
      // input border tinting deliberately stay inline (entangled with
      // text-shaping and border-color emission respectively).
      ...captureFormControls(el, cs, tag),
      selectDisplayTextGeometry: _selectDisplayTextGeometry,
      ..._fileSelectorCapture,
      // ComputedStyle::EffectiveAppearance after Blink's author-style
      // adjustment. This is distinct from the computed `appearance`
      // longhand and lets later decoration ownership split at the exact
      // menulist-button boundary (DM-2455).
      effectiveAppearance: _effectiveAppearance || undefined,
      textShadow: cs.textShadow,
      ...threadFrozenTransform(cs, frozenTransform, frozenTransformOrigin),
      transformRelatedBox: _transformRelatedBox.get(el),
      // CSS Transforms 2 §4: `transform-style` != `flat` (i.e. `preserve-3d`)
      // creates a stacking context. Captured so the renderer's SC detection
      // sees it; otherwise z-index:-1 descendants hoist past their intended
      // SC and end up behind the wrong background (DM-589).
      transformStyle: cs.transformStyle,
      // DM-2385: keep perspective as its own computed ancestor signal. It
      // creates stacking/fixed-CB ownership without appearing in a child's
      // computed transform matrix; perspective-origin is the resolved
      // border-box point and is inert when perspective computes to none.
      perspective: cs.perspective,
      perspectiveOrigin: cs.perspectiveOrigin,
      backfaceVisibility: cs.backfaceVisibility,
      webkitBoxReflect: cs.webkitBoxReflect,
      willChange: cs.willChange,
      contain: cs.contain,
      isolation: cs.isolation,
      writingMode: cs.writingMode,
      textOrientation: cs.textOrientation,
      // CSS resize: 'none' / 'both' / 'vertical' / 'horizontal' / 'block' /
      // 'inline'. When non-none on a <textarea> Chrome paints a small
      // diagonal-line resize handle in the bottom-right corner. (DM-339)
      resize: cs.resize,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      textTransform: cs.textTransform,
      // MathML layout inherits math-style through rows, fractions, and scripts;
      // the radical's own computed value selects its OpenType MATH gap.
      mathStyle: el.namespaceURI === "http://www.w3.org/1998/Math/MathML" ? cs.mathStyle : undefined,
      color: normColor(cs.color),
      // DM-2470: font metrics live in Blink's pre-transform plane. Effective
      // CSS zoom is layout-local and is crossed here exactly once; the later
      // signed CSS transform is carried solely by textPaintGeometry.
      fontSize: (function () {
        var _fs = parseFloat(cs.fontSize);
        if (!isFinite(_fs)) return cs.fontSize;
        return (_fs * _effectiveZoomFor(el)).toFixed(4) + "px";
      })(),
      fontLogicalSize: cs.fontSize,
      fontComputedSize: (function () {
        var _fs = parseFloat(cs.fontSize);
        if (!isFinite(_fs)) return cs.fontSize;
        return (_fs * _effectiveZoomFor(el)).toFixed(4) + "px";
      })(),
      // DM-2051: an element with NO author-declared font-family is a Blink
      // kStandardFamily description, which resolves to the SCRIPT-KEYED
      // `settings.Standard(script)` — so `lang=ja` with no declared family
      // paints the Japanese standard face for the whole run, though the
      // computed string serializes to the concrete standard name ("Times").
      // Rewrite that case to the `-webkit-standard` generic keyword, which is
      // exactly what kStandardFamily maps to; the renderer's
      // `matchFamilyNameToKey("-webkit-standard", true, lang)` then routes it
      // script-keyed. A declared `font-family: Times` (identical computed
      // string, but Latin→Times / CJK→fallback) is left untouched.
      fontFamily: _capturedFontFamilyStack.genericFamily === "standard" ? "-webkit-standard" : cs.fontFamily,
      fontFamilyStack: _capturedFontFamilyStack,
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      opacity: cs.opacity,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      fontKerning: cs.fontKerning,
      fontStretch: cs.fontStretch,
      fontVariationSettings: cs.fontVariationSettings,
      fontOpticalSizing: cs.fontOpticalSizing,
      fontFeatureSettings: cs.fontFeatureSettings,
      textSpacingTrim: cs.getPropertyValue("text-spacing-trim") || "normal",
      fontVariantAlternates: cs.fontVariantAlternates,
      // The alias table is document-global but only alternate-bearing nodes
      // can consume it; omit it from the common element shape to avoid
      // repeating author rule data throughout the serialized tree.
      fontFeatureValues:
        cs.fontVariantAlternates && cs.fontVariantAlternates !== "normal"
          ? _fontFeatureValuesFor(el.ownerDocument)
          : undefined,
      // CSS font-variant-caps. 'small-caps' / 'all-small-caps' route to
      // the OpenType smcp feature; renderer applies synthesized small-caps
      // when the active font lacks smcp (Helvetica, Times, etc.). DM-361.
      fontVariantCaps: cs.fontVariantCaps,
      // CSS font-variant-east-asian / -numeric / -ligatures. Each maps to a
      // set of OpenType feature tags (e.g. `traditional` → `trad`, `jis78` →
      // `jp78`, `oldstyle-nums` → `onum`) that the path renderer forwards to
      // fontkit shaping. Without these, e.g. `font-variant-east-asian:
      // traditional` paints the simplified/JP default glyph (国) instead of
      // the traditional form (國). DM-1117.
      fontVariantEastAsian: cs.fontVariantEastAsian,
      fontVariantNumeric: cs.fontVariantNumeric,
      fontVariantLigatures: cs.fontVariantLigatures,
      // CSS font-variant-position — maps to the OpenType subs/sups
      // features (`font_features.cc:230-239`, rev 7d859f27). DM-2048.
      fontVariantPosition: cs.fontVariantPosition,
      // CSS font-synthesis-{weight,style,small-caps} — `auto` or `none`. Not a
      // hint: Blink ANDs each into the corresponding synthesis decision, so
      // `none` means Chrome paints the thin/upright/lowercase face where we
      // would otherwise embolden, shear, or scale. DM-1971.
      // CSS text-rendering — `optimizeSpeed` disables the normal-state
      // ligature features at shaping time, the same way a non-zero
      // letter-spacing does. DM-1963.
      textRendering: cs.textRendering,
      fontSynthesisWeight: cs.fontSynthesisWeight,
      fontSynthesisStyle: cs.fontSynthesisStyle,
      fontSynthesisSmallCaps: cs.fontSynthesisSmallCaps,
      // CSS font-variant-emoji — a genuine face-selection input (it overrides
      // the run's emoji-vs-text fallback priority and forces VS15/VS16 into
      // the glyph lookups). The renderer threads it into the per-codepoint
      // resolver and the raster-emoji overlay routing.
      fontVariantEmoji: cs.fontVariantEmoji,
      fontPalette: cs.fontPalette,
      fontPaletteIdentity: _resolveFontPalette(el, cs),
      // Author shadow trees are captured through the custom-element raster
      // boundary. Their own @font-palette-values rules are ignored by Blink,
      // but document rules and animated palette-mix states still change the
      // pixels inside that host. Carry those descendant paint identities on
      // the raster owner so the captured record explains the selected PNG.
      shadowFontPaletteIdentities: _resolveShadowFontPalettes(el),
      direction: cs.direction,
      // `unicode-bidi` decides whether the characters' OWN bidi types are
      // honored or overridden. `bidi-override` / `isolate-override` tell the
      // UBA to treat every character as strong in `direction`, which is the
      // one case the renderer cannot reconstruct from the text: it derives
      // levels by running the algorithm on the characters, and the override
      // is precisely an instruction to ignore what the characters say.
      unicodeBidi: cs.unicodeBidi,
      // Computed BCP-47 language tag from el.lang or nearest ancestor
      // [lang], falling back to document.documentElement.lang. Used by the
      // path renderer to route CJK Han fallback to the right PingFang
      // regional variant. (DM-394)
      lang: (function () {
        var n: HTMLElement | null = el;
        while (n != null && n.nodeType === 1) {
          if (n.lang) return n.lang;
          n = n.parentElement;
        }
        return document.documentElement.lang || "";
      })(),
      textDecorationLine: cs.textDecorationLine,
      textDecorationColor: cs.textDecorationColor,
      textDecorationStyle: cs.textDecorationStyle,
      textDecorationThickness: cs.textDecorationThickness,
      textUnderlineOffset: cs.textUnderlineOffset,
      textUnderlinePosition: cs.textUnderlinePosition,
      textDecorationSkipInk: cs.textDecorationSkipInk,
      // DM-920: text-emphasis. Captured per CSS Text Decoration 3 §3.5.
      // `text-emphasis-style` resolved string ("filled circle" / "open
      // sesame" / `"★"` etc.) maps to a single mark character in the
      // renderer per Chromium's `ComputedStyle::TextEmphasisMarkString`
      // (third_party/blink/renderer/core/style/computed_style.cc:
      // kBullet U+2022 / kWhiteBullet U+25E6 / kBlackCircle U+25CF /
      // kWhiteCircle U+25CB / kFisheye U+25C9 / kBullseye U+25CE /
      // kBlackUpPointingTriangle U+25B2 / kWhiteUpPointingTriangle
      // U+25B3 / kSesameDot U+FE45 / kWhiteSesameDot U+FE46).
      textEmphasisStyle: cs.textEmphasisStyle,
      textEmphasisColor: cs.textEmphasisColor,
      textEmphasisPosition: cs.textEmphasisPosition,
    };
  };
};
