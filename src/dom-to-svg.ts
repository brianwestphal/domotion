/**
 * DOM-to-SVG Converter
 *
 * Uses Playwright to inspect DOM elements and recreate them as native SVG.
 */

import type { Page } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { renderSingleLineText, renderMultiSegmentText, renderMultiLineText, renderInputText } from "./text-renderer.js";
import { getGlyphDefs } from "./text-to-path.js";
import type { DefCtx } from "./form-controls.js";
import { renderFormControl } from "./form-controls.js";

/**
 * Convert a `file://` (or absolute filesystem) URL to a base64 data URI so the
 * generated SVG is self-contained and renders in tools that block local-file
 * references for security (most online SVG viewers, embeds, etc.). Pass-through
 * for http(s):// and existing data: URLs. Returns the original string on any
 * error so failures degrade gracefully.
 */
const _dataUriCache = new Map<string, string>();
function embedAsDataUri(url: string): string {
  if (url == null || url === "") return url;
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) return url;
  const cached = _dataUriCache.get(url);
  if (cached != null) return cached;
  let path = url;
  if (path.startsWith("file://")) path = decodeURIComponent(path.slice("file://".length));
  if (!existsSync(path)) {
    _dataUriCache.set(url, url);
    return url;
  }
  try {
    const buf = readFileSync(path);
    let mime = "application/octet-stream";
    const lower = path.toLowerCase();
    if (lower.endsWith(".png")) mime = "image/png";
    else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
    else if (lower.endsWith(".gif")) mime = "image/gif";
    else if (lower.endsWith(".webp")) mime = "image/webp";
    else if (lower.endsWith(".svg")) mime = "image/svg+xml";
    else if (lower.endsWith(".avif")) mime = "image/avif";
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    _dataUriCache.set(url, dataUri);
    return dataUri;
  } catch {
    _dataUriCache.set(url, url);
    return url;
  }
}

export interface TextSegment {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Per-character viewport-absolute x offsets (one entry per visible char in
   * `text`). When provided, renderers anchor each glyph at xOffsets[i] instead
   * of summing fontkit advances — closing the per-char drift that accumulates
   * over long paragraphs. May be undefined when capture couldn't produce it
   * (e.g. input/textarea values).
   */
  xOffsets?: number[];
  /** Override color for this segment (e.g. ::before / ::after pseudos whose
   *  CSS `color` differs from the element's). Renderer uses parent fill when
   *  undefined. */
  color?: string;
  /** Override font-size in CSS pixels (e.g. abbr[title]::after { font-size: 0.9em }).
   *  Undefined means inherit from the element. */
  fontSize?: number;
  /** Override font-weight (e.g. li[data-badge]::before { font-weight: bold }).
   *  Undefined means inherit from the element. */
  fontWeight?: string;
  /**
   * Override fontBoundingBoxAscent (px) when the segment uses a font/size
   * different from the element (::before / ::after with custom font-size).
   * Renderer falls back to the element's fontAscent when this is undefined.
   */
  fontAscent?: number;
  /**
   * Viewport-relative rectangle (CSS pixels) to screenshot when the WHOLE
   * segment is raster-worthy — used for ::before / ::after pseudos whose
   * entire text is a color-bitmap run. Populated by CAPTURE_SCRIPT;
   * captureElementTree fills in rasterDataUri. Renderer emits one <image>
   * covering rasterRect and skips the text pipeline entirely. See SK-1058.
   */
  rasterRect?: { x: number; y: number; width: number; height: number };
  /** data:image/png;base64,… populated by Node-side raster. Renderer checks this. */
  rasterDataUri?: string;
  /**
   * Per-character raster overlays for emoji / color-bitmap codepoints mixed
   * into an otherwise path-rendered text run (SK-1090). Each entry pins the
   * char's exact viewport-relative rect; rasterizeBitmapGlyphs fills in
   * dataUri, and the renderer stamps an <image> on top of the path text at
   * that rect. Path emission for the underlying glyph is left intact — the
   * <image> overlays wherever needed, and for pure-emoji codepoints the path
   * pipeline emits nothing anyway (zero-contour glyph from fontkit).
   */
  rasterGlyphs?: Array<{
    charIndex: number;
    rect: { x: number; y: number; width: number; height: number };
    dataUri?: string;
  }>;
}

export interface CapturedElement {
  tag: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * If the source DOM had `data-domotion-anim="<id>"` on this element, the id
   * is captured here. The renderer surfaces it as `class="anim-<id>"` on the
   * rendered group so an intra-frame animation (DM-209) can target it via CSS
   * keyframes. The animator (or CLI wrapper) is responsible for setting the
   * data attribute on the live DOM before capture.
   */
  animId?: string;
  styles: {
    backgroundColor: string;
    borderColor: string;
    borderWidth: string;
    borderRadius: string;
    /**
     * Resolved per-corner border-radius (top-left, top-right, bottom-right,
     * bottom-left). Chrome returns longhand corner values in pixels even when
     * the author used percentages, so capturing these lets the renderer pick
     * a circle radius for `border-radius: 50%` instead of treating the "50"
     * from the shorthand as a 50-px corner. See SK-1093.
     */
    borderTopLeftRadius?: string;
    borderTopRightRadius?: string;
    borderBottomRightRadius?: string;
    borderBottomLeftRadius?: string;
    /** Per-side border widths as strings (e.g. "6px"). All set together so we can decide uniform-vs-split in the renderer. */
    borderTopWidth: string;
    borderRightWidth: string;
    borderBottomWidth: string;
    borderLeftWidth: string;
    borderTopStyle: string;
    borderRightStyle: string;
    borderBottomStyle: string;
    borderLeftStyle: string;
    borderTopColor: string;
    borderRightColor: string;
    borderBottomColor: string;
    borderLeftColor: string;
    /**
     * For table cells: `"collapse"` means the parent table sets
     * `border-collapse: collapse` so adjacent cells share a single painted
     * border instead of stacking two adjacent ones. The renderer paints
     * cell borders centered on the cell edge (no half-inset) in this mode
     * so that two cells'\'' shared edges overlap exactly into one line
     * instead of doubling.
     */
    borderCollapse: string;
    overflowX: string;
    overflowY: string;
    scrollbarGutter: string;
    /** el.scrollHeight / scrollWidth vs client* — used to decide whether to paint a scrollbar. */
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
    scrollTop: number;
    scrollLeft: number;
    objectFit: string;
    objectPosition: string;
    filter: string;
    backdropFilter: string;
    mixBlendMode: string;
    clipPath: string;
    mask: string;
    maskImage: string;
    maskMode: string;
    maskSize: string;
    maskPosition: string;
    maskRepeat: string;
    maskComposite: string;
    listStyleType: string;
    listStyleImage: string;
    listStylePosition: string;
    backgroundImage: string;
    backgroundSize: string;
    backgroundPosition: string;
    backgroundRepeat: string;
    backgroundClip: string;
    backgroundOrigin: string;
    backgroundAttachment: string;
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
    /** Intrinsic dimensions per background-image layer (same order as splitTopLevelCommas). */
    backgroundIntrinsic?: Array<{ w: number; h: number } | null>;
    borderImageSource: string;
    borderImageSlice: string;
    borderImageWidth: string;
    borderImageOutset: string;
    borderImageRepeat: string;
    /** Intrinsic pixel dimensions of a border-image url() source, resolved at capture time. */
    borderImageIntrinsicWidth?: number;
    borderImageIntrinsicHeight?: number;
    zIndex: string;
    position: string;
    float: string;
    /** For <td>/<th> with empty-cells: hide — suppress bg + border. */
    emptyCellsHidden?: boolean;
    /** Form-control state captured so we can synthesize native chrome. */
    inputType?: string;
    checked?: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    progressValue?: number;
    progressMax?: number;
    /** Custom CSS on ::-webkit-progress-bar (the track) — when set, overrides the default track. */
    progressBarBg?: string;
    progressBarBgImage?: string;
    progressBarRadius?: string;
    /** Custom CSS on ::-webkit-progress-value (the fill) — when set, overrides the synthesized fill. */
    progressValueBg?: string;
    progressValueBgImage?: string;
    progressValueRadius?: string;
    meterValue?: number;
    meterMin?: number;
    meterMax?: number;
    meterLow?: number;
    meterHigh?: number;
    meterOptimum?: number;
    /** Custom CSS on ::-webkit-meter-bar / ::-webkit-meter-*-value pseudo-elements. */
    meterBarBg?: string;
    meterBarBgImage?: string;
    meterBarRadius?: string;
    meterOptimumBg?: string;
    meterOptimumBgImage?: string;
    meterSuboptimumBg?: string;
    meterSuboptimumBgImage?: string;
    meterEvenLessGoodBg?: string;
    meterEvenLessGoodBgImage?: string;
    detailsOpen?: boolean;
    selectChevron?: boolean;
    accentColor?: string;
    caretColor?: string;
    /** For <input type=range/color/date/time/...> — the current value. */
    inputValue?: string;
    inputMin?: string;
    inputMax?: string;
    inputStep?: string;
    /** For <input type=file> — name of the first selected file, or empty. */
    inputFileName?: string;
    /** Custom-styled <input type=range> ::-webkit-slider-runnable-track / ::-webkit-slider-thumb (SK-1131). */
    rangeTrackBg?: string;
    rangeTrackHeight?: string;
    rangeTrackRadius?: string;
    /** Resolved gradient text for the slider track (SK-1224). Captured when the rule sets background or background-image to a *-gradient(). */
    rangeTrackBgImage?: string;
    rangeThumbBg?: string;
    rangeThumbWidth?: string;
    rangeThumbHeight?: string;
    rangeThumbRadius?: string;
    /** Resolved gradient text for the slider thumb (SK-1224). */
    rangeThumbBgImage?: string;
    /** ::-webkit-color-swatch pseudo styles (SK-1223). */
    colorSwatchBg?: string;
    colorSwatchBgImage?: string;
    colorSwatchBorder?: string;
    colorSwatchRadius?: string;
    colorSwatchWrapperPadding?: string;
    /** ::-webkit-inner-spin-button pseudo styles (SK-1223; capture only — renderer pickup is a follow-up). */
    numberSpinButtonBg?: string;
    numberSpinButtonBorder?: string;
    numberSpinButtonRadius?: string;
    /** ::-webkit-search-cancel-button pseudo styles (SK-1223; capture only — renderer pickup is a follow-up). */
    searchCancelButtonBg?: string;
    searchCancelButtonBorder?: string;
    searchCancelButtonRadius?: string;
    /** For <input type=file> — captured ::file-selector-button pseudo styles. */
    fileButtonBg?: string;
    fileButtonColor?: string;
    fileButtonBorder?: string;
    fileButtonBorderRadius?: string;
    fileButtonPadding?: string;
    fileButtonFontWeight?: string;
    /** CSS outline (drawn outside the border-box, doesn't take layout space). */
    outlineStyle?: string;
    outlineWidth?: string;
    outlineColor?: string;
    outlineOffset?: string;
    /** CSS box-shadow (raw value: outset/inset, x y blur spread color, comma-separated). */
    boxShadow?: string;
    /** CSS text-shadow (raw value: x y blur color, comma-separated; no inset/spread). */
    textShadow?: string;
    /** CSS transform (e.g. `rotate(30deg)`, `scale(1.5)`, `matrix(1,0,0,1,0,0)`). 'none' → no transform. */
    transform?: string;
    /** CSS transform-origin resolved to pixel pair (e.g. `60px 30px`). Defaults to '50% 50%' = bbox center. */
    transformOrigin?: string;
    /** CSS writing-mode (`horizontal-tb` | `vertical-rl` | `vertical-lr` | `sideways-rl` | `sideways-lr`). */
    writingMode?: string;
    /** CSS text-orientation (`mixed` | `upright` | `sideways`). Used in vertical writing-modes. */
    textOrientation?: string;
    color: string;
    fontSize: string;
    fontFamily: string;
    fontWeight: string;
    /** 'italic' | 'oblique' | 'normal' — drives the SF Pro slnt axis in
     *  text-to-path so <em>, <i>, [style=font-style:italic] etc. render
     *  slanted instead of upright. */
    fontStyle?: string;
    opacity: string;
    lineHeight: string;
    letterSpacing: string;
    fontKerning: string;
    fontStretch: string;
    fontVariationSettings: string;
    fontFeatureSettings: string;
    /** CSS direction ('ltr' / 'rtl'). Drives BiDi reordering on RTL paragraphs. */
    direction?: string;
    /** `text-decoration-line` — 'underline', 'line-through', 'overline', or
     *  combinations. 'none' means no decoration; renderer draws an SVG line
     *  below / through / above the text when present. */
    textDecorationLine?: string;
    /** `text-decoration-color` — color for the decoration line. Falls back to
     *  the element's text color when undefined. */
    textDecorationColor?: string;
    /** `text-decoration-style` — 'solid' / 'dashed' / 'dotted' / 'double' /
     *  'wavy'. Undefined or 'solid' = plain line. */
    textDecorationStyle?: string;
  };
  children: CapturedElement[];
  imageSrc?: string;
  /** Intrinsic pixel dimensions of <img>, used for object-fit: none. */
  imageIntrinsic?: { w: number; h: number };
  /** Intrinsic pixel dimensions of list-style-image on <li>. */
  listMarkerIntrinsic?: { w: number; h: number };
  /** 1-based list-item counter value used to format numeric/alpha markers. */
  listItemIndex?: number;
  /** Computed ::marker pseudo styles when set on an <li>. CSS lets authors
   *  recolor / re-weight / resize the marker independent of the list item
   *  text (e.g. li::marker { color: #ea580c; font-weight: bold }). See
   *  SK-1115. */
  markerColor?: string;
  markerFontWeight?: string;
  markerFontSize?: string;
  /** ::before / ::after pseudo-element image content (content: url(...)). */
  pseudoImages?: Array<{ url: string; x: number; y: number; width: number; height: number }>;
  svgContent?: string;
  /** Individual text node segments (for mixed content with interleaved child elements) */
  textSegments?: TextSegment[];
  /** Bounding box of all text (union of segments) */
  textTop?: number;
  textLeft?: number;
  textHeight?: number;
  textWidth?: number;
  /**
   * Chrome's `canvas.measureText().fontBoundingBoxAscent` for the element's
   * computed font (px, integer-rounded). This is the exact distance Chrome
   * paints from line-box top to baseline — reading it from the browser
   * sidesteps the fontkit-vs-Chrome metric divergence (Helvetica/Arial/Times
   * etc on macOS use winAscent, not hhea, while SF Pro has equal metrics; the
   * "right metric per font" is fragile to derive but trivial to measure).
   */
  fontAscent?: number;
  fontDescent?: number;
  /**
   * Per-char x positions for input/textarea value text (SK-1234), measured
   * via a hidden DOM probe with the same font/value. Lets the renderer
   * anchor each glyph at the position Chromium would paint instead of
   * trusting fontkit's native advances (which can drift up to ~0.5px per
   * char vs HarfBuzz). One entry per UTF-16 code unit; viewport-relative.
   */
  inputXOffsets?: number[];
  /** Rasterized text as PNG data URI (rendered via canvas for cross-browser consistency) */
  textImageUri?: string;
  /** Scale factor used for text rasterization (e.g. 2 for retina) */
  textImageScale?: number;
  /**
   * True when `text` came from an input/textarea `placeholder=…` attribute
   * (value was empty). Renderer paints the text in placeholderColor instead
   * of the normal text color. See SK-1097 / SK-1100.
   */
  isPlaceholderText?: boolean;
  /** Computed ::placeholder color (normalized). Set when isPlaceholderText. */
  placeholderColor?: string;
  /** Computed ::placeholder font-style (e.g. italic). Set when isPlaceholderText. */
  placeholderFontStyle?: string;
  /** Computed ::placeholder font-weight. Set when isPlaceholderText. */
  placeholderFontWeight?: string;
  /**
   * Viewport-relative rect of the element's internal content area (minus
   * borders + padding) that rasterizeBitmapGlyphs should screenshot and
   * stash on dataUri for the renderer to stamp in place of path text. Used
   * for <textarea> whose soft-wrap text layout is too involved to replicate
   * in the path pipeline (see SK-1108) — rely on Chrome's own render of the
   * content region. Detection happens in CAPTURE_SCRIPT.
   */
  elementRaster?: { x: number; y: number; width: number; height: number; dataUri?: string };
}

