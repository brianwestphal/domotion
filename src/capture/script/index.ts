// @ts-nocheck
//
// Source for the in-page capture script. The orchestrator of the per-concern
// factory modules under `src/capture/script/`. The build step at
// `scripts/build-capture-script.mjs` bundles this entry + its imports (esbuild
// with bundle:true) into a single self-contained function expression that
// becomes the `CAPTURE_SCRIPT` string in `src/capture/script.generated.ts`,
// which `src/capture/index.ts` injects via page.evaluate(). The function runs
// in the captured page's context — at runtime there are no imports left, just
// one IIFE that takes `args` and returns `{ tree, warnings }`.
//
// Helpers that are self-contained pre-walk / per-call utilities live in
// sibling files (`color-norm.ts`, `emoji-detect.ts`, `font-metrics.ts`,
// `placeholder-shown.ts`, `pseudo-rules.ts`, `warnings.ts`); per-concern
// walker handlers live under `./walker/`. This file owns the remaining
// `captureInner` walker body and the top-level orchestration (fixed-ancestor
// pre-pass, counter pre-walk, root-element capture, mask-def + dark-mode
// attachment to the result tree).

import { createColorNorm } from "./color-norm.js";
import { createEmojiDetect } from "./emoji-detect.js";
import { createFontMetrics } from "./font-metrics.js";
import { createPlaceholderShown } from "./placeholder-shown.js";
import { createPseudoRules } from "./pseudo-rules.js";
import { createWarnings } from "./warnings.js";
import { createListsCountersHandler } from "./walker/lists-counters.js";
import { createReplacedElementsHandler } from "./walker/replaced-elements.js";
import { createMasksClipsHandler } from "./walker/masks-clips.js";
import { createFormControlsHandler } from "./walker/form-controls.js";
import { createTransformsHandler } from "./walker/transforms.js";
import { createBordersBackgroundsHandler } from "./walker/borders-backgrounds.js";

