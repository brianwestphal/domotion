/**
 * Capture-side types describing the serialisable element tree produced by the
 * in-page CAPTURE_SCRIPT and consumed by the Node-side renderer. These live in
 * `src/capture/` rather than `src/render/` because the capture script's
 * shape determines the contract: any change here must keep both sides in
 * sync.
 *
 * - `TextSegment`        — per-baseline text run within an element.
 * - `CapturedElement`    — the recursive captured DOM-element record.
 * - `MaskFragmentDef`    — inline `<mask>` defs lifted from author-supplied
 *                          SVG `mask-image: url(#id)` references.
 * - `MaskRasterRef`      — capture-time placeholder for a mask image whose
 *                          contents must be rasterised by Node after the page
 *                          has been screenshotted.
 * - `CaptureWarning`     — warnings the capture pass surfaces about features
 *                          it couldn't represent faithfully.
 */

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
  /** Override font-style (e.g. ::first-line { font-style: italic }). */
  fontStyle?: string;
  /** Override font-family (e.g. `.icon-angle-right { font-family: 'sdicon' }`
   *  with `::before { content: '\\e87a' }` — the icon glyph routes through
   *  the icon webfont, not the parent element's body font). DM-513. */
  fontFamily?: string;
  /** Override font-variant (e.g. ::first-line { font-variant: small-caps }).
   *  When 'small-caps', renderer applies the OpenType `smcp` feature so
   *  lowercase letters shape as small uppercase forms — Chrome paints them
   *  the same way and the captured xOffsets already encode the small-caps
   *  advance widths, so the only thing the renderer needs to change is the
   *  glyph variant per character. (DM-294) */
  fontVariant?: string;
  /**
   * Override fontBoundingBoxAscent (px) when the segment uses a font/size
   * different from the element (::before / ::after with custom font-size).
   * Renderer falls back to the element's fontAscent when this is undefined.
   */
  fontAscent?: number;
  /**
   * Override `text-shadow` for this segment (DM-989: a `::first-letter`
   * pseudo whose shadow differs from the host element's). The element-level
   * shadow renderer in `element-tree-to-svg.ts` (SK-1113) handles the
   * default case by stacking a shifted+recolored copy of the whole text
   * tree behind the main paint; for the styled-first-letter segment, the
   * styled-segment renderer applies this override JUST to that one segment.
   */
  textShadow?: string;
  /**
   * DM-990: vertical writing-mode segment. Set to the element's computed
   * `writing-mode` value (`vertical-rl` / `vertical-lr` / `sideways-rl`
   * / `sideways-lr`) when the host element paints text in a vertical
   * orientation. The renderer dispatches such segments to a vertical-
   * column path that emits each char at its captured `(x, yOffsets[i])`
   * position — upright glyphs at their natural shape, rotated glyphs
   * (per `verticalOrientations[i]`) wrapped in a `<g transform=
   * "rotate(90, cx, cy)">` so their advance flows down the column.
   */
  verticalWritingMode?: string;
  /**
   * DM-990: per-char Y position in the column for vertical segments
   * (viewport-relative, one entry per UTF-16 code unit in `text`).
   * Replaces `xOffsets` for vertical layout — chars stack along Y, not X.
   */
  yOffsets?: number[];
  /**
   * DM-990: per-char orientation for vertical segments — `'upright'`
   * (no rotation, glyph paints normally) or `'rotated'` (glyph rotated
   * 90° clockwise so its horizontal advance becomes vertical, per CSS
   * Writing Modes 4 `text-orientation: mixed` rules from UAX #50).
   * One entry per UTF-16 code unit in `text`.
   */
  verticalOrientations?: Array<'upright' | 'rotated'>;
  /**
   * DM-990: per-char advance along the vertical axis (= `Range.height`
   * the capture script measured for each char) for vertical segments.
   * For upright chars this is roughly `font-size` (CJK), for rotated
   * chars it's the char's natural HORIZONTAL advance pre-rotation.
   * One entry per UTF-16 code unit in `text`.
   */
  verticalAdvances?: number[];
  /**
   * DM-996: per-char NATURAL horizontal advance (canvas
   * `measureText(ch).width`) for vertical segments. Used by the
   * renderer to center upright glyphs in their column — `Range.width`
   * reports the column width (~font-size + slack), not the glyph's own
   * advance, so we probe via canvas at capture time.
   */
  verticalNaturalWidths?: number[];
  /**
   * DM-1032: tate-chu-yoko (`text-combine-upright: all` / `digits`). When set,
   * this vertical segment is a SINGLE horizontally-combined upright group that
   * occupies one ~1em column cell, not a stack of column chars. `text` is the
   * whole combined run (e.g. "31"); the renderer emits it as one upright
   * horizontal run anchored at `(x, y)` with each glyph placed at its captured
   * `verticalCombineXOffsets[i]` (Chrome's painted per-char x within the cell),
   * so it bypasses the per-char upright/rotated column emission entirely.
   */
  verticalCombineUpright?: boolean;
  /**
   * DM-1032: per-char x offset (CSS px) of each combined glyph RELATIVE to the
   * segment's `x` (the leftmost glyph), in DOM order. Chrome's actual painted
   * positions — anchoring each glyph here reproduces the side-by-side combined
   * layout (and any sub-1em condensing Chrome applied) without re-deriving it.
   * One entry per UTF-16 code unit in `text`.
   */
  verticalCombineXOffsets?: number[];
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
    /** When true, the underlying text-path emit for this charIndex must be
     *  suppressed: the raster image is the ONLY paint for this codepoint
     *  (e.g. ::first-letter drop caps where the styled big-letter raster
     *  would otherwise sit on top of the body-size path glyph). DM-439. */
    suppressGlyph?: boolean;
  }>;
  /**
   * Pseudo-element box paint (DM-497): when this segment came from a
   * `::before` / `::after` whose computed style sets a non-trivial
   * `background-color` or `border-radius`, the renderer emits a `<rect>` of
   * these dimensions BEHIND the segment's text glyphs to honor the pseudo
   * box paint (badge / pill / chip pattern). Coordinates are viewport-relative
   * and already include padding + border insets so the rect surrounds the
   * captured text segment with the author-specified inflation.
   */
  pseudoBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Pre-resolved srgb-form CSS color (or "transparent"). Renderer parses
     *  via parseColor and emits as the rect fill. */
    backgroundColor?: string;
    /** Raw CSS `background-image` value (gradient / url() / multiple
     *  layers) when the pseudo paints a gradient or image instead of (or in
     *  addition to) a flat color. DM-767: `.corner::after` accent stripes
     *  with `background: linear-gradient(...)` need this — without it the
     *  pseudoBox emit was skipped entirely. Renderer threads through
     *  `buildBackgroundLayerDef` the same way the regular-element
     *  background-image path does. */
    backgroundImage?: string;
    /** Resolved px border-radius (CSS shorthand — single value, four-corner
     *  symmetric). */
    borderRadius?: number;
    /** Uniform border (single side-width + color). When set, the renderer
     *  emits `<rect stroke=... stroke-width=...>` around the box. */
    borderWidth?: number;
    borderColor?: string;
    /** Per-side border widths (px). Always populated; zero when the side
     *  carries no border. Renderer reads these together with the per-side
     *  colors below when no `borderWidth` (uniform) is set. */
    borL?: number;
    borR?: number;
    borT?: number;
    borB?: number;
    /** Per-side border colors. Set ONLY when the pseudo has a non-uniform
     *  border (e.g. `border-bottom: 1px solid …` only). For uniform borders
     *  the renderer uses `borderColor` + `borderWidth` and the per-side
     *  fields are undefined. Slashdot's `.carouselHeading::after` is the
     *  motivating fixture — a 1px translucent-white border-bottom on the
     *  italic "Most Discussed" heading. */
    borderTopColor?: string;
    borderRightColor?: string;
    borderBottomColor?: string;
    borderLeftColor?: string;
    /** DM-783: pseudo's own `transform` (rotate/scale/translate/matrix/skew).
     *  Captured verbatim from `getComputedStyle(host, '::before').transform`,
     *  which Chrome returns in resolved `matrix(a,b,c,d,e,f)` form — pasteable
     *  directly into an SVG `<g transform="…">` wrapper. Renderer wraps the
     *  pseudoBox rect + glyph emit so rotate(45deg) on a `::before { border-
     *  right; border-bottom }` paints as a check-mark (the rotation pivots
     *  around the box center per `transformOrigin`). */
    transform?: string;
    /** Resolved px transform-origin (e.g. `"50px 50px"` for a 100×100 box's
     *  default `50% 50%`). Renderer pre-bakes a translate-transform-translate
     *  matrix so the rotation/scale pivots around the captured origin instead
     *  of (0, 0). When undefined, renderer defaults to the box center. */
    transformOrigin?: string;
    /** DM-1051: the pseudo's resolved `z-index` as an integer, when it's a
     *  numeric value (not `auto`). A NEGATIVE z-index means the pseudo paints
     *  BEHIND the host's own content — Resend's `.rainbow-border::after` glow
     *  is `z-index: -10`, so the renderer must paint it before child content
     *  (a soft halo behind the dark pill) instead of treating it as an NYT-
     *  style fade overlay deferred ON TOP of the text. Undefined for `auto`. */
    zIndex?: number;
    /** DM-1051: the pseudo's own `filter` (e.g. `"blur(20px)"`), captured
     *  verbatim from `getComputedStyle(host, '::after').filter` when non-`none`.
     *  Renderer translates a `blur(<px>)` into an SVG `<feGaussianBlur>` wrapper
     *  so the glow renders soft instead of as a sharp-edged gradient rect. */
    filter?: string;
  };
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
  /**
   * Author-supplied magic-move pairing key from `data-magic-key="…"` (DM-900).
   * When the same key appears on an element in two consecutive animation
   * frames, the magic-move transition force-pairs them (so the matched element
   * slides/scales between frames) ahead of the fingerprint/path heuristic —
   * the escape hatch for demos where the heuristic mis-pairs similar elements.
   */
  magicKey?: string;
  /**
   * DM-1106: the element's effective CSS `cursor` keyword (e.g. `pointer`,
   * `text`, `grab`), resolved in-page — `auto` is resolved per Blink's
   * `SelectAutoCursor` and `url(...)` reduced to its keyword fallback. Omitted
   * when it resolves to the default arrow; the auto cursor-overlay hit-test
   * treats a missing value as `default`. Not used for rendering the element
   * itself (cursors are OS-drawn, never in the page paint).
   */
  cursor?: string;
  /**
   * DM-603 viewBox culling. Set to `true` by `cullElementsOutsideViewBox()` (or a single-frame
   * static cull) when this element's bbox never intersects the viewBox during
   * the scene cycle. The renderer surfaces it as `style="display:none"` on
   * the element's outermost `<g>` wrapper.
   */
  displayNone?: boolean;
  /**
   * DM-603 viewBox culling. CSS class name (`cull-N`) that maps to a
   * scene-wide keyframes block toggling `display: inline ↔ none` for the
   * times when this element is partially visible (e.g. only after an
   * `animation: translateY` brings it into the viewBox). The keyframes block
   * is emitted by `cullElementsOutsideViewBox()`; the renderer just stamps the class onto the
   * outer `<g>`.
   */
  cullClass?: string;
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
    /**
     * CSS `overflow-clip-margin` shorthand value as computed by Chrome
     * (e.g. `"20px"`, `"content-box 12px"`, or the empty string when the
     * default `0px` resolves and the element doesn't paint outside its
     * reference box). Only takes effect when `overflow: clip` (DM-761) —
     * `hidden` ignores it per CSS Overflow 3.
     */
    overflowClipMargin?: string;
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
    /**
     * DM-476 frosted-glass fallback: when the element has a non-trivial
     * `backdrop-filter` AND a near-transparent `background-color` (alpha
     * ≤ 0.1), CAPTURE_SCRIPT reads `document.body`'s computed background
     * color and stores it here as a normalized `rgb(...)` / `rgba(...)`
     * string so the renderer can paint a synthesized opaque fill where
     * Chromium would have painted blurred underlying pixels. Undefined
     * when the element doesn't trigger the frosted condition. See
     * `docs/19-frosted-backdrop-fallback.md`.
     */
    frostedBgFallback?: string;
    mixBlendMode: string;
    clipPath: string;
    mask: string;
    maskImage: string;
    maskMode: string;
    maskSize: string;
    maskPosition: string;
    maskRepeat: string;
    maskComposite: string;
    /**
     * CSS `mask-clip` — the box (border-box / padding-box / content-box / etc.)
     * the mask painted area is clipped to. Defaults to `border-box`. Captured
     * separately from `mask-origin` because Chromium retains both verbatim
     * (mask-clip controls visibility, mask-origin controls layer positioning).
     */
    maskClip?: string;
    /**
     * CSS `mask-border-source` / legacy `-webkit-mask-box-image` source.
     * Chrome exposes this only via the legacy webkit name (DM-758). The
     * renderer routes it through the mask-image pipeline ONLY for the
     * "simple" 9-slice cases (`slice 0 fill / 0 / 0` and `slice 1 fill / 0
     * / 0`) where the entire source is used as a stretched full-element
     * mask. Real 9-slice tiling (non-zero `width` / `outset`, `round` /
     * `space` repeat) needs its own implementation.
     */
    maskBorderSource?: string;
    /** Resolved `-webkit-mask-box-image-slice` (e.g. `"1 fill"`, `"30 fill"`). */
    maskBorderSlice?: string;
    /** Resolved `-webkit-mask-box-image-width` (e.g. `"0"`, `"20px"`). */
    maskBorderWidth?: string;
    /** Resolved `-webkit-mask-box-image-outset` (e.g. `"0"`, `"15px"`). */
    maskBorderOutset?: string;
    /** Resolved `-webkit-mask-box-image-repeat` (`stretch` / `repeat` /
     *  `round` / `space`, optionally one per axis). DM-793. */
    maskBorderRepeat?: string;
    /** Intrinsic dimensions of the `mask-border-source` asset (px). Same
     *  probe pattern as `borderImageIntrinsicWidth`. DM-793. */
    maskBorderIntrinsicWidth?: number;
    maskBorderIntrinsicHeight?: number;
    listStyleType: string;
    listStyleImage: string;
    listStylePosition: string;
    /** CSS `display` (e.g. `block`, `list-item`, `flex`). Used by the
     *  renderer to detect display:list-item on non-li tags. DM-451. */
    display?: string;
    backgroundImage: string;
    backgroundSize: string;
    backgroundPosition: string;
    backgroundRepeat: string;
    backgroundClip: string;
    backgroundOrigin: string;
    backgroundAttachment: string;
    /**
     * CSS `background-blend-mode` — per-layer blend mode (comma-separated to
     * match the layer count). Captured verbatim from `getComputedStyle`. The
     * renderer applies each layer's mode as `style="mix-blend-mode:<mode>"`
     * on the layer's `<rect>`, wrapped in a `<g style="isolation:isolate">`
     * so the blend doesn't escape the element's bg-layer stack.
     */
    backgroundBlendMode?: string;
    /**
     * CSS `-webkit-text-fill-color`. When `backgroundClip` is `text` the
     * common pattern is `webkit-text-fill-color: transparent` so the
     * background-image (gradient / url) shows through the glyph shapes —
     * a "gradient headline" effect (Stripe / Resend / Linear hero copy).
     * Captured separately because `color` may still report a normal value
     * when the rendered text is actually transparent. DM-462.
     */
    webkitTextFillColor?: string;
    /**
     * DM-749: Stripe / Resend pattern — when an element has
     * `webkit-text-fill-color: transparent` but its own background-image is
     * `none`, the gradient lives on an ANCESTOR with `background-clip:
     * text`. Chrome's paint propagates that gradient through descendant
     * glyphs. Captured as the resolved `background-image` string of the
     * nearest ancestor with `background-clip: text` (walked up to 8 levels).
     */
    inheritedTextFillGradient?: string;
    /** DM-908: bbox of the ancestor that supplied `inheritedTextFillGradient`.
     *  The gradient must resolve against the ANCESTOR's coordinates so two
     *  sibling children inheriting from the same ancestor share one
     *  continuous gradient span instead of each painting a fresh ramp
     *  within its own (smaller) bbox. */
    inheritedTextFillGradientRect?: { x: number; y: number; width: number; height: number };
    /** `-webkit-text-stroke-width` (e.g. "2px"). DM-719. */
    webkitTextStrokeWidth?: string;
    /** `-webkit-text-stroke-color` (e.g. "rgb(220,38,38)"). DM-719. */
    webkitTextStrokeColor?: string;
    /** `paint-order` (e.g. "stroke fill"). Controls whether the text stroke
     *  paints before or after the fill — `stroke fill` puts the stroke
     *  UNDER the fill so the fill rests on top of half the stroke width,
     *  eliminating the chunky "fill-on-top-of-stroke" artifact at large
     *  stroke widths. DM-719. */
    paintOrder?: string;
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
    /** CSS `order` (flex/grid items). Per CSS Flexbox 1 §5.4.1 and CSS Grid 1
     *  §17, paint order is order-modified document order — items are painted
     *  in ascending `order` value, ties broken by source (DOM) order. The
     *  property has no effect on non-flex/non-grid items but Chrome still
     *  reports it on every computed style, so we capture unconditionally. */
    order: string;
    /** CSS `flex-direction` on a flex container (`row` / `row-reverse` /
     *  `column` / `column-reverse`). Empirically Chrome paints children of a
     *  `*-reverse` flex container in REVERSE of their order-modified document
     *  order, so the rightmost (or bottommost) item paints LAST in every
     *  flex-direction — matching what users expect from a visually-reordered
     *  layout. Captured on the parent so the child sorter can read it. */
    flexDirection: string;
    /** For <td>/<th> with empty-cells: hide — suppress bg + border. */
    emptyCellsHidden?: boolean;
    /** Form-control state captured so we can synthesize native chrome. */
    inputType?: string;
    /** CSS `appearance` / `-webkit-appearance` longhand. 'none' means the
     *  author has opted out of UA chrome — the renderer should let the host
     *  rect (background / border / border-radius) show through and only
     *  overlay the :checked indicator. DM-285. */
    inputAppearance?: string;
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
    /** True when the `<summary>`'s `::marker` was hidden by author CSS
     *  (e.g. `::marker { color: transparent }` or
     *  `::-webkit-details-marker { color: transparent }`), so the renderer
     *  should NOT paint its own UA disclosure triangle on top of the
     *  author's custom marker. DM-448. */
    summaryMarkerSuppressed?: boolean;
    /** DM-1123: the computed `::marker` color of a SHOWN summary disclosure
     *  triangle (e.g. `summary::marker { color: #6d28d9 }` → purple). Chrome
     *  paints the triangle in this color, not the summary's text color. Unset
     *  when the marker is suppressed or the element isn't `<details>`. */
    summaryMarkerColor?: string;
    /** DM-1123: the computed `::marker` font-size in px (e.g.
     *  `summary::marker { font-size: 14px }`). The triangle scales with this,
     *  not the summary's own font-size. Defaults (inherits) to the summary's
     *  font-size when the author didn't set one. */
    summaryMarkerFontSize?: number;
    /** DM-1123: true when the shown marker's `list-style-position` is `inside`
     *  (the UA default for `<summary>`), so the renderer offsets the triangle
     *  past the summary's own `padding-left` to the content-start. `outside`
     *  → the legacy placement at the summary's border-box left edge. */
    summaryMarkerInside?: boolean;
    selectChevron?: boolean;
    /** Text of the currently-selected option, rendered inside the `<select>`
     *  content rect for closed dropdowns (DM-246). For listbox-mode selects
     *  (`size > 1` or `multiple`) this is undefined and per-option rendering
     *  flows through the listbox path instead. */
    selectDisplayText?: string;
    /** Captured option list for listbox-mode `<select>` (size > 1 or
     *  multiple). Each entry is one row the renderer paints inside the
     *  select's content rect. DM-282. */
    selectListboxOptions?: Array<{
      text: string;
      selected: boolean;
      disabled: boolean;
      /** Optgroup label row (italic + bold; not user-selectable). */
      isOptgroupLabel?: boolean;
      /** Indented child of an optgroup. */
      isOptgroupChild?: boolean;
    }>;
    accentColor?: string;
    caretColor?: string;
    /** For <input type=range/color/date/time/...> — the current value. */
    inputValue?: string;
    inputMin?: string;
    inputMax?: string;
    inputStep?: string;
    /** True for inputs with the `multiple` attribute (file / email / select). DM-271. */
    inputMultiple?: boolean;
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
    /** ::-webkit-slider-runnable-track border shorthand (DM-273). */
    rangeTrackBorder?: string;
    /** ::-webkit-slider-thumb border shorthand (DM-273). */
    rangeThumbBorder?: string;
    /** ::-webkit-slider-thumb box-shadow (DM-319). Used for the donut-ring
     *  effect: `box-shadow: 0 0 0 Npx <color>` paints an outer ring of width
     *  N around the thumb. We only render the spread-only form. */
    rangeThumbBoxShadow?: string;
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
    fileButtonFontSize?: string;
    fileButtonFontFamily?: string;
    fileButtonMarginRight?: string;
    /** Canvas-measureText width of the button label at the captured font (DM-288).
     *  Lets the renderer position the trailing 'No file chosen' placeholder at
     *  exactly Chrome's painted x rather than overestimating via a per-char ratio. */
    fileButtonLabelWidth?: number;
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
    /** CSS will-change (DM-498): a comma-separated hint listing properties the
     *  author intends to animate. When the list contains a property whose
     *  non-initial value WOULD create a stacking context (transform, opacity,
     *  filter, mask, clip-path, perspective, top/right/bottom/left, position,
     *  z-index, isolation, mix-blend-mode), the element itself becomes a
     *  stacking-context root regardless of whether that property has a
     *  non-initial value applied. Used by `establishesStackingContext`. */
    willChange?: string;
    /** CSS contain (DM-498): `layout`, `paint`, `strict`, `content`, `size`,
     *  or combinations. `paint` / `strict` / `content` (which includes paint)
     *  create a stacking context per spec. */
    contain?: string;
    /** CSS isolation (DM-498): `isolate` creates a stacking context. */
    isolation?: string;
    /**
     * DM-552: page-level color-scheme inferred from the capture context.
     * Sourced from `matchMedia('(prefers-color-scheme: dark)').matches` at
     * capture time and ONLY populated on the captured tree's root element
     * (other elements omit it). Renderer reads this to decide whether to
     * emit `color-scheme="dark"` on the root `<svg>`.
     */
    rootColorScheme?: "light" | "dark";
    /**
     * DM-552: `getComputedStyle(document.documentElement).backgroundColor`
     * resolved by Chromium at capture time. Covers the transparent-root
     * case where the page declares no background and Chromium fills its
     * UA default per scheme (`#ffffff` for light, `rgb(28, 28, 28)`-ish
     * for dark). ONLY populated on the captured tree's root element.
     */
    rootBgComputed?: string;
    /** CSS transform-origin resolved to pixel pair (e.g. `60px 30px`). Defaults to '50% 50%' = bbox center. */
    transformOrigin?: string;
    /** DM-587: true when the live CSS transform was non-none at capture
     *  time. We record `transform: 'none'` in this struct (because captured
     *  rects are in live viewport coords post-transforms and the renderer
     *  must not wrap them in a duplicate transform `<g>`), but CSS Transforms
     *  2 §4 says any non-none transform creates a stacking context, and
     *  `establishesStackingContext` needs that bit to keep z-index ordering
     *  correct (e.g. `transform: translate(0)` on a positioned element traps
     *  its descendants' z-indices). */
    transformCreatesSc?: boolean;
    /** CSS transform-style. `preserve-3d` (or anything != `flat`) creates a stacking context per CSS Transforms 2 §4 (DM-589). */
    transformStyle?: string;
    /**
     * DM-751: extracted Z translation from `matrix3d(...)` when the
     * element's transform has a non-zero translateZ component. Used by the
     * paint-order sort when the parent has `transform-style: preserve-3d`
     * (CSS Transforms 2 §6 sorts children by Z in 3D space, not z-index).
     * SVG can't render perspective, so this is paint-order only.
     */
    translateZ?: number;
    /** CSS writing-mode (`horizontal-tb` | `vertical-rl` | `vertical-lr` | `sideways-rl` | `sideways-lr`). */
    writingMode?: string;
    /** CSS text-orientation (`mixed` | `upright` | `sideways`). Used in vertical writing-modes. */
    textOrientation?: string;
    /** CSS resize. Non-none on textareas paints the bottom-right resize handle. */
    resize?: string;
    /** CSS text-overflow ('clip' | 'ellipsis' | "<string>" | …). Renderer paints
     *  the truncation marker at the visible right edge when overflow is hidden
     *  and white-space prevents wrapping. (DM-373) */
    textOverflow?: string;
    /** Whitespace handling — needed alongside text-overflow to determine if the
     *  truncation marker should paint. */
    whiteSpace?: string;
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
    /** CSS font-variant-caps — 'normal' | 'small-caps' | 'all-small-caps' |
     *  'petite-caps' | 'all-petite-caps' | 'unicase' | 'titling-caps'.
     *  Renderer applies the matching OpenType feature (smcp / c2sc / etc.).
     *  DM-361. */
    fontVariantCaps?: string;
    /** CSS font-variant-east-asian — e.g. 'traditional', 'jis78', 'full-width'.
     *  Mapped to OpenType features (trad / jp78 / fwid …) at shape time. DM-1117. */
    fontVariantEastAsian?: string;
    /** CSS font-variant-numeric — e.g. 'oldstyle-nums', 'tabular-nums', 'diagonal-fractions'.
     *  Mapped to OpenType features (onum / tnum / frac …). DM-1117. */
    fontVariantNumeric?: string;
    /** CSS font-variant-ligatures — e.g. 'no-common-ligatures', 'discretionary-ligatures'.
     *  Mapped to OpenType features (liga off / dlig …). DM-1117. */
    fontVariantLigatures?: string;
    /** CSS direction ('ltr' / 'rtl'). Drives BiDi reordering on RTL paragraphs. */
    direction?: string;
    /** BCP-47 language tag inherited from `el.lang` / nearest ancestor `[lang]` /
     *  `<html lang>`. Routes Han fallback to the matching PingFang regional
     *  variant (TC / HK / MO) or Hiragino Kaku for `ja`. (DM-394) */
    lang?: string;
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
    /** `text-decoration-thickness` — explicit length (e.g. `5px`) or `auto`.
     *  When set to a length, overrides the auto thickness in
     *  `getDecorationMetrics`. DM-431. */
    textDecorationThickness?: string;
    /** `text-underline-offset` — extra distance below the baseline for the
     *  underline stroke. Adds to the auto offset. DM-431. */
    textUnderlineOffset?: string;
    /** DM-936: `text-underline-position` (`auto` / `from-font` / `under` /
     *  `left` / `right`) — drives where the underline paints. Needed for
     *  the elementRaster dedupe key so vertical-mode columns with
     *  different underline-position values don't share screenshots. */
    textUnderlinePosition?: string;
    /** DM-920: `text-emphasis-style` — `none`, a `<string>` (`"★"`), or a
     *  `[filled | open] [dot | circle | double-circle | triangle | sesame]`
     *  combination. Renderer maps the keyword form to a single mark
     *  character per Chromium's `ComputedStyle::TextEmphasisMarkString`. */
    textEmphasisStyle?: string;
    /** DM-920: `text-emphasis-color` — defaults to `currentcolor`. */
    textEmphasisColor?: string;
    /** DM-920: `text-emphasis-position` — `over` / `under` (×
     *  `left` / `right` in horizontal-tb). */
    textEmphasisPosition?: string;
    /** `text-decoration-skip-ink` — 'auto' (default; break around descenders),
     *  'none' (always solid), or 'all'. Per Chromium's
     *  `decoration_line_painter.cc`, only solid + double underlines honor
     *  skip-ink; dashed / dotted / wavy ignore it. DM-446. */
    textDecorationSkipInk?: string;
    /**
     * `box-decoration-break` — `slice` (default) or `clone`. Controls how
     * inline elements that wrap across multiple line boxes paint their
     * background / border / padding / shadow: `slice` paints the box once
     * across all fragments (first fragment gets the left side, last gets the
     * right side); `clone` paints a complete box on every fragment. Captured
     * so the renderer can split the per-fragment paint at line-box boundaries
     * when `inlineFragments` is present.
     */
    boxDecorationBreak?: string;
  };
  /**
   * Per-line-fragment rects (viewport-relative px) for inline elements that
   * wrap across multiple line boxes. Populated by capture when the element
   * is `display: inline` AND has a non-transparent background or non-zero
   * border AND `el.getClientRects().length > 1`. When present, the renderer
   * paints the background + border per-fragment instead of once across the
   * element's bbox — without this, an inline span like `<span class="hl">…
   * wrapping text …</span>` paints a single rectangle covering the whole
   * logical inline (typically the full container width) and the text floats
   * outside / behind the painted background. Slice vs clone semantics are
   * driven by `styles.boxDecorationBreak`. See `docs/01-fidelity.md`.
   */
  inlineFragments?: Array<{ x: number; y: number; width: number; height: number }>;
  /** DM-754: the fragmentation axis that produced the `inlineFragments`
   *  entries. `"inline"` — the element is `display: inline` and wrapped onto
   *  multiple line boxes (the original DM-721 case); slice mode suppresses
   *  the LEFT side on non-first fragments and the RIGHT side on non-last.
   *  `"block"` — the element is block-level inside a multi-column container
   *  ancestor (DM-754); slice mode suppresses TOP on non-first and BOTTOM on
   *  non-last. Both axes produce vertically-stacked frag rects in practice,
   *  so we can't distinguish them geometrically at render time. Defaults to
   *  `"inline"` when undefined (backwards-compatible with pre-DM-754 captures). */
  fragmentAxis?: "inline" | "block";
  children: CapturedElement[];
  imageSrc?: string;
  /** Intrinsic pixel dimensions of <img>, used for object-fit: none. */
  imageIntrinsic?: { w: number; h: number };
  /** True when the <img> failed to load (`complete && naturalWidth === 0`).
   *  Renderer paints the broken-image fallback (icon + alt text). DM-372. */
  imageBroken?: boolean;
  /** <img alt> attribute, painted next to the broken-image icon. DM-372. */
  imageAlt?: string;
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
  /** Computed `::marker { content: ... }`. When non-default ("normal" or
   *  empty), Chrome paints this string in place of the list-style-type
   *  bullet/number. Captured as the raw computed value (may include
   *  surrounding quotes). DM-447. */
  markerContent?: string;
  /** Computed `::marker { font-family }`. Defaults to inherit, but authors
   *  can override (e.g. `font-family: monospace` on numeric markers). */
  markerFontFamily?: string;
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
  /**
   * DM-680: per-axis cumulative ancestor scale, present ONLY when the element
   * sits inside an anisotropically scaled subtree (e.g. `transform: scale(1.3,
   * 0.8)`). The geometric mean is already folded into fontSize / fontAscent /
   * fontDescent at capture time — these fields drive a per-axis correction
   * `<g transform="scale(cx, cy)">` around the text emission so glyphs render
   * with the same width / height stretch Chrome paints. Absent when the
   * cumulative scale is isotropic (uniform scale, or no scale) — the
   * geometric-mean handling already produces a faithful result there.
   */
  cumScaleX?: number;
  cumScaleY?: number;
  /**
   * For <canvas> / <video> / <iframe> / <object> / <embed>: a viewport-relative
   * content-box rect (border-box minus border + padding) that
   * rasterizeReplacedElements should screenshot via Playwright and stash on
   * dataUri. The renderer then emits an <image> at the same rect to cover what
   * Chrome actually painted in that element's content area, so these element
   * types stop leaving blank holes in real-world captures. The capture warning
   * is still emitted because these types are out of the spirit of the path-
   * based rendering contract — the snapshot is a frozen raster, not a faithful
   * re-render. See docs/17-replaced-element-snapshots.md (DM-457).
   */
  replacedSnapshot?: { x: number; y: number; width: number; height: number; rid: string; dataUri?: string };
  /**
   * Image-replacement icon (DM-506): a CSS-sprite icon whose accessible label
   * is hidden via `text-indent: -9999px; overflow: hidden` (or the modern
   * `text-indent: <neg>; overflow: hidden; white-space: nowrap` variant). The
   * element's painted box is rasterized through the `replacedSnapshot` path so
   * the sprite slice is captured as Chrome painted it; capture also clears
   * `text` / `textSegments` / `styles.backgroundImage` so the renderer doesn't
   * double-paint the sliced sprite or leak the off-screen text into the SVG.
   * `titleText` is the suppressed author text — emitted as an SVG `<title>`
   * child of the rasterized `<image>` so screen readers and tooltips still
   * surface the label. See `docs/23-css-sprite-icons.md`.
   */
  imageReplacement?: { titleText: string };
  /**
   * <fieldset> with a top-aligned <legend>: Chrome's UA paints the fieldset's
   * top border at the legend's vertical center (not at fs.y) and notches the
   * border across the legend's horizontal extent. The captured x/y/width/
   * height already encode the inset (y shifted down by legend.height/2,
   * height reduced to match), and this field carries the legend's full
   * absolute bbox so the renderer can clip the top border behind it via an
   * even-odd clipPath. DM-342 / DM-343.
   */
  fieldsetLegendNotch?: { x: number; y: number; w: number; h: number };
  /**
   * Top-level (root only) collection of `<mask>` definitions referenced by
   * fragment URLs (`mask-image: url("#id")`) anywhere in the captured tree.
   * CAPTURE_SCRIPT resolves each fragment id to the corresponding inline
   * `<mask>` element via `document.getElementById` and serialises its
   * `outerHTML` here. The renderer copies these into the output `<defs>`
   * with id rewriting so a captured `<mask id="m1">` becomes a
   * domotion-prefixed mask def referenced by elements that point at `#m1`.
   * Same-document only — external `.svg#fragment` refs are deferred (DM-496).
   * See `docs/21-mask-fragment-references.md`.
   */
  maskDefs?: MaskFragmentDef[];
  /**
   * DM-826: Top-level (root only) collection of `<clipPath>` definitions
   * referenced by fragment URLs (`clip-path: url("#id")`) anywhere in the
   * captured tree. CAPTURE_SCRIPT resolves each fragment id via
   * `document.getElementById` and serialises the `<clipPath>` element's
   * `outerHTML` here. The renderer copies these into the output `<defs>`
   * with id rewriting so a captured `<clipPath id="hex">` becomes a
   * domotion-prefixed clip-path def referenced by elements that point at
   * `#hex`. Same-document only — external `.svg#fragment` refs are
   * deferred. See `docs/39-clip-path-fragment-references.md`.
   */
  clipPathDefs?: ClipPathFragmentDef[];
  /**
   * DM-934: Inline `<filter>` defs referenced by CSS `filter: url(#id)`.
   * Captured at root level; the renderer copies them into the output SVG's
   * top-level `<defs>` and the existing pass-through of `cs.filter` as an
   * inline style on the wrapping group references them. Same-document only.
   */
  filterDefs?: { id: string; outerHTML: string }[];
  /**
   * DM-494: Raster snapshots of elements referenced by `mask-image:
   * element(#id)`. Top-level (root only) — same-document only (cross-document
   * `element()` is not in scope; CSS spec doesn't define it). Each raster is
   * the actual painted output of the referenced element captured via
   * `page.screenshot({ clip: rect, omitBackground: true })` after a hide-
   * everything-else stylesheet, encoded as `data:image/png;base64,…`.
   * Renderer's `buildMaskDef` looks up the entry by `id` and emits an
   * `<image>` inside the `<mask>` with `mask-type="luminance"` per Chrome's
   * `mask-mode: match-source` default for element() references. See
   * `docs/22-mask-element-paint-references.md`.
   */
  maskRasters?: MaskRasterRef[];
  /**
   * DM-579 box-only pseudo-elements: empty-content `::before` / `::after`
   * whose effective rect + per-side borders + background are captured for
   * decorative-separator emission. The renderer in `element-tree-to-svg.ts`
   * emits one `<rect>` per pseudoBox plus up to four `<line>`s for visible
   * borders. Captured per element (not just root). Optional — only emitted
   * when at least one such pseudo exists on this element.
   */
  pseudoBoxes?: PseudoBox[];
}