// Browser-side capture code as a string to avoid tsx __name transform issues
const CAPTURE_SCRIPT = `
(args) => {
  const sel = args.sel;
  const vp = args.vp;

  // Normalize any CSS <color> value (named, #hex, hsl, hwb, lab/lch, oklab/oklch,
  // color(), color-mix(), etc.) to an srgb form parseColor() can consume.
  // We use a hidden probe element with 'color-mix(in srgb, <c> 100%, transparent 0%)'
  // — a trick that forces getComputedStyle() to resolve wide-gamut inputs into
  // 'color(srgb r g b / alpha)' or 'rgb()/rgba()' form. Canvas fillStyle works for
  // srgb colors but silently rejects lab/lch/oklab/oklch/color(), so we avoid it.
  const _normProbe = document.createElement('div');
  _normProbe.style.position = 'absolute'; _normProbe.style.visibility = 'hidden';
  document.body.appendChild(_normProbe);

  // Walk document.styleSheets and collect rules that target any of the
  // supported WebKit form-control shadow pseudos (SK-1131, SK-1138, SK-1222).
  //
  // Original problem: getComputedStyle(el, '::-webkit-slider-thumb') in
  // Chromium returns the HOST element's computed style for these
  // UA-internal pseudos rather than the pseudo's cascaded value — so
  // width: 22px on the thumb rule came back as the host's width:100%
  // (~544px) and the renderer drew a giant pill instead of a small thumb.
  // SK-1193 confirmed the same quirk affects every WebKit-internal input,
  // progress, and meter pseudo (the only exception is ::file-selector-button
  // which is a real shadow-DOM element). Reading rules directly via
  // document.styleSheets avoids the quirk uniformly.
  //
  // var() and calc() expressions are resolved at apply-time by probing the
  // host element's inline style (SK-1191) — the host has the same custom
  // properties in scope as the pseudo. State pseudos
  // (:hover/:active/:focus/:focus-visible/:focus-within/:disabled) ARE
  // supported (SK-1192) — rules with these in the host selector are
  // collected like any other and el.matches(hostSel) at apply-time decides
  // whether each rule applies given the element's current DOM state.
  // Gradient backgrounds (linear + radial) round-trip via the renderer's
  // gradient-def pipeline (SK-1224 / SK-1225 / SK-1226).
  //
  // Pseudo "kind" names are short stable identifiers used by the renderer
  // to look up captured fields. The regex below maps each WebKit selector
  // to its kind.
  const _pseudoKindRe = /^(.*?)::?(-webkit-slider-runnable-track|-webkit-slider-thumb|-webkit-progress-bar|-webkit-progress-value|-webkit-meter-bar|-webkit-meter-optimum-value|-webkit-meter-suboptimum-value|-webkit-meter-even-less-good-value|-webkit-color-swatch|-webkit-color-swatch-wrapper|-webkit-inner-spin-button|-webkit-search-cancel-button)$/;
  const _kindMap = {
    '-webkit-slider-runnable-track': 'track',
    '-webkit-slider-thumb': 'thumb',
    '-webkit-progress-bar': 'progress-bar',
    '-webkit-progress-value': 'progress-value',
    '-webkit-meter-bar': 'meter-bar',
    '-webkit-meter-optimum-value': 'meter-optimum',
    '-webkit-meter-suboptimum-value': 'meter-suboptimum',
    '-webkit-meter-even-less-good-value': 'meter-even-less-good',
    '-webkit-color-swatch': 'color-swatch',
    '-webkit-color-swatch-wrapper': 'color-swatch-wrapper',
    '-webkit-inner-spin-button': 'inner-spin-button',
    '-webkit-search-cancel-button': 'search-cancel-button',
  };
  const _pseudoRules = [];
  const _collectPseudoRules = (rules) => {
    if (rules == null) return;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule == null) continue;
      const selectorText = rule.selectorText;
      if (typeof selectorText === 'string') {
        const selectors = selectorText.split(',').map(function (s) { return s.trim(); });
        for (let j = 0; j < selectors.length; j++) {
          const sel = selectors[j];
          const m = sel.match(_pseudoKindRe);
          if (m == null) continue;
          const kind = _kindMap[m[2]];
          if (kind == null) continue;
          const hostSel = m[1].trim();
          _pseudoRules.push({ kind: kind, hostSel: hostSel, decl: rule.style });
        }
      }
      if (rule.cssRules != null && rule.cssRules.length > 0) _collectPseudoRules(rule.cssRules);
    }
  };
  for (let _si = 0; _si < document.styleSheets.length; _si++) {
    try { _collectPseudoRules(document.styleSheets[_si].cssRules); } catch (e) { /* CORS — skip */ }
  }
  // Resolve a pseudo's cascaded declarations for an element by applying
  // matching rules in source order (later rules win per property). Specificity
  // is approximated as source order — adequate for a single author stylesheet.
  const _firstColorRe = /(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\)|hsla?\\([^)]*\\)|\\b(?:white|black|red|green|blue|yellow|purple|orange|gray|grey|currentColor)\\b)/;
  const _isUnsetCssValue = (v) => v === '' || v === 'initial' || v === 'inherit' || v === 'unset' || v === 'revert';
  // Resolve var() and calc() in a declared rule value by temporarily applying
  // it to the host's inline style and reading the computed value back
  // (SK-1191). The host has the same CSS variables in scope as the pseudo
  // (custom props inherit through the shadow boundary), so values like
  // var(--thumb-size) or calc(var(--track-h) * 2) resolve correctly.
  // Limitations: percentage values resolve against the host's containing
  // block, not the pseudo's, and width/height: 100% on a thumb especially can
  // come out wrong — but the common authoring patterns (var-driven tokens,
  // calc with px units) round-trip faithfully.
  const _needsResolve = (v) => v != null && v !== '' && (v.indexOf('var(') >= 0 || v.indexOf('calc(') >= 0);
  const _propMap = { backgroundColor: 'background-color', backgroundImage: 'background-image', borderRadius: 'border-radius', width: 'width', height: 'height' };
  const _resolveOne = (host, propKey, value) => {
    if (!_needsResolve(value)) return value;
    const cssProp = _propMap[propKey] || propKey;
    const saved = host.style.getPropertyValue(cssProp);
    const savedPriority = host.style.getPropertyPriority(cssProp);
    host.style.setProperty(cssProp, value);
    const resolved = window.getComputedStyle(host).getPropertyValue(cssProp);
    if (saved === '') host.style.removeProperty(cssProp);
    else host.style.setProperty(cssProp, saved, savedPriority);
    return resolved !== '' ? resolved : value;
  };
  // Detect whether a value is a CSS gradient function (linear/radial/conic
  // and their repeating variants). Used to capture rangeTrackBgImage etc.
  // SK-1224: linear-gradient ships first; SK-1225 adds radial.
  const _gradientRe = /^\\s*(repeating-)?(linear|radial|conic)-gradient\\s*\\(/i;
  const _resolvePseudo = (el, kind) => {
    let width = '', height = '', backgroundColor = '', borderRadius = '', backgroundImage = '';
    let border = '', padding = '';
    let matched = false;
    for (let i = 0; i < _pseudoRules.length; i++) {
      const r = _pseudoRules[i];
      if (r.kind !== kind) continue;
      let isMatch = false;
      try { isMatch = el.matches(r.hostSel); } catch (e) { /* invalid selector */ }
      if (!isMatch) continue;
      matched = true;
      const d = r.decl;
      if (!_isUnsetCssValue(d.width)) width = d.width;
      if (!_isUnsetCssValue(d.height)) height = d.height;
      if (!_isUnsetCssValue(d.borderRadius)) borderRadius = d.borderRadius;
      if (!_isUnsetCssValue(d.border)) border = d.border;
      if (!_isUnsetCssValue(d.padding)) padding = d.padding;
      // background-color longhand expands to 'initial' when the rule only
      // declared the 'background' shorthand with a non-color value (e.g. a
      // gradient). In that case fall through to extracting the first color
      // stop from the shorthand string.
      if (!_isUnsetCssValue(d.backgroundColor)) {
        backgroundColor = d.backgroundColor;
      } else if (!_isUnsetCssValue(d.background)) {
        const cm = d.background.match(_firstColorRe);
        if (cm != null) backgroundColor = cm[1];
        // Shorthand of the form 'background: var(--accent)' that references a
        // solid color via a custom property: the regex won't match var(), but
        // probing the host's background-color longhand resolves it.
        else if (_needsResolve(d.background)) backgroundColor = d.background;
      }
      // Gradient capture (SK-1224). Two sources: the background-image
      // longhand, or a gradient function within the background shorthand.
      // The shorthand commonly carries gradients in author CSS
      // ('background: linear-gradient(...)'). Prefer longhand when set.
      if (!_isUnsetCssValue(d.backgroundImage) && _gradientRe.test(d.backgroundImage)) {
        backgroundImage = d.backgroundImage;
      } else if (!_isUnsetCssValue(d.background) && _gradientRe.test(d.background)) {
        backgroundImage = d.background;
      }
    }
    return {
      matched: matched,
      width: _resolveOne(el, 'width', width),
      height: _resolveOne(el, 'height', height),
      backgroundColor: _resolveOne(el, 'backgroundColor', backgroundColor),
      borderRadius: _resolveOne(el, 'borderRadius', borderRadius),
      // Resolve var()/calc() inside gradient text via the same host-probe
      // (Chromium rewrites the gradient to fully-resolved rgb()/deg form).
      backgroundImage: _resolveOne(el, 'backgroundImage', backgroundImage),
      border: border,
      padding: padding,
    };
  };

  // Codepoint predicate for glyphs Chrome paints via a color-bitmap font
  // (Apple Color Emoji on macOS, Noto Color Emoji on Linux) even when a
  // path-font has a glyph. fontkit cannot emit a <path> from CBDT/sbix bitmap
  // tables, so these need to be rasterized via page.screenshot and embedded
  // as <image>. See SK-1058.
  //
  // Narrow scope on purpose: the Miscellaneous-Symbols / Geometric-Shapes /
  // Arrows blocks have path glyphs in Apple Symbols that render faithfully
  // (e.g. ⚑ U+2691, → U+2192), so they stay on the path pipeline. The list
  // below is codepoints we've observed Chrome routing to the emoji font
  // despite path availability (checkmark family), plus the canonical emoji
  // planes (U+1F300+).
  const _rasterCps = new Set([0x2713, 0x2714, 0x2716, 0x2717, 0x2757]);
  const needsRaster = (cp) => {
    if (_rasterCps.has(cp)) return true;
    // Regional-indicator flags (pairs are joined into country flag emoji).
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;
    // Main emoji blocks: Misc Symbols & Pictographs, Emoticons, Transport &
    // Map, Alchemical, Supplemental Symbols & Pictographs, Pictographs
    // Extended-A, Symbols & Pictographs Extended-B.
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
    return false;
  };
  const textNeedsRaster = (s) => {
    for (let i = 0; i < s.length; i++) {
      const cp = s.codePointAt(i);
      if (needsRaster(cp)) return true;
      if (cp > 0xFFFF) i++;
    }
    return false;
  };

  // Per-font baseline metric cache. fontkit's font.ascent (HHEA) does not
  // match where Chrome paints the baseline on macOS for the legacy MS-shipped
  // fonts (Helvetica, Arial, Times, Georgia, Menlo, Courier) — Chrome uses
  // OS/2.usWinAscent there, not HHEA. Reading the answer from
  // canvas.measureText().fontBoundingBoxAscent dodges the per-font metric-
  // selection rules entirely (the browser already applied them). Cached by
  // resolved font spec to avoid recreating canvases per element.
  const _fontMetricsCache = new Map();
  const _measureFontMetrics = (cs) => {
    // Compose a stable key matching what canvas font shorthand will normalize
    // to. fontStyle / fontWeight / fontSize / fontFamily are the inputs that
    // affect the ascent value.
    const fs = cs.fontStyle || 'normal';
    const fw = cs.fontWeight || '400';
    const fz = cs.fontSize || '14px';
    const ff = cs.fontFamily || 'sans-serif';
    const key = fs + '|' + fw + '|' + fz + '|' + ff;
    let v = _fontMetricsCache.get(key);
    if (v != null) return v;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    // Canvas font shorthand: <style> <weight> <size> <family>
    ctx.font = fs + ' ' + fw + ' ' + fz + ' ' + ff;
    // 'Mxgp' picks up cap, x-height, and descender — fontBoundingBoxAscent is
    // font-wide max so the exact string only matters as a non-empty input.
    const m = ctx.measureText('Mxgp');
    v = { ascent: m.fontBoundingBoxAscent, descent: m.fontBoundingBoxDescent };
    _fontMetricsCache.set(key, v);
    return v;
  };

  // Unsupported-feature warnings. Collected during capture and returned to the
  // Node-side caller. Deduped by (feature, selector). See SK-465.
  const _warnings = [];
  const _warnKeys = new Set();
  const warn = (sel, feature, detail) => {
    const k = feature + '|' + sel;
    if (_warnKeys.has(k)) return;
    _warnKeys.add(k);
    _warnings.push({ selector: sel, feature, detail });
  };
  // Build a short CSS-selectorish path for an element. Not guaranteed unique;
  // just enough context for a developer to find it.
  const shortSelector = (el) => {
    const parts = [];
    let cur = el;
    while (cur != null && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += '#' + cur.id; parts.unshift(p); break; }
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\\s+/).slice(0, 2).join('.');
        if (cls !== '') p += '.' + cls;
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const normColor = (c) => {
    if (c == null || c === '' || c === 'transparent' || c === 'currentcolor' || c === 'auto') return c;
    // Fast path: already in rgb/rgba/#hex form.
    if (/^(rgba?\\(|#[0-9a-f]{3,8}$)/i.test(c)) return c;
    try {
      _normProbe.style.color = '';
      _normProbe.style.color = 'color-mix(in srgb, ' + c + ' 100%, transparent 0%)';
      const v = getComputedStyle(_normProbe).color;
      if (v != null && v !== '') return v;
    } catch (e) { /* fall through */ }
    return c;
  };

  const capture = (el) => {
    // For elements with a CSS transform, getBoundingClientRect (and per-char
    // Range rects, child rects, etc.) all return *post-transform* viewport
    // coordinates. Re-applying our own transform on top would double-rotate.
    // So when transform != none, clear the inline transform for the entire
    // capture of this element (including children and per-char text rects),
    // then restore at the end. CSS transforms dont participate in layout, so
    // this doesnt reflow the document. The renderer applies the saved
    // transform back via the SVG group wrapper. See SK-1134.
    //
    // CSSStyleDeclaration is LIVE — snapshot the original transform value
    // BEFORE clearing or our captured tree would record transform: 'none'
    // and the renderer would skip emitting the SVG transform.
    const cs = window.getComputedStyle(el);
    const originalTransform = cs.transform;
    const originalTransformOrigin = cs.transformOrigin;
    const hasTransform = originalTransform && originalTransform !== 'none';
    const savedInlineTransform = hasTransform ? el.style.transform : null;
    if (hasTransform) el.style.transform = 'none';
    const result = captureInner(el, cs, hasTransform ? originalTransform : null, hasTransform ? originalTransformOrigin : null);
    if (hasTransform) el.style.transform = savedInlineTransform;
    return result;
  };
  const captureInner = (el, cs, frozenTransform, frozenTransformOrigin) => {
    const rect = el.getBoundingClientRect();
    if (rect.right < vp.x || rect.bottom < vp.y || rect.left > vp.x + vp.width || rect.top > vp.y + vp.height) return null;

    if (cs.display === 'none' || cs.visibility === 'hidden') return null;

    // Zero-sized elements — skip visual rendering of the element itself but
    // still walk children. Elements with all position:absolute children
    // collapse to 0 height (absolutes don't contribute to layout) — those
    // children still need to be captured and painted.
    const zeroSized = rect.width === 0 || rect.height === 0;
    // Skip empty zero-sized elements UNLESS they're tagged for an intra-frame
    // animation — an animated element starting at width: 0 should still be
    // captured so the renderer can emit its anim-class wrapper. (DM-209.)
    const _hasAnim = el.dataset != null && el.dataset.domotionAnim != null && el.dataset.domotionAnim !== '';
    if (zeroSized && el.children.length === 0 && !_hasAnim) return null;

    const tag = el.tagName.toLowerCase();

    // Emit warnings for features domotion can't fully round-trip. Keep
    // these short and actionable — consumers (CLI, tests, demo scripts) log
    // them so the fidelity gaps are self-documenting.
    const sel = shortSelector(el);
    if (cs.transform && cs.transform.startsWith('matrix3d')) {
      warn(sel, 'transform-3d', 'matrix3d/translate3d/rotate3d/perspective downgraded to 2D submatrix; z component + perspective dropped (SK-1135)');
    }
    if (cs.backdropFilter && cs.backdropFilter !== 'none') {
      warn(sel, 'backdrop-filter', 'captured but not emitted — no SVG equivalent');
    }
    // writing-mode != horizontal-tb is handled via elementRaster (SK-1128)
    // — the text region is screenshot-rasterized so vertical text and
    // sideways glyph rotation come from Chromes own paint. No warning.
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      warn(sel, 'position:' + cs.position, 'rendered as a static snapshot at t=0; scroll-following behavior is not animated');
    }
    if (cs.mask && cs.mask !== 'none' && cs.mask !== '') {
      warn(sel, 'mask', 'captured but not emitted — mask sources need coordinate-aware emission');
    }
    if (cs.borderImageSource && cs.borderImageSource !== 'none') {
      warn(sel, 'border-image', '9-slice composition pending (SK-466); border-image-source ignored');
    }
    if (tag === 'iframe' || tag === 'canvas' || tag === 'video' || tag === 'object' || tag === 'embed') {
      warn(sel, '<' + tag + '>', 'element type is not rendered by domotion');
    }
    // Scrollbars appear when content overflows a non-visible overflow container.
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll' || cs.overflowY === 'auto' || cs.overflowY === 'scroll')
        && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      warn(sel, 'scrollbar', 'native scrollbar chrome not emulated yet (SK-468); content is clipped but no scroll indicator');
    }
    // Conic gradients have no SVG equivalent.
    if (cs.backgroundImage && /conic-gradient/i.test(cs.backgroundImage)) {
      warn(sel, 'conic-gradient', 'SVG has no conic gradient; layer falls back to nothing');
    }
    // text-align: justify combined with wrapping — renderer doesn't space-stretch.
    if (cs.textAlign === 'justify') {
      warn(sel, 'text-align:justify', 'path-mode renderer does not space-stretch justified text');
    }
    let text = '';
    let imageSrc = undefined;
    let svgContent = undefined;

    let textTop = 0;
    let textLeft = 0;
    let textHeight = 0;
    let textWidth = 0;
    let fontAscent = 0;
    let fontDescent = 0;
    let inputXOffsets;
    const textSegments = [];
    // ::before / ::after generated content. Each pseudo's content is captured
    // as an extra TextSegment positioned relative to the element's text box.
    // Handles string literals and attr() lookups; url()/counter()/open-quote
    // are out of scope (warn on the last two).
    const pseudoSegments = [];
    for (const pseudo of ['::before', '::after']) {
      const pcs = window.getComputedStyle(el, pseudo);
      const content = pcs.content;
      if (content == null || content === 'none' || content === 'normal' || content === '') continue;
      // Parse content string. CSS concatenates mixed forms:
      //   "literal"  attr(x)  url(foo)  counter(name)  open-quote
      // Handled: string literals, attr(), url() (rendered as <image>).
      // Not handled: counter() (needs list-counter tracking).
      let text = '';
      let imageUrl = '';
      let i = 0;
      while (i < content.length) {
        const c = content[i];
        if (c === '"' || c === "'") {
          const end = content.indexOf(c, i + 1);
          if (end < 0) break;
          text += content.slice(i + 1, end);
          i = end + 1;
        } else if (content.startsWith('attr(', i)) {
          const end = content.indexOf(')', i);
          if (end < 0) break;
          const attrName = content.slice(i + 5, end).trim();
          text += el.getAttribute(attrName) || '';
          i = end + 1;
        } else if (content.startsWith('url(', i)) {
          const end = content.indexOf(')', i);
          if (end < 0) break;
          let url = content.slice(i + 4, end).trim();
          // Strip surrounding quotes.
          if ((url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"))) {
            url = url.slice(1, -1);
          }
          imageUrl = url;
          i = end + 1;
        } else {
          i++;
        }
      }
      if (text === '' && imageUrl === '') continue;

      // url() content -> emit as an image pseudo. Chrome decouples LAYOUT from
      // RENDER: the CSS box (pcs.width / pcs.height) drives how far following
      // inline text is shifted, but the image itself paints at its INTRINSIC
      // dimensions regardless of the CSS box — overflowing down/right when the
      // box is smaller than intrinsic (see SK-1057). We track both: seg.width/
      // height carry the LAYOUT box; renderWidth/renderHeight carry the paint
      // size for the <image> element.
      if (imageUrl !== '' && text === '') {
        const probeImg = new Image();
        probeImg.src = imageUrl;
        // Playwright waits for the load event before capture, so the image is
        // already decoded and naturalWidth/Height resolve synchronously from
        // cache.
        const intrinsicW = probeImg.naturalWidth || 0;
        const intrinsicH = probeImg.naturalHeight || 0;
        let layoutW = parseFloat(pcs.width) || 0;
        let layoutH = parseFloat(pcs.height) || 0;
        if (layoutW <= 0) layoutW = intrinsicW || 24;
        if (layoutH <= 0) layoutH = intrinsicH || 24;
        const renderW = intrinsicW > 0 ? intrinsicW : layoutW;
        const renderH = intrinsicH > 0 ? intrinsicH : layoutH;
        const elTop = rect.top - vp.y + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
        const elLeft = rect.left - vp.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
        const elFontSizeForImg = parseFloat(pcs.fontSize) || 14;
        const lineHImg = parseFloat(pcs.lineHeight) || elFontSizeForImg * 1.2;
        // Vertically center the LAYOUT box in the line (vertical-align: middle
        // baseline); the image paints from this anchor at render dims, which
        // may overflow downward.
        const yPosImg = elTop + (lineHImg - layoutH) / 2;
        pseudoSegments.push({
          isBefore: pseudo === '::before',
          imageUrl,
          seg: { text: '', x: elLeft, y: yPosImg, width: layoutW, height: layoutH },
          renderWidth: renderW,
          renderHeight: renderH,
          color: pcs.color,
        });
        continue;
      }
      if (text === '') continue;
      // Measure via canvas using the pseudo's computed font.
      const m = /^(italic|normal|oblique)?\\s*(?:small-caps\\s+)?(bold|normal|[\\d]+)?\\s*([\\d.]+px)\\s*(.*)$/i.exec(pcs.font || ('' + pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily));
      const fontSpec = pcs.font || (pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily);
      void m;
      const measureCanvas = document.createElement('canvas');
      const mctx = measureCanvas.getContext('2d');
      mctx.font = fontSpec;
      const pseudoWidth = mctx.measureText(text).width;
      // Position: ::before sits at the START of the element's text/content.
      // ::after sits at the END. We use the element's textLeft/textWidth if
      // available, otherwise fall back to (el.x, el.y + padTop).
      const elTop = rect.top - vp.y + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
      const elLeft = rect.left - vp.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
      const elFontSize = parseFloat(pcs.fontSize) || 14;
      const lineH = parseFloat(pcs.lineHeight) || elFontSize * 1.2;
      const yPos = elTop + (lineH - elFontSize) / 2;
      // For ::before: place at the element's content left. The main text that
      // follows is already shifted right by the pseudo's width per Chromium layout.
      // For ::after: place at the END of the element's content — we approximate by
      // using elLeft + (element's intrinsic text width) but we don't know that
      // precisely; Chromium positions ::after right after the last text node.
      // Capture pseudos baseline metric — CSS lets ::before / ::after override
      // font-size independent of the host, so the captured ascent must come
      // from the pseudo's computed font, not the element's. Renderer uses
      // seg.fontAscent when present and falls back to el.fontAscent otherwise.
      const _pseudoMetrics = _measureFontMetrics(pcs);
      const pseudoSeg = {
        text, x: pseudo === '::before' ? elLeft : elLeft + rect.width - pseudoWidth - 2 * (parseFloat(cs.paddingRight) || 0),
        y: yPos, width: pseudoWidth, height: elFontSize,
        // Carry pseudo-specific typography so the renderer can respect
        // per-pseudo color, font-size, font-weight (CSS lets pseudos style
        // independently of their parent — see .stamp::after green check,
        // li[data-badge]::before purple bold badge, etc.).
        color: pcs.color, fontSize: elFontSize, fontWeight: pcs.fontWeight,
        fontAscent: _pseudoMetrics.ascent,
      };
      // If the pseudo contains any codepoint Chrome paints via a color-bitmap
      // font (U+2713 ✓, emoji, etc.), record a page-absolute rect so the
      // Node-side raster can screenshot the exact pixels Chrome produced and
      // swap in an <image> for the path-mode emission. Expand the height to
      // the full line box: emoji glyphs often extend above/below font-size,
      // and the surrounding transparent pixels are harmless under the
      // omitBackground: true screenshot.
      if (textNeedsRaster(text)) {
        // Viewport-relative rect — matches the SVG coordinate system so the
        // renderer can emit <image x=…/> alongside other viewport-local
        // markup. Node-side raster adds vp.x/vp.y when calling
        // page.screenshot (which wants page-absolute pixels).
        pseudoSeg.rasterRect = {
          x: pseudoSeg.x,
          y: elTop,
          width: pseudoWidth,
          height: lineH,
        };
      }
      pseudoSegments.push({ isBefore: pseudo === '::before', seg: pseudoSeg, color: pcs.color });
    }

    // Skip text capture for elements where the child text is fallback content
    // hidden by the browser's shadow-DOM rendering (meter, progress, datalist,
    // option). These fall back to their text only when the element fails to
    // render; on a healthy browser the text is invisible but Range.getClientRects
    // still reports a rect at (0, 0) which would place a stray label at the top
    // of the page.
    const textIsHiddenFallback = tag === 'meter' || tag === 'progress' || tag === 'datalist' || tag === 'option' || tag === 'optgroup';
    if (tag !== 'svg' && tag !== 'img' && !textIsHiddenFallback) {
      // Capture input/textarea values (not in text nodes). For input types
      // whose value is rendered as native chrome (range thumb, color swatch,
      // checkbox tick, radio dot, file button, date picker formatted text)
      // we suppress the raw text capture — form-controls.ts paints those
      // visuals separately, and capturing the raw value here would produce
      // text that overlaps the synthesized chrome with the wrong content
      // (e.g. raw '2026-04-21' under a 'MM/DD/YYYY' date picker).
      const inputType = (tag === 'input') ? (el.type || 'text') : '';
      const skipValueCapture = inputType === 'range' || inputType === 'color'
        || inputType === 'checkbox' || inputType === 'radio'
        || inputType === 'file' || inputType === 'image' || inputType === 'hidden'
        || inputType === 'date' || inputType === 'time' || inputType === 'datetime-local'
        || inputType === 'month' || inputType === 'week';
      // Placeholder fallback: when an input or textarea has no user-typed
      // value but carries a 'placeholder' attribute, Chrome renders the
      // attribute text inside the control in the computed ::placeholder color
      // (default is a muted gray). Capture it the same way we capture the
      // value so the renderer produces the same visible string — just with
      // the placeholder color. See SK-1097 / SK-1100.
      var isPlaceholderCapture = false;
      if ((tag === 'input' || tag === 'textarea') && !el.value && !skipValueCapture) {
        const placeholder = el.getAttribute && el.getAttribute('placeholder');
        if (placeholder != null && placeholder !== '') {
          isPlaceholderCapture = true;
          text = placeholder;
        }
      }
      if (((tag === 'input' || tag === 'textarea') && el.value && !skipValueCapture) || isPlaceholderCapture) {
        // For password inputs replace the raw value with a bullet string the
        // same length so the field reads like Chrome's masked view instead
        // of leaking the plaintext password. (Placeholder text is rendered
        // as-is even on password inputs — Chrome doesn't mask placeholders.)
        if (!isPlaceholderCapture) {
          text = inputType === 'password' ? '•'.repeat(el.value.length) : el.value;
        }
        const pl = parseFloat(cs.paddingLeft) || 0;
        const pt = parseFloat(cs.paddingTop) || 0;
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const bt = parseFloat(cs.borderTopWidth) || 0;
        textLeft = rect.left - vp.x + bl + pl;
        textTop = rect.top - vp.y + bt + pt;
        textHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
        textWidth = rect.width - bl * 2 - pl * 2;
        const _inputMetrics = _measureFontMetrics(cs);
        fontAscent = _inputMetrics.ascent;
        fontDescent = _inputMetrics.descent;
        // Per-char xOffsets via a hidden probe span (SK-1234). Without these
        // the renderer falls back to fontkit's native advances which drift
        // ~0.5px/char vs Chromium's HarfBuzz shaping. The probe replicates
        // the input's font properties (family/size/weight/style/letter-spacing)
        // so per-char Range rects produce the same shaping Chrome would paint.
        if (text.length > 0 && tag === 'input') {
          const probe = document.createElement('span');
          probe.style.position = 'absolute';
          probe.style.left = '-9999px';
          probe.style.top = '-9999px';
          probe.style.visibility = 'hidden';
          probe.style.whiteSpace = 'pre';
          probe.style.fontFamily = cs.fontFamily;
          probe.style.fontSize = cs.fontSize;
          probe.style.fontWeight = cs.fontWeight;
          probe.style.fontStyle = cs.fontStyle;
          probe.style.letterSpacing = cs.letterSpacing;
          probe.style.fontKerning = cs.fontKerning;
          probe.style.fontVariationSettings = cs.fontVariationSettings;
          probe.style.fontFeatureSettings = cs.fontFeatureSettings;
          probe.textContent = text;
          document.body.appendChild(probe);
          const probeNode = probe.firstChild;
          if (probeNode != null) {
            const probeOriginX = probe.getBoundingClientRect().left;
            const xs = [];
            let i = 0;
            while (i < text.length) {
              const code = text.charCodeAt(i);
              const isHigh = code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length;
              const step = isHigh ? 2 : 1;
              const rng = document.createRange();
              rng.setStart(probeNode, i);
              rng.setEnd(probeNode, i + step);
              const cr = rng.getBoundingClientRect();
              const left = cr.left - probeOriginX + textLeft;
              for (let k = 0; k < step; k++) xs.push(left);
              i += step;
            }
            inputXOffsets = xs;
          }
          document.body.removeChild(probe);
        }
      } else {
        // Capture each text node as one segment *per visual line*. For wrapped
        // paragraphs the browser produces multiple line boxes — we walk
        // character-by-character and group runs with matching rect.top into
        // separate segments so the renderer emits one <text>/path row per line.
        // This also handles bidi visual ordering: chars in RTL runs come back
        // right-to-left from getBoundingClientRect, so we sort runs by x within
        // each line.
        let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
        // ::first-letter detection (SK-1114). Compare the pseudos computed
        // font-size against the elements own font-size — when they differ
        // the author has styled ::first-letter (drop cap pattern), and we
        // raster the very first character as a glyph image so its bigger
        // size + custom color paint correctly. Other ::first-letter delta
        // signals (color, weight, etc.) come along for free since the
        // screenshot captures whatever Chrome painted.
        const flStyle = window.getComputedStyle(el, '::first-letter');
        const elFsRaw = parseFloat(cs.fontSize) || 0;
        const flFsRaw = parseFloat(flStyle.fontSize) || 0;
        const firstLetterStyled = flFsRaw > 0 && Math.abs(flFsRaw - elFsRaw) > 0.5;
        let firstCharSeen = false;
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            const raw = node.textContent || '';
            if (!raw.trim()) continue;
            text += raw.trim() + ' ';

            // Group characters by their laid-out line (matching rect.top).
            // Record each char's rect.left so we can sort by visual x within
            // the line at the end — this handles bidi/RTL where chars in a
            // logical sequence are painted right-to-left within a line. Also
            // keep xOffsets so the text renderer can anchor each glyph at the
            // exact viewport x Chrome used (closes per-char advance drift).
            const lines = [];
            let cur = null;
            for (let i = 0; i < raw.length; i++) {
              // Handle UTF-16 surrogate pairs as a single code point so
              // supplementary-plane emoji (🚀 U+1F680, 📈 U+1F4C8, …) get
              // one char record with the emoji's full rect — otherwise the
              // pair splits into a two-char tofu sequence and codePointAt on
              // the low surrogate returns the surrogate value (never matches
              // needsRaster).
              const code = raw.charCodeAt(i);
              const isHighSurrogate = code >= 0xD800 && code <= 0xDBFF && i + 1 < raw.length;
              const step = isHighSurrogate ? 2 : 1;
              const r = document.createRange();
              r.setStart(node, i);
              r.setEnd(node, i + step);
              const cr = r.getBoundingClientRect();
              // Skip whitespace chars Chrome collapsed away (e.g. the second
              // space at a line wrap, where HTML normal whitespace collapsing
              // leaves only one painted space). Such chars report rect.width
              // === 0 even when rect.height matches the line box. Non-
              // whitespace zero-width chars (combining marks like the acute
              // on é) MUST stay in the stream — they pair with the preceding
              // base char during shaping.
              const isWs = step === 1 && /\\s/.test(raw[i]);
              if (cr.width === 0 && (cr.height === 0 || isWs)) { i += step - 1; continue; }
              const ch = raw.slice(i, i + step);
              // Carry each chars full per-char rect so the line-emission
              // pass can build rasterGlyphs for codepoints Chrome paints via
              // a color-bitmap font (emoji, U+2713 check, etc.).
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
            // Preserve DOM/logical order. For an LTR paragraph that's also
            // visual order. For RTL runs Chrome paints chars at non-monotonic
            // x (logical-first goes to visual-right), so xOffsets may zig-zag
            // — the renderer uses per-char anchoring to place each shaped
            // glyph at its captured x. Keeping logical order lets bidi-js's
            // paired-bracket mirroring find matching pairs (BD16 can't
            // recognize pairs in visual-sorted text where a closer may
            // precede its opener).
            for (const ln of lines) {
              // Build text as a straight concatenation of char.ch (each may
              // be 1 or 2 UTF-16 units for surrogate-paired emoji), and
              // expand xOffsets to keep one entry per UTF-16 code unit —
              // downstream text-to-path checks xOffsets.length === text.length,
              // so the low surrogate of an emoji needs a duplicate xOffset
              // entry to preserve that invariant.
              ln.text = ln.chars.map((c) => c.ch).join('');
              const xo = [];
              for (const c of ln.chars) {
                for (let k = 0; k < c.ch.length; k++) xo.push(c.left);
              }
              ln.xOffsets = xo;
            }

            for (const line of lines) {
              // Keep text and xOffsets aligned char-for-char so the renderer's
              // per-char path stays active. Trimming whitespace would drop
              // chars from text while leaving them in xOffsets, breaking the
              // length-equality check and forcing fallback to native fontkit
              // advances (which drift wide vs Chrome). Browser-collapsed
              // whitespace already has zero rect width and is excluded above;
              // any whitespace still present here is real layout space.
              const visualText = line.text.replace(/[\\t\\n\\r]/g, ' ');
              if (visualText.replace(/\s/g, '') === '') continue;
              // Per-char raster candidates (SK-1090): emoji / color-bitmap
              // codepoints in the middle of a plain-text run. Each entry
              // carries the chars viewport-relative rect; rasterizeBitmapGlyphs
              // fills in dataUri post-capture and the renderer stamps an
              // <image> over the chars xOffset. charIndex is a UTF-16 position
              // into segment.text (not a code-point index) so
              // text.codePointAt(charIndex) resolves correctly for surrogate-
              // paired emoji.
              const rasterGlyphs = [];
              let utf16Idx = 0;
              for (const cRec of line.chars) {
                const cp = cRec.ch.codePointAt(0);
                const isFirstLetter = firstLetterStyled && !firstCharSeen && /\\S/.test(cRec.ch);
                if (isFirstLetter) firstCharSeen = true;
                if ((cp != null && needsRaster(cp)) || isFirstLetter) {
                  rasterGlyphs.push({
                    charIndex: utf16Idx,
                    rect: {
                      x: cRec.left - vp.x,
                      y: cRec.top - vp.y,
                      width: cRec.right - cRec.left,
                      height: cRec.bottom - cRec.top,
                    },
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
        }
        text = text.trim();
        if (minLeft < Infinity) {
          textLeft = minLeft - vp.x;
          textTop = minTop - vp.y;
          textWidth = maxRight - minLeft;
          textHeight = maxBottom - minTop;
          const _textMetrics = _measureFontMetrics(cs);
          fontAscent = _textMetrics.ascent;
          fontDescent = _textMetrics.descent;
        }
      }
    }
    // Inject pseudo-element segments now that we have the main text boundaries.
    // ::before is prepended; ::after is appended. Adjust the ::before x to sit
    // just left of the first main segment, since that's where Chromium painted
    // it (el.textLeft already excludes the pseudo's width).
    // Image pseudos (content: url(...)) are collected separately for rendering
    // as <image> elements at the appropriate position.
    const pseudoImages = [];
    for (const p of pseudoSegments) {
      if (p.imageUrl) {
        // Position: before = at element content-left, shifting main text right.
        // Browsers already shifted the main text right by the pseudos LAYOUT
        // width (p.seg.width), so we place the layout anchor at
        // (firstSeg.x - layoutWidth). The image itself then paints at
        // renderWidth/Height from that anchor and can overflow right/down.
        if (p.isBefore && textSegments.length > 0) {
          const firstSeg = textSegments[0];
          p.seg.x = firstSeg.x - p.seg.width;
          p.seg.y = firstSeg.y + (firstSeg.height - p.seg.height) / 2;
        } else if (!p.isBefore && textSegments.length > 0) {
          const lastSeg = textSegments[textSegments.length - 1];
          p.seg.x = lastSeg.x + lastSeg.width;
          p.seg.y = lastSeg.y + (lastSeg.height - p.seg.height) / 2;
        }
        pseudoImages.push({
          url: p.imageUrl,
          x: p.seg.x, y: p.seg.y,
          width: p.renderWidth, height: p.renderHeight,
        });
        continue;
      }
      if (p.isBefore && textSegments.length > 0) {
        // Offset by measured width before the first real segment's x.
        const firstSeg = textSegments[0];
        p.seg.x = firstSeg.x - p.seg.width;
        p.seg.y = firstSeg.y;
        p.seg.height = firstSeg.height;
        textSegments.unshift(p.seg);
      } else if (!p.isBefore && textSegments.length > 0) {
        const lastSeg = textSegments[textSegments.length - 1];
        p.seg.x = lastSeg.x + lastSeg.width;
        p.seg.y = lastSeg.y;
        p.seg.height = lastSeg.height;
        textSegments.push(p.seg);
      } else {
        // No main text — just place at element origin.
        textSegments.push(p.seg);
      }
      // If we flagged this pseudo for raster, re-anchor the screenshot rect
      // to the final (post-injection) x/y. Its x was computed against the
      // elements right edge for ::after / content-left for ::before, but the
      // injection above moves it to sit flush against the main text — the
      // rasterRect has to follow or we screenshot empty space.
      if (p.seg.rasterRect != null) {
        p.seg.rasterRect.x = p.seg.x;
        p.seg.rasterRect.y = p.seg.y;
        p.seg.rasterRect.height = p.seg.height;
      }
      text = (p.isBefore ? p.seg.text + ' ' : ' ' + p.seg.text) + text;
    }

    let textImageUri = undefined;
    const textImageScale = 2;

    if (tag === 'img') {
      // currentSrc is the URL the browser actually resolved + loaded (from
      // srcset / <picture> <source>). Fall back to src when currentSrc is empty.
      imageSrc = el.currentSrc || el.src;
      // Intrinsic <img> dims — used by the renderer for object-fit: none.
      if (el.naturalWidth > 0 && el.naturalHeight > 0) {
        var imageIntrinsic = { w: el.naturalWidth, h: el.naturalHeight };
      }
    } else if (tag === 'input' && el.type === 'image') {
      // <input type="image"> renders the src as a clickable button-image.
      // No currentSrc / naturalWidth on HTMLInputElement; the bounding rect
      // already reflects width/height attributes or the image's natural size.
      imageSrc = el.src;
    }
    // Capture list-style-image intrinsic dims on <li> so the renderer paints
    // markers at their natural size (CSS default).
    let listMarkerIntrinsic = undefined;
    let listItemIndex = undefined;
    if (tag === 'li') {
      if (cs.listStyleImage && cs.listStyleImage !== 'none') {
        const u = /^url\\((?:"|')?([^"')]+)/.exec(cs.listStyleImage);
        if (u != null) {
          const img = new Image();
          img.src = u[1];
          if (img.naturalWidth > 0) listMarkerIntrinsic = { w: img.naturalWidth, h: img.naturalHeight };
        }
      }
      // Compute 1-based index for numeric/alpha markers. Respect <ol start>, <ol reversed>, <li value>.
      const parent = el.parentElement;
      if (parent != null) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName.toLowerCase() === 'li');
        const parentTag = parent.tagName.toLowerCase();
        const reversed = parentTag === 'ol' && parent.hasAttribute('reversed');
        let start = 1;
        if (parentTag === 'ol' && parent.hasAttribute('start')) start = parseInt(parent.getAttribute('start'), 10) || 1;
        if (reversed) start = siblings.length;
        let cur = start;
        for (const s of siblings) {
          if (s.hasAttribute('value')) cur = parseInt(s.getAttribute('value'), 10) || cur;
          if (s === el) { listItemIndex = cur; break; }
          cur += reversed ? -1 : 1;
        }
      }
    }
    if (tag === 'svg') svgContent = el.outerHTML;

    const children = [];
    for (const child of el.children) {
      // Closed <details> hides non-<summary> children visually. getBoundingClientRect
      // still returns their rects and cs.display isn't 'none', so we explicitly
      // skip non-summary children when the parent details is closed.
      if (tag === 'details' && !el.open && child.tagName.toLowerCase() !== 'summary') continue;
      const c = capture(child);
      if (c) children.push(c);
    }

    const _animId = el.dataset != null ? el.dataset.domotionAnim : undefined;
    return {
      tag, text,
      x: rect.left - vp.x, y: rect.top - vp.y,
      width: rect.width, height: rect.height,
      animId: _animId,
      styles: {
        backgroundColor: normColor(cs.backgroundColor),
        borderColor: normColor(cs.borderColor),
        borderWidth: cs.borderWidth,
        borderRadius: cs.borderRadius,
        // Resolve any % border-radius to pixels here — Chromes computed
        // longhand still preserves percentages, so a 50% border-radius
        // would otherwise come through as "50%" and parseFloat would read it
        // as 50 px. CSS spec resolves percentage on horizontal axis against
        // width and vertical against height; we average the corner-axis pair
        // for a single rx value, which is fine for the common symmetric case
        // (50% on a square box → circle). See SK-1093.
        borderTopLeftRadius: (function () {
          const v = cs.borderTopLeftRadius || '';
          if (v.indexOf('%') < 0) return v;
          const parts = v.split(/\\s+/);
          const hp = parseFloat(parts[0]) || 0;
          const vp = parseFloat(parts[1] != null ? parts[1] : parts[0]) || 0;
          const hpPx = parts[0].endsWith('%') ? hp * rect.width / 100 : hp;
          const vpPx = (parts[1] != null ? parts[1] : parts[0]).endsWith('%') ? vp * rect.height / 100 : vp;
          return ((hpPx + vpPx) / 2) + 'px';
        })(),
        borderTopWidth: cs.borderTopWidth,
        borderRightWidth: cs.borderRightWidth,
        borderBottomWidth: cs.borderBottomWidth,
        borderLeftWidth: cs.borderLeftWidth,
        borderTopStyle: cs.borderTopStyle,
        borderRightStyle: cs.borderRightStyle,
        borderBottomStyle: cs.borderBottomStyle,
        borderLeftStyle: cs.borderLeftStyle,
        borderTopColor: normColor(cs.borderTopColor),
        borderRightColor: normColor(cs.borderRightColor),
        borderBottomColor: normColor(cs.borderBottomColor),
        borderLeftColor: normColor(cs.borderLeftColor),
        borderCollapse: cs.borderCollapse,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        scrollbarGutter: cs.scrollbarGutter || 'auto',
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
        scrollLeft: el.scrollLeft,
        objectFit: cs.objectFit,
        objectPosition: cs.objectPosition,
        filter: cs.filter,
        backdropFilter: cs.backdropFilter || cs.webkitBackdropFilter || '',
        mixBlendMode: cs.mixBlendMode,
        clipPath: cs.clipPath,
        mask: cs.mask || cs.webkitMask || '',
        maskImage: cs.maskImage || cs.webkitMaskImage || '',
        maskMode: cs.maskMode || 'match-source',
        maskSize: cs.maskSize || cs.webkitMaskSize || 'auto',
        maskPosition: cs.maskPosition || cs.webkitMaskPosition || '0% 0%',
        maskRepeat: cs.maskRepeat || cs.webkitMaskRepeat || 'repeat',
        maskComposite: cs.maskComposite || 'add',
        listStyleType: cs.listStyleType,
        listStyleImage: cs.listStyleImage,
        listStylePosition: cs.listStylePosition,
        backgroundImage: cs.backgroundImage,
        backgroundSize: cs.backgroundSize,
        backgroundPosition: cs.backgroundPosition,
        backgroundRepeat: cs.backgroundRepeat,
        backgroundClip: cs.backgroundClip,
        backgroundOrigin: cs.backgroundOrigin,
        backgroundAttachment: cs.backgroundAttachment,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        backgroundIntrinsic: (() => {
          const bgImage = cs.backgroundImage;
          if (bgImage == null || bgImage === 'none' || bgImage === '') return undefined;
          // Split on top-level commas respecting nested parens.
          const layers = [];
          {
            let depth = 0, start = 0;
            for (let i = 0; i < bgImage.length; i++) {
              const c = bgImage[i];
              if (c === '(') depth++;
              else if (c === ')') depth--;
              else if (c === ',' && depth === 0) { layers.push(bgImage.slice(start, i)); start = i + 1; }
            }
            layers.push(bgImage.slice(start));
          }
          return layers.map((layer) => {
            const u = /^\\s*url\\((?:"|')?([^"')]+)/.exec(layer);
            if (u == null) return null;
            const img = new Image();
            img.src = u[1];
            const w = img.naturalWidth || 0;
            const h = img.naturalHeight || 0;
            return w > 0 && h > 0 ? { w, h } : null;
          });
        })(),
        borderImageSource: cs.borderImageSource,
        borderImageSlice: cs.borderImageSlice,
        borderImageWidth: cs.borderImageWidth,
        borderImageOutset: cs.borderImageOutset,
        borderImageRepeat: cs.borderImageRepeat,
        borderImageIntrinsicWidth: (() => {
          const m = /^url\\((?:"|')?([^"')]+)/.exec(cs.borderImageSource || '');
          if (m == null) return undefined;
          const img = new Image();
          img.src = m[1];
          return img.naturalWidth || undefined;
        })(),
        borderImageIntrinsicHeight: (() => {
          const m = /^url\\((?:"|')?([^"')]+)/.exec(cs.borderImageSource || '');
          if (m == null) return undefined;
          const img = new Image();
          img.src = m[1];
          return img.naturalHeight || undefined;
        })(),
        zIndex: cs.zIndex,
        position: cs.position,
        float: cs.float,
        emptyCellsHidden: (tag === 'td' || tag === 'th') && cs.emptyCells === 'hide' && (el.textContent || '').trim() === '' && el.children.length === 0,
        inputType: tag === 'input' ? (el.type || 'text') : undefined,
        checked: (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ? !!el.checked : undefined,
        indeterminate: (tag === 'input' && el.type === 'checkbox') ? !!el.indeterminate : undefined,
        disabled: (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') ? !!el.disabled : undefined,
        progressValue: tag === 'progress' ? (el.hasAttribute('value') ? +el.value : undefined) : undefined,
        progressMax: tag === 'progress' ? (el.max || 1) : undefined,
        // ::-webkit-progress-bar / ::-webkit-progress-value pseudo styles —
        // resolved via the same stylesheet walker the slider track/thumb
        // use (SK-1222). getComputedStyle(el, pseudo) returns the host
        // <progress>'s style for these UA pseudos, not the pseudo's
        // cascaded value, so author rules like
        // ::-webkit-progress-value { background: green } were silently
        // dropped. Walking document.styleSheets restores them.
        ...(tag === 'progress' ? (function () {
          const bar = _resolvePseudo(el, 'progress-bar');
          const val = _resolvePseudo(el, 'progress-value');
          return {
            progressBarBg: bar.matched && bar.backgroundColor !== '' ? normColor(bar.backgroundColor) : undefined,
            progressBarBgImage: bar.matched && bar.backgroundImage !== '' ? bar.backgroundImage : undefined,
            progressBarRadius: bar.matched && bar.borderRadius !== '' ? bar.borderRadius : undefined,
            progressValueBg: val.matched && val.backgroundColor !== '' ? normColor(val.backgroundColor) : undefined,
            progressValueBgImage: val.matched && val.backgroundImage !== '' ? val.backgroundImage : undefined,
            progressValueRadius: val.matched && val.borderRadius !== '' ? val.borderRadius : undefined,
          };
        })() : {}),
        meterValue: tag === 'meter' ? (el.value != null ? +el.value : undefined) : undefined,
        meterMin: tag === 'meter' ? (el.min || 0) : undefined,
        meterMax: tag === 'meter' ? (el.max || 1) : undefined,
        meterLow: tag === 'meter' ? (el.low != null ? +el.low : undefined) : undefined,
        meterHigh: tag === 'meter' ? (el.high != null ? +el.high : undefined) : undefined,
        meterOptimum: tag === 'meter' ? (el.optimum != null ? +el.optimum : undefined) : undefined,
        // <meter> pseudo styles via the stylesheet walker (SK-1222 — same
        // Chromium quirk as <progress>).
        ...(tag === 'meter' ? (function () {
          const bar = _resolvePseudo(el, 'meter-bar');
          const opt = _resolvePseudo(el, 'meter-optimum');
          const sub = _resolvePseudo(el, 'meter-suboptimum');
          const elg = _resolvePseudo(el, 'meter-even-less-good');
          return {
            meterBarBg: bar.matched && bar.backgroundColor !== '' ? normColor(bar.backgroundColor) : undefined,
            meterBarBgImage: bar.matched && bar.backgroundImage !== '' ? bar.backgroundImage : undefined,
            meterBarRadius: bar.matched && bar.borderRadius !== '' ? bar.borderRadius : undefined,
            meterOptimumBg: opt.matched && opt.backgroundColor !== '' ? normColor(opt.backgroundColor) : undefined,
            meterOptimumBgImage: opt.matched && opt.backgroundImage !== '' ? opt.backgroundImage : undefined,
            meterSuboptimumBg: sub.matched && sub.backgroundColor !== '' ? normColor(sub.backgroundColor) : undefined,
            meterSuboptimumBgImage: sub.matched && sub.backgroundImage !== '' ? sub.backgroundImage : undefined,
            meterEvenLessGoodBg: elg.matched && elg.backgroundColor !== '' ? normColor(elg.backgroundColor) : undefined,
            meterEvenLessGoodBgImage: elg.matched && elg.backgroundImage !== '' ? elg.backgroundImage : undefined,
          };
        })() : {}),
        detailsOpen: tag === 'details' ? !!el.open : undefined,
        selectChevron: tag === 'select' && el.size <= 1 && !el.multiple,
        accentColor: (tag === 'input' || tag === 'progress' || tag === 'meter') ? normColor(cs.accentColor || 'auto') : undefined,
        caretColor: (tag === 'input' || tag === 'textarea') ? normColor(cs.caretColor || 'auto') : undefined,
        inputValue: tag === 'input' ? (el.value || '') : undefined,
        inputMin: tag === 'input' ? (el.min || '') : undefined,
        inputMax: tag === 'input' ? (el.max || '') : undefined,
        inputStep: tag === 'input' ? (el.step || '') : undefined,
        inputFileName: (tag === 'input' && el.type === 'file' && el.files && el.files.length > 0) ? el.files[0].name : undefined,
        // ::-webkit-color-swatch / -wrapper / -inner-spin-button /
        // -search-cancel-button pseudo styles via the stylesheet walker
        // (SK-1223). Same Chromium quirk as slider/progress/meter — captured
        // here as fields the renderer can pick up. v1: color-swatch is the
        // most commonly authored; the others land their fields for future
        // renderer work.
        ...(tag === 'input' && el.type === 'color' ? (function () {
          const swatch = _resolvePseudo(el, 'color-swatch');
          const wrap = _resolvePseudo(el, 'color-swatch-wrapper');
          return {
            colorSwatchBg: swatch.matched && swatch.backgroundColor !== '' ? normColor(swatch.backgroundColor) : undefined,
            colorSwatchBgImage: swatch.matched && swatch.backgroundImage !== '' ? swatch.backgroundImage : undefined,
            colorSwatchBorder: swatch.matched && swatch.border !== '' ? swatch.border : undefined,
            colorSwatchRadius: swatch.matched && swatch.borderRadius !== '' ? swatch.borderRadius : undefined,
            colorSwatchWrapperPadding: wrap.matched && wrap.padding !== '' ? wrap.padding : undefined,
          };
        })() : {}),
        ...(tag === 'input' && el.type === 'number' ? (function () {
          const spin = _resolvePseudo(el, 'inner-spin-button');
          return {
            numberSpinButtonBg: spin.matched && spin.backgroundColor !== '' ? normColor(spin.backgroundColor) : undefined,
            numberSpinButtonBorder: spin.matched && spin.border !== '' ? spin.border : undefined,
            numberSpinButtonRadius: spin.matched && spin.borderRadius !== '' ? spin.borderRadius : undefined,
          };
        })() : {}),
        ...(tag === 'input' && el.type === 'search' ? (function () {
          const cancel = _resolvePseudo(el, 'search-cancel-button');
          return {
            searchCancelButtonBg: cancel.matched && cancel.backgroundColor !== '' ? normColor(cancel.backgroundColor) : undefined,
            searchCancelButtonBorder: cancel.matched && cancel.border !== '' ? cancel.border : undefined,
            searchCancelButtonRadius: cancel.matched && cancel.borderRadius !== '' ? cancel.borderRadius : undefined,
          };
        })() : {}),
        // input[type=range] custom pseudo styles (SK-1131 / SK-1137 / SK-1138).
        // Resolved by walking document.styleSheets — getComputedStyle(el, pseudo)
        // is unreliable for these UA-internal pseudos in Chromium (returns the
        // host element's style instead of the pseudo's). A pseudo is treated
        // as author-styled when at least one matching rule was found OR the
        // host has -webkit-appearance: none (the .r-custom pattern always
        // pairs the two and we want the renderer to drop UA chrome even if
        // only the track is rule-styled).
        ...(tag === 'input' && el.type === 'range' ? (function () {
          const ts = _resolvePseudo(el, 'track');
          const ms = _resolvePseudo(el, 'thumb');
          const elAppearance = cs.webkitAppearance || cs.appearance;
          const customAppearance = elAppearance === 'none';
          const styledTrack = ts.matched || customAppearance;
          const styledThumb = ms.matched || customAppearance;
          return {
            rangeTrackBg: styledTrack && ts.backgroundColor !== '' ? normColor(ts.backgroundColor) : (styledTrack ? 'rgba(0, 0, 0, 0)' : undefined),
            rangeTrackHeight: styledTrack ? ts.height : undefined,
            rangeTrackRadius: styledTrack ? ts.borderRadius : undefined,
            rangeTrackBgImage: styledTrack && ts.backgroundImage !== '' ? ts.backgroundImage : undefined,
            rangeThumbBg: styledThumb && ms.backgroundColor !== '' ? normColor(ms.backgroundColor) : (styledThumb ? 'rgba(0, 0, 0, 0)' : undefined),
            rangeThumbWidth: styledThumb ? ms.width : undefined,
            rangeThumbHeight: styledThumb ? ms.height : undefined,
            rangeThumbRadius: styledThumb ? ms.borderRadius : undefined,
            rangeThumbBgImage: styledThumb && ms.backgroundImage !== '' ? ms.backgroundImage : undefined,
          };
        })() : {}),
        fileButtonBg: (tag === 'input' && el.type === 'file') ? normColor(window.getComputedStyle(el, '::file-selector-button').backgroundColor) : undefined,
        fileButtonColor: (tag === 'input' && el.type === 'file') ? normColor(window.getComputedStyle(el, '::file-selector-button').color) : undefined,
        fileButtonBorder: (tag === 'input' && el.type === 'file') ? window.getComputedStyle(el, '::file-selector-button').border : undefined,
        fileButtonBorderRadius: (tag === 'input' && el.type === 'file') ? window.getComputedStyle(el, '::file-selector-button').borderRadius : undefined,
        fileButtonPadding: (tag === 'input' && el.type === 'file') ? window.getComputedStyle(el, '::file-selector-button').padding : undefined,
        fileButtonFontWeight: (tag === 'input' && el.type === 'file') ? window.getComputedStyle(el, '::file-selector-button').fontWeight : undefined,
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        outlineColor: normColor(cs.outlineColor),
        outlineOffset: cs.outlineOffset,
        boxShadow: cs.boxShadow,
        textShadow: cs.textShadow,
        transform: frozenTransform != null ? frozenTransform : cs.transform,
        transformOrigin: frozenTransformOrigin != null ? frozenTransformOrigin : cs.transformOrigin,
        writingMode: cs.writingMode,
        textOrientation: cs.textOrientation,
        color: normColor(cs.color),
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        opacity: cs.opacity,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        fontKerning: cs.fontKerning,
        fontStretch: cs.fontStretch,
        fontVariationSettings: cs.fontVariationSettings,
        fontFeatureSettings: cs.fontFeatureSettings,
        direction: cs.direction,
        textDecorationLine: cs.textDecorationLine,
        textDecorationColor: cs.textDecorationColor,
        textDecorationStyle: cs.textDecorationStyle,
      },
      children, imageSrc, imageIntrinsic, listMarkerIntrinsic, listItemIndex, svgContent, pseudoImages,
      // ::marker pseudo styles (SK-1115). Only meaningful on <li>; rest of
      // the time the values come back equal to the elements own font and
      // are quietly ignored at render time.
      markerColor: tag === 'li' ? normColor(window.getComputedStyle(el, '::marker').color) : undefined,
      markerFontWeight: tag === 'li' ? window.getComputedStyle(el, '::marker').fontWeight : undefined,
      markerFontSize: tag === 'li' ? window.getComputedStyle(el, '::marker').fontSize : undefined,
      textSegments: textSegments.length > 0 ? textSegments : undefined,
      textTop, textLeft, textHeight, textWidth, fontAscent, fontDescent,
      inputXOffsets,
      textImageUri, textImageScale,
      // Placeholder metadata (SK-1097 / SK-1100): when the captured text came
      // from an input/textarea placeholder attribute, the renderer paints it
      // in ::placeholder color (muted gray by default) instead of the normal
      // text color.
      isPlaceholderText: isPlaceholderCapture || undefined,
      placeholderColor: isPlaceholderCapture
        ? normColor(window.getComputedStyle(el, '::placeholder').color || cs.color)
        : undefined,
      // Author may also style the placeholders font (CSS lets ::placeholder
      // override font-style / font-weight independently of the inputs own
      // font). Pull both so renderInputText can pick italic + bold purple
      // text instead of plain upright. See SK-1099.
      placeholderFontStyle: isPlaceholderCapture
        ? window.getComputedStyle(el, '::placeholder').fontStyle
        : undefined,
      placeholderFontWeight: isPlaceholderCapture
        ? window.getComputedStyle(el, '::placeholder').fontWeight
        : undefined,
      // Textarea soft-wrap: our path-mode input renderer paints el.value as a
      // single line, which looks wrong for any textarea whose value is longer
      // than one visual line. Rather than reimplement Chromes word-wrap (font
      // metrics + kerning + break opportunities + CSS wrap=hard/soft), stamp
      // the textareas exact rendered pixels by screenshotting its content box
      // (minus border + padding). Scoped to textareas with a non-empty value
      // so short/empty ones keep the cleaner path pipeline. See SK-1108.
      elementRaster: ((tag === 'textarea' && el.value)
        || (cs.writingMode && cs.writingMode !== 'horizontal-tb' && (el.textContent || '').trim() !== ''))
        ? (function () {
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
          })()
        : undefined,
    };
  };

  const root = document.querySelector(sel);
  if (!root) return { tree: [], warnings: [] };
  const result = [];
  for (const child of root.children) {
    const c = capture(child);
    if (c) result.push(c);
  }
  return { tree: result, warnings: _warnings };
}
`;