export const captureScript =
(args) => {
  const sel = args.sel;
  const vp = args.vp;

  // Wire up per-concern helpers. Each factory closes over its own state and
  // returns the handles captureInner / the orchestration tail call. Renamed
  // (e.g. `warnings: _warnings`) to keep captureInner's existing references
  // unchanged.
  const { normColor } = createColorNorm();
  const { needsRaster, textNeedsRaster } = createEmojiDetect();
  const { measureFontMetrics: _measureFontMetrics, substituteAliasedFamilies: _substituteAliasedFamilies } = createFontMetrics();
  const { resolvePlaceholderShownBg: _resolvePlaceholderShownBg } = createPlaceholderShown();
  const { resolvePseudo: _resolvePseudo, resolveCornerRadius: _resolveCornerRadius } = createPseudoRules();
  const { warn, shortSelector, warnings: _warnings } = createWarnings();
  const { captureListsCounters } = createListsCountersHandler({ normColor });
  const { handleReplacedElement } = createReplacedElementsHandler({ vp });
  const { discoverMasks, maskDefs: _maskDefs, maskRasters: _maskRasters } = createMasksClipsHandler({ vp, warn });
  const { captureFormControls } = createFormControlsHandler({ normColor, resolvePseudo: _resolvePseudo });
  const { wrapWithFrozenTransform, threadFrozenTransform } = createTransformsHandler();
  const { captureBordersBackgrounds } = createBordersBackgroundsHandler({
    normColor,
    resolvePlaceholderShownBg: _resolvePlaceholderShownBg,
    resolveCornerRadius: _resolveCornerRadius,
  });

  const capture = (el) => {
    // Freeze the element's CSS transform for the duration of the capture
    // so getBoundingClientRect returns un-transformed coords; the renderer
    // re-applies the saved transform via an SVG group wrapper. See
    // walker/transforms.ts for the rationale.
    const cs = window.getComputedStyle(el);
    return wrapWithFrozenTransform(el, cs, captureInner);
  };
  const captureInner = (el, cs, frozenTransform, frozenTransformOrigin) => {
    const rect = el.getBoundingClientRect();
    // DM-513: when an element's rect is outside the viewport, normally skip the
    // whole subtree. But position:fixed / position:sticky descendants escape
    // their containing-block flow and can paint INSIDE the viewport even when
    // their DOM-tree parent is offscreen (e.g. slashdot's #mongo-stick-it ad
    // bar is position:fixed at top:710px but its parent <footer id="ft"> is
    // at y=7140 in the document flow). Don't return null for an ancestor that
    // has at least one position:fixed/sticky descendant in-viewport — instead
    // capture the element as a transparent container (no own paint, but walk
    // children) so the in-viewport descendants are reached. _fixedAncestors
    // is precomputed in the pre-pass below.
    const outsideViewport = rect.right < vp.x || rect.bottom < vp.y || rect.left > vp.x + vp.width || rect.top > vp.y + vp.height;
    if (outsideViewport && !_fixedAncestors.has(el)) return null;

    // visibility: collapse on table-row/column/group collapses that section
    // (Chrome zero-sizes the row/col, so the zeroSized check below handles it).
    // On any other element, the spec says it behaves as visibility: hidden — the
    // text + children are hidden but adjacent layout / shared borders remain.
    // DM-375.
    //
    // For <td>/<th> with visibility:hidden|collapse inside a border-collapse:collapse
    // table, Chrome still paints the cell's borders (they're part of the shared
    // table grid). The TOP edge of a hidden header cell is owned by the cell
    // itself (no neighbor above to draw it), so dropping the cell loses that line.
    // Fall through with bordersOnlyCell = true and clear text/children/bg
    // before the final return. DM-450.
    const _earlyTag = el.tagName.toLowerCase();
    const bordersOnlyCell = (_earlyTag === 'td' || _earlyTag === 'th')
      && (cs.visibility === 'hidden' || cs.visibility === 'collapse')
      && cs.borderCollapse === 'collapse';
    if (cs.display === 'none') return null;
    if ((cs.visibility === 'hidden' || cs.visibility === 'collapse') && !bordersOnlyCell) return null;

    // DM-580: standard accessibility "visually-hidden" / "sr-only" idioms.
    // Chrome paints nothing for these (clipped to zero), but the DOM text is
    // still present for screen readers. Without this filter the captured tree
    // emits stray text (skip-to-content links, country/section abbreviations,
    // hidden tooltip labels) that the real page never paints. Three patterns:
    //   1. Legacy: clip: rect(0,0,0,0) (still used across major news/CMS sites)
    //   2. Modern: clip-path: inset(50%) or inset(100%) — collapses to 0 box
    //   3. 1x1 sr-only: tiny absolutely-positioned box with overflow:hidden
    const _clip = cs.clip || '';
    if (_clip !== 'auto' && _clip !== '' && _clip !== 'normal') {
      const _cm = _clip.match(/rect\(\s*([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^,\s]+)[ ,]+([^)\s]+)\s*\)/);
      if (_cm != null
          && parseFloat(_cm[1]) === 0 && parseFloat(_cm[2]) === 0
          && parseFloat(_cm[3]) === 0 && parseFloat(_cm[4]) === 0) {
        return null;
      }
    }
    const _cp = cs.clipPath || '';
    if (_cp.indexOf('inset(') === 0) {
      const _ipm = _cp.match(/inset\(\s*([0-9.]+)\s*%/);
      if (_ipm != null && parseFloat(_ipm[1]) >= 50) return null;
    }
    if (rect.width <= 1 && rect.height <= 1
        && (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden')
        && (cs.position === 'absolute' || cs.position === 'fixed')) {
      return null;
    }

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
    // Mask discovery — same-document fragment refs (`url("#id")`), element
    // refs (`element(#id)`), and warnings for unsupported mask sources.
    // Handler owns the maskDefs / maskRasters Maps that the orchestration
    // tail consumes. See walker/masks-clips.ts.
    discoverMasks(el, cs, sel);
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
    // DM-547/549/550: conic-gradient layers are rasterized into PNG tiles by
    // the capture pre-pass (rasterizeConicGradients) and emitted as
    // <pattern><image> via buildConicGradientDef. The previous unconditional
    // warning fired even when the layer rendered correctly — moved to
    // rasterizeConicGradients (DM-549) which warns only on parse failure.
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
    // Resolve open/close quote characters per the Chrome quotes property and
    // q-element nesting depth (DM-367 / DM-376). For an element whose quotes
    // computed string is e.g. "« " " »" "“ " " ”", depth=0 picks pair 0
    // (« and »), depth=1 picks pair 1 (“ ”), and so on — falling back to
    // the last pair when depth exceeds available pairs.
    function pickQuoteChar(forEl, isOpen) {
      // Count how many q-element ancestors above this element (depth=0 = the
      // first q not inside another q). The pseudo lives ON forEl so when
      // forEl IS a q, its own depth = ancestorQ count. When forEl is some
      // other element with a manual ::before { content: open-quote }, depth
      // is ancestorQ count too (manual content treated as outer-level text).
      let depth = 0;
      let p = forEl.tagName === 'Q' ? forEl.parentElement : forEl.parentElement;
      while (p != null) {
        if (p.tagName === 'Q') depth++;
        p = p.parentElement;
      }
      const cs = window.getComputedStyle(forEl).quotes;
      // quotes: auto / none / missing — fall back to English curly defaults.
      if (cs == null || cs === '' || cs === 'none' || cs === 'auto') {
        const pairs = [['“','”'],['‘','’']];
        const pair = pairs[Math.min(depth, pairs.length - 1)];
        return isOpen ? pair[0] : pair[1];
      }
      // Parse the CSS quotes string: a sequence of double-quoted strings
      // (CSS escapes any quote char). The format Chrome returns is e.g.
      //   "« " " »" "“ " " ”"
      // Walk and extract one string per token, alternating open/close.
      const tokens = [];
      let i = 0;
      while (i < cs.length) {
        if (cs[i] === '"') {
          let j = i + 1;
          let s = '';
          while (j < cs.length && cs[j] !== '"') {
            if (cs[j] === '\\') { s += cs[j+1]; j += 2; } else { s += cs[j]; j++; }
          }
          tokens.push(s);
          i = j + 1;
        } else {
          i++;
        }
      }
      if (tokens.length < 2) {
        const pair = [['“','”']][0];
        return isOpen ? pair[0] : pair[1];
      }
      // Pairs are (open, close, open, close, …).
      const pairIdx = Math.min(depth, Math.floor((tokens.length - 1) / 2));
      const o = tokens[pairIdx * 2];
      const c = tokens[pairIdx * 2 + 1];
      return isOpen ? o : c;
    }
    for (const pseudo of ['::before', '::after']) {
      const pcs = window.getComputedStyle(el, pseudo);
      const content = pcs.content;
      if (content == null || content === 'none' || content === 'normal' || content === '') continue;
      // Parse content string. CSS concatenates mixed forms:
      //   "literal"  attr(x)  url(foo)  counter(name)  open-quote
      // Handled: string literals, attr(), url() (rendered as <image>),
      // open-quote / close-quote (default English quotation marks; nested
      // levels not tracked — DM-254).
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
        } else if (content.startsWith('counter(', i) || content.startsWith('counters(', i)) {
          // Resolve counter() / counters() against the element's snapshot of
          // active CSS counter scopes (computed in the pre-walk above). DM-357.
          const isCounters = content.startsWith('counters(', i);
          const openIdx = i + (isCounters ? 'counters('.length : 'counter('.length);
          const closeIdx = content.indexOf(')', openIdx);
          if (closeIdx < 0) { i++; continue; }
          const args = content.slice(openIdx, closeIdx).split(',').map((s) => {
            const t = s.trim();
            if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
              return t.slice(1, -1);
            }
            return t;
          });
          const cname = args[0];
          const sep = isCounters ? (args[1] ?? '') : '';
          // counter-style argument (third arg of counters(), second of counter())
          // is currently ignored — we always render decimal. Most fixtures use
          // the default style; non-decimal formatting can be added later.
          const snapshot = _counterSnapshot.get(el) || [];
          const matches = snapshot.filter((s) => s.name === cname).map((s) => String(s.value));
          if (isCounters) {
            text += matches.length > 0 ? matches.join(sep) : '0';
          } else {
            text += matches.length > 0 ? matches[matches.length - 1] : '0';
          }
          i = closeIdx + 1;
        } else if (content.startsWith('open-quote', i)) {
          // Resolve open-quote against the element computed CSS quotes
          // property at the current q-element nesting depth (DM-367 / DM-376).
          // Chrome :lang(fr) quotes "guillemets" produces "« »" instead of
          // curly quotes; :lang(de) quotes "low-9 left,right" flips the open
          // mark to U+201E. Default chain is U+201C / U+201D (outer) and
          // U+2018 / U+2019 (inner) when no quotes property is set.
          text += pickQuoteChar(el, true);
          i += 'open-quote'.length;
        } else if (content.startsWith('close-quote', i)) {
          text += pickQuoteChar(el, false);
          i += 'close-quote'.length;
        } else if (content.startsWith('no-open-quote', i)) {
          i += 'no-open-quote'.length;
        } else if (content.startsWith('no-close-quote', i)) {
          i += 'no-close-quote'.length;
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
        // Capture the inline-blocks outer-box horizontal contributions: the
        // following text is shifted by (marginL + borderL + paddingL + width +
        // paddingR + borderR + marginR), but the IMAGE paints at the content-
        // box top-left = (outerLeft + marginL + borderL + paddingL). Without
        // these we lose marginR/paddingR/borderR — DM-453 (.img-before with
        // margin-right:6px rendered 6px right of Chrome).
        const pMarginL = parseFloat(pcs.marginLeft) || 0;
        const pMarginR = parseFloat(pcs.marginRight) || 0;
        const pBorderL = parseFloat(pcs.borderLeftWidth) || 0;
        const pBorderR = parseFloat(pcs.borderRightWidth) || 0;
        const pPaddingL = parseFloat(pcs.paddingLeft) || 0;
        const pPaddingR = parseFloat(pcs.paddingRight) || 0;
        pseudoSegments.push({
          isBefore: pseudo === '::before',
          imageUrl,
          seg: { text: '', x: elLeft, y: yPosImg, width: layoutW, height: layoutH },
          renderWidth: renderW,
          renderHeight: renderH,
          color: pcs.color,
          boxMarginLeft: pMarginL,
          boxMarginRight: pMarginR,
          boxBorderLeft: pBorderL,
          boxBorderRight: pBorderR,
          boxPaddingLeft: pPaddingL,
          boxPaddingRight: pPaddingR,
        });
        continue;
      }
      if (text === '') continue;
      // Measure via canvas using the pseudo's computed font.
      const m = /^(italic|normal|oblique)?\s*(?:small-caps\s+)?(bold|normal|[\d]+)?\s*([\d.]+px)\s*(.*)$/i.exec(pcs.font || ('' + pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily));
      const fontSpec = pcs.font || (pcs.fontWeight + ' ' + pcs.fontSize + ' ' + pcs.fontFamily);
      void m;
      const measureCanvas = document.createElement('canvas');
      const mctx = measureCanvas.getContext('2d');
      mctx.font = fontSpec;
      // DM-507: prefer Chrome's resolved layout width over canvas.measureText
      // when available. For position:absolute pseudos with auto-width Chrome
      // shrink-to-fits the box and getComputedStyle returns the resolved
      // content-box width (assumes box-sizing: content-box, the default).
      // canvas.measureText drifts ~1-2px from Chrome's actual layout in
      // common bold/symbol-mix fixtures because the canvas font-shaping path
      // differs slightly from Chrome's HarfBuzz paint pipeline. Falling back
      // to canvas measurement when pcs.width is unavailable (typical for
      // non-positioned inline pseudos) keeps the existing path.
      var pseudoWidth = mctx.measureText(text).width;
      if (pcs.position === 'absolute' || pcs.position === 'fixed') {
        var _pcsW = parseFloat(pcs.width);
        if (!isNaN(_pcsW) && _pcsW > 0) pseudoWidth = _pcsW;
      }
      // Position: ::before sits at the START of the element's text/content.
      // ::after sits at the END. We use the element's textLeft/textWidth if
      // available, otherwise fall back to (el.x, el.y + padTop).
      const elTop = rect.top - vp.y + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.borderTopWidth) || 0);
      const elLeft = rect.left - vp.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
      const elFontSize = parseFloat(pcs.fontSize) || 14;
      const lineH = parseFloat(pcs.lineHeight) || elFontSize * 1.2;
      // Position: ::before sits at the START of the element's text/content.
      // ::after sits at the END. We use the element's textLeft/textWidth if
      // available, otherwise fall back to (el.x, el.y + padTop).
      // Capture pseudos baseline metric — CSS lets ::before / ::after override
      // font-size independent of the host, so the captured ascent must come
      // from the pseudo's computed font, not the element's. Renderer uses
      // seg.fontAscent when present and falls back to el.fontAscent otherwise.
      const _pseudoMetrics = _measureFontMetrics(pcs);
      // DM-495: when the pseudo itself is positioned (absolute / fixed /
      // relative offsets), it does NOT participate in the parent's inline
      // flow — it paints at its own coordinates anchored to its containing
      // block. Use pcs.left / pcs.top (resolved px values) relative to the
      // parent's padding box for absolute/fixed, and as an offset from the
      // in-flow position for relative.
      var xPos, yPos;
      var pseudoIsPositioned = false;
      if (pcs.position === 'absolute' || pcs.position === 'fixed') {
        // Containing block for absolute is the nearest positioned ancestor's
        // padding box; for the pseudo, that ancestor is el itself when el is
        // positioned, otherwise the chain Chromium resolved. The simple case
        // we handle: the pseudo left/top are resolved against el padding
        // box (true when el is the offsetParent — the common case since
        // authors typically position the host to anchor the pseudo).
        var pcsLeft = parseFloat(pcs.left);
        var pcsTop = parseFloat(pcs.top);
        var pcsRight = parseFloat(pcs.right);
        var pcsBottom = parseFloat(pcs.bottom);
        var paddingBoxLeft = rect.left - vp.x + (parseFloat(cs.borderLeftWidth) || 0);
        var paddingBoxTop = rect.top - vp.y + (parseFloat(cs.borderTopWidth) || 0);
        var paddingBoxRight = rect.right - vp.x - (parseFloat(cs.borderRightWidth) || 0);
        var paddingBoxBottom = rect.bottom - vp.y - (parseFloat(cs.borderBottomWidth) || 0);
        // DM-507: anchor xPos / yPos at the pseudo BOX edge, not the text
        // edge. Box width = textWidth + padL + padR + borL + borR; box height
        // = lineH + padT + padB + borT + borB. For left/top-anchored, box-
        // left/top = paddingBoxX + pcsLeft/Top — the unconditional
        // xPos += padL + borL below converts box-left to text-left. For
        // right/bottom-anchored, box-right/bottom = paddingBoxOpposite -
        // pcsRight/Bottom; subtract the FULL box dimension here so the
        // unconditional += padL/T + borL/T lands xPos/yPos on the text
        // edge. Previously we subtracted only textWidth/lineH, which left
        // xPos too far right by (padL + padR + borL + borR).
        var _pPadL = parseFloat(pcs.paddingLeft) || 0;
        var _pPadR = parseFloat(pcs.paddingRight) || 0;
        var _pPadT = parseFloat(pcs.paddingTop) || 0;
        var _pPadB = parseFloat(pcs.paddingBottom) || 0;
        var _pBorL = parseFloat(pcs.borderLeftWidth) || 0;
        var _pBorR = parseFloat(pcs.borderRightWidth) || 0;
        var _pBorT = parseFloat(pcs.borderTopWidth) || 0;
        var _pBorB = parseFloat(pcs.borderBottomWidth) || 0;
        if (!isNaN(pcsLeft)) xPos = paddingBoxLeft + pcsLeft;
        else if (!isNaN(pcsRight)) xPos = paddingBoxRight - pcsRight - pseudoWidth - _pPadL - _pPadR - _pBorL - _pBorR;
        else xPos = paddingBoxLeft;
        if (!isNaN(pcsTop)) yPos = paddingBoxTop + pcsTop;
        else if (!isNaN(pcsBottom)) yPos = paddingBoxBottom - pcsBottom - lineH - _pPadT - _pPadB - _pBorT - _pBorB;
        else yPos = paddingBoxTop;
        // Pseudo's own padding shifts the content inside its box.
        xPos += _pPadL;
        xPos += _pBorL;
        yPos += _pPadT;
        yPos += _pBorT;
        // Center within the line box (vertical-align baseline approximation).
        yPos += (lineH - elFontSize) / 2;
        pseudoIsPositioned = true;
      } else {
        yPos = elTop + (lineH - elFontSize) / 2;
        xPos = pseudo === '::before' ? elLeft : elLeft + rect.width - pseudoWidth - 2 * (parseFloat(cs.paddingRight) || 0);
      }
      const pseudoSeg = {
        text, x: xPos,
        y: yPos, width: pseudoWidth, height: elFontSize,
        // Carry pseudo-specific typography so the renderer can respect
        // per-pseudo color, font-size, font-weight, font-family (CSS lets
        // pseudos style independently of their parent — see .stamp::after
        // green check, li[data-badge]::before purple bold badge, and icon-
        // font pseudos like Slashdots .icon-angle-right with
        // font-family: sdicon + ::before content U+e87a (DM-513).
        color: pcs.color, fontSize: elFontSize, fontWeight: pcs.fontWeight,
        fontFamily: pcs.fontFamily,
        fontAscent: _pseudoMetrics.ascent,
      };
      // DM-497: stash pseudos own background / border-radius on the wrapper
      // (boxStyles below). The actual pseudoBox rect is computed after the
      // injection loop reassigns seg.x/seg.y to anchor against the parents
      // real text boundaries — at capture-time xPos isnt final.
      const _pseudoBgRaw = pcs.backgroundColor;
      const _pseudoBgColor = _pseudoBgRaw && _pseudoBgRaw !== '' && _pseudoBgRaw !== 'rgba(0, 0, 0, 0)' && _pseudoBgRaw !== 'transparent'
        ? normColor(_pseudoBgRaw) : '';
      const _pseudoBR = parseFloat(pcs.borderRadius) || 0;
      // Capture a uniform border when all four sides match. Mixed-side styling
      // is rare on pseudos in real-world fixtures and falls through.
      const _bw = parseFloat(pcs.borderTopWidth) || 0;
      const _bwUniform = _bw > 0
        && (parseFloat(pcs.borderRightWidth) || 0) === _bw
        && (parseFloat(pcs.borderBottomWidth) || 0) === _bw
        && (parseFloat(pcs.borderLeftWidth) || 0) === _bw;
      const _pseudoBC = _bwUniform ? normColor(pcs.borderTopColor) : '';
      var _pseudoBoxStyles = null;
      if (_pseudoBgColor !== '' || _pseudoBR > 0 || (_bwUniform && _pseudoBC !== '' && _pseudoBC !== 'rgba(0, 0, 0, 0)')) {
        _pseudoBoxStyles = {
          padL: parseFloat(pcs.paddingLeft) || 0,
          padR: parseFloat(pcs.paddingRight) || 0,
          padT: parseFloat(pcs.paddingTop) || 0,
          padB: parseFloat(pcs.paddingBottom) || 0,
          borL: parseFloat(pcs.borderLeftWidth) || 0,
          borR: parseFloat(pcs.borderRightWidth) || 0,
          borT: parseFloat(pcs.borderTopWidth) || 0,
          borB: parseFloat(pcs.borderBottomWidth) || 0,
          // Inline-box bg paints at line-height, not at font-size — so the
          // boxs vertical extent is lineH + padding + border (not fontSize).
          // Capture lineH alongside the metrics; the post-injection block
          // uses it to compute boxH and boxY (centered on the line box).
          lineH: lineH,
          fontSize: elFontSize,
          backgroundColor: _pseudoBgColor !== '' ? _pseudoBgColor : undefined,
          borderRadius: _pseudoBR > 0 ? _pseudoBR : undefined,
          borderWidth: _bwUniform ? _bw : undefined,
          borderColor: _bwUniform && _pseudoBC !== '' && _pseudoBC !== 'rgba(0, 0, 0, 0)' ? _pseudoBC : undefined,
        };
      }
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
      pseudoSegments.push({ isBefore: pseudo === '::before', seg: pseudoSeg, color: pcs.color, isPositioned: pseudoIsPositioned, boxStyles: _pseudoBoxStyles });
    }

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
            const probeBox = probe.getBoundingClientRect();
            const probeOriginX = probeBox.left;
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
            // Honor text-align inside an <input> (Chrome centers / right-aligns
            // the value within the content box; the probe is an inline-level
            // span so its xOffsets are flush-left and need post-shift). DM-353:
            // .spin input with text-align center left "3" against the left
            // padding instead of centered between the +/- buttons.
            const pr = parseFloat(cs.paddingRight) || 0;
            const br = parseFloat(cs.borderRightWidth) || 0;
            const contentBoxW = rect.width - bl - br - pl - pr;
            const probeW = probeBox.width;
            const slack = contentBoxW - probeW;
            const align = cs.textAlign;
            const dir = cs.direction;
            let shift = 0;
            if (slack > 0) {
              if (align === 'center') shift = slack / 2;
              else if (align === 'right' || (align === 'end' && dir !== 'rtl') || (align === 'start' && dir === 'rtl')) shift = slack;
            }
            if (shift !== 0) {
              textLeft += shift;
              for (let k = 0; k < xs.length; k++) xs[k] += shift;
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
            // Apply CSS text-transform — Chrome paints transformed glyphs and
            // measures them at the transformed advance. Range.getBoundingClientRect
            // returns the transformed-glyph rect even though node.textContent
            // is the un-transformed source string, so we must mirror the
            // transform on our text content for the path renderer to draw the
            // matching glyphs at the captured x positions. Capitalize uses an
            // ASCII word-boundary heuristic — sufficient for current fixtures;
            // a CSS-spec-compliant Unicode word break would need ICU.
            let raw = node.textContent || '';
            const tt = cs.textTransform;
            if (tt === 'uppercase') raw = raw.toUpperCase();
            else if (tt === 'lowercase') raw = raw.toLowerCase();
            else if (tt === 'capitalize') raw = raw.replace(/\b\p{L}/gu, (ch) => ch.toUpperCase());
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
              const isWs = step === 1 && /\s/.test(raw[i]);
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
            // BiDi visual-fragment splitting (DM-323). When a single DOM text
            // node lands inside a dir=rtl paragraph, Chrome can split it
            // into multiple visually-separate chunks — most commonly trailing
            // punctuation reorders to the visual-left while the rest of the
            // run paints on the visual-right. Detect those large xOffset
            // discontinuities here (gap between consecutive chars > 80 px in
            // either direction) and split the line into multiple fragments,
            // each with its own xOffset min so the segment downstream renders
            // at the correct anchor. Without this, our min(xOffsets) for
            // the whole line collapses the visually-rightmost run onto the
            // visually-leftmost char x and the chars overlap.
            const fragmentedLines = [];
            for (const ln of lines) {
              if (ln.chars.length <= 1) { fragmentedLines.push(ln); continue; }
              let frag = { chars: [ln.chars[0]], top: ln.top, bottom: ln.bottom };
              const fragments = [frag];
              for (let ci = 1; ci < ln.chars.length; ci++) {
                const prev = ln.chars[ci - 1];
                const cur = ln.chars[ci];
                // Big leftward jump (cur starts well to the LEFT of prev's
                // left edge) OR big rightward jump (cur starts well to the
                // RIGHT of prev's right edge) — either is a reordered
                // fragment boundary that Chrome paints at a discontinuous x.
                const leftJump = cur.left < prev.left - 80;
                const rightJump = cur.left > prev.right + 80;
                if (leftJump || rightJump) {
                  frag = { chars: [cur], top: ln.top, bottom: ln.bottom };
                  fragments.push(frag);
                } else {
                  frag.chars.push(cur);
                }
              }
              for (const f of fragments) {
                let l = Infinity, r = -Infinity;
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
              const visualText = line.text.replace(/[\t\n\r]/g, ' ');
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
              for (let _ci = 0; _ci < line.chars.length; _ci++) {
                const cRec = line.chars[_ci];
                const cp = cRec.ch.codePointAt(0);
                const nextCh = _ci + 1 < line.chars.length ? line.chars[_ci + 1].ch : '';
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
        }
        // ::first-line detection (DM-294). The first visual line of an element
        // can carry styles different from the rest via the ::first-line pseudo
        // (font-variant: small-caps, color, font-style, font-weight, font-size,
        // letter-spacing). Chrome's getComputedStyle(el, '::first-line')
        // resolves the actual computed values for us — we don't need to walk
        // the stylesheet or implement the CSS cascade ourselves. When the
        // pseudo's resolved style differs from the element's base, attach the
        // overrides to textSegments[0] (= the first visual line) so the
        // renderer applies them only there. Letter-spacing already comes
        // through in the captured xOffsets so we don't propagate it.
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
        // The image paints at the inline-blocks CONTENT-BOX top-left. The
        // following text is shifted by the full outer-box advance
        // (marginL + borderL + paddingL + width + paddingR + borderR +
        // marginR). For ::before that means
        //   contentBoxLeft = firstSeg.x - (paddingR + borderR + marginR + width)
        // For ::after the leading text ends at lastSeg.x + lastSeg.width, then
        //   contentBoxLeft = lastSegEnd + marginL + borderL + paddingL
        const mL = p.boxMarginLeft || 0;
        const mR = p.boxMarginRight || 0;
        const bL = p.boxBorderLeft || 0;
        const bR = p.boxBorderRight || 0;
        const pL = p.boxPaddingLeft || 0;
        const pR = p.boxPaddingRight || 0;
        if (p.isBefore && textSegments.length > 0) {
          const firstSeg = textSegments[0];
          p.seg.x = firstSeg.x - p.seg.width - pR - bR - mR;
          p.seg.y = firstSeg.y + (firstSeg.height - p.seg.height) / 2;
        } else if (!p.isBefore && textSegments.length > 0) {
          const lastSeg = textSegments[textSegments.length - 1];
          p.seg.x = lastSeg.x + lastSeg.width + mL + bL + pL;
          p.seg.y = lastSeg.y + (lastSeg.height - p.seg.height) / 2;
        }
        pseudoImages.push({
          url: p.imageUrl,
          x: p.seg.x, y: p.seg.y,
          width: p.renderWidth, height: p.renderHeight,
        });
        continue;
      }
      if (p.isPositioned) {
        // Positioned pseudo paints at its own anchor — do NOT realign to the
        // parent's text flow (DM-495).
        if (p.isBefore) textSegments.unshift(p.seg);
        else textSegments.push(p.seg);
      } else if (p.isBefore && textSegments.length > 0) {
        // Offset by measured width before the first real segment's x. When
        // the pseudo carries its own margin / border / padding (DM-497 badge
        // pattern), the text content is inset further so subtract the right-
        // side outer-box advance from the anchor.
        const firstSeg = textSegments[0];
        const _bs = p.boxStyles || {};
        const _mR = parseFloat(window.getComputedStyle(el, '::before').marginRight) || 0;
        p.seg.x = firstSeg.x - p.seg.width - (_bs.padR || 0) - (_bs.borR || 0) - _mR;
        p.seg.y = firstSeg.y;
        p.seg.height = firstSeg.height;
        textSegments.unshift(p.seg);
      } else if (!p.isBefore && textSegments.length > 0) {
        // ::after sits to the right of the parents trailing text. When the
        // pseudo has its own margin / padding / border (DM-497), the text
        // content is offset by margin-left + border-left + padding-left from
        // the parents text right edge.
        const lastSeg = textSegments[textSegments.length - 1];
        const _bs = p.boxStyles || {};
        const _mL = parseFloat(window.getComputedStyle(el, '::after').marginLeft) || 0;
        p.seg.x = lastSeg.x + lastSeg.width + _mL + (_bs.borL || 0) + (_bs.padL || 0);
        p.seg.y = lastSeg.y;
        p.seg.height = lastSeg.height;
        textSegments.push(p.seg);
      } else {
        // No main text — just place at element origin.
        textSegments.push(p.seg);
      }
      // DM-495: when the pseudo is the only text on the element, propagate
      // its bounds up to el.textLeft/textTop/etc. so the renderer's single-
      // segment path positions and sizes the text from the pseudo (without
      // this, textLeft / textTop default to 0 and the text paints at the
      // SVG origin).
      if (textSegments.length === 1 && textSegments[0] === p.seg) {
        textLeft = p.seg.x;
        textTop = p.seg.y;
        textWidth = p.seg.width;
        textHeight = p.seg.height;
        if (p.seg.fontAscent != null) fontAscent = p.seg.fontAscent;
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
      // DM-497: now that seg.x/y is in its final viewport-relative position,
      // compute the pseudos own paint box (for ::before/::after with their
      // own background-color or border-radius — badge / pill / chip patterns).
      // The text anchor is treated as the content-box origin; expand outward
      // by padding + border on all sides to get the box rect.
      if (p.boxStyles != null) {
        const bs = p.boxStyles;
        // Inline-box bg paints at lineH + padding (not fontSize). Vertical
        // anchor: text top is at (lineCenter - fontSize/2); box top should
        // be at (lineCenter - lineH/2 - padT - borT). Solve for lineCenter
        // from p.seg.y (text-top) and project the box top from that.
        const _lineCenter = p.seg.y + bs.fontSize / 2;
        const _boxTop = _lineCenter - bs.lineH / 2 - bs.padT - bs.borT;
        const _bx = p.seg.x - bs.padL - bs.borL;
        const _bw = p.seg.width + bs.padL + bs.padR + bs.borL + bs.borR;
        const _bh = bs.lineH + bs.padT + bs.padB + bs.borT + bs.borB;
        if (_bw > 0 && _bh > 0) {
          p.seg.pseudoBox = {
            x: _bx, y: _boxTop, width: _bw, height: _bh,
            backgroundColor: bs.backgroundColor,
            borderRadius: bs.borderRadius,
            borderWidth: bs.borderWidth,
            borderColor: bs.borderColor,
          };
        }
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
      // Broken-image fallback (DM-372): el.complete && naturalWidth===0 means
      // the browser tried to load and failed (or src was empty). Chrome paints
      // a small broken-image icon plus the alt text inline. Capture both so
      // the renderer can synthesize the same fallback.
      var imageBroken = el.complete && el.naturalWidth === 0;
      var imageAlt = el.alt || '';
    } else if (tag === 'input' && el.type === 'image') {
      // <input type="image"> renders the src as a clickable button-image.
      // No currentSrc / naturalWidth on HTMLInputElement; the bounding rect
      // already reflects width/height attributes or the image's natural size.
      imageSrc = el.src;
    }
    const _listsCounters = captureListsCounters(el, cs, tag);
    if (tag === 'svg') {
      // Inline SVG icons styled by external CSS (e.g. '.icon-btn svg { fill:none;
      // stroke: currentColor; stroke-width: 2 }') need their resolved presentation
      // attributes baked into the outerHTML so the icon paints correctly when
      // re-embedded outside the original cascade. Skip when the svg already
      // declared the attribute inline. DM-279.
      const svgFill = cs.fill;
      const svgStroke = cs.stroke;
      const svgStrokeWidth = cs.strokeWidth;
      const svgFontFamily = cs.fontFamily;
      const clone = el.cloneNode(true);
      // DM-524: an attribute literal like fill="var(--hds-color-text-solid)"
      // (Stripe's nav rects) parses as a presentation-attribute value that
      // resolves only against the source page's custom-property cascade.
      // Outside that cascade — i.e. in our extracted SVG — the var is
      // unresolved and the rect paints with the SVG default black (or
      // currentColor), not the intended HDS palette color. Treat such
      // unresolved CSS-function values as "no concrete attribute" so we bake
      // the resolved computed value over them.
      const _unresolvedCssExprRe = /\b(?:var|calc|env|attr)\s*\(/;
      function _isUnresolvedCssExpr(v) {
        return v != null && _unresolvedCssExprRe.test(v);
      }
      function _hasConcreteAttr(node, attr) {
        return node.hasAttribute(attr) && !_isUnresolvedCssExpr(node.getAttribute(attr));
      }
      if (svgFill && svgFill !== '' && !_hasConcreteAttr(el, 'fill')) clone.setAttribute('fill', svgFill);
      if (svgStroke && svgStroke !== '' && svgStroke !== 'none' && !_hasConcreteAttr(el, 'stroke')) clone.setAttribute('stroke', svgStroke);
      if (svgStrokeWidth && svgStrokeWidth !== '' && !_hasConcreteAttr(el, 'stroke-width')) clone.setAttribute('stroke-width', svgStrokeWidth);
      // Bake the inherited font-family onto the root <svg> so any <text>
      // descendants without their own font-family inherit it when the SVG
      // is re-embedded outside the page's cascade. Without this, SVG <text>
      // defaults to "serif" (Times) and breaks pages whose body sets
      // sans-serif. DM-306.
      if (svgFontFamily && svgFontFamily !== '' && !el.hasAttribute('font-family')) {
        clone.setAttribute('font-family', svgFontFamily);
      }
      // Walk SVG descendants and bake each one's resolved presentation
      // attributes onto the cloned node. Without this, CSS-only styling such
      // as svg|rect { stroke: red } or *|circle { fill: green } (DM-346) is
      // lost when the SVG is re-embedded outside the original cascade —
      // computed style is resolved against the source DOM, not the clone.
      const _bakeSvgAttrs = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'fill-opacity', 'opacity'];
      const _walkBake = (origNode, cloneNode) => {
        if (origNode.nodeType !== 1) return;
        const ns = origNode.namespaceURI;
        if (ns === 'http://www.w3.org/2000/svg' && origNode !== el) {
          const ocs = window.getComputedStyle(origNode);
          for (const attr of _bakeSvgAttrs) {
            const camel = attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            const val = ocs[camel];
            // DM-524: see _hasConcreteAttr comment above. Skip the bake only
            // when the source attr value is a concrete literal — var() /
            // calc() / env() / attr() references resolve against the source
            // cascade and lose their resolution outside it, so we replace
            // them with the resolved computed value.
            if (val != null && val !== '' && !_hasConcreteAttr(origNode, attr)) {
              cloneNode.setAttribute(attr, val);
            }
          }
          // DM-508: bake CSS-animated transforms at t=0. CSS animation /
          // transition declarations mean the computed transform reflects the
          // animation's current frame at capture time — getComputedStyle
          // returns e.g. matrix(0.707, 0.707, -0.707, 0.707, 0, 0) for a 45-
          // deg rotated rect. The SVG transform attribute applies around
          // (0,0) by default, so a CSS transform-origin: center has to be
          // composed into the matrix manually:
          //   final = translate(ox, oy) * css_transform * translate(-ox, -oy)
          // For transform-box: fill-box (and the new CSS default for SVG),
          // origin px values are relative to the element's bounding box. We
          // read those from getComputedStyle().transformOrigin and compose.
          var transformVal = ocs.transform;
          if (transformVal != null && transformVal !== '' && transformVal !== 'none') {
            var transformOriginVal = ocs.transformOrigin || '0 0';
            var originParts = transformOriginVal.trim().split(/\s+/);
            var ox = parseFloat(originParts[0] || '0') || 0;
            var oy = parseFloat(originParts[1] || '0') || 0;
            // For transform-box: fill-box (Chrome default for SVG since CSS
            // Transforms 2), origin coords are relative to the element's bbox.
            // We need them in the parent's user space — add the bbox origin.
            // getBBox() works on rendered SVG nodes.
            try {
              if (typeof origNode.getBBox === 'function') {
                var bbox = origNode.getBBox();
                ox += bbox.x;
                oy += bbox.y;
              }
            } catch (e) { /* element not yet in render tree, fall through */ }
            var composed;
            if (ox === 0 && oy === 0) {
              composed = transformVal;
            } else {
              composed = 'translate(' + ox + ',' + oy + ') ' + transformVal + ' translate(' + (-ox) + ',' + (-oy) + ')';
            }
            cloneNode.setAttribute('transform', composed);
          }
        }
        const oChildren = origNode.children;
        const cChildren = cloneNode.children;
        const n = Math.min(oChildren.length, cChildren.length);
        for (let i = 0; i < n; i++) _walkBake(oChildren[i], cChildren[i]);
      };
      _walkBake(el, clone);
      // DM-499: resolve <use href="#id"> fragment refs by inlining the
      // referenced symbol/group/path into the cloned subtree. Without this
      // the cloned outerHTML carries dangling fragment refs whose targets
      // live in a sibling hidden-defs SVG that we never emit (apple.com
      // country dropdown checkmark, search/cart nav icons, footer social).
      // Same-document fragment-only refs handled here; external file refs
      // (./icons.svg#foo) and unresolved targets are left in place — the
      // dangling ref still doesn't paint, but at least we tried.
      const _svgNS = 'http://www.w3.org/2000/svg';
      const _xlinkNS = 'http://www.w3.org/1999/xlink';
      const _resolveUseRefs = (root, depth) => {
        if (depth > 5) return; // cycle / depth guard
        var uses = root.querySelectorAll ? root.querySelectorAll('use') : [];
        for (var ui = 0; ui < uses.length; ui++) {
          var useEl = uses[ui];
          var href = useEl.getAttribute('href');
          if (href == null || href === '') href = useEl.getAttributeNS(_xlinkNS, 'href') || '';
          if (href.charAt(0) !== '#') continue; // external or invalid
          var targetId = href.slice(1);
          var target = document.getElementById(targetId);
          if (target == null) continue;
          if (target.namespaceURI !== _svgNS) continue;
          // DM-508: animated subtrees no longer trigger raster fallback. The
          // _walkBake pass above bakes computed presentation attrs and
          // transforms at the moment of capture, so the t=0 paint state is
          // captured declaratively in the inlined SVG. Animation timing /
          // future frames don't survive — the icon is frozen at t=0 — but the
          // drawing is correct for the captured moment, which is the
          // contract Domotion provides for any other time-varying content.
          // We still warn so consumers know the snapshot is one frame.
          if (typeof target.getAnimations === 'function') {
            try {
              var anims = target.getAnimations({ subtree: true });
              if (anims != null && anims.length > 0) {
                warn(sel, 'inline-svg', '<use href="#' + targetId + '"> resolved to a CSS-animated subtree; the inlined SVG carries the t=0 computed paint state (no animation in the output)');
              }
            } catch (e) { /* getAnimations not supported — fall through, no warning */ }
          }
          var ux = parseFloat(useEl.getAttribute('x') || '0') || 0;
          var uy = parseFloat(useEl.getAttribute('y') || '0') || 0;
          var uw = useEl.getAttribute('width');
          var uh = useEl.getAttribute('height');
          var targetTag = target.tagName.toLowerCase();
          var replacement;
          if (targetTag === 'symbol') {
            // <symbol> => nested <svg> with the consumer's x/y/width/height
            // and the symbol's viewBox. Browsers honor preserveAspectRatio
            // on the nested <svg> the same way they do for <use> against a
            // symbol target — we let SVG do the math.
            var vb = target.getAttribute('viewBox') || '';
            var par = target.getAttribute('preserveAspectRatio') || '';
            replacement = document.createElementNS(_svgNS, 'svg');
            if (ux !== 0) replacement.setAttribute('x', String(ux));
            if (uy !== 0) replacement.setAttribute('y', String(uy));
            if (uw != null) replacement.setAttribute('width', uw);
            if (uh != null) replacement.setAttribute('height', uh);
            if (vb !== '') replacement.setAttribute('viewBox', vb);
            if (par !== '') replacement.setAttribute('preserveAspectRatio', par);
            for (var ci = 0; ci < target.children.length; ci++) {
              var clonedChild = target.children[ci].cloneNode(true);
              replacement.appendChild(clonedChild);
              // DM-508: bake t=0 computed styles on the inlined subtree.
              // The hidden-defs symbol's children carry CSS animations whose
              // computed values (transform, fill, opacity, etc.) reflect the
              // animation's current frame at capture time. Walking with the
              // original DOM as source captures those values.
              _walkBake(target.children[ci], clonedChild);
            }
          } else {
            // <g>, <path>, <circle>, <svg>, etc. — wrap in <g translate(x,y)>.
            // Skip translate when ux/uy are zero to keep the markup tidy.
            replacement = document.createElementNS(_svgNS, 'g');
            if (ux !== 0 || uy !== 0) {
              replacement.setAttribute('transform', 'translate(' + ux + ',' + uy + ')');
            }
            var clonedTarget = target.cloneNode(true);
            // Drop the id on the clone — keeping it would create a duplicate
            // id in the output document (the original lives in the hidden
            // defs SVG which won't be in our output, but safer to remove it
            // either way).
            if (clonedTarget.removeAttribute) clonedTarget.removeAttribute('id');
            replacement.appendChild(clonedTarget);
            // DM-508: bake t=0 computed styles on the inlined target subtree.
            _walkBake(target, clonedTarget);
          }
          // Carry over any presentation attrs from the <use> element. CSS
          // spec: attributes on <use> override the same attribute on the
          // referenced subtree's root.
          var _useAttrs = ['fill', 'stroke', 'stroke-width', 'opacity', 'class', 'style'];
          for (var ai = 0; ai < _useAttrs.length; ai++) {
            var av = useEl.getAttribute(_useAttrs[ai]);
            if (av != null && av !== '') replacement.setAttribute(_useAttrs[ai], av);
          }
          useEl.parentNode.replaceChild(replacement, useEl);
          // The replacement may itself contain <use> refs (chain). Recurse
          // with depth guard.
          _resolveUseRefs(replacement, depth + 1);
        }
      };
      _resolveUseRefs(clone, 0);
      // DM-499: substitute fill="currentColor" / stroke="currentColor" with
      // the consumer's resolved cs.color so the inlined symbol picks up the
      // host's color even when the resolved subtree's own ancestors don't
      // propagate currentColor (e.g. a symbol child with explicit
      // color="red" would otherwise short-circuit the wrapping <g color>
      // injection at render time). Defense in depth — the renderer also
      // emits a wrapping <g color=...> for currentColor propagation.
      var _hostColor = cs.color;
      var _substCurrentColor = (node) => {
        if (node.nodeType !== 1) return;
        var fa = node.getAttribute && node.getAttribute('fill');
        if (fa != null && /^currentcolor$/i.test(fa)) node.setAttribute('fill', _hostColor);
        var sa = node.getAttribute && node.getAttribute('stroke');
        if (sa != null && /^currentcolor$/i.test(sa)) node.setAttribute('stroke', _hostColor);
        for (var ci = 0; ci < node.children.length; ci++) _substCurrentColor(node.children[ci]);
      };
      _substCurrentColor(clone);
      svgContent = clone.outerHTML;
    }

    const children = [];
    for (const child of el.children) {
      // Closed <details> hides non-<summary> children visually. getBoundingClientRect
      // still returns their rects and cs.display isn't 'none', so we explicitly
      // skip non-summary children when the parent details is closed.
      if (tag === 'details' && !el.open && child.tagName.toLowerCase() !== 'summary') continue;
      // <select> renders its own listbox/dropdown via the form-control
      // synth; recursively capturing <option>/<optgroup> children would
      // emit their own background rects and stack them on top of the
      // synth output, hiding the option text. Skip them. (DM-355)
      if (tag === 'select' && (child.tagName.toLowerCase() === 'option' || child.tagName.toLowerCase() === 'optgroup')) continue;
      const c = capture(child);
      if (c) children.push(c);
    }

    const _animId = el.dataset != null ? el.dataset.domotionAnim : undefined;

    // <fieldset> with a top-aligned <legend>: Chrome's UA fieldset paints its
    // top border at the legend's vertical center, with a notch cut in the
    // border across the legend's x range. fieldset.getBoundingClientRect()
    // returns the OUTER box that includes the legend's full height — so the
    // visible box top sits legend.height/2 below rect.top. Inset the captured
    // y/height to match Chrome's painted box, and capture the legend's x
    // range for the renderer to notch the top border behind it. DM-342/DM-343.
    let fieldsetLegendNotch;
    let fsX = rect.left - vp.x;
    let fsY = rect.top - vp.y;
    let fsW = rect.width;
    let fsH = rect.height;
    if (tag === 'fieldset') {
      for (let i = 0; i < el.children.length; i++) {
        const ch = el.children[i];
        if (ch.tagName.toLowerCase() !== 'legend') continue;
        const lr = ch.getBoundingClientRect();
        // Top-aligned legend (legend.top === fieldset.top, with sub-px slack).
        if (lr.height > 0 && lr.width > 0 && Math.abs(lr.top - rect.top) < 2) {
          const inset = lr.height / 2;
          fsY = (rect.top - vp.y) + inset;
          fsH = rect.height - inset;
          fieldsetLegendNotch = { x: lr.left - vp.x, y: lr.top - vp.y, w: lr.width, h: lr.height };
        }
        break;
      }
    }

    const _captured = {
      tag, text,
      x: fsX, y: fsY,
      width: fsW, height: fsH,
      fieldsetLegendNotch,
      animId: _animId,
      styles: {
        // Border + background + outline + box-shadow fields — see
        // walker/borders-backgrounds.ts. Includes the
        // backgroundColor placeholder-shown fallback (DM-283), %-resolved
        // corner radii (SK-1093), per-side color-input border tint
        // workaround (DM-434), frosted-bg fallback (DM-476), per-layer
        // background-image intrinsic dims (DM-308), and border-image
        // intrinsic dims.
        ...captureBordersBackgrounds(el, cs, tag, rect, isPlaceholderCapture),
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
        display: cs.display,
        listStylePosition: cs.listStylePosition,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        zIndex: cs.zIndex,
        position: cs.position,
        float: cs.float,
        order: cs.order,
        flexDirection: cs.flexDirection,
        emptyCellsHidden: (tag === 'td' || tag === 'th') && cs.emptyCells === 'hide' && (el.textContent || '').trim() === '' && el.children.length === 0,
        // Form-control fields — input / progress / meter / select / details
        // + ::-webkit-* pseudos for slider track/thumb, color swatch, number
        // spin button, search cancel, file-selector button. See
        // walker/form-controls.ts. Input value-capture-as-text and color-
        // input border tinting deliberately stay inline (entangled with
        // text-shaping and border-color emission respectively).
        ...captureFormControls(el, cs, tag),
        textShadow: cs.textShadow,
        ...threadFrozenTransform(cs, frozenTransform, frozenTransformOrigin),
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
        // CSS font-variant-caps. 'small-caps' / 'all-small-caps' route to
        // the OpenType smcp feature; renderer applies synthesized small-caps
        // when the active font lacks smcp (Helvetica, Times, etc.). DM-361.
        fontVariantCaps: cs.fontVariantCaps,
        direction: cs.direction,
        // Computed BCP-47 language tag from el.lang or nearest ancestor
        // [lang], falling back to document.documentElement.lang. Used by the
        // path renderer to route CJK Han fallback to the right PingFang
        // regional variant. (DM-394)
        lang: (function() {
          var n = el;
          while (n != null && n.nodeType === 1) {
            if (n.lang) return n.lang;
            n = n.parentElement;
          }
          return document.documentElement.lang || '';
        })(),
        textDecorationLine: cs.textDecorationLine,
        textDecorationColor: cs.textDecorationColor,
        textDecorationStyle: cs.textDecorationStyle,
        textDecorationThickness: cs.textDecorationThickness,
        textUnderlineOffset: cs.textUnderlineOffset,
        textDecorationSkipInk: cs.textDecorationSkipInk,
      },
      children, imageSrc, imageIntrinsic, imageBroken, imageAlt, svgContent, pseudoImages,
      // SK-1115: ::marker pseudo styles plus list-marker intrinsic dims and
      // list-item index — see walker/lists-counters.ts.
      ..._listsCounters,
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
    // DM-450: hidden/collapsed table cell — keep the cell's box + borders so
    // shared edges of the collapsed table grid still paint, but suppress
    // text, children, and background fill (per CSS visibility:hidden).
    if (bordersOnlyCell) {
      _captured.text = '';
      _captured.children = [];
      _captured.styles.backgroundColor = 'rgba(0, 0, 0, 0)';
      _captured.styles.backgroundImage = undefined;
      _captured.textSegments = undefined;
      _captured.imageSrc = undefined;
      _captured.svgContent = undefined;
      _captured.pseudoImages = undefined;
      _captured.elementRaster = undefined;
    }
    // Replaced-element snapshot routing — <iframe>/<canvas>/<video>/<object>/
    // <embed>, custom elements with open shadow DOM, and the CSS sprite-icon
    // image-replacement idiom. Handler mutates _captured (.replacedSnapshot,
    // .imageReplacement, and on the sprite-icon path .styles.backgroundImage /
    // .text / .textSegments). See walker/replaced-elements.ts.
    handleReplacedElement(el, cs, tag, rect, _captured, bordersOnlyCell);
    return _captured;
  };

  const root = document.querySelector(sel);
  if (!root) return { tree: [], warnings: [] };

  // DM-513: pre-pass to find position:fixed / position:sticky descendants
  // whose rect intersects the viewport. Their DOM-tree parents may be far
  // outside the viewport (e.g. slashdot's #mongo-stick-it ad bar pinned at
  // top:710px while its <footer> ancestor sits at y=7140 in document flow),
  // and the per-element viewport filter in captureInner would otherwise drop
  // the whole subtree. We mark every ancestor of every in-viewport fixed/
  // sticky element so captureInner knows to walk past those ancestors as
  // transparent containers. position:absolute is NOT included because absolute
  // elements are positioned relative to their containing block, so if their
  // CB ancestor's rect is offscreen, so is the absolute child.
  const _fixedAncestors = new Set();
  const _allEls = root.getElementsByTagName('*');
  for (let _i = 0; _i < _allEls.length; _i++) {
    const _el = _allEls[_i];
    const _pos = getComputedStyle(_el).position;
    if (_pos !== 'fixed' && _pos !== 'sticky') continue;
    const _r = _el.getBoundingClientRect();
    const _outside = _r.right < vp.x || _r.bottom < vp.y || _r.left > vp.x + vp.width || _r.top > vp.y + vp.height;
    if (_outside) continue;
    // Walk up and mark every ancestor up to root.
    let _cur = _el.parentElement;
    while (_cur != null && _cur !== root.parentElement) {
      if (_fixedAncestors.has(_cur)) break;
      _fixedAncestors.add(_cur);
      _cur = _cur.parentElement;
    }
  }

  // CSS counters pre-walk (DM-357). Walk the document in DOM order,
  // applying counter-reset / counter-set / counter-increment per the
  // computed style of each element, and snapshot the active counter
  // scope chain at every element. The pseudo emit loop later substitutes
  // counter(name) / counters(name, sep) tokens against this snapshot.
  // Without this, content like 'counter(section) "."' was emitted
  // verbatim — so headings rendered as just '.' instead of '1.', '2.',
  // '99.', etc. Counter scoping rules (CSS Lists & Counters Level 3):
  // counter-reset on element X creates a counter scoped to X plus all
  // descendants; counter() resolves to the innermost ancestor's value;
  // counters() joins all values along the ancestor chain (outermost first).
  const _counterSnapshot = new WeakMap();
  function _parseCounterDecl(declStr, defaultValue) {
    if (!declStr || declStr === 'none') return [];
    // Format: "name1 [num] name2 [num] ..."
    const tokens = declStr.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      const name = tokens[i++];
      if (!name) continue;
      let value = defaultValue;
      if (i < tokens.length && /^-?\d+$/.test(tokens[i])) {
        value = parseInt(tokens[i++], 10);
      }
      out.push({ name, value });
    }
    return out;
  }
  // Active counter scope stack: each entry { name, value, owner }.
  const _activeScopes = [];
  function _findInnermost(name) {
    for (let i = _activeScopes.length - 1; i >= 0; i--) {
      if (_activeScopes[i].name === name) return _activeScopes[i];
    }
    return null;
  }
  function _counterPreWalk(el) {
    const cs = window.getComputedStyle(el);
    const owned = [];
    _parseCounterDecl(cs.counterReset, 0).forEach(({name, value}) => {
      const scope = { name, value, owner: el };
      _activeScopes.push(scope);
      owned.push(scope);
    });
    _parseCounterDecl(cs.counterSet, 0).forEach(({name, value}) => {
      const s = _findInnermost(name);
      if (s) s.value = value;
      else { const ns = { name, value, owner: el }; _activeScopes.push(ns); owned.push(ns); }
    });
    _parseCounterDecl(cs.counterIncrement, 1).forEach(({name, value}) => {
      const s = _findInnermost(name);
      if (s) s.value += value;
      else { const ns = { name, value, owner: el }; _activeScopes.push(ns); owned.push(ns); }
    });
    // Snapshot the active scopes (shallow copy of name+value pairs).
    _counterSnapshot.set(el, _activeScopes.map((s) => ({ name: s.name, value: s.value })));
    for (const child of el.children) _counterPreWalk(child);
    // Pop scopes owned by this element on exit (counter scope ends with the
    // owner element's subtree).
    while (_activeScopes.length > 0 && owned.length > 0
      && _activeScopes[_activeScopes.length - 1] === owned[owned.length - 1]) {
      _activeScopes.pop();
      owned.pop();
    }
  }
  _counterPreWalk(root);

  const result = [];
  // Capture the root element itself when it has visible border or background
  // (DM-362: <body style="border:3px solid pink"> was not rendering because
  // we only walked root.children). When the root has nothing visually
  // distinctive, fall through to the prior child-walk so we don't wrap
  // every page in a redundant outer rect.
  const rootCs = window.getComputedStyle(root);
  const rootHasBorder = (parseFloat(rootCs.borderTopWidth) || 0) > 0
    || (parseFloat(rootCs.borderRightWidth) || 0) > 0
    || (parseFloat(rootCs.borderBottomWidth) || 0) > 0
    || (parseFloat(rootCs.borderLeftWidth) || 0) > 0;
  const rootBg = rootCs.backgroundColor;
  const rootHasBg = rootBg != null && rootBg !== 'rgba(0, 0, 0, 0)' && rootBg !== 'transparent';
  // DM-365: invalid HTML like <p>foo<div>bar</div>baz</p> auto-closes the <p>
  // when the <div> opens, leaving "baz" as a direct text-node child of <body>.
  // Chrome paints it; we'd miss it if we only walked root.children (Element
  // children only). When the root has any direct text-node child with non-
  // whitespace content, capture root so its text-node walk picks them up.
  let rootHasDirectText = false;
  for (const node of root.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim() !== '') {
      rootHasDirectText = true;
      break;
    }
  }
  if (rootHasBorder || rootHasBg || rootHasDirectText) {
    const c = capture(root);
    if (c) result.push(c);
  } else {
    for (const child of root.children) {
      const c = capture(child);
      if (c) result.push(c);
    }
  }
  // DM-493: attach the collected mask fragment defs to the first root element
  // as a top-level payload. Renderer reads tree[0].maskDefs to emit the mask
  // defs into the output SVG.
  if (_maskDefs.size > 0 && result.length > 0) {
    result[0].maskDefs = Array.from(_maskDefs.values());
  }
  // DM-494: attach mask raster references (mask-image: element(#id)). Skip
  // null entries (display:none / zero-area / not-found targets). The post-
  // capture rasterize pass on the Node side fills in dataUri.
  if (_maskRasters.size > 0 && result.length > 0) {
    var rasterArr = [];
    for (var entry of _maskRasters.values()) {
      if (entry != null) rasterArr.push(entry);
    }
    if (rasterArr.length > 0) result[0].maskRasters = rasterArr;
  }
  // DM-552: stamp page-level dark-mode signals on the captured tree's root
  // element. The renderer reads these to emit color-scheme="dark" on the
  // root <svg> (this slice) and to source the body-bg fallback in the
  // transparent-root case (DM-554 wires up the second consumer).
  if (result.length > 0) {
    try {
      var _isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      result[0].styles.rootColorScheme = _isDark ? 'dark' : 'light';
      result[0].styles.rootBgComputed = window.getComputedStyle(document.documentElement).backgroundColor;
    } catch (_e) { /* no-op — never block capture on this */ }
  }
  return { tree: result, warnings: _warnings };
}
;