export interface PseudoBox {
  /** Which pseudo-element this box came from. CSS render order paints the
   *  host's main content between `::before` (under) and `::after` (over), so
   *  the renderer needs the distinction to emit `::after` AFTER text — DM-1001
   *  / nytimes mobile's right-edge fade-out overlays the headline via
   *  `::after`. Optional so older captured trees still load. */
  pseudo?: "::before" | "::after";
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor?: string;
  backgroundImage?: string;
  /** DM-1121: the pseudo's `background-position` / `background-size`, captured
   *  only when it carries a `background-image`. Stripe's keynote-speaker glow is
   *  a `::after { background: radial-gradient(...); background-position: -90px
   *  90px; opacity: 0.45 }` — dropping the position painted the pink core
   *  centered over the speaker's face instead of offset to the lower-left
   *  corner. The renderer feeds these into `buildBackgroundLayerDef` instead of
   *  the previous hardcoded `"0% 0%"` / `"auto"`. */
  backgroundPosition?: string;
  backgroundSize?: string;
  /** DM-1121: the pseudo's own `opacity` when < 1, so the renderer can wrap the
   *  emitted box in a `<g opacity>` (the Stripe glow is painted at 0.45). Omitted
   *  for the default `1`. Fully-transparent pseudos (`opacity: 0`) are dropped at
   *  capture time and never produce a box. */
  opacity?: number;
  borderTopWidth?: number; borderTopColor?: string; borderTopStyle?: string;
  borderRightWidth?: number; borderRightColor?: string; borderRightStyle?: string;
  borderBottomWidth?: number; borderBottomColor?: string; borderBottomStyle?: string;
  borderLeftWidth?: number; borderLeftColor?: string; borderLeftStyle?: string;
  borderRadius?: number;
  transform?: string;
  transformOrigin?: string;
  /** DM-1051: numeric `z-index` (omitted for `auto`). Negative → the pseudo
   *  paints BEHIND the host content; the renderer emits it before child paint
   *  instead of deferring it on top as a fade overlay. */
  zIndex?: number;
  /** DM-1051: the pseudo's own `filter` (e.g. `"blur(20px)"`), so the renderer
   *  can wrap the box in an `<feGaussianBlur>` instead of painting a sharp rect. */
  filter?: string;
}