export interface CaptureWarning {
  /** Short selector path identifying the element that tripped the warning. */
  selector: string;
  /** Feature name (e.g. 'transform', 'backdrop-filter', '<iframe>'). */
  feature: string;
  /** Short detail about what's not supported and/or a tracking ticket. */
  detail: string;
}

/**
 * Collected warnings from the most recent captureElementTree() call. Reset on
 * each call. Callers can inspect or log these to find out what domotion
 * couldn't render faithfully on the input page. See SK-465.
 */
let lastCaptureWarnings: CaptureWarning[] = [];

export function getLastCaptureWarnings(): CaptureWarning[] {
  return lastCaptureWarnings;
}

/**
 * Print the last capture's warnings to stderr in a compact format. Useful in
 * CLI / test scripts that want a one-line-per-warning summary.
 */
export function logCaptureWarnings(label: string = ""): void {
  if (lastCaptureWarnings.length === 0) return;
  const prefix = label !== "" ? `[domotion ${label}] ` : "[domotion] ";
  for (const w of lastCaptureWarnings) {
    console.error(`${prefix}${w.feature} on ${w.selector} — ${w.detail}`);
  }
}

/**
 * Capture the visual tree of elements within a viewport region. Warnings about
 * unsupported features encountered during capture are stored and accessible
 * via getLastCaptureWarnings() / logCaptureWarnings().
 */
export async function captureElementTree(
  page: Page,
  selector: string = "body",
  viewport: { x: number; y: number; width: number; height: number },
): Promise<CapturedElement[]> {
  // Inject and call the capture script to avoid tsx __name transform issues
  const result = await page.evaluate(`(${CAPTURE_SCRIPT})({sel: ${JSON.stringify(selector)}, vp: ${JSON.stringify(viewport)}})`);
  const typed = result as { tree: CapturedElement[]; warnings: CaptureWarning[] };
  lastCaptureWarnings = typed.warnings ?? [];
  await rasterizeBitmapGlyphs(page, typed.tree, viewport);
  return typed.tree;
}

/**
 * For every text segment CAPTURE_SCRIPT flagged with a rasterRect (contains a
 * color-bitmap glyph like U+2713 ✓ or an emoji), ask Playwright for a
 * transparent-background screenshot of that pixel region and embed it back on
 * the segment as a data URI. The renderer then emits an <image> in place of
 * the failed path run. Dedup by (text + color + fontSize + fontWeight) so
 * repeated glyphs (common for list markers, repeating checkmarks, etc.) share
 * a single screenshot. See SK-1058.
 */
async function rasterizeBitmapGlyphs(
  page: Page,
  tree: CapturedElement[],
  viewport: { x: number; y: number; width: number; height: number },
): Promise<void> {
  // Two kinds of candidates share the pipeline:
  //  - Segment-level rasterRect (SK-1058): the whole pseudo text is a color-
  //    bitmap run; renderer emits one <image> and skips the text path.
  //  - Per-char rasterGlyphs (SK-1090): an emoji in the middle of an
  //    otherwise path-rendered plain-text run; renderer stamps an <image>
  //    over each char on top of the text path.
  interface Candidate {
    rect: { x: number; y: number; width: number; height: number };
    key: string;
    setDataUri: (uri: string) => void;
  }
  const candidates: Candidate[] = [];
  const walk = (els: CapturedElement[]): void => {
    for (const el of els) {
      // Element-level raster (SK-1108): textarea content region, too
      // involved to word-wrap in the path pipeline. Key on text+size+color so
      // identical textareas dedupe to one screenshot.
      if (el.elementRaster != null) {
        const er = el.elementRaster;
        candidates.push({
          rect: { x: er.x, y: er.y, width: er.width, height: er.height },
          key: `el|${el.tag}|${el.text}|${el.styles.color}|${el.styles.fontSize}|${er.width}x${er.height}`,
          setDataUri: (uri) => { er.dataUri = uri; },
        });
      }
      if (el.textSegments != null) {
        for (const seg of el.textSegments) {
          if (seg.rasterRect != null) {
            candidates.push({
              rect: seg.rasterRect,
              key: `seg|${seg.text}|${seg.color ?? ""}|${seg.fontSize ?? ""}|${seg.fontWeight ?? ""}`,
              setDataUri: (uri) => { seg.rasterDataUri = uri; },
            });
          }
          if (seg.rasterGlyphs != null) {
            for (const g of seg.rasterGlyphs) {
              const cp = seg.text.codePointAt(g.charIndex);
              // Include rect width+height (rounded) in the dedupe key so a
              // ::first-letter raster of the letter "F" doesnt collide with
              // a regular-sized "F" elsewhere on the page (different render
              // sizes need different screenshots). See SK-1114.
              const w = Math.round(g.rect.width);
              const h = Math.round(g.rect.height);
              candidates.push({
                rect: g.rect,
                key: `glyph|${cp}|${seg.color ?? ""}|${seg.fontSize ?? ""}|${seg.fontWeight ?? ""}|${w}x${h}`,
                setDataUri: (uri) => { g.dataUri = uri; },
              });
            }
          }
        }
      }
      if (el.children.length > 0) walk(el.children);
    }
  };
  walk(tree);
  if (candidates.length === 0) return;

  const cache = new Map<string, string>();
  for (const cand of candidates) {
    let dataUri = cache.get(cand.key);
    if (dataUri == null) {
      // rect is viewport-relative; page.screenshot clip takes page-absolute
      // CSS pixels, so add vp.x/vp.y back. Snap floor/ceil outward to
      // guarantee the glyph is fully contained (Playwright rejects zero-size
      // clips and clips at integer boundaries anyway).
      const clip = {
        x: Math.max(0, Math.floor(cand.rect.x + viewport.x)),
        y: Math.max(0, Math.floor(cand.rect.y + viewport.y)),
        width: Math.max(1, Math.ceil(cand.rect.width)),
        height: Math.max(1, Math.ceil(cand.rect.height)),
      };
      try {
        const buf = await page.screenshot({ clip, omitBackground: true, type: "png" });
        dataUri = `data:image/png;base64,${Buffer.from(buf).toString("base64")}`;
        cache.set(cand.key, dataUri);
      } catch {
        continue;
      }
    }
    cand.setDataUri(dataUri);
  }
}


/**
 * Wrap inner SVG markup (as returned by `elementTreeToSvg`) in a complete
 * `<svg>` document with the standard namespace, viewBox, and intrinsic size.
 * This is the boilerplate every standalone-capture user would otherwise write
 * themselves — call this when you want a self-contained SVG file.
 */