export interface MaskFragmentDef {
  /** Original DOM id of the captured `<mask>` element. */
  id: string;
  /** Verbatim `outerHTML` of the captured `<mask>` element. */
  outerHTML: string;
}

export interface ClipPathFragmentDef {
  /** Original DOM id of the captured `<clipPath>` element. */
  id: string;
  /** Verbatim `outerHTML` of the captured `<clipPath>` element. */
  outerHTML: string;
  /** Resolved `clipPathUnits` — `"userSpaceOnUse"` (the SVG default) or
   *  `"objectBoundingBox"`. The renderer needs this to decide whether the def
   *  must be translated per-consumer (userSpaceOnUse coords are element-local;
   *  objectBoundingBox auto-scales into the element bbox) — DM-828. */
  clipPathUnits?: "userSpaceOnUse" | "objectBoundingBox";
}

export interface MaskRasterRef {
  /** DOM id referenced by `mask-image: element(#id)` — used by the renderer
   *  to look up the raster from the layer reference. */
  id: string;
  /** `data:image/png;base64,…` of the referenced element's painted box.
   *  Populated by `rasterizeMaskSources`; may be undefined if the screenshot
   *  failed (e.g. clip went off-page) — renderer falls back to no mask
   *  emission and warns. */
  dataUri?: string;
  /** Captured element rect (viewport-relative px). Used by the post-capture
   *  pass to drive page.screenshot's clip. Renderer doesn't consume this
   *  directly; the `<image>` placement comes from the consuming element's
   *  mask-position / mask-size. */
  width: number;
  height: number;
  /** `data-domotion-rid` value attached to the live DOM target so the
   *  hide-everything-else stylesheet has a unique selector. */
  rid: string;
  /** Viewport-relative rect of the referenced element, used by the post-
   *  capture pass. */
  rect: { x: number; y: number; width: number; height: number };
}

export interface CaptureWarning {
  /** Short selector path identifying the element that tripped the warning. */
  selector: string;
  /** Feature name (e.g. 'transform', 'backdrop-filter', '<iframe>'). */
  feature: string;
  /** Short detail about what's not supported and/or a tracking ticket. */
  detail: string;
}