export function wrapSvg(inner: string, width: number, height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${inner}</svg>`;
}

/**
 * Convert a CapturedElement tree into SVG markup.
 */
export function elementTreeToSvg(
  elements: CapturedElement[],
  width: number,
  height: number,
  /** Prefix for clipPath IDs — required when combining multiple frames in one SVG to avoid ID collisions */
  idPrefix: string = "",
  /**
   * When true (default), include the shared glyph definitions in this frame's
   * <defs>. Multi-frame animated SVGs should pass false so glyph defs can be
   * hoisted to the top-level SVG <defs> and shared across frames.
   */
  includeGlyphDefs: boolean = true,
): string {
  const svgParts: string[] = [];
  const defsParts: string[] = [];
  let clipIdx = 0;
  let gradIdx = 0;
  // Form-control gradient defs (SK-1224) — renderFormControl pushes
  // <linearGradient> entries into defsParts via this context.
  const defCtx: DefCtx = {
    idPrefix,
    defsParts,
    gradientCache: new Map<string, string>(),
    nextGradId: () => `${idPrefix}grad${gradIdx++}`,
  };
  // Viewport dims for background-attachment: fixed — passed down into layer def building.
  const captureViewport = { w: width, h: height };

  function renderElement(el: CapturedElement, depth: number): void {
    const indent = "  ".repeat(depth);
    const bgColor = parseColor(el.styles.backgroundColor);
    const textColor = parseColor(el.styles.color);
    const borderColor = parseColor(el.styles.borderColor);
    const borderWidth = parseFloat(el.styles.borderWidth) || 0;
    // Border-radius resolution (SK-1093): the borderRadius shorthand keeps
    // author percentages ("50%") so naive parseFloat reads it as 50 px. Use
    // the longhand top-left value, which Chrome resolves to pixels regardless
    // of the input form. Falls back to the shorthand for older captures.
    const borderRadius = parseFloat(el.styles.borderTopLeftRadius ?? el.styles.borderRadius) || 0;
    const opacity = parseFloat(el.styles.opacity);

    if (opacity === 0) return;
    // empty-cells: hide — suppress bg + border on empty <td>/<th>.
    const suppressEmptyCell = el.styles.emptyCellsHidden === true;

    // Element opacity applies to the background, border, text, and all descendants.
    // Emit a group wrapper when opacity < 1 so the whole subtree tints uniformly.
    // Also open a group to host CSS filter / mix-blend-mode — both are honored by
    // the browser's SVG renderer when passed through as inline styles, so we
    // don't need to translate filter functions into <filter> elements.
    // backdrop-filter has no equivalent in img-rendered SVG; it's captured but
    // not emitted (documented limitation).
    const filterCss = el.styles.filter && el.styles.filter !== "none" ? el.styles.filter : "";
    const blendCss = el.styles.mixBlendMode && el.styles.mixBlendMode !== "normal" ? el.styles.mixBlendMode : "";
    // clip-path: translate common CSS shape functions into an SVG <clipPath>
    // anchored at the element's absolute (x, y). A verbatim style-passthrough
    // does NOT work because CSS clip-path uses the element's local coord space
    // while our SVG group is drawn in absolute viewport coords, so a
    // 'circle(50% at center)' would clip around the viewport origin instead.
    const clipPathCss = el.styles.clipPath && el.styles.clipPath !== "none" ? el.styles.clipPath : "";
    let clipPathUrlId: string | null = null;
    if (clipPathCss !== "") {
      const shape = translateClipPath(clipPathCss, el.x, el.y, el.width, el.height);
      if (shape !== "") {
        clipPathUrlId = `${idPrefix}cp${clipIdx++}`;
        defsParts.push(`<clipPath id="${clipPathUrlId}">${shape}</clipPath>`);
      }
    }
    // mask: if mask-image is a gradient or url(), translate it to an SVG <mask>.
    const maskImage = el.styles.maskImage;
    let maskUrlId: string | null = null;
    if (maskImage != null && maskImage !== "none" && maskImage !== "") {
      const maskDef = buildMaskDef(
        `${idPrefix}mk${clipIdx++}`,
        maskImage,
        el.x, el.y, el.width, el.height,
        el.styles.maskMode ?? "match-source",
        el.styles.maskSize ?? "auto",
        el.styles.maskPosition ?? "0% 0%",
        el.styles.maskRepeat ?? "repeat",
        el.styles.maskComposite ?? "add",
      );
      if (maskDef.def !== "") {
        maskUrlId = maskDef.id;
        defsParts.push(maskDef.def);
      }
    }
    // CSS 2D transform (SK-1134): wrap the elements rendered group in
    // <g transform=...> composed around the resolved transform-origin in
    // viewport coords. transform-origin is reported by Chrome in pixels
    // relative to the elements border box (e.g. "0px 0px" for top-left,
    // "Npx Mpx" for the 50%-50% default). Add el.x/el.y to convert to the
    // viewport coordinate system the SVG draws in. Chrome resolves every
    // CSS transform function to a matrix in computed style, so we only
    // need to translate matrix() / matrix3d() into SVG syntax.
    const originParts = (el.styles.transformOrigin ?? "").trim().split(/\s+/);
    // parseFloat("0px") === 0, which is falsy — guarding with `||` would
    // silently substitute the bbox center for an explicit `transform-origin: 0 0`
    // (and rotate around the center instead of the top-left).
    const parsedOX = parseFloat(originParts[0] ?? "");
    const parsedOY = parseFloat(originParts[1] ?? "");
    const tOriginX = el.x + (Number.isFinite(parsedOX) ? parsedOX : el.width / 2);
    const tOriginY = el.y + (Number.isFinite(parsedOY) ? parsedOY : el.height / 2);
    const transformAttr = cssTransformToSvg(el.styles.transform, tOriginX, tOriginY);
    const needsGroup = opacity < 1 || filterCss !== "" || blendCss !== "" || clipPathUrlId != null || maskUrlId != null || transformAttr !== "";
    const groupAttrs: string[] = [];
    if (transformAttr !== "") groupAttrs.push(`transform="${transformAttr}"`);
    if (opacity < 1) groupAttrs.push(`opacity="${r(opacity)}"`);
    if (clipPathUrlId != null) groupAttrs.push(`clip-path="url(#${clipPathUrlId})"`);
    if (maskUrlId != null) groupAttrs.push(`mask="url(#${maskUrlId})"`);
    // animId (DM-209): elements tagged with `data-domotion-anim="<id>"` in the
    // source DOM get a `class="anim-<id>"` on an extra inner `<g>` wrapper so
    // the animator can target them via CSS keyframes for intra-frame motion.
    // The class lives on a SEPARATE wrapper from any merger-added visibility
    // class (which gets applied to the outer group) so the two `animation`
    // declarations don't clobber each other.
    const animClass = el.animId != null && el.animId !== "" ? `anim-${el.animId}` : "";
    const styleParts: string[] = [];
    if (filterCss !== "") styleParts.push(`filter:${filterCss}`);
    if (blendCss !== "") styleParts.push(`mix-blend-mode:${blendCss}`);
    if (styleParts.length > 0) groupAttrs.push(`style="${styleParts.join(";")}"`);
    const opened = needsGroup;
    if (opened) svgParts.push(`${indent}<g ${groupAttrs.join(" ")}>`);
    // Inner anim-class wrapper sits INSIDE any visibility/transform group so
    // the merger's class (added on the outer group) and our anim class can
    // each carry their own `animation` shorthand without clobbering.
    if (animClass !== "") svgParts.push(`${indent}<g class="${animClass}">`);

    // Outset box-shadow (SK-1101 + SK-1113): paints BENEATH the element box.
    // CSS spec says the first shadow in the list is closest to the element;
    // later shadows sit further behind. SVG paints later in document order,
    // so to get the same stacking we iterate the list in REVERSE (deepest
    // first). Blur > 0 routes through an SVG <filter feGaussianBlur> with
    // stdDeviation ≈ blur/2 (matches Chromes blur-to-stdDev mapping).
    {
      const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
      for (let si = shadows.length - 1; si >= 0; si--) {
        const sh = shadows[si];
        if (sh.inset) continue;
        if (sh.spread < 0) continue;
        // Rect inflated by spread and shifted by (x, y).
        const sx = el.x + sh.x - sh.spread;
        const sy = el.y + sh.y - sh.spread;
        const sw = el.width + sh.spread * 2;
        const sh2 = el.height + sh.spread * 2;
        if (sw <= 0 || sh2 <= 0) continue;
        const sr = Math.max(0, borderRadius + sh.spread);
        let filterAttr = "";
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}sh${clipIdx++}`;
          // Filter region needs to extend beyond the shadow rect by enough
          // padding to keep the Gaussian fall-off from clipping. Use a
          // generous 200% on each side; primitiveUnits inherits the default
          // userSpaceOnUse-equivalent so stdDeviation is in CSS pixels.
          defsParts.push(
            `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
          );
          filterAttr = ` filter="url(#${fid})"`;
        }
        svgParts.push(
          `${indent}<rect x="${r(sx)}" y="${r(sy)}" width="${r(sw)}" height="${r(sh2)}" rx="${r(sr)}" fill="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}"${filterAttr} />`,
        );
      }
    }

    // Background rect(s). CSS lets backgrounds stack via background-image with
    // a comma-separated list of linear/radial gradients and url() images. The
    // first layer paints on top — we emit in reverse so the rect order matches
    // CSS layering. The background-color paints *under* all layers.
    if (!suppressEmptyCell && bgColor != null && bgColor.a > 0.01) {
      svgParts.push(
        `${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" rx="${r(borderRadius)}" fill="${colorStr(bgColor)}" />`,
      );
    }
    const bgImage = el.styles.backgroundImage;
    if (bgImage != null && bgImage !== "none" && bgImage !== "") {
      const layers = splitTopLevelCommas(bgImage);
      const sizeLayers = splitTopLevelCommas(el.styles.backgroundSize ?? "auto");
      const posLayers = splitTopLevelCommas(el.styles.backgroundPosition ?? "0% 0%");
      const repeatLayers = splitTopLevelCommas(el.styles.backgroundRepeat ?? "repeat");
      const clipLayers = splitTopLevelCommas(el.styles.backgroundClip ?? "border-box");
      const originLayers = splitTopLevelCommas(el.styles.backgroundOrigin ?? "padding-box");
      const attachmentLayers = splitTopLevelCommas(el.styles.backgroundAttachment ?? "scroll");
      const intrinsicLayers = el.styles.backgroundIntrinsic ?? [];
      // Per-side borders + padding for clip/origin math.
      const bwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const bwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const bwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      const bwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const padT = parseFloat(el.styles.paddingTop ?? "0") || 0;
      const padR = parseFloat(el.styles.paddingRight ?? "0") || 0;
      const padB = parseFloat(el.styles.paddingBottom ?? "0") || 0;
      const padL = parseFloat(el.styles.paddingLeft ?? "0") || 0;
      // Box helpers: border-box = captured rect, padding-box = border inset,
      // content-box = border+padding inset.
      const boxFor = (key: string): { x: number; y: number; w: number; h: number } => {
        if (key === "content-box") {
          return { x: el.x + bwL + padL, y: el.y + bwT + padT, w: el.width - bwL - bwR - padL - padR, h: el.height - bwT - bwB - padT - padB };
        }
        if (key === "padding-box") {
          return { x: el.x + bwL, y: el.y + bwT, w: el.width - bwL - bwR, h: el.height - bwT - bwB };
        }
        return { x: el.x, y: el.y, w: el.width, h: el.height };
      };
      // CSS: first layer paints on top of later layers. Emit in reverse order
      // so later SVG elements (= on top) correspond to first CSS layer.
      for (let li = layers.length - 1; li >= 0; li--) {
        const layer = layers[li].trim();
        const layerSize = (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim();
        const layerPos = (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim();
        const layerRepeat = (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim();
        const layerClip = (clipLayers[li] ?? clipLayers[0] ?? "border-box").trim();
        const layerOrigin = (originLayers[li] ?? originLayers[0] ?? "padding-box").trim();
        const layerIntrinsic = intrinsicLayers[li] ?? null;
        const layerAttachment = (attachmentLayers[li] ?? attachmentLayers[0] ?? "scroll").trim();
        const originBox = boxFor(layerOrigin);
        const clipBox = boxFor(layerClip);
        const defId = `${idPrefix}bg${clipIdx++}`;
        // Pattern is positioned + sized relative to the origin box (where the image starts)
        // then painted into a rect clipped to the clip box. For fixed attachment
        // the origin is the viewport instead.
        const out = buildBackgroundLayerDef(defId, layer, originBox.x, originBox.y, originBox.w, originBox.h, layerSize, layerPos, layerRepeat, layerIntrinsic, layerAttachment, captureViewport);
        if (out.def === "") continue;
        defsParts.push(out.def);
        svgParts.push(
          `${indent}<rect x="${r(clipBox.x)}" y="${r(clipBox.y)}" width="${r(clipBox.w)}" height="${r(clipBox.h)}" rx="${r(Math.max(0, borderRadius - Math.max(bwL, bwT)))}" fill="url(#${defId})" />`,
        );
      }
    }

    // Inset box-shadow (SK-1111): per CSS paint order this sits ON TOP of
    // the background layers but BEHIND the border. Outset shadows would sit
    // underneath the entire box and aren't supported in this pass — only
    // inset, no blur, with non-negative spread is handled (sufficient for the
    // common "padding visualizer" pattern: box-shadow: inset 0 0 0 NNpx
    // <color>). Anything fancier falls through silently and becomes a
    // follow-up. See SK-1111.
    {
      const shadows = parseBoxShadow(el.styles.boxShadow ?? "none");
      // Border widths — re-parse here because the bg-layer block above (where
      // bwL/bwR/bwT/bwB are computed) is conditional on backgroundImage.
      const sbwL = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
      const sbwR = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
      const sbwT = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
      const sbwB = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
      // Border-inner box (where inset shadow paints).
      const ibLeft = el.x + sbwL;
      const ibTop = el.y + sbwT;
      const ibW = Math.max(0, el.width - sbwL - sbwR);
      const ibH = Math.max(0, el.height - sbwT - sbwB);
      const innerR = Math.max(0, borderRadius - Math.max(sbwL, sbwT));
      for (const sh of shadows) {
        if (!sh.inset) continue;
        // Skip non-trivial shadows we cant emit accurately — anything with
        // an x/y offset (asymmetric inset glow not supported), negative
        // spread, or zero spread + zero blur (paints nothing).
        if (sh.x !== 0 || sh.y !== 0) continue;
        if (sh.spread < 0) continue;
        if (sh.spread === 0 && sh.blur === 0) continue;
        if (ibW <= 0 || ibH <= 0) continue;
        // Effective ring width: spread itself, plus blur for the soft glow
        // case. Pure-blur insets (e.g. inset 0 0 12px) treat blur as the
        // ring width; pure-spread (no-blur) treats spread as the width.
        // Approximate combined width as max(spread, blur) so the stroke
        // sits where Chromes painted ring centers.
        const sp = Math.max(sh.spread, sh.blur);
        const rx = ibLeft + sp / 2;
        const ry = ibTop + sp / 2;
        const rw = Math.max(0, ibW - sp);
        const rh = Math.max(0, ibH - sp);
        if (rw <= 0 || rh <= 0) continue;
        let filterAttr = "";
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}ish${clipIdx++}`;
          defsParts.push(
            `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
          );
          filterAttr = ` filter="url(#${fid})"`;
        }
        svgParts.push(
          `${indent}<rect x="${r(rx)}" y="${r(ry)}" width="${r(rw)}" height="${r(rh)}" rx="${r(Math.max(0, innerR - sp / 2))}" fill="none" stroke="${colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 })}" stroke-width="${r(sp)}"${filterAttr} />`,
        );
      }
    }

    // Border-image: if a URL source with intrinsic dimensions is present,
    // emit a 9-slice composition and SKIP the plain-border fallback below.
    // Gradient sources are not supported in this pass (tracked as follow-up).
    const borderImageMarkup = renderBorderImage(el, indent, idPrefix, defsParts, clipIdx);
    if (borderImageMarkup.usedIds > 0) clipIdx += borderImageMarkup.usedIds;
    const borderImagePainted = borderImageMarkup.svg !== "";
    if (borderImagePainted) svgParts.push(borderImageMarkup.svg);

    // Border — uniform or per-side. Skipped when a border-image painted above.
    const bt = parseSide(el.styles.borderTopWidth, el.styles.borderTopStyle, el.styles.borderTopColor);
    const br = parseSide(el.styles.borderRightWidth, el.styles.borderRightStyle, el.styles.borderRightColor);
    const bb = parseSide(el.styles.borderBottomWidth, el.styles.borderBottomStyle, el.styles.borderBottomColor);
    const bl = parseSide(el.styles.borderLeftWidth, el.styles.borderLeftStyle, el.styles.borderLeftColor);
    const uniform = bt != null && br != null && bb != null && bl != null
      && bt.w === br.w && br.w === bb.w && bb.w === bl.w
      && bt.style === br.style && br.style === bb.style && bb.style === bl.style
      && sameColor(bt.color, br.color) && sameColor(br.color, bb.color) && sameColor(bb.color, bl.color);

    if (suppressEmptyCell) {
      // empty-cells: hide — suppress the border too.
    } else if (borderImagePainted) {
      // Border visual came from border-image. Skip the plain-border emission.
    } else if (uniform && bt != null && bt.w > 0) {
      const style = bt.style;
      if (style === "double" && bt.w >= 3) {
        // CSS double border: two parallel strokes each 1/3 of border-width,
        // separated by 1/3 gap. Our captured rect is the border box (outer
        // edge), so strokes need their centerlines at 1/6*w (outer) and
        // 5/6*w (inner) inside the border box.
        const strokeW = bt.w / 3;
        const outerInset = bt.w / 6;
        const innerInset = bt.w * 5 / 6;
        svgParts.push(
          `${indent}<rect x="${r(el.x + outerInset)}" y="${r(el.y + outerInset)}" width="${r(el.width - 2 * outerInset)}" height="${r(el.height - 2 * outerInset)}" rx="${r(Math.max(0, borderRadius - outerInset))}" fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}" />`,
        );
        svgParts.push(
          `${indent}<rect x="${r(el.x + innerInset)}" y="${r(el.y + innerInset)}" width="${r(el.width - 2 * innerInset)}" height="${r(el.height - 2 * innerInset)}" rx="${r(Math.max(0, borderRadius - innerInset))}" fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(strokeW)}" />`,
        );
      } else if ((style === "groove" || style === "ridge") && bt.w >= 2) {
        // Two concentric half-width strokes. groove: outer dark / inner light
        // (carved-in look); ridge: outer light / inner dark (raised-out).
        // Outer stroke centerline at bw/4 inside border box; inner at 3*bw/4.
        const half = bt.w / 2;
        const darker = shadeColor(bt.color, -18);
        const lighter = shadeColor(bt.color, 18);
        const outerColor = style === "groove" ? darker : lighter;
        const innerColor = style === "groove" ? lighter : darker;
        const outerInset = bt.w / 4;
        const innerInset = bt.w * 3 / 4;
        svgParts.push(
          `${indent}<rect x="${r(el.x + outerInset)}" y="${r(el.y + outerInset)}" width="${r(el.width - 2 * outerInset)}" height="${r(el.height - 2 * outerInset)}" rx="${r(Math.max(0, borderRadius - outerInset))}" fill="none" stroke="${colorStr(outerColor)}" stroke-width="${r(half)}" />`,
        );
        svgParts.push(
          `${indent}<rect x="${r(el.x + innerInset)}" y="${r(el.y + innerInset)}" width="${r(el.width - 2 * innerInset)}" height="${r(el.height - 2 * innerInset)}" rx="${r(Math.max(0, borderRadius - innerInset))}" fill="none" stroke="${colorStr(innerColor)}" stroke-width="${r(half)}" />`,
        );
      } else if (style === "inset" || style === "outset") {
        // Top+left get one shade, bottom+right get the other. inset looks pressed-in,
        // outset raised-out. Emit via 4 per-side lines so each side can have its own color.
        const darker = shadeColor(bt.color, -22);
        const lighter = shadeColor(bt.color, 22);
        const tlColor = style === "inset" ? darker : lighter;
        const brColor = style === "inset" ? lighter : darker;
        const w = bt.w;
        // Lines at centerline of each side.
        svgParts.push(
          `${indent}<line x1="${r(el.x)}" y1="${r(el.y + w / 2)}" x2="${r(el.x + el.width)}" y2="${r(el.y + w / 2)}" stroke="${colorStr(tlColor)}" stroke-width="${r(w)}" />`,
        );
        svgParts.push(
          `${indent}<line x1="${r(el.x + w / 2)}" y1="${r(el.y)}" x2="${r(el.x + w / 2)}" y2="${r(el.y + el.height)}" stroke="${colorStr(tlColor)}" stroke-width="${r(w)}" />`,
        );
        svgParts.push(
          `${indent}<line x1="${r(el.x)}" y1="${r(el.y + el.height - w / 2)}" x2="${r(el.x + el.width)}" y2="${r(el.y + el.height - w / 2)}" stroke="${colorStr(brColor)}" stroke-width="${r(w)}" />`,
        );
        svgParts.push(
          `${indent}<line x1="${r(el.x + el.width - w / 2)}" y1="${r(el.y)}" x2="${r(el.x + el.width - w / 2)}" y2="${r(el.y + el.height)}" stroke="${colorStr(brColor)}" stroke-width="${r(w)}" />`,
        );
      } else if ((style === "dashed" || style === "dotted") && borderRadius === 0) {
        // Dashed/dotted uniform borders need per-side dash spacing — Chrome
        // adjusts the dash cycle so dashes start and end exactly at corners.
        // SVG `stroke-dasharray` on a single rect would use ONE pattern across
        // all 4 sides, but the top/bottom and left/right have different
        // lengths, so the pattern would mis-align at every corner. Emit 4
        // lines instead so each side gets its own adjusted pattern.
        const collapse = el.styles.borderCollapse === "collapse";
        const inset = collapse ? 0 : bt.w / 2;
        const linecap = style === "dotted" ? ` stroke-linecap="round"` : "";
        const sides: Array<[number, number, number, number, number]> = [
          [el.x, el.y + inset, el.x + el.width, el.y + inset, el.width],
          [el.x + el.width - inset, el.y, el.x + el.width - inset, el.y + el.height, el.height],
          [el.x, el.y + el.height - inset, el.x + el.width, el.y + el.height - inset, el.width],
          [el.x + inset, el.y, el.x + inset, el.y + el.height, el.height],
        ];
        for (const [x1, y1, x2, y2, len] of sides) {
          const dash = adjustedDashArray(style, bt.w, len);
          svgParts.push(
            `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
          );
        }
      } else {
        const dash = dashArrayForStyle(bt.style, bt.w);
        const linecap = bt.style === "dotted" ? ` stroke-linecap="round"` : "";
        // CSS paints borders INSIDE the border-box. SVG strokes are centered on
        // the path, so half would spill outside. Inset the rect by half the
        // stroke width so the stroke sits entirely inside the element box.
        // Exception: with border-collapse:collapse on the parent table, Chrome
        // collapses adjacent cell borders into a single shared line painted ON
        // the shared edge (not inset). If we kept the inset, two adjacent
        // cells'\'' borders would land ~1px apart and read as a doubled 2px line.
        // Centered painting (no inset) lets the two cells'\'' borders overlap
        // exactly, producing a single 1px line — matching Chrome'\''s collapsed
        // table grid.
        const collapse = el.styles.borderCollapse === "collapse";
        const half = collapse ? 0 : bt.w / 2;
        svgParts.push(
          `${indent}<rect x="${r(el.x + half)}" y="${r(el.y + half)}" width="${r(Math.max(0, el.width - half * 2))}" height="${r(Math.max(0, el.height - half * 2))}" rx="${r(Math.max(0, borderRadius - half))}" fill="none" stroke="${colorStr(bt.color)}" stroke-width="${r(bt.w)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
        );
      }
    } else if (!uniform) {
      // Per-side border: emit 4 separate lines along the element edges. Lines
      // are drawn at the centerline of each border so stroke spills equally
      // inward/outward — visually close enough for typical 1-10px borders.
      // border-collapse:collapse → paint each side ON the cell edge (not
      // inset by half-width), so two adjacent cells'\'' shared sides overlap
      // exactly and produce a single line instead of a doubled one.
      const collapse = el.styles.borderCollapse === "collapse";
      const inset = (w: number) => collapse ? 0 : w / 2;
      const sides: Array<[typeof bt, number, number, number, number, number]> = [
        [bt, el.x, el.y + inset(bt?.w ?? 0), el.x + el.width, el.y + inset(bt?.w ?? 0), el.width],
        [br, el.x + el.width - inset(br?.w ?? 0), el.y, el.x + el.width - inset(br?.w ?? 0), el.y + el.height, el.height],
        [bb, el.x, el.y + el.height - inset(bb?.w ?? 0), el.x + el.width, el.y + el.height - inset(bb?.w ?? 0), el.width],
        [bl, el.x + inset(bl?.w ?? 0), el.y, el.x + inset(bl?.w ?? 0), el.y + el.height, el.height],
      ];
      for (const [side, x1, y1, x2, y2, len] of sides) {
        if (side == null || side.w <= 0 || side.color.a < 0.01) continue;
        if (side.style === "none" || side.style === "hidden") continue;
        const dash = adjustedDashArray(side.style, side.w, len);
        const linecap = side.style === "dotted" ? ` stroke-linecap="round"` : "";
        svgParts.push(
          `${indent}<line x1="${r(x1)}" y1="${r(y1)}" x2="${r(x2)}" y2="${r(y2)}" stroke="${colorStr(side.color)}" stroke-width="${r(side.w)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
        );
      }
    } else if (borderWidth > 0 && borderColor != null && borderColor.a > 0.01) {
      // Legacy path for elements whose per-side captures weren't parsed cleanly.
      svgParts.push(
        `${indent}<rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" rx="${r(borderRadius)}" fill="none" stroke="${colorStr(borderColor)}" stroke-width="${r(borderWidth)}" />`,
      );
    }

    // Outline (SK-1111): drawn outside the border-box and shifted further out
    // by outline-offset (which can be negative). Doesn't take layout space —
    // the captured rect is the border-box, so we inflate from that. Outline
    // styles (solid / dashed / dotted) reuse dashArrayForStyle.
    {
      const ow = parseFloat(el.styles.outlineWidth ?? "0") || 0;
      const ostyle = el.styles.outlineStyle ?? "none";
      if (ow > 0 && ostyle !== "none" && ostyle !== "hidden") {
        const ocolor = parseColor(el.styles.outlineColor ?? el.styles.color);
        if (ocolor != null && ocolor.a > 0.01) {
          const offset = parseFloat(el.styles.outlineOffset ?? "0") || 0;
          // Outline rect outer edge is at border-box + offset. Stroke is
          // centered, so the rect goes at offset + ow/2 from the border-box.
          const inflate = offset + ow / 2;
          const ox = el.x - inflate;
          const oy = el.y - inflate;
          const owd = el.width + inflate * 2;
          const oh = el.height + inflate * 2;
          const dash = dashArrayForStyle(ostyle, ow);
          const linecap = ostyle === "dotted" ? ` stroke-linecap="round"` : "";
          // Outline radius: CSS spec says rounded outlines follow the border
          // radius extended outward by the offset+width. Approximate.
          const oRadius = borderRadius > 0 ? borderRadius + inflate : 0;
          svgParts.push(
            `${indent}<rect x="${r(ox)}" y="${r(oy)}" width="${r(owd)}" height="${r(oh)}" rx="${r(oRadius)}" fill="none" stroke="${colorStr(ocolor)}" stroke-width="${r(ow)}"${dash !== "" ? ` stroke-dasharray="${dash}"` : ""}${linecap} />`,
          );
        }
      }
    }

    // Inline SVG. The captured outerHTML preserves the source attributes,
    // including viewBox, but inline SVGs in the wild often omit width/height
    // (size is set by CSS on the element, e.g. width: 16px). Without explicit
    // width/height on the <svg> tag, browsers fall back to the 300x150 SVG
    // default, which produces giant rendering when we re-embed it. Inject
    // width/height from the captured rect so the SVG renders at its actual
    // on-page size.
    if (el.svgContent != null) {
      const sized = injectSvgSize(el.svgContent, el.width, el.height);
      svgParts.push(`${indent}<g transform="translate(${r(el.x)}, ${r(el.y)})">${sized}</g>`);
      return;
    }

    // Form control chrome (checkbox, radio, range, color, progress, meter,
    // select chevron, details disclosure). Paints on top of the element's
    // bg/border so the UA-default visuals are synthesized where the bare
    // capture missed them. Styled controls (author-set background/border)
    // still look like bare rects — the common case where authors match
    // Chromium defaults is handled here.
    const fc = renderFormControl(el, indent, defCtx);
    if (fc !== "") svgParts.push(fc);

    // Image (<img> or <input type="image">)
    if (el.imageSrc != null && (el.tag === "img" || (el.tag === "input" && el.styles.inputType === "image"))) {
      const fit = el.styles.objectFit ?? "fill";
      if (fit === "none" && el.imageIntrinsic != null && el.imageIntrinsic.w > 0 && el.imageIntrinsic.h > 0) {
        // object-fit: none -> render image at intrinsic size, aligned via
        // object-position inside the element's box, and clip overflow to the box.
        const iw = el.imageIntrinsic.w;
        const ih = el.imageIntrinsic.h;
        const { hPct, vPct } = parseObjectPosition(el.styles.objectPosition ?? "50% 50%");
        const ix = el.x + (el.width - iw) * (hPct / 100);
        const iy = el.y + (el.height - ih) * (vPct / 100);
        const clipId = `${idPrefix}ifn${clipIdx++}`;
        defsParts.push(`<clipPath id="${clipId}"><rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" /></clipPath>`);
        svgParts.push(
          `${indent}<image href="${esc(embedAsDataUri(el.imageSrc))}" x="${r(ix)}" y="${r(iy)}" width="${r(iw)}" height="${r(ih)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`,
        );
      } else {
        const par = preserveAspectRatioFor(fit, el.styles.objectPosition);
        svgParts.push(
          `${indent}<image href="${esc(embedAsDataUri(el.imageSrc))}" x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" preserveAspectRatio="${par}" />`,
        );
      }
    }

    // List marker — render list-style-image at the marker position for <li>
    // elements. Per CSS spec, the marker image paints at its INTRINSIC size
    // (not scaled to fontSize). The li's own height is stretched by Chromium
    // to accommodate the marker, which means el.height for a large-image
    // marker is big — we position the marker vertically centered in the first
    // line box (top of li) and let it overflow left for outside markers.
    if (el.tag === "li") {
      const lsImage = el.styles.listStyleImage;
      const lsType = el.styles.listStyleType ?? "disc";
      const fontSizePx = parseFloat(el.styles.fontSize) || 14;
      const lineHeightPx = parseFloat(el.styles.lineHeight) || fontSizePx * 1.2;
      const outside = el.styles.listStylePosition !== "inside";
      if (lsImage != null && lsImage !== "none") {
        const urlMatch = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(lsImage);
        if (urlMatch != null) {
          const intrinsic = el.listMarkerIntrinsic;
          const markerW = intrinsic != null && intrinsic.w > 0 ? intrinsic.w : 16;
          const markerH = intrinsic != null && intrinsic.h > 0 ? intrinsic.h : 16;
          const mx = outside ? el.x - markerW - 4 : el.x;
          // For a big image marker Chrome stretches the li's height to contain
          // it, then centers the text vertically within that li. The marker
          // itself is centered on the li too, so its center aligns with the
          // text line's center. Use el.height (captured from the laid-out li)
          // so we stay in sync with whatever vertical metrics Chrome used.
          const my = el.y + (el.height - markerH) / 2;
          svgParts.push(
            `${indent}<image href="${esc(embedAsDataUri(urlMatch[1]))}" x="${r(mx)}" y="${r(my)}" width="${r(markerW)}" height="${r(markerH)}" preserveAspectRatio="xMidYMid meet" />`,
          );
        }
      } else if (lsType !== "none" && lsType !== "") {
        // Synthesize a text/shape marker per list-style-type. Numeric and
        // alpha-based markers use el.listItemIndex (captured below).
        // Author CSS can override the markers color / font-weight / font-size
        // via the ::marker pseudo (SK-1115). Use those when present, falling
        // back to the lis own text color and font-size when not set.
        const markerStyleColor = el.markerColor != null ? parseColor(el.markerColor) : null;
        const markerColor = markerStyleColor != null && markerStyleColor.a > 0.01
          ? colorStr(markerStyleColor)
          : (textColor != null ? colorStr(textColor) : "rgb(0,0,0)");
        const markerFontSize = parseFloat(el.markerFontSize ?? "") || fontSizePx;
        const markerFontWeight = el.markerFontWeight ?? el.styles.fontWeight;
        // Text-marker baseline = li's text baseline. When CAPTURE_SCRIPT
        // recorded fontAscent (canvas.measureText().fontBoundingBoxAscent),
        // textTop+fontAscent is exactly where Chrome painted the body text
        // baseline (DM-237). Falling back to a 0.72*lineHeight approximation
        // when we don't have either textTop or fontAscent — that path is rare
        // (li with empty direct text), and visually close enough.
        const my = (el.textTop != null && el.fontAscent != null)
          ? el.textTop + el.fontAscent
          : el.y + lineHeightPx * 0.72;
        const shapeY = el.y + lineHeightPx / 2;
        // Default gap between marker and content = ~8px.
        const gap = 8;
        const idx = el.listItemIndex ?? 1;
        if (lsType === "disc" || lsType === "circle" || lsType === "square") {
          // Chrome's disc marker is the U+2022 bullet glyph at the marker
          // font-size; in sans-serif at 16px it's roughly 6.5px wide → r ≈ 0.20em.
          const r0 = markerFontSize * 0.2;
          const mx = outside ? el.x - gap - r0 : el.x + r0;
          if (lsType === "disc") {
            svgParts.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="${markerColor}" />`);
          } else if (lsType === "circle") {
            svgParts.push(`${indent}<circle cx="${r(mx)}" cy="${r(shapeY)}" r="${r(r0)}" fill="none" stroke="${markerColor}" stroke-width="1" />`);
          } else {
            svgParts.push(`${indent}<rect x="${r(mx - r0)}" y="${r(shapeY - r0)}" width="${r(r0 * 2)}" height="${r(r0 * 2)}" fill="${markerColor}" />`);
          }
        } else {
          // Text-based marker (decimal / lower-alpha / lower-roman / etc.).
          // Chrome's default ::marker is right-aligned within the marker box
          // with a small UA-defined gap to the content (~4px on macOS Chrome).
          // Anchor to `el.x - smallGap` with text-anchor="end" so the marker's
          // right edge sits just left of the principal block — guessing the
          // marker's rendered width is unreliable across font fallbacks
          // ("1." is 11.5px in Helvetica, 13.6px in Inter, 18px in Courier),
          // and getting it ~10px wrong drives the entire visible offset.
          const label = formatListMarker(lsType, idx) + ".";
          const smallGap = 4;
          const mx = outside ? el.x - smallGap : el.x;
          const anchor = outside ? "end" : "start";
          svgParts.push(
            `${indent}<text x="${r(mx)}" y="${r(my)}" text-anchor="${anchor}" font-size="${r(markerFontSize)}" font-weight="${markerFontWeight}" font-family="${el.styles.fontFamily}" fill="${markerColor}">${label}</text>`,
          );
        }
      }
    }

    // CSS paint order: floats paint AFTER block descendants but BEFORE the
    // parent's inline content. The "inline content" here is `el.text` — when
    // a paragraph has a `float: left` span followed by text and the span's
    // `shape-outside` lets text wrap into the float's bounding box, the text
    // should paint ON TOP of the float (not be covered by it).
    //
    // Only hoist floats when this element actually has its own text. If we
    // hoisted floats unconditionally, a parent like `<main>` whose children
    // are all blocks (search/article/figure) plus a float (aside) would
    // paint the aside FIRST and then the block siblings would cover it.
    // Letting the float fall through to the normal child sort puts it last
    // (= on top of preceding block siblings) — matching Chrome for that case.
    const hasOwnText = el.text !== "";
    const floatChildren: CapturedElement[] = [];
    const nonFloatChildren: CapturedElement[] = [];
    if (hasOwnText) {
      for (const c of el.children) {
        const flt = c.styles.float ?? "none";
        const pos = c.styles.position;
        const positioned = pos != null && pos !== "static";
        if (!positioned && flt !== "none") floatChildren.push(c);
        else nonFloatChildren.push(c);
      }
      for (const child of floatChildren) {
        renderElement(child, depth + 1);
      }
    }

    // Text rendering — delegated to text-renderer.ts based on configured mode
    if (el.text !== "") {
      const fillColor = textColor != null ? colorStr(textColor) : "#e6edf3";
      const cid = `${idPrefix}ct${clipIdx++}`;
      defsParts.push(`<clipPath id="${cid}"><rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" /></clipPath>`);

      // SK-1128: writing-mode != horizontal-tb activates the same element-
      // raster path used for textareas (SK-1108). The text region is
      // screenshotted via Playwright and stamped as <image>, bypassing the
      // path pipeline entirely. character-by-character rotation logic for
      // text-orientation: mixed (CJK upright vs Latin sideways) is a lot
      // more involved than the work we get from a faithful raster of what
      // Chrome painted, and the test corpus has only one vertical-mode
      // case for now.
      if (el.elementRaster != null && el.elementRaster.dataUri != null
          && el.styles.writingMode != null && el.styles.writingMode !== "horizontal-tb") {
        const er = el.elementRaster;
        svgParts.push(`${indent}<image href="${er.dataUri}" x="${r(er.x)}" y="${r(er.y)}" width="${r(er.width)}" height="${r(er.height)}" preserveAspectRatio="none" clip-path="url(#${cid})"/>`);
      } else {

      const renderOneText = (opts: { el: CapturedElement; idPrefix: string; clipId: string; fillColor: string }): string => {
        const hasMultipleSegments = opts.el.textSegments != null && opts.el.textSegments.length > 1;
        const isMultiLine = opts.el.text.includes("\n");
        if (hasMultipleSegments) return renderMultiSegmentText(opts, opts.el.textSegments!);
        if (isMultiLine) return renderMultiLineText(opts);
        if (opts.el.tag === "input" || opts.el.tag === "textarea") return renderInputText(opts);
        return renderSingleLineText(opts);
      };

      // text-shadow (SK-1113): render each shadow as a recolored copy of
      // the same text, shifted by the shadows (x, y) and wrapped in a
      // Gaussian-blur filter when blur > 0. Shadows paint UNDER the main
      // text, with the FIRST listed shadow CLOSEST to the text — so emit
      // in REVERSE order (deepest first). Each shadow uses a fake element
      // with x/y shifted in place of the original; the renderers anchor
      // off el.textLeft/el.textTop/segment.x/y so this is enough to move
      // every glyph by the same delta.
      const textShadows = parseBoxShadow(el.styles.textShadow ?? "none");
      for (let si = textShadows.length - 1; si >= 0; si--) {
        const sh = textShadows[si];
        if (sh.inset) continue; // text-shadow has no inset; defensive
        const shadowFillColor = colorStr(parseColor(sh.color) ?? { r: 0, g: 0, b: 0, a: 0 });
        const shifted: CapturedElement = {
          ...el,
          x: el.x + sh.x,
          y: el.y + sh.y,
          textLeft: el.textLeft != null ? el.textLeft + sh.x : undefined,
          textTop: el.textTop != null ? el.textTop + sh.y : undefined,
          textSegments: el.textSegments?.map((s) => ({
            ...s,
            x: s.x + sh.x,
            y: s.y + sh.y,
            xOffsets: s.xOffsets?.map((v) => v + sh.x),
            // The shadow shouldnt double-stamp emoji/raster overlays —
            // those already carry their own pixel-baked color and shifting
            // them paints the same emoji again. Drop them on the shadow
            // copy so only the path text gets shadowed.
            rasterRect: undefined,
            rasterDataUri: undefined,
            rasterGlyphs: undefined,
          })),
        };
        let body = renderOneText({ el: shifted, idPrefix, clipId: cid, fillColor: shadowFillColor });
        if (sh.blur > 0) {
          const stdDev = sh.blur / 2;
          const fid = `${idPrefix}tsh${clipIdx++}`;
          defsParts.push(
            `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${r(stdDev)}"/></filter>`,
          );
          body = `<g filter="url(#${fid})">${body}</g>`;
        }
        svgParts.push(`${indent}${body}`);
      }

      const renderOpts = { el, idPrefix, clipId: cid, fillColor };
      svgParts.push(`${indent}${renderOneText(renderOpts)}`);
      }
    }

    // Pseudo-element image content (::before / ::after with content: url(...)).
    if (el.pseudoImages != null) {
      for (const pi of el.pseudoImages) {
        svgParts.push(`${indent}<image href="${esc(embedAsDataUri(pi.url))}" x="${r(pi.x)}" y="${r(pi.y)}" width="${r(pi.width)}" height="${r(pi.height)}" preserveAspectRatio="xMidYMid meet" />`);
      }
    }

    // Overflow clipping: when a parent has overflow != visible (hidden/scroll/
    // auto/clip on either axis), its children must be clipped to its box.
    // We wrap just the child recursion in a <g clip-path="..."> so the element's
    // own bg/border/text render unclipped (border-box is outside the padding
    // edge, which is where overflow clips).
    const ox = el.styles.overflowX;
    const oy = el.styles.overflowY;
    const clipsOverflow = (ox != null && ox !== "visible") || (oy != null && oy !== "visible");
    let overflowClipId: string | null = null;
    if (clipsOverflow && el.children.length > 0) {
      overflowClipId = `${idPrefix}ov${clipIdx++}`;
      defsParts.push(`<clipPath id="${overflowClipId}"><rect x="${r(el.x)}" y="${r(el.y)}" width="${r(el.width)}" height="${r(el.height)}" rx="${r(borderRadius)}" /></clipPath>`);
      svgParts.push(`${indent}<g clip-path="url(#${overflowClipId})">`);
    }

    // Children — sorted by CSS paint order. Elements with position != static
    // and an explicit integer z-index paint in z-index order (negative below,
    // positive above); auto or static keeps DOM order. This is an approximation
    // of full CSS stacking context semantics but covers the common case of
    // positioned siblings jockeying for front/back. When we hoisted floats
    // above (text-bearing parents), exclude them here; otherwise sort all.
    const remainingChildren = hasOwnText ? nonFloatChildren : el.children;
    const sortedChildren = sortChildrenByPaintOrder(remainingChildren);
    for (const child of sortedChildren) {
      renderElement(child, depth + 1);
    }

    if (overflowClipId != null) svgParts.push(`${indent}</g>`);

    // Scrollbar thumb indicator — only painted when the element has an
    // actual scroll offset (scrollTop > 0 or scrollLeft > 0). Chromium macOS
    // uses overlay scrollbars that are invisible at rest (verified: Playwright
    // captures show no scrollbar chrome for non-scrolled static frames), so
    // rendering one by default actually makes diffs worse. When content IS
    // scrolled, the thumb gives a useful visual cue.
    const scrollbarMarkup = renderScrollbarChrome(el, indent);
    if (scrollbarMarkup !== "") svgParts.push(scrollbarMarkup);

    if (animClass !== "") svgParts.push(`${indent}</g>`);
    if (opened) svgParts.push(`${indent}</g>`);
  }

  // Sort top-level siblings by CSS paint order too. captureElementTree
  // returns the root element's children as a flat array (body's children for
  // the default selector), and without this sort a fixed-positioned top-level
  // sibling painted before a following static one would end up BEHIND it —
  // visible on 13-pos-fixed where the .filler block was covering the .footbar
  // because both are body children and filler followed footbar in DOM.
  const sortedTopLevel = sortChildrenByPaintOrder(elements);
  for (const el of sortedTopLevel) {
    renderElement(el, 1);
  }

  // Prepend defs block: clipPaths + optional glyph path definitions. For
  // animated multi-frame SVGs the caller passes includeGlyphDefs=false and
  // collects glyph defs once at the top level via getGlyphDefs().
  const glyphDefsMarkup = includeGlyphDefs ? getGlyphDefs() : "";
  const allDefs = defsParts.join("") + glyphDefsMarkup;
  const defs = allDefs !== "" ? `  <defs>${allDefs}</defs>\n` : "";
  return defs + svgParts.join("\n");
}

interface RGBA { r: number; g: number; b: number; a: number }

function parseColor(css: string): RGBA | null {
  if (css === "" || css === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  // rgb()/rgba() — Chromium uses this form for srgb colors.
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(css);
  if (m != null) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] != null ? +m[4] : 1 };
  // #rrggbb / #rrggbbaa — hex fallbacks.
  const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(css);
  if (h != null) {
    const a = h[2] != null ? parseInt(h[2], 16) / 255 : 1;
    return { r: parseInt(h[1].slice(0, 2), 16), g: parseInt(h[1].slice(2, 4), 16), b: parseInt(h[1].slice(4, 6), 16), a };
  }
  // color(srgb r g b [/ a]) — produced by the capture-side normalizer for
  // wide-gamut inputs (oklch/lab/color(display-p3)/color-mix). Values are 0..1
  // floats, sometimes negative or >1 when the source was out-of-srgb-gamut;
  // clamp before scaling to 0..255.
  const cs = /^color\(srgb\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i.exec(css);
  if (cs != null) {
    const clamp = (v: number): number => Math.max(0, Math.min(1, v));
    return {
      r: Math.round(clamp(+cs[1]) * 255),
      g: Math.round(clamp(+cs[2]) * 255),
      b: Math.round(clamp(+cs[3]) * 255),
      a: cs[4] != null ? +cs[4] : 1,
    };
  }
  return null;
}

function colorStr(c: RGBA): string {
  return c.a < 1 ? `rgba(${c.r},${c.g},${c.b},${r(c.a)})` : `rgb(${c.r},${c.g},${c.b})`;
}

function r(n: number): string { return Number(n.toFixed(1)).toString(); }
function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

/**
 * Inject explicit width/height into an inline `<svg ...>` opening tag if it
 * doesn't already have them. Inline icon SVGs commonly omit width/height (CSS
 * sizes them) — re-embedding such an SVG without explicit dimensions makes
 * the renderer fall back to the 300x150 default size, producing the giant
 * black-blob bug. We force width/height to match the captured layout rect
 * so the existing viewBox scales to the right on-page size.
 */
function injectSvgSize(svgHtml: string, w: number, h: number): string {
  if (w <= 0 || h <= 0) return svgHtml;
  const m = /^(<svg\b)([^>]*)(>)/i.exec(svgHtml);
  if (m == null) return svgHtml;
  const attrs = m[2];
  const hasWidth = /\swidth\s*=/.test(attrs);
  const hasHeight = /\sheight\s*=/.test(attrs);
  if (hasWidth && hasHeight) return svgHtml;
  let inject = "";
  if (!hasWidth) inject += ` width="${r(w)}"`;
  if (!hasHeight) inject += ` height="${r(h)}"`;
  return svgHtml.slice(0, m[0].length - 1) + inject + ">" + svgHtml.slice(m[0].length);
}

interface BorderSide { w: number; style: string; color: RGBA }

function parseSide(widthCss: string | undefined, styleCss: string | undefined, colorCss: string | undefined): BorderSide | null {
  if (widthCss == null || styleCss == null || colorCss == null) return null;
  const w = parseFloat(widthCss) || 0;
  const color = parseColor(colorCss);
  if (color == null) return null;
  return { w, style: styleCss, color };
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && Math.abs(a.a - b.a) < 0.01;
}

/**
 * Render a CSS border-image 9-slice around the element's border box.
 *
 * Supports:
 *   - border-image-source: url(...)         (gradient sources out of scope)
 *   - border-image-slice: t r b l            (percent + length, optional 'fill')
 *   - border-image-width: per-side (falls back to element border-width)
 *   - border-image-outset: per-side
 *   - border-image-repeat: stretch / repeat / round / space
 *
 * Returns { svg, usedIds }. usedIds indicates how many clipIdx values were
 * consumed so the caller can keep its own counter in sync.
 */
function renderBorderImage(
  el: CapturedElement,
  indent: string,
  idPrefix: string,
  defsParts: string[],
  clipIdx: number,
): { svg: string; usedIds: number } {
  const src = el.styles.borderImageSource;
  if (src == null || src === "none" || src === "") return { svg: "", usedIds: 0 };

  const urlMatch = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(src);
  if (urlMatch == null) return { svg: "", usedIds: 0 };
  const url = urlMatch[1];
  const natW = el.styles.borderImageIntrinsicWidth ?? 0;
  const natH = el.styles.borderImageIntrinsicHeight ?? 0;
  if (natW <= 0 || natH <= 0) return { svg: "", usedIds: 0 };

  // Slice values: numbers are pixels (intrinsic image pixels). Percentages
  // resolve against natW/natH. 'fill' keyword (anywhere) enables center.
  const sliceRaw = el.styles.borderImageSlice ?? "100%";
  const fillCenter = /\bfill\b/i.test(sliceRaw);
  const sliceTokens = sliceRaw.replace(/\bfill\b/i, "").trim().split(/\s+/);
  const sliceNums = sliceTokens.map((t) => {
    if (/%$/.test(t)) {
      // First two tokens measure vertically (top/bottom from natH); next two horizontally (right/left from natW).
      // We'll resolve per-side below using index.
      return { pct: parseFloat(t) };
    }
    return { px: parseFloat(t) };
  });
  const resolveSlice = (tok: { pct?: number; px?: number }, basis: number): number => {
    if (tok.pct != null) return (tok.pct / 100) * basis;
    return tok.px ?? 0;
  };
  const st = resolveSlice(sliceNums[0] ?? { px: 0 }, natH);
  const sr = resolveSlice(sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);
  const sb = resolveSlice(sliceNums[2] ?? sliceNums[0] ?? { px: 0 }, natH);
  const sl = resolveSlice(sliceNums[3] ?? sliceNums[1] ?? sliceNums[0] ?? { px: 0 }, natW);

  // Widths and outsets: CSS allows px/%/unitless. Unitless = multiplier of the
  // element's border-width on that side. 'auto' = element's border-width.
  const bwTop = parseFloat(el.styles.borderTopWidth ?? "0") || 0;
  const bwRight = parseFloat(el.styles.borderRightWidth ?? "0") || 0;
  const bwBottom = parseFloat(el.styles.borderBottomWidth ?? "0") || 0;
  const bwLeft = parseFloat(el.styles.borderLeftWidth ?? "0") || 0;
  const parseBorderImageLen = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "" || tok === "auto") return borderW;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    // Unitless number -> multiplier of border-width.
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : borderW;
  };
  const widthTokens = (el.styles.borderImageWidth ?? "").trim().split(/\s+/);
  const wt = parseBorderImageLen(widthTokens[0], el.height, bwTop);
  const wr = parseBorderImageLen(widthTokens[1] ?? widthTokens[0], el.width, bwRight);
  const wb = parseBorderImageLen(widthTokens[2] ?? widthTokens[0], el.height, bwBottom);
  const wl = parseBorderImageLen(widthTokens[3] ?? widthTokens[1] ?? widthTokens[0], el.width, bwLeft);

  // Outsets: same parsing; default 0.
  const outsetTokens = (el.styles.borderImageOutset ?? "0").trim().split(/\s+/);
  const parseOutset = (tok: string | undefined, basis: number, borderW: number): number => {
    if (tok == null || tok === "") return 0;
    if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
    if (/(px|em|rem|pt|pc|cm|mm|in|Q)$/.test(tok)) return parseFloat(tok) || 0;
    const n = parseFloat(tok);
    return Number.isFinite(n) ? n * borderW : 0;
  };
  const ot = parseOutset(outsetTokens[0], el.height, bwTop);
  const or_ = parseOutset(outsetTokens[1] ?? outsetTokens[0], el.width, bwRight);
  const ob = parseOutset(outsetTokens[2] ?? outsetTokens[0], el.height, bwBottom);
  const ol = parseOutset(outsetTokens[3] ?? outsetTokens[1] ?? outsetTokens[0], el.width, bwLeft);

  const boxX = el.x - ol;
  const boxY = el.y - ot;
  const boxW = el.width + ol + or_;
  const boxH = el.height + ot + ob;

  // Repeat policy per axis (tokens order: H V; fallback: single token applies to both).
  const repeatTokens = (el.styles.borderImageRepeat ?? "stretch").trim().split(/\s+/);
  const rH = (repeatTokens[0] || "stretch").toLowerCase();
  const rV = (repeatTokens[1] || rH).toLowerCase();

  // Slot geometry (in element-absolute coords).
  const x0 = boxX, x1 = boxX + wl, x2 = boxX + boxW - wr, x3 = boxX + boxW;
  const y0 = boxY, y1 = boxY + wt, y2 = boxY + boxH - wb, y3 = boxY + boxH;

  // Corresponding source regions (in intrinsic image pixels).
  // Full image 9-slice mapping:
  //   NW = (0,0)-(sl,st); N = (sl,0)-(natW-sr,st); NE = (natW-sr,0)-(natW,st)
  //   W  = (0,st)-(sl,natH-sb); C = (sl,st)-(natW-sr,natH-sb); E = (natW-sr,st)-(natW,natH-sb)
  //   SW = (0,natH-sb)-(sl,natH); S = (sl,natH-sb)-(natW-sr,natH); SE = ...
  const sxL = 0, sxR = natW - sr, sxC = sl, sxW_C = natW - sl - sr;
  const syT = 0, syB = natH - sb, syC = st, syH_C = natH - st - sb;

  const parts: string[] = [];
  let usedIds = 0;

  // Each slot is either:
  //   - a <pattern> backed by a clipped <svg><image/></svg> tile (for repeat variants)
  //   - or a simple <image href preserveAspectRatio='none'> scaled to the slot (stretch, corners)
  // For slots drawn by <image>, we use an SVG <clipPath> + translate to show just the
  // right slice of the source. Since href is an absolute URL, loading is shared.

  const emitStretchedSlice = (
    dxSlot: number,
    dySlot: number,
    dwSlot: number,
    dhSlot: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    const clipId = `${idPrefix}bi${clipIdx + usedIds}`;
    usedIds++;
    // Clip to the slot, draw the whole image scaled so the source region (sx,sy,sw,sh) maps to (dxSlot,dySlot,dwSlot,dhSlot).
    defsParts.push(`<clipPath id="${clipId}"><rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" /></clipPath>`);
    const scaleX = dwSlot / sw;
    const scaleY = dhSlot / sh;
    const imgX = dxSlot - sx * scaleX;
    const imgY = dySlot - sy * scaleY;
    const imgW = natW * scaleX;
    const imgH = natH * scaleY;
    parts.push(`${indent}<image href="${esc(embedAsDataUri(url))}" x="${r(imgX)}" y="${r(imgY)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`);
  };

  // For edge slots with repeat/round/space, we tile along one axis. Simplest
  // repeating impl: use a <pattern>. Round rescales tile count to be integer.
  const emitTiledSliceEdge = (
    dxSlot: number,
    dySlot: number,
    dwSlot: number,
    dhSlot: number,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    axis: "x" | "y",
    mode: "repeat" | "round" | "space",
  ): void => {
    if (dwSlot <= 0 || dhSlot <= 0 || sw <= 0 || sh <= 0) return;
    // Natural tile size = source region scaled to match the slot's non-tiling dimension.
    let tileW: number, tileH: number;
    if (axis === "x") {
      // Top / bottom edges: tile horizontally; non-tiling dim is height.
      tileH = dhSlot;
      tileW = sw * (dhSlot / sh);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dwSlot / tileW));
        tileW = dwSlot / count;
      }
    } else {
      tileW = dwSlot;
      tileH = sh * (dwSlot / sw);
      if (mode === "round") {
        const count = Math.max(1, Math.round(dhSlot / tileH));
        tileH = dhSlot / count;
      }
    }
    // space: pad between tiles. Approximated here as a constant gap; exact
    // placement depends on count math Chrome uses. Close-enough fallback.
    let patternW = tileW, patternH = tileH;
    if (mode === "space") {
      if (axis === "x") {
        const count = Math.max(1, Math.floor(dwSlot / tileW));
        patternW = dwSlot / count;
      } else {
        const count = Math.max(1, Math.floor(dhSlot / tileH));
        patternH = dhSlot / count;
      }
    }
    const patId = `${idPrefix}bip${clipIdx + usedIds}`;
    usedIds++;
    // Pattern: single <image> showing just the slice, scaled to patternW x patternH.
    const imgScaleX = tileW / sw;
    const imgScaleY = tileH / sh;
    const inImgX = -sx * imgScaleX;
    const inImgY = -sy * imgScaleY;
    const inImgW = natW * imgScaleX;
    const inImgH = natH * imgScaleY;
    defsParts.push(`<pattern id="${patId}" patternUnits="userSpaceOnUse" x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(patternW)}" height="${r(patternH)}"><image href="${esc(embedAsDataUri(url))}" x="${r(inImgX)}" y="${r(inImgY)}" width="${r(inImgW)}" height="${r(inImgH)}" preserveAspectRatio="none" /></pattern>`);
    parts.push(`${indent}<rect x="${r(dxSlot)}" y="${r(dySlot)}" width="${r(dwSlot)}" height="${r(dhSlot)}" fill="url(#${patId})" />`);
  };

  // Corners: always stretched (CSS spec).
  emitStretchedSlice(x0, y0, wl, wt, sxL, syT, sl, st);                             // NW
  emitStretchedSlice(x2, y0, wr, wt, sxR, syT, sr, st);                             // NE
  emitStretchedSlice(x0, y2, wl, wb, sxL, syB, sl, sb);                             // SW
  emitStretchedSlice(x2, y2, wr, wb, sxR, syB, sr, sb);                             // SE

  // Top + Bottom edges (horizontal axis).
  if (rH === "stretch") {
    emitStretchedSlice(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st);
    emitStretchedSlice(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb);
  } else {
    emitTiledSliceEdge(x1, y0, x2 - x1, wt, sxC, syT, sxW_C, st, "x", rH as "repeat" | "round" | "space");
    emitTiledSliceEdge(x1, y2, x2 - x1, wb, sxC, syB, sxW_C, sb, "x", rH as "repeat" | "round" | "space");
  }
  // Left + Right edges (vertical axis).
  if (rV === "stretch") {
    emitStretchedSlice(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C);
    emitStretchedSlice(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C);
  } else {
    emitTiledSliceEdge(x0, y1, wl, y2 - y1, sxL, syC, sl, syH_C, "y", rV as "repeat" | "round" | "space");
    emitTiledSliceEdge(x2, y1, wr, y2 - y1, sxR, syC, sr, syH_C, "y", rV as "repeat" | "round" | "space");
  }
  // Center (only if 'fill').
  if (fillCenter) {
    if (rH === "stretch" && rV === "stretch") {
      emitStretchedSlice(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
    } else {
      // Center repeat is uncommon; fall back to stretch for simplicity.
      emitStretchedSlice(x1, y1, x2 - x1, y2 - y1, sxC, syC, sxW_C, syH_C);
    }
  }

  return { svg: parts.join("\n"), usedIds };
}

/**
 * Emit a macOS-style overlay scrollbar thumb when the captured element has
 * been scrolled (scrollTop > 0 or scrollLeft > 0). Chromium macOS uses
 * overlay scrollbars that are invisible at rest — a screenshot capture of a
 * non-scrolled page shows no scrollbar chrome at all. So we ONLY paint the
 * thumb when the captured state reflects an active scroll; this matches
 * Chromium's captured appearance during/after a scroll gesture, and avoids
 * noise when the capture is a fresh page at scrollTop=0.
 *
 * Thumb: ~7px rounded-rect with rgba(0,0,0,0.4) fill. Positioned on the
 * inside-right edge (Y axis) / inside-bottom edge (X axis) of the element.
 */
function renderScrollbarChrome(el: CapturedElement, indent: string): string {
  const s = el.styles;
  const THUMB = 7;
  const THUMB_COLOR = "rgba(0,0,0,0.40)";

  const overflowYScroll = s.overflowY === "auto" || s.overflowY === "scroll";
  const overflowXScroll = s.overflowX === "auto" || s.overflowX === "scroll";
  const scrolledY = overflowYScroll && (s.scrollTop ?? 0) > 0 && s.scrollHeight != null && s.clientHeight != null && s.scrollHeight > s.clientHeight;
  const scrolledX = overflowXScroll && (s.scrollLeft ?? 0) > 0 && s.scrollWidth != null && s.clientWidth != null && s.scrollWidth > s.clientWidth;

  if (!scrolledY && !scrolledX) return "";

  const parts: string[] = [];
  if (scrolledY) {
    const trackH = el.height;
    const thumbH = Math.max(20, (trackH * s.clientHeight!) / s.scrollHeight!);
    const thumbY = el.y + ((trackH - thumbH) * s.scrollTop!) / Math.max(1, s.scrollHeight! - s.clientHeight!);
    parts.push(`${indent}<rect x="${r(el.x + el.width - THUMB - 2)}" y="${r(thumbY)}" width="${r(THUMB)}" height="${r(thumbH)}" rx="${r(THUMB / 2)}" fill="${THUMB_COLOR}" />`);
  }
  if (scrolledX) {
    const trackW = el.width;
    const thumbW = Math.max(20, (trackW * s.clientWidth!) / s.scrollWidth!);
    const thumbX = el.x + ((trackW - thumbW) * s.scrollLeft!) / Math.max(1, s.scrollWidth! - s.clientWidth!);
    parts.push(`${indent}<rect x="${r(thumbX)}" y="${r(el.y + el.height - THUMB - 2)}" width="${r(thumbW)}" height="${r(THUMB)}" rx="${r(THUMB / 2)}" fill="${THUMB_COLOR}" />`);
  }
  return parts.join("\n");
}

/**
 * Shade an RGBA color by adjusting lightness in HSL space. delta is in -100..100.
 * Used for border-style groove/ridge/inset/outset where the border color is
 * lightened or darkened per side to produce the 3D bevel look Chromium paints.
 */
function shadeColor(c: RGBA, delta: number): RGBA {
  const r255 = c.r / 255, g255 = c.g / 255, b255 = c.b / 255;
  const max = Math.max(r255, g255, b255);
  const min = Math.min(r255, g255, b255);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r255: h = ((g255 - b255) / d + (g255 < b255 ? 6 : 0)) / 6; break;
      case g255: h = ((b255 - r255) / d + 2) / 6; break;
      default:   h = ((r255 - g255) / d + 4) / 6;
    }
  }
  const newL = Math.max(0, Math.min(1, l + delta / 100));
  // HSL -> RGB.
  if (s === 0) {
    const v = Math.round(newL * 255);
    return { r: v, g: v, b: v, a: c.a };
  }
  const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s;
  const p = 2 * newL - q;
  const hueToRgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: Math.round(hueToRgb(h + 1 / 3) * 255),
    g: Math.round(hueToRgb(h) * 255),
    b: Math.round(hueToRgb(h - 1 / 3) * 255),
    a: c.a,
  };
}

/**
 * Sort children into approximate paint order (CSS 2.1 §9.9 + §9.5):
 *   1. Positioned children with negative z-index (ascending).
 *   2. Non-positioned, non-floating children in DOM order (the 'block' layer).
 *   3. Floating children in DOM order (above block content).
 *   4. Positioned children with z-index: auto or 0 (DOM order).
 *   5. Positioned children with positive z-index (ascending, DOM order tie-break).
 *
 * Floats were previously lumped with base, which caused a floated <aside>
 * painted before the following <article> to be covered by the article's
 * own background rect. Promoting floats to layer 3 matches CSS painting rules.
 */
function sortChildrenByPaintOrder(children: CapturedElement[]): CapturedElement[] {
  const negative: Array<{ z: number; idx: number; el: CapturedElement }> = [];
  const floats: CapturedElement[] = [];
  const zeroOrAuto: CapturedElement[] = [];
  const positive: Array<{ z: number; idx: number; el: CapturedElement }> = [];
  const base: CapturedElement[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    const pos = c.styles.position;
    const flt = c.styles.float ?? "none";
    const zRaw = c.styles.zIndex;
    const positioned = pos != null && pos !== "static";
    const z = zRaw === "auto" || zRaw === "" || zRaw == null ? NaN : parseInt(zRaw, 10);
    if (!positioned && flt !== "none") {
      floats.push(c);
    } else if (!positioned) {
      base.push(c);
    } else if (isNaN(z)) {
      zeroOrAuto.push(c);
    } else if (z < 0) {
      negative.push({ z, idx: i, el: c });
    } else {
      positive.push({ z, idx: i, el: c });
    }
  }
  negative.sort((a, b) => a.z - b.z || a.idx - b.idx);
  positive.sort((a, b) => a.z - b.z || a.idx - b.idx);
  return [...negative.map((x) => x.el), ...base, ...floats, ...zeroOrAuto, ...positive.map((x) => x.el)];
}

/**
 * Split a comma-separated list respecting parentheses nesting. Used to split
 * multiple CSS background layers like:
 *   'linear-gradient(red, blue), url("x.png")'
 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Turn a single background-image layer into an SVG <defs> entry. Returns
 * { def, stretchedImage? } where def is always a <pattern>/<linearGradient>/<radialGradient>
 * block that can be referenced via url(#id).
 *
 * For url() sources this honors background-size (auto, cover, contain,
 * explicit px/%/keywords, per-axis), background-position (keywords + %/px),
 * and background-repeat (repeat/no-repeat/repeat-x/repeat-y/round/space).
 */
function buildBackgroundLayerDef(
  id: string, layer: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string = "auto", posCss: string = "0% 0%", repeatCss: string = "repeat",
  intrinsic: { w: number; h: number } | null = null,
  attachment: string = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
): { def: string } {
  const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
  if (linear != null) {
    const repeating = /^repeating-/i.test(layer);
    return { def: buildLinearGradientDef(id, linear[1], repeating, w, h) };
  }
  const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
  if (radial != null) {
    const repeating = /^repeating-/i.test(layer);
    return { def: buildRadialGradientDef(id, radial[1], repeating, elX, elY, w, h) };
  }
  const url = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(layer);
  if (url != null) {
    return { def: buildImagePatternDef(id, url[1], elX, elY, w, h, sizeCss, posCss, repeatCss, intrinsic, attachment, fixedViewport) };
  }
  return { def: "" };
}

/** Compute the tile size + origin offset + effective repeat unit for a url() background layer. */
function buildImagePatternDef(
  id: string, href: string,
  elX: number, elY: number, w: number, h: number,
  sizeCss: string, posCss: string, repeatCss: string,
  intrinsic: { w: number; h: number } | null,
  /**
   * background-attachment. When 'fixed' the image is anchored to the viewport,
   * not the element. For a static capture we don't need dynamic scroll-following —
   * we just need the right offset at t=0: viewport coords === SVG canvas coords,
   * so patX/patY should be viewport-relative instead of element-relative.
   * 'fixedViewport' is {w, h} of the capture viewport (needed for size keywords
   * like cover/contain/%).
   */
  attachment: string = "scroll",
  fixedViewport: { w: number; h: number } | null = null,
): string {
  // When background-attachment is fixed, the sizing + positioning basis is
  // the viewport, not the elements box. Override w/h + origin for that path.
  const isFixed = attachment === "fixed" && fixedViewport != null;
  const basisW = isFixed ? fixedViewport!.w : w;
  const basisH = isFixed ? fixedViewport!.h : h;
  const originX = isFixed ? 0 : elX;
  const originY = isFixed ? 0 : elY;
  // Split repeat into per-axis (CSS: repeat-x/-y are shorthands).
  let repH = "repeat", repV = "repeat";
  const rTok = repeatCss.trim().split(/\s+/);
  if (rTok[0] === "repeat-x") { repH = "repeat"; repV = "no-repeat"; }
  else if (rTok[0] === "repeat-y") { repH = "no-repeat"; repV = "repeat"; }
  else {
    repH = rTok[0];
    repV = rTok[1] ?? rTok[0];
  }

  // Resolve background-size into a concrete tile w/h. For fixed backgrounds
  // the basis is the viewport, not the element.
  let tileW = basisW, tileH = basisH;
  const sizeTok = sizeCss.trim().split(/\s+/);
  if (sizeCss === "cover") {
    if (intrinsic != null) {
      const scale = Math.max(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else if (sizeCss === "contain") {
    if (intrinsic != null) {
      const scale = Math.min(basisW / intrinsic.w, basisH / intrinsic.h);
      tileW = intrinsic.w * scale;
      tileH = intrinsic.h * scale;
    }
  } else {
    const resolveSizeToken = (tok: string, basis: number, intrinsicDim: number): number => {
      if (tok == null || tok === "auto") return intrinsicDim;
      if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
      return parseFloat(tok) || intrinsicDim;
    };
    const hasTwo = sizeTok.length > 1;
    const intrinsicW = intrinsic?.w ?? basisW;
    const intrinsicH = intrinsic?.h ?? basisH;
    tileW = resolveSizeToken(sizeTok[0], basisW, intrinsicW);
    if (hasTwo) {
      tileH = resolveSizeToken(sizeTok[1], basisH, intrinsicH);
    } else if (sizeTok[0] === "auto") {
      tileH = intrinsicH;
    } else if (intrinsic != null) {
      // Single value sizes width; height scales proportionally to intrinsic aspect.
      tileH = tileW * (intrinsicH / intrinsicW);
    } else {
      tileH = basisH;
    }
  }

  // Resolve background-position. Keywords: left/right/top/bottom/center; %/px.
  // For fixed backgrounds the basis is the viewport. Chrome normalizes the
  // 4-token form "right 20px bottom 20px" to calc() form — e.g.
  // "calc(100% - 20px) calc(100% - 20px)" — so our tokenizer must respect
  // parens and the resolver must evaluate simple calc expressions.
  const tokenizeTopLevel = (s: string): string[] => {
    const tokens: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of s) {
      if (ch === "(") { depth++; current += ch; continue; }
      if (ch === ")") { depth--; current += ch; continue; }
      if (/\s/.test(ch) && depth === 0) {
        if (current !== "") { tokens.push(current); current = ""; }
        continue;
      }
      current += ch;
    }
    if (current !== "") tokens.push(current);
    return tokens;
  };
  const posTok = tokenizeTopLevel(posCss.trim());
  const evalCalc = (t: string, basis: number, tile: number): number => {
    const m = /^calc\((.+)\)$/.exec(t);
    if (m == null) return NaN;
    const parts = m[1].trim().split(/\s+([+-])\s+/);
    if (parts.length !== 3) return NaN;
    const [a, op, c] = parts;
    const reso = (s: string): number => {
      if (/%$/.test(s)) return (parseFloat(s) / 100) * (basis - tile);
      return parseFloat(s) || 0;
    };
    const lhs = reso(a);
    const rhs = reso(c);
    return op === "+" ? lhs + rhs : lhs - rhs;
  };
  const resolveH = (t: string): number => {
    if (t === "left") return 0;
    if (t === "right") return basisW - tileW;
    if (t === "center") return (basisW - tileW) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisW, tileW);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisW - tileW));
    return parseFloat(t) || 0;
  };
  const resolveV = (t: string): number => {
    if (t === "top") return 0;
    if (t === "bottom") return basisH - tileH;
    if (t === "center") return (basisH - tileH) / 2;
    if (t.startsWith("calc(")) return evalCalc(t, basisH, tileH);
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basisH - tileH));
    return parseFloat(t) || 0;
  };
  const isHoriz = (t: string): boolean => t === "left" || t === "right";
  const isVert = (t: string): boolean => t === "top" || t === "bottom";
  const isLen = (t: string): boolean => /^-?\d/.test(t) || t === "0";
  // Parse an explicit offset value (px or %) used after a side keyword in the
  // 4-token form. Percentages scale against the available space.
  const parseAxisOffset = (t: string, basis: number, tile: number): number => {
    if (/%$/.test(t)) return ((parseFloat(t) / 100) * (basis - tile));
    return parseFloat(t) || 0;
  };
  let posX: number;
  let posY: number;
  // 4-token form: side offset side offset — e.g. "right 20px bottom 20px".
  // Each side keyword is anchored to the matching edge and the offset pushes
  // the tile inward.
  if (
    posTok.length >= 4
    && (isHoriz(posTok[0]) || isVert(posTok[0]))
    && isLen(posTok[1])
    && (isHoriz(posTok[2]) || isVert(posTok[2]))
    && isLen(posTok[3])
  ) {
    const aIsH = isHoriz(posTok[0]);
    const hSide = aIsH ? posTok[0] : posTok[2];
    const hOff = aIsH ? posTok[1] : posTok[3];
    const vSide = aIsH ? posTok[2] : posTok[0];
    const vOff = aIsH ? posTok[3] : posTok[1];
    posX = hSide === "right"
      ? basisW - tileW - parseAxisOffset(hOff, basisW, tileW)
      : parseAxisOffset(hOff, basisW, tileW);
    posY = vSide === "bottom"
      ? basisH - tileH - parseAxisOffset(vOff, basisH, tileH)
      : parseAxisOffset(vOff, basisH, tileH);
  } else {
    posX = resolveH(posTok[0] ?? "0%");
    posY = resolveV(posTok[1] ?? posTok[0] ?? "0%");
    // Swap when keywords are given in vertical-first order (e.g. "top 50%").
    if (posTok[0] === "top" || posTok[0] === "bottom") {
      posY = resolveV(posTok[0]);
      posX = resolveH(posTok[1] ?? "50%");
    }
  }

  // 'round' rebinds tile size so count is integer.
  if (repH === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisW / tileW));
    tileW = basisW / count;
  }
  if (repV === "round" && intrinsic != null) {
    const count = Math.max(1, Math.round(basisH / tileH));
    tileH = basisH / count;
  }
  const periodW = (repH === "repeat" || repH === "round") ? tileW
                : repH === "space" ? Math.max(tileW, basisW / Math.max(1, Math.floor(basisW / tileW)))
                : basisW * 2; // no-repeat: make pattern huge so only one tile fits
  const periodH = (repV === "repeat" || repV === "round") ? tileH
                : repV === "space" ? Math.max(tileH, basisH / Math.max(1, Math.floor(basisH / tileH)))
                : basisH * 2;

  // Pattern position in userSpaceOnUse — absolute SVG canvas coords. For scroll
  // backgrounds that's elX+posX (positioned within the element). For fixed
  // backgrounds the viewport IS the canvas, so patX = posX directly.
  const patX = originX + posX;
  const patY = originY + posY;

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${r(patX)}" y="${r(patY)}" width="${r(periodW)}" height="${r(periodH)}"><image href="${esc(embedAsDataUri(href))}" x="0" y="0" width="${r(tileW)}" height="${r(tileH)}" preserveAspectRatio="none" /></pattern>`;
}

interface GradientStop { color: RGBA; pos: number }

/** Parse the comma-separated 'args' inside a linear-gradient(...) and emit an SVG <linearGradient>.
 * w/h are the element box dimensions — needed to compute corner-to-corner
 * directional keywords ('to top right' etc.) which are aspect-ratio-dependent,
 * not always 45deg. */
function buildLinearGradientDef(id: string, args: string, repeating: boolean, w: number = 1, h: number = 1): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let angleDeg = 180; // default 'to bottom'
  let stopsStart = 0;
  const first = parts[0];
  const toMatch = /^to\s+(.+)$/i.exec(first);
  if (toMatch != null) {
    angleDeg = cssDirectionToAngle(toMatch[1], w, h);
    stopsStart = 1;
  } else {
    const angleMatch = /^(-?[\d.]+)(deg|rad|grad|turn)?$/i.exec(first);
    if (angleMatch != null) {
      const unit = (angleMatch[2] ?? "deg").toLowerCase();
      const n = parseFloat(angleMatch[1]);
      angleDeg = unit === "rad" ? (n * 180) / Math.PI : unit === "grad" ? n * 0.9 : unit === "turn" ? n * 360 : n;
      stopsStart = 1;
    }
  }
  const stops = parseGradientStops(parts.slice(stopsStart));
  if (stops.length === 0) return "";

  // CSS: 0deg points up. SVG coords: y grows down. Vector for CSS angle α is
  // (sin α, -cos α). Gradient line goes through center; endpoints are at
  // center ± 0.5*vector in objectBoundingBox coords.
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const x1 = 0.5 - 0.5 * dx;
  const y1 = 0.5 - 0.5 * dy;
  const x2 = 0.5 + 0.5 * dx;
  const y2 = 0.5 + 0.5 * dy;

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  // Stop offsets need 4 decimals of precision — rounding 0.33 to 0.3 would turn
  // three equal thirds into uneven bands. Use stopFmt, not r(), here.
  const stopsMarkup = stops.map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");
  return `<linearGradient id="${id}" x1="${stopFmt(x1)}" y1="${stopFmt(y1)}" x2="${stopFmt(x2)}" y2="${stopFmt(y2)}"${spread}>${stopsMarkup}</linearGradient>`;
}

function stopFmt(n: number): string { return Number(n.toFixed(4)).toString(); }

/** Parse radial-gradient args and emit an SVG <radialGradient>.
 *
 * Emits in userSpaceOnUse so we can honor CSS shape (circle vs ellipse),
 * size keywords (closest/farthest side/corner), explicit radii, and position
 * accurately in a non-square box. elX/elY are the element's absolute top-left.
 */
function buildRadialGradientDef(
  id: string, args: string, repeating: boolean,
  elX: number, elY: number, w: number, h: number,
): string {
  const parts = splitTopLevelCommas(args).map((p) => p.trim());
  let stopsStart = 0;
  let shape: "circle" | "ellipse" = "ellipse"; // CSS default
  let sizeKeyword: "closest-side" | "closest-corner" | "farthest-side" | "farthest-corner" = "farthest-corner";
  let explicitRx: number | null = null;
  let explicitRy: number | null = null;
  let cxFrac = 0.5, cyFrac = 0.5;

  // First argument can be: 'circle' | 'ellipse' [size-keyword] [at <pos>], OR
  // explicit size (one length, or two lengths for ellipse), optionally with shape, at <pos>.
  // Example valid first-args:
  //   'circle'
  //   'ellipse at top'
  //   'circle closest-side at 30% 30%'
  //   '80px 60px at 70% 40%'
  //   '100px'
  const first = parts[0];
  // Try to detect if first arg is shape/size info (no parens / no color chars)
  const isLikelyStopsStart = /#|rgb|hsl|hwb|lab|lch|oklab|oklch|color\(|transparent|[a-z]{3,}$/i.test(first) && !/\b(circle|ellipse|closest|farthest|at\b)/i.test(first);
  if (!isLikelyStopsStart) {
    stopsStart = 1;
    // Parse 'at <pos>' suffix.
    const mAt = /\bat\b/i.exec(first);
    const beforeAt = mAt != null ? first.slice(0, mAt.index).trim() : first.trim();
    const afterAt = mAt != null ? first.slice(mAt.index + 2).trim() : "";
    if (afterAt !== "") {
      const posTokens = afterAt.split(/\s+/);
      const p1 = posTokens[0] ?? "center";
      const p2 = posTokens[1] ?? "center";
      // Position can be keyword / % / px / plain number (treated as px in CSS).
      // resolvePosFraction (the linear-gradient helper) only understands keywords
      // + percent, so convert pixel values here against w/h.
      const toFrac = (tok: string, axis: "h" | "v"): number => {
        const t = tok.trim();
        if (t === "center") return 0.5;
        if (axis === "h" && t === "left") return 0;
        if (axis === "h" && t === "right") return 1;
        if (axis === "v" && t === "top") return 0;
        if (axis === "v" && t === "bottom") return 1;
        if (/%$/.test(t)) return parseFloat(t) / 100;
        // Pixels (or bare numbers treated as pixels per CSS spec).
        const px = parseFloat(t);
        if (!isNaN(px)) {
          const basis = axis === "h" ? w : h;
          return basis > 0 ? px / basis : 0;
        }
        return 0.5;
      };
      cxFrac = toFrac(p1, "h");
      cyFrac = toFrac(p2, "v");
    }
    // Parse shape / size keyword / explicit radii from beforeAt.
    const tokens = beforeAt.split(/\s+/).filter((t) => t !== "");
    for (const t of tokens) {
      if (t === "circle") shape = "circle";
      else if (t === "ellipse") shape = "ellipse";
      else if (t === "closest-side" || t === "closest-corner" || t === "farthest-side" || t === "farthest-corner") {
        sizeKeyword = t;
      } else if (/(px|%|em|rem)$/.test(t) || /^-?[\d.]+$/.test(t)) {
        const val = /%$/.test(t) ? parseFloat(t) / 100 : parseFloat(t);
        const isPct = /%$/.test(t);
        if (explicitRx == null) explicitRx = isPct ? val * w : val;
        else if (explicitRy == null) explicitRy = isPct ? val * h : val;
      }
    }
    if (explicitRx != null && explicitRy == null) {
      // Single length -> circle with that radius.
      explicitRy = explicitRx;
      shape = "circle";
    }
  }
  const stops = parseGradientStops(parts.slice(stopsStart));
  if (stops.length === 0) return "";

  // Compute center in absolute user-space coords.
  const cx = elX + cxFrac * w;
  const cy = elY + cyFrac * h;

  // Compute effective radii per shape + size keyword.
  const dxL = cxFrac * w;        // distance to left side
  const dxR = (1 - cxFrac) * w;  // to right
  const dyT = cyFrac * h;        // to top
  const dyB = (1 - cyFrac) * h;  // to bottom
  const closestX = Math.min(dxL, dxR);
  const farthestX = Math.max(dxL, dxR);
  const closestY = Math.min(dyT, dyB);
  const farthestY = Math.max(dyT, dyB);

  let rx: number, ry: number;
  if (explicitRx != null && explicitRy != null) {
    rx = explicitRx;
    ry = explicitRy;
  } else if (shape === "circle") {
    let r0: number;
    switch (sizeKeyword) {
      case "closest-side":   r0 = Math.min(closestX, closestY); break;
      case "farthest-side":  r0 = Math.max(farthestX, farthestY); break;
      case "closest-corner": r0 = Math.sqrt(closestX * closestX + closestY * closestY); break;
      case "farthest-corner":
      default:               r0 = Math.sqrt(farthestX * farthestX + farthestY * farthestY); break;
    }
    rx = r0;
    ry = r0;
  } else {
    // ellipse
    switch (sizeKeyword) {
      case "closest-side":
        rx = closestX; ry = closestY; break;
      case "farthest-side":
        rx = farthestX; ry = farthestY; break;
      case "closest-corner":
      case "farthest-corner":
      default: {
        // Ellipse that passes through the corner along the shape's aspect ratio.
        // For farthest-corner: radii (rx, ry) satisfy rx/ry = farthestX/farthestY
        // AND rx = farthestX*sqrt(2), ry = farthestY*sqrt(2) (since the corner
        // at (farthestX, farthestY) satisfies (farthestX/rx)^2 + (farthestY/ry)^2 = 1).
        const aspectX = sizeKeyword === "closest-corner" ? closestX : farthestX;
        const aspectY = sizeKeyword === "closest-corner" ? closestY : farthestY;
        rx = aspectX * Math.SQRT2;
        ry = aspectY * Math.SQRT2;
        break;
      }
    }
  }

  const spread = repeating ? ` spreadMethod="repeat"` : "";
  const stopsMarkup = stops.map((s) => `<stop offset="${stopFmt(s.pos)}" stop-color="${colorStr(s.color)}" />`).join("");

  // SVG radialGradient has a single r — use rx as r and scale Y via gradientTransform
  // to stretch it into an ellipse matching (rx, ry).
  const rScale = rx > 0 ? ry / rx : 1;
  const gradientTransform = Math.abs(rScale - 1) > 0.001
    ? ` gradientTransform="translate(0 ${stopFmt(cy * (1 - rScale))}) scale(1 ${stopFmt(rScale)})"`
    : "";

  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${stopFmt(cx)}" cy="${stopFmt(cy)}" r="${stopFmt(Math.max(rx, 1))}"${spread}${gradientTransform}>${stopsMarkup}</radialGradient>`;
}

function resolvePosFraction(token: string, axis: "h" | "v"): number {
  const t = token.trim();
  if (t === "center") return 0.5;
  if (axis === "h") {
    if (t === "left") return 0;
    if (t === "right") return 1;
  } else {
    if (t === "top") return 0;
    if (t === "bottom") return 1;
  }
  if (/%$/.test(t)) return parseFloat(t) / 100;
  return 0.5;
}

function parseGradientStops(tokens: string[]): GradientStop[] {
  // First pass: parse each token into {color, explicitPositions[]} OR {hint}.
  // A color-hint is a bare percentage between two color stops that shifts the
  // midpoint of the interpolation between them. We record hints inline so
  // they can apply to the neighboring colors after we finalize positions.
  type RawItem = { kind: "color"; color: RGBA; positions: number[] } | { kind: "hint"; pos: number };
  const raw: RawItem[] = [];
  for (const tokRaw of tokens) {
    const tok = tokRaw.trim();
    if (tok === "") continue;
    if (/^-?[\d.]+%$/.test(tok)) {
      raw.push({ kind: "hint", pos: parseFloat(tok) / 100 });
      continue;
    }
    const posMatch = tok.match(/(\s+-?[\d.]+(%|px)?\s*){1,2}$/);
    let colorStr = tok;
    const positions: number[] = [];
    if (posMatch != null) {
      colorStr = tok.slice(0, posMatch.index).trim();
      for (const pt of posMatch[0].trim().split(/\s+/)) {
        if (/%$/.test(pt)) positions.push(parseFloat(pt) / 100);
        else positions.push(parseFloat(pt));
      }
    }
    const color = parseColor(colorStr) ?? { r: 0, g: 0, b: 0, a: 1 };
    raw.push({ kind: "color", color, positions });
  }
  // Filter hints out for the first-pass color expansion; we'll inject them after
  // stop positions are resolved.
  const hints: Array<{ pos: number; afterColorIdx: number }> = [];
  const colorRaw: Array<{ color: RGBA; positions: number[] }> = [];
  for (const r of raw) {
    if (r.kind === "color") colorRaw.push({ color: r.color, positions: r.positions });
    else hints.push({ pos: r.pos, afterColorIdx: colorRaw.length - 1 });
  }
  if (colorRaw.length === 0) return [];

  // Second pass: expand each color into 1+ stops (a color can have 2 positions
  // to form a hard stop). Track which stops came from which color-raw-index so
  // we can inject hint stops in the right spot.
  const stops: GradientStop[] = [];
  const stopColorIdx: number[] = [];
  for (let i = 0; i < colorRaw.length; i++) {
    const r = colorRaw[i];
    if (r.positions.length === 0) {
      stops.push({ color: r.color, pos: NaN });
      stopColorIdx.push(i);
    } else {
      for (const p of r.positions) { stops.push({ color: r.color, pos: p }); stopColorIdx.push(i); }
    }
  }
  if (isNaN(stops[0].pos)) stops[0].pos = 0;
  if (isNaN(stops[stops.length - 1].pos)) stops[stops.length - 1].pos = 1;

  // Fill interior NaN positions by evenly distributing between the nearest
  // resolved neighbors — matches CSS behavior for implicit stops.
  let i = 0;
  while (i < stops.length) {
    if (!isNaN(stops[i].pos)) { i++; continue; }
    let j = i;
    while (j < stops.length && isNaN(stops[j].pos)) j++;
    const left = stops[i - 1].pos;
    const right = j < stops.length ? stops[j].pos : 1;
    const count = j - i + 1;
    for (let k = 0; k < j - i; k++) stops[i + k].pos = left + ((k + 1) / count) * (right - left);
    i = j;
  }
  // Monotonic clamp: each stop >= previous (CSS rule).
  for (let k = 1; k < stops.length; k++) {
    if (stops[k].pos < stops[k - 1].pos) stops[k].pos = stops[k - 1].pos;
  }

  // Inject color hints: between two stops A (at posA) and B (at posB) with a
  // hint at posH, CSS shifts the 50% transition point to posH using a power
  // interpolation. We approximate by adding a single mid-color stop at posH.
  // This is close enough for visual fidelity on most hint use cases.
  if (hints.length > 0) {
    const out: GradientStop[] = [];
    let hintIdx = 0;
    for (let s = 0; s < stops.length; s++) {
      out.push(stops[s]);
      // Is there a hint between this color's last stop and the next color's first stop?
      if (s === stops.length - 1) continue;
      const thisColorIdx = stopColorIdx[s];
      const nextColorIdx = stopColorIdx[s + 1];
      if (thisColorIdx === nextColorIdx) continue; // inside same color (hard stop)
      while (hintIdx < hints.length && hints[hintIdx].afterColorIdx <= thisColorIdx) {
        const h = hints[hintIdx++];
        if (h.afterColorIdx !== thisColorIdx) continue;
        const a = stops[s];
        const b = stops[s + 1];
        if (h.pos > a.pos && h.pos < b.pos) {
          const mid: RGBA = {
            r: Math.round((a.color.r + b.color.r) / 2),
            g: Math.round((a.color.g + b.color.g) / 2),
            b: Math.round((a.color.b + b.color.b) / 2),
            a: (a.color.a + b.color.a) / 2,
          };
          out.push({ color: mid, pos: h.pos });
        }
      }
    }
    return out;
  }
  return stops;
}

/** Map 'to top', 'to right', 'to top right' etc. to a CSS gradient angle (deg).
 *
 * Corner-to-corner directions ('to top right', etc.) depend on the box's
 * aspect ratio per CSS spec — the gradient line is drawn between opposite
 * corners, so the angle is atan2(w, h) for a w×h box (not always 45°). This
 * matters for narrow/tall boxes: a 3:1 landscape 'to top right' is ~72°, not 45°.
 */
function cssDirectionToAngle(dir: string, w: number = 1, h: number = 1): number {
  const parts = dir.trim().toLowerCase().split(/\s+/);
  const set = new Set(parts);
  const hasTop = set.has("top");
  const hasBottom = set.has("bottom");
  const hasLeft = set.has("left");
  const hasRight = set.has("right");
  if (hasTop && !hasLeft && !hasRight) return 0;
  if (hasBottom && !hasLeft && !hasRight) return 180;
  if (hasRight && !hasTop && !hasBottom) return 90;
  if (hasLeft && !hasTop && !hasBottom) return 270;
  // Corner: angle from vertical axis to the line from opposite corner to this corner.
  const cornerAngle = Math.atan2(w, h) * 180 / Math.PI;
  if (hasTop && hasRight) return cornerAngle;
  if (hasBottom && hasRight) return 180 - cornerAngle;
  if (hasBottom && hasLeft) return 180 + cornerAngle;
  if (hasTop && hasLeft) return 360 - cornerAngle;
  return 180;
}

/**
 * Translate a CSS mask-image value + mask-* siblings into an SVG <mask>.
 * Handles single-layer gradients and url() sources. Position/size/repeat are
 * applied via an internal <pattern> for url sources; gradients use direct
 * gradient fills sized to the element box.
 *
 * SVG <mask> uses luminance by default (bright pixels visible). CSS mask-mode
 * 'alpha' makes the alpha channel control visibility. We set mask-type on the
 * <mask> element accordingly. Note: Chromium may render mask-mode:'match-source'
 * differently depending on the source; we pick alpha for gradients and url()
 * (common case) and respect explicit mask-mode when given.
 */
function buildMaskDef(
  id: string, maskImage: string,
  elX: number, elY: number, w: number, h: number,
  maskMode: string, sizeCss: string, posCss: string, repeatCss: string,
  compositeCss: string,
): { id: string; def: string } {
  const layers = splitTopLevelCommas(maskImage);
  const sizeLayers = splitTopLevelCommas(sizeCss);
  const posLayers = splitTopLevelCommas(posCss);
  const repeatLayers = splitTopLevelCommas(repeatCss);
  const compositeLayers = splitTopLevelCommas(compositeCss);

  // Determine mask-type per CSS mask-mode. match-source = alpha for gradients
  // and bitmap images (the common practical behavior). Fall to luminance only
  // if the author explicitly opts in.
  const maskType = maskMode === "luminance" ? "luminance" : "alpha";

  // Per-layer contents. contents[li] = array of SVG strings (gradient defs
  // + painted rect/image) for layer li. We keep each layer separate so
  // mask-composite: intersect can emit one <mask> per layer and chain them
  // via the `mask` attribute on nested content (intersection). For plain
  // mask-composite: add (the default) we flatten all layers into a single
  // <mask> — SVG's native layer-stacking is additive.
  const layerContents: string[][] = [];
  for (let li = 0; li < layers.length; li++) layerContents.push([]);
  // Set when we encountered an SVG url() mask source that we deliberately
  // contribute no content for (SK-859/SK-860). An empty <mask> hides the
  // element entirely in SVG, matching Chrome's observed behavior for these
  // sources. Without this flag an all-empty layer list would skip mask
  // emission altogether and the element would show UNMASKED (opposite of
  // what we want), so force emission of an empty mask when it's set.
  let forceHide = false;
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li].trim();
    const layerSize = (sizeLayers[li] ?? sizeLayers[0] ?? "auto").trim();
    const layerPos = (posLayers[li] ?? posLayers[0] ?? "0% 0%").trim();
    const layerRepeat = (repeatLayers[li] ?? repeatLayers[0] ?? "repeat").trim();
    const contents = layerContents[li];
    const gradient = /^(?:repeating-)?(linear|radial)-gradient\(/i.test(layer);
    if (gradient) {
      // Resolve mask-size (defaults to 'auto' = full element box) and
      // mask-position (defaults to 0% 0%) so gradient masks honor the same
      // positioning model as url() masks. mask-size:80px+mask-position:25% 25%
      // means the gradient is painted in an 80x80 patch positioned 25%/25% of
      // the available space — not stretched to fill the whole element.
      let gradW = w, gradH = h;
      const sizeTok = layerSize.trim().split(/\s+/);
      const resolveSize = (tok: string, basis: number, fallback: number): number => {
        if (tok == null || tok === "auto" || tok === "") return fallback;
        if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
        return parseFloat(tok) || fallback;
      };
      if (layerSize === "contain" || layerSize === "cover" || layerSize === "auto" || layerSize === "") {
        gradW = w; gradH = h;
      } else {
        gradW = resolveSize(sizeTok[0], w, w);
        gradH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : gradW;
      }
      const posTok = layerPos.trim().split(/\s+/);
      const resolveH = (t: string): number => {
        if (t === "left") return 0;
        if (t === "right") return w - gradW;
        if (t === "center") return (w - gradW) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - gradW);
        return parseFloat(t) || 0;
      };
      const resolveV = (t: string): number => {
        if (t === "top") return 0;
        if (t === "bottom") return h - gradH;
        if (t === "center") return (h - gradH) / 2;
        if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - gradH);
        return parseFloat(t) || 0;
      };
      const gx = elX + resolveH(posTok[0] ?? "0%");
      const gy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
      const gradId = `${id}g${li}`;
      const linear = /^(?:repeating-)?linear-gradient\((.+)\)$/i.exec(layer);
      const radial = /^(?:repeating-)?radial-gradient\((.+)\)$/i.exec(layer);
      let def = "";
      if (linear != null) def = buildLinearGradientDef(gradId, linear[1], /^repeating-/i.test(layer), gradW, gradH);
      else if (radial != null) def = buildRadialGradientDef(gradId, radial[1], /^repeating-/i.test(layer), gx, gy, gradW, gradH);
      if (def === "") continue;
      contents.push(def);
      contents.push(`<rect x="${r(gx)}" y="${r(gy)}" width="${r(gradW)}" height="${r(gradH)}" fill="url(#${gradId})" />`);
      continue;
    }
    const url = /^url\((?:"|')?([^"')]+)(?:"|')?\)$/i.exec(layer);
    if (url != null) {
      // Chrome hides the element entirely for `mask-image: url(*.svg)` —
      // whether no-repeat + contain (SK-860) or repeat + sized (SK-859). The
      // likely cause is mask-mode: match-source resolving to luminance for
      // SVG sources and the common icon SVG (transparent background + a
      // colored shape) computing near-zero luminance over most of the tile,
      // so the mask alpha is effectively zero. Reproducing that ourselves
      // would need embedding an <image> inside the mask with mask-type
      // sampling logic that matches Chrome's exact source-type resolution,
      // which is complex and variable across renderer versions. User
      // guidance on SK-859/SK-860: match Chrome by rendering nothing.
      // Contribute no mask content for this layer — the element gets hidden
      // wherever an SVG url() mask layer claims it, matching Chrome.
      const urlHref = url[1];
      if (/\.svg(\?|#|$)/i.test(urlHref)) { forceHide = true; continue; }
      // For no-repeat mask images, emit the image DIRECTLY inside the mask —
      // not wrapped in a pattern + filled rect. The pattern+rect path paints
      // the rect opaque where the pattern is transparent, defeating alpha
      // masking. Direct <image> makes the sources alpha channel propagate
      // cleanly: opaque pixels = mask visible, transparent pixels = hidden.
      const isNoRepeat = /\bno-repeat\b/i.test(layerRepeat);
      if (isNoRepeat) {
        // Resolve mask-size + mask-position to a concrete image rect.
        let imgW = w, imgH = h;
        const sizeTok = layerSize.trim().split(/\s+/);
        const resolveSize = (tok: string, basis: number, intrinsicDim: number): number => {
          if (tok == null || tok === "auto" || tok === "") return intrinsicDim;
          if (/%$/.test(tok)) return (parseFloat(tok) / 100) * basis;
          return parseFloat(tok) || intrinsicDim;
        };
        if (layerSize === "contain" || layerSize === "cover") {
          // We don't have intrinsic mask-image dims without new Image(). For
          // now approximate with element box (contain = fit inside, cover = fill).
          // This is close enough for the common icon-mask case.
          imgW = w; imgH = h;
        } else {
          imgW = resolveSize(sizeTok[0], w, w);
          imgH = sizeTok.length > 1 ? resolveSize(sizeTok[1], h, h) : imgW;
        }
        const posTok = layerPos.trim().split(/\s+/);
        const resolveH = (t: string): number => {
          if (t === "left") return 0;
          if (t === "right") return w - imgW;
          if (t === "center") return (w - imgW) / 2;
          if (/%$/.test(t)) return (parseFloat(t) / 100) * (w - imgW);
          return parseFloat(t) || 0;
        };
        const resolveV = (t: string): number => {
          if (t === "top") return 0;
          if (t === "bottom") return h - imgH;
          if (t === "center") return (h - imgH) / 2;
          if (/%$/.test(t)) return (parseFloat(t) / 100) * (h - imgH);
          return parseFloat(t) || 0;
        };
        const ix = elX + resolveH(posTok[0] ?? "0%");
        const iy = elY + resolveV(posTok[1] ?? posTok[0] ?? "0%");
        contents.push(`<image href="${esc(embedAsDataUri(url[1]))}" x="${r(ix)}" y="${r(iy)}" width="${r(imgW)}" height="${r(imgH)}" preserveAspectRatio="xMidYMid ${layerSize === "contain" ? "meet" : layerSize === "cover" ? "slice" : "meet"}" />`);
      } else {
        // Repeating mask: fall back to pattern. Since mask-type=alpha, the
        // pattern itself needs to be backed by an <image> that's clipped to
        // the tile size so outside-tile pixels are transparent.
        const patId = `${id}p${li}`;
        const patDef = buildImagePatternDef(patId, url[1], elX, elY, w, h, layerSize, layerPos, layerRepeat, null);
        if (patDef === "") continue;
        contents.push(patDef);
        contents.push(`<rect x="${r(elX)}" y="${r(elY)}" width="${r(w)}" height="${r(h)}" fill="url(#${patId})" />`);
      }
    }
  }
  // Drop empty layers (e.g. unsupported layer values) to simplify downstream.
  const nonEmpty = layerContents.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) {
    if (forceHide) {
      // Empty <mask> hides the referenced element — matches Chrome's empty
      // rendering for SVG url() mask sources.
      return { id, def: `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}"></mask>` };
    }
    return { id, def: "" };
  }

  // Resolve per-layer composite operator. CSS accepts one value applied to
  // all layers or a comma-separated list. Only `intersect` needs special
  // handling — add is the SVG default, subtract/exclude aren't representable
  // with nested masks alone (would need filter feComposite) so we fall back
  // to add for those and warn via the captureWarnings pipeline.
  const composite = (compositeLayers[0] ?? "add").trim();
  const isIntersect = composite === "intersect"
    && compositeLayers.every((c) => c.trim() === "intersect");

  // For the default add case (single layer OR all-add), flatten every
  // layer's contents into one <mask>. SVG stacks them additively — alpha
  // accumulates where layers overlap.
  if (!isIntersect || nonEmpty.length === 1) {
    const flat = nonEmpty.flat().join("");
    const def = `<mask id="${id}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${flat}</mask>`;
    return { id, def };
  }

  // Intersect: chain N masks so each layer gates the next. Layer 0 is the
  // outer mask (the one the element references); each layer's painted rect
  // carries a mask="url(#inner)" attribute pointing at layer i+1, so its
  // pixels only show where layer i+1 is also opaque. Walk from the innermost
  // layer outward so we can reference already-built inner mask ids.
  const defs: string[] = [];
  let innerId: string | null = null;
  for (let li = nonEmpty.length - 1; li >= 0; li--) {
    const isOuter = li === 0;
    const layerMaskId = isOuter ? id : `${id}i${li}`;
    // The last item in each layer's contents is the rect/image that PAINTS
    // the mask source (earlier entries are supporting defs like <pattern>
    // or <linearGradient>). Attach mask=url(#innerId) to that paint so it's
    // clipped by the inner mask.
    const items = nonEmpty[li].slice();
    if (innerId != null && items.length > 0) {
      const last = items[items.length - 1];
      // Inject mask="..." before the closing /> (works for <rect .../> and
      // <image .../>). Safe because these are single self-closing tags we
      // emit ourselves earlier in this function.
      items[items.length - 1] = last.replace(/\/>$/, ` mask="url(#${innerId})"/>`);
    }
    defs.push(`<mask id="${layerMaskId}" maskUnits="userSpaceOnUse" mask-type="${maskType}">${items.join("")}</mask>`);
    innerId = layerMaskId;
  }
  return { id, def: defs.join("") };
}

/**
 * Translate a CSS clip-path value into an SVG <clipPath> body anchored at the
 * element's absolute (x, y, w, h). Returns "" for unsupported shapes.
 *
 * Supported:
 *   inset(<t> <r> <b> <l>) — treats percentages as fractions of the element's box
 *   circle(<r> at <x> <y>) — cx/cy via keywords or percentages
 *   ellipse(<rx> <ry> at <x> <y>)
 *   polygon(<x1> <y1>, <x2> <y2>, ...) — supports percentages and px values
 *
 * Unsupported (returns ""): path(), geometry-box references, complex shape mixes.
 */
function translateClipPath(value: string, x: number, y: number, w: number, h: number): string {
  const resolvePx = (tok: string, basis: number): number => {
    const t = tok.trim();
    if (t === "center") return basis / 2;
    if (t === "top" || t === "left") return 0;
    if (t === "bottom" || t === "right") return basis;
    if (/%$/.test(t)) return (parseFloat(t) / 100) * basis;
    return parseFloat(t) || 0;
  };
  const inset = /^inset\(([^)]+)\)$/i.exec(value);
  if (inset != null) {
    // CSS: inset(top [right [bottom [left]]] [round <border-radius>]).
    // Split off the optional `round R...` suffix first; what's left is the
    // inset offsets.
    const innerStr = inset[1].trim();
    const roundIdx = innerStr.search(/\bround\b/i);
    const insetStr = roundIdx >= 0 ? innerStr.slice(0, roundIdx).trim() : innerStr;
    const radiusStr = roundIdx >= 0 ? innerStr.slice(roundIdx + 5).trim() : "";
    const parts = insetStr.split(/\s+/);
    const top = resolvePx(parts[0], h);
    const right = resolvePx(parts[1] ?? parts[0], w);
    const bottom = resolvePx(parts[2] ?? parts[0], h);
    const left = resolvePx(parts[3] ?? parts[1] ?? parts[0], w);
    let rx = 0, ry = 0;
    if (radiusStr !== "") {
      // border-radius shorthand here can be 1-4 values, optionally with a `/`
      // separator for rx/ry pairs. Common cases: single value, two values.
      // We collapse to a uniform rx=ry using the first horizontal radius.
      const slashIdx = radiusStr.indexOf("/");
      const hPart = (slashIdx >= 0 ? radiusStr.slice(0, slashIdx) : radiusStr).trim();
      const vPart = (slashIdx >= 0 ? radiusStr.slice(slashIdx + 1) : hPart).trim();
      const hTok = hPart.split(/\s+/);
      const vTok = vPart.split(/\s+/);
      rx = resolvePx(hTok[0] ?? "0", w);
      ry = resolvePx(vTok[0] ?? hTok[0] ?? "0", h);
    }
    const rectAttrs = `x="${r(x + left)}" y="${r(y + top)}" width="${r(w - left - right)}" height="${r(h - top - bottom)}"`;
    const radiusAttrs = rx > 0 || ry > 0 ? ` rx="${r(rx)}" ry="${r(ry)}"` : "";
    return `<rect ${rectAttrs}${radiusAttrs} />`;
  }
  const circle = /^circle\(([^)]*)\)$/i.exec(value);
  if (circle != null) {
    const inner = circle[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiusPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const radiusBasis = Math.sqrt((w * w + h * h) / 2);
    const radius = radiusPart === "" ? Math.min(w, h) / 2 : resolvePx(radiusPart, radiusBasis);
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    return `<circle cx="${r(x + cx)}" cy="${r(y + cy)}" r="${r(radius)}" />`;
  }
  const ellipse = /^ellipse\(([^)]*)\)$/i.exec(value);
  if (ellipse != null) {
    const inner = ellipse[1].trim();
    const mAt = /\bat\b/i.exec(inner);
    const radiiPart = (mAt != null ? inner.slice(0, mAt.index) : inner).trim();
    const atPart = mAt != null ? inner.slice(mAt.index + 2).trim() : "50% 50%";
    const radii = radiiPart === "" ? [w / 2, h / 2] : radiiPart.split(/\s+/).map((s, i) => resolvePx(s, i === 0 ? w : h));
    const atTokens = atPart.split(/\s+/);
    const cx = resolvePx(atTokens[0] ?? "50%", w);
    const cy = resolvePx(atTokens[1] ?? "50%", h);
    return `<ellipse cx="${r(x + cx)}" cy="${r(y + cy)}" rx="${r(radii[0])}" ry="${r(radii[1] ?? radii[0])}" />`;
  }
  const polygon = /^polygon\(([^)]+)\)$/i.exec(value);
  if (polygon != null) {
    const pts = polygon[1].split(",").map((pair) => {
      const [px, py] = pair.trim().split(/\s+/);
      return `${r(x + resolvePx(px, w))},${r(y + resolvePx(py, h))}`;
    });
    return `<polygon points="${pts.join(" ")}" />`;
  }
  // path("M ... Z") — coordinates are in the element's reference box (border-
  // box by default), so apply a translate(x,y) transform directly on the
  // <path> element. SVG's <clipPath> doesn't accept <g> wrappers — only basic
  // shapes, <path>, and <use> — so the transform has to live on the path
  // itself, not on a group.
  const pathFn = /^path\(\s*(?:"([^"]+)"|'([^']+)')\s*\)$/i.exec(value);
  if (pathFn != null) {
    const d = pathFn[1] ?? pathFn[2] ?? "";
    if (d === "") return "";
    const transform = (x === 0 && y === 0) ? "" : ` transform="translate(${r(x)},${r(y)})"`;
    return `<path d="${d}"${transform} />`;
  }
  return "";
}

/**
 * Translate CSS object-fit + object-position to an SVG preserveAspectRatio
 * attribute. Best-effort — SVG does not cover every CSS combination exactly.
 *
 * Mapping:
 *   fill         -> 'none' (stretch both axes, may distort)
 *   contain      -> '<align> meet' (fit inside, letterbox)
 *   cover        -> '<align> slice' (fill, crop)
 *   none         -> not representable without intrinsic size info; 'none' stretch is the least-bad default
 *   scale-down   -> treated as 'contain' (common case; exact rule requires intrinsic size)
 *
 * object-position keywords (top/right/bottom/left/center) and '0% 0%' / '100% 100%'
 * map to xMin/xMid/xMax + yMin/yMid/yMax. Percentages are bucketed to thirds
 * since SVG has no finer-grained alignment.
 */
function preserveAspectRatioFor(fit: string | undefined, pos: string | undefined): string {
  const f = (fit ?? "fill").trim();
  if (f === "fill" || f === "none") return "none";
  const align = alignFromObjectPosition(pos ?? "50% 50%");
  const mode = f === "cover" ? "slice" : "meet";
  return `${align} ${mode}`;
}

/**
 * Parse an object-position value into horizontal / vertical percentages.
 * Used by object-fit: none to position the intrinsic-size image inside the
 * element box.
 */
function parseObjectPosition(pos: string): { hPct: number; vPct: number } {
  const tokens = pos.trim().split(/\s+/);
  let hPct = 50, vPct = 50;
  const setH = (t: string): void => {
    if (t === "left") hPct = 0;
    else if (t === "right") hPct = 100;
    else if (t === "center") hPct = 50;
    else if (/%$/.test(t)) hPct = parseFloat(t);
  };
  const setV = (t: string): void => {
    if (t === "top") vPct = 0;
    else if (t === "bottom") vPct = 100;
    else if (t === "center") vPct = 50;
    else if (/%$/.test(t)) vPct = parseFloat(t);
  };
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t === "top" || t === "bottom") setV(t);
    else setH(t);
  } else if (tokens.length >= 2) {
    setH(tokens[0]);
    setV(tokens[1]);
  }
  return { hPct, vPct };
}

function alignFromObjectPosition(pos: string): string {
  // Parse up to two tokens. Accept keywords (top/right/bottom/left/center) or '<n>%'.
  const tokens = pos.trim().split(/\s+/);
  let hPct = 50;
  let vPct = 50;
  const setH = (t: string): void => {
    if (t === "left") hPct = 0;
    else if (t === "right") hPct = 100;
    else if (t === "center") hPct = 50;
    else if (/%$/.test(t)) hPct = parseFloat(t);
  };
  const setV = (t: string): void => {
    if (t === "top") vPct = 0;
    else if (t === "bottom") vPct = 100;
    else if (t === "center") vPct = 50;
    else if (/%$/.test(t)) vPct = parseFloat(t);
  };
  if (tokens.length === 1) {
    const t = tokens[0];
    if (t === "top" || t === "bottom") setV(t);
    else setH(t);
  } else if (tokens.length >= 2) {
    setH(tokens[0]);
    setV(tokens[1]);
  }
  const xAlign = hPct < 33 ? "xMin" : hPct > 67 ? "xMax" : "xMid";
  const yAlign = vPct < 33 ? "YMin" : vPct > 67 ? "YMax" : "YMid";
  return `${xAlign}${yAlign}`;
}

/**
 * Format a list-item marker label for the given list-style-type + 1-based index.
 * Supports the most common values. Unknown types fall back to decimal.
 */
function formatListMarker(type: string, n: number): string {
  switch (type) {
    case "decimal": return String(n);
    case "decimal-leading-zero": return n < 10 ? "0" + n : String(n);
    case "lower-alpha":
    case "lower-latin":
      return alphaMarker(n, /*upper*/ false);
    case "upper-alpha":
    case "upper-latin":
      return alphaMarker(n, /*upper*/ true);
    case "lower-roman":
      return romanMarker(n).toLowerCase();
    case "upper-roman":
      return romanMarker(n);
    case "lower-greek":
      return greekMarker(n);
    default:
      return String(n);
  }
}

function alphaMarker(n: number, upper: boolean): string {
  if (n <= 0) return String(n);
  const base = upper ? 65 : 97;
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(base + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// CSS `lower-greek` walks the 24 letters of the Greek alphabet (α..ω, no
// final-sigma ς), then doubles up (αα, αβ, αγ, …) just like lower-alpha.
function greekMarker(n: number): string {
  if (n <= 0) return String(n);
  // U+03B1 α through U+03C9 ω, but skip U+03C2 ς (final sigma) — only 24
  // letters in the CSS counter style. Build the explicit alphabet so we
  // don't have to special-case the U+03C2 hole.
  const greek = "αβγδεζηθικλμνξοπρστυφχψω"; // 24 chars
  let s = "";
  let v = n;
  while (v > 0) {
    v--;
    s = greek.charAt(v % 24) + s;
    v = Math.floor(v / 24);
  }
  return s;
}

function romanMarker(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let s = "";
  for (let i = 0; i < vals.length; i++) {
    while (n >= vals[i]) { s += syms[i]; n -= vals[i]; }
  }
  return s;
}

/**
 * Parse a single computed box-shadow component (already split on top-level
 * commas). getComputedStyle returns shadows as `<color> <x> <y> <blur>
 * <spread> inset?`, with the color in either rgb()/rgba() or color(srgb …).
 * Returns null when the input is "none" or unparseable. See SK-1111.
 */
interface BoxShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}
function parseBoxShadow(value: string): BoxShadow[] {
  if (value == null || value === "" || value === "none") return [];
  const out: BoxShadow[] = [];
  for (const raw of splitTopLevelCommas(value)) {
    const s = raw.trim();
    if (s === "") continue;
    // Pull the color out first (rgb/rgba/hsl/color/oklab/etc + bracket-wrapped).
    // The color block may sit anywhere in the value but typically comes at the
    // start in computed form. Match `<funcname>(...)` greedy.
    let color = "";
    let rest = s;
    const colorMatch = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\([^)]*\)/i.exec(s);
    if (colorMatch != null) {
      color = colorMatch[0];
      rest = s.slice(colorMatch[0].length).trim();
    }
    const tokens = rest.split(/\s+/).filter((t) => t !== "");
    let inset = false;
    const lengths: number[] = [];
    for (const t of tokens) {
      if (t === "inset") { inset = true; continue; }
      const n = parseFloat(t);
      if (!isNaN(n)) lengths.push(n);
    }
    // CSS allows the color anywhere; if it wasn't at the start, scan tokens.
    if (color === "" && tokens.length > 0) {
      // Last token that doesn't parse as length and isn't "inset" is the color.
      for (let i = tokens.length - 1; i >= 0; i--) {
        const t = tokens[i];
        if (t === "inset" || !isNaN(parseFloat(t))) continue;
        color = t;
        break;
      }
    }
    if (color === "") color = "currentcolor";
    out.push({
      inset,
      x: lengths[0] ?? 0,
      y: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color,
    });
  }
  return out;
}

/**
 * Convert a CSS computed transform string to an SVG `transform` attribute
 * value, composed around (originX, originY) so the transform pivots there
 * (matches CSS's transform-origin semantics). Returns "" when the transform
 * is none or unparseable. See SK-1134.
 *
 * Chrome's getComputedStyle.transform always resolves to either
 * `matrix(a,b,c,d,e,f)` (2D) or `matrix3d(m11,m12,…m44)` (3D), so we don't
 * need to handle each named CSS function — just the matrix forms. 3D is
 * downgraded to its 2D submatrix (m11, m12, m21, m22, m41, m42 → SVG matrix
 * a, b, c, d, e, f), which loses perspective/depth but preserves x/y rotate
 * and scale. SK-1135 tracks the warning emission for 3D.
 */
function cssTransformToSvg(transform: string | undefined, originX: number, originY: number): string {
  if (transform == null || transform === "" || transform === "none") return "";
  const m2 = /^matrix\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)$/.exec(transform);
  let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  if (m2 != null) {
    a = parseFloat(m2[1]); b = parseFloat(m2[2]); c = parseFloat(m2[3]); d = parseFloat(m2[4]); e = parseFloat(m2[5]); f = parseFloat(m2[6]);
  } else {
    const m3 = /^matrix3d\(([^)]+)\)$/.exec(transform);
    if (m3 == null) return "";
    const parts = m3[1].split(",").map((s) => parseFloat(s.trim()));
    if (parts.length !== 16 || parts.some((n) => !isFinite(n))) return "";
    // CSS matrix3d is column-major: m11..m14, m21..m24, m31..m34, m41..m44.
    // The 2D submatrix is m11, m12, m21, m22, m41, m42 → a, b, c, d, e, f.
    a = parts[0]; b = parts[1]; c = parts[4]; d = parts[5]; e = parts[12]; f = parts[13];
  }
  // Identity short-circuit: don't emit a no-op transform.
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return "";
  // Compose around (originX, originY) so the rotate/scale pivots at the CSS
  // origin: SVG `translate(ox,oy) matrix(...) translate(-ox,-oy)`. When the
  // CSS matrix has a translation component (e, f), that already shifts; the
  // outer translate-origin pair makes the rotate/scale pivot correct.
  const ox = Number(originX.toFixed(2));
  const oy = Number(originY.toFixed(2));
  const matrixStr = `matrix(${Number(a.toFixed(5))} ${Number(b.toFixed(5))} ${Number(c.toFixed(5))} ${Number(d.toFixed(5))} ${Number(e.toFixed(2))} ${Number(f.toFixed(2))})`;
  if (ox === 0 && oy === 0) return matrixStr;
  return `translate(${ox} ${oy}) ${matrixStr} translate(${-ox} ${-oy})`;
}

/** Map CSS border-style to an SVG stroke-dasharray. Returns "" for solid (no dash). */
function dashArrayForStyle(style: string, width: number): string {
  switch (style) {
    case "dashed": return `${r(width * 2)} ${r(width * 2)}`;
    // Dotted: use a near-zero dash with round linecap so each "dot" becomes a
    // circle of diameter ~= stroke-width. Dash period = stroke-width * 2.
    case "dotted": return `0.01 ${r(width * 2)}`;
    // Double/groove/ridge/inset/outset: not fully supported yet; render as solid
    // so the border still appears (better than nothing). Tracked in a follow-up.
    default: return "";
  }
}

/**
 * Per-side adjusted dash array. Chrome'\''s dashed/dotted border rasterizer
 * (see Blink `BoxPainterBase::PaintBorderSides`) sizes each side'\''s dash
 * cycle so dashes start and end exactly at the corners — otherwise the last
 * dash before a corner is partial and the pattern looks ragged.
 *
 * Algorithm: ideal period (dash + gap) is `4 * width` for dashed, `2 * width`
 * for dotted. Compute cycle count `N = round(sideLength / period)` (clamped
 * to ≥1), then scale dash and gap by `sideLength / (N * period)` so
 * `N * (dash + gap) === sideLength` exactly.
 *
 * Returns "" when style isn'\''t dashed/dotted, or when the side is too short
 * to fit even one cycle (renderer falls back to solid).
 */
function adjustedDashArray(style: string, width: number, sideLength: number): string {
  if (sideLength <= 0 || width <= 0) return "";
  if (style === "dashed") {
    const idealDash = width * 2;
    const idealGap = width * 2;
    const idealPeriod = idealDash + idealGap;
    const cycles = Math.max(1, Math.round(sideLength / idealPeriod));
    const scale = sideLength / (cycles * idealPeriod);
    return `${r(idealDash * scale)} ${r(idealGap * scale)}`;
  }
  if (style === "dotted") {
    // Dot diameter = width (round-cap on near-zero dash). Dot center spacing
    // = `2 * width`, so each cycle (dot + gap) = 2 * width.
    const idealPeriod = width * 2;
    const cycles = Math.max(1, Math.round(sideLength / idealPeriod));
    const adjustedPeriod = sideLength / cycles;
    return `0.01 ${r(adjustedPeriod)}`;
  }
  return "";
}
