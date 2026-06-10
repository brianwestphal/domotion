// @ts-nocheck
//
// Form-control capture: per-element fields that the renderer reads to paint
// inputs, progress bars, meters, selects, details/summary, and the host of
// `::-webkit-*` pseudo-elements Chromium uses for slider tracks/thumbs,
// color swatches, number spin buttons, file selector buttons, search cancel
// buttons, etc.
//
// Returns a flat object that's `...spread` into the captured `styles`
// sub-object. Fields not relevant to the element's tag/type come back as
// `undefined` and the renderer skips them.
//
// What's NOT in this handler:
//
//   - **Input value capture** (the `if ((tag === 'input' || tag ===
//     'textarea') && el.value)` block that sets `text` for the shaping
//     pipeline) is interleaved with the text-segment / placeholder-shown
//     work and stays inline in captureInner until the text-segments slice
//     factors text shaping itself.
//
//   - **Color-input border tinting** (the `(tag === 'input' && el.type ===
//     'color')` overrides of borderTopColor / borderRightColor / etc.)
//     lives alongside the other border-color fields in the styles literal.
//     Moving four override-ternaries out would mean either two competing
//     `borderTopColor:` keys in the same object literal or a spread merge
//     gymnastic — neither cleaner than the status quo.
//
//   - **selectListboxOptions / selectChevron / detailsOpen / summaryMarker
//     Suppressed**: included here even though `<select>` and `<details>`
//     aren't strictly "form controls" by every taxonomy. They're
//     UA-rendered native widgets driven by author CSS in the same way the
//     input pseudos are, so they slot naturally next to them.

export const createFormControlsHandler = ({ normColor, resolvePseudo }) => {
  const captureFormControls = (el, cs, tag) => {
    // DM-1115 / DM-1123: resolve the <summary> disclosure-marker state once.
    // `suppressed` → author hid the UA triangle (`list-style: none` or a
    // transparent `::marker`), so the renderer paints nothing. Otherwise the
    // marker IS shown and we capture its computed `::marker` color / font-size
    // / inside-position for the renderer to reproduce Chrome's paint.
    const mk = tag === 'details' ? (() => {
      const sum = el.querySelector(':scope > summary');
      if (sum == null) return { suppressed: false };
      if (window.getComputedStyle(sum).listStyleType === 'none') return { suppressed: true };
      const mcs = window.getComputedStyle(sum, '::marker');
      const mc = mcs.color;
      // 'transparent' or 'rgba(R, G, B, 0)' → alpha=0. 'rgb(R, G, B)' (no
      // alpha component) is opaque and must NOT trigger suppression.
      if (mc === 'transparent') return { suppressed: true };
      const am = /^rgba\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*([0-9.]+)\s*\)$/.exec(mc);
      if (am != null && parseFloat(am[1]) === 0) return { suppressed: true };
      return {
        suppressed: false,
        color: normColor(mc),
        fontSize: parseFloat(mcs.fontSize) || undefined,
        inside: mcs.listStylePosition === 'inside',
      };
    })() : null;
    const out = {
      inputType: tag === 'input' ? (el.type || 'text') : undefined,
      // CSS appearance / -webkit-appearance longhand for inputs. When 'none'
      // (the appearance:none custom-styled pattern) the renderer suppresses
      // its UA-default checkbox / radio chrome so the host's author-styled
      // border + background show through, with only the :checked indicator
      // overlaid on top. DM-285.
      inputAppearance: tag === 'input' ? (cs.webkitAppearance || cs.appearance || '') : undefined,
      checked: (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) ? !!el.checked : undefined,
      indeterminate: (tag === 'input' && el.type === 'checkbox') ? !!el.indeterminate : undefined,
      disabled: (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') ? !!el.disabled : undefined,
      progressValue: tag === 'progress' ? (el.hasAttribute('value') ? +el.value : undefined) : undefined,
      progressMax: tag === 'progress' ? (el.max || 1) : undefined,
      meterValue: tag === 'meter' ? (el.value != null ? +el.value : undefined) : undefined,
      meterMin: tag === 'meter' ? (el.min || 0) : undefined,
      meterMax: tag === 'meter' ? (el.max || 1) : undefined,
      meterLow: tag === 'meter' ? (el.low != null ? +el.low : undefined) : undefined,
      meterHigh: tag === 'meter' ? (el.high != null ? +el.high : undefined) : undefined,
      meterOptimum: tag === 'meter' ? (el.optimum != null ? +el.optimum : undefined) : undefined,
      detailsOpen: tag === 'details' ? !!el.open : undefined,
      // Detect if author CSS hid the summary's UA disclosure marker. If so,
      // skip painting our own triangle — the author's custom marker (typically
      // a ::before / ::after pseudo) is the only one that should show.
      //   - `list-style: none` / `list-style-type: none` removes the disclosure
      //     marker entirely (the marker IS a list-item ::marker with
      //     list-style-type `disclosure-closed`/`disclosure-open`; setting it to
      //     `none` drops it, exactly as for a styled <li>). This is the common
      //     idiom — `summary { list-style: none }` plus a custom ::after caret.
      //     DM-1115. Note `display: flex` on the summary does NOT itself suppress
      //     the marker — Chrome still paints it when list-style-type is a
      //     disclosure value, so we key off list-style-type, not display.
      //   - `::marker { color: transparent }` is the other author technique for
      //     hiding the UA triangle without changing the box model. DM-448.
      summaryMarkerSuppressed: tag === 'details' ? (mk == null || mk.suppressed) : undefined,
      // DM-1123: when the disclosure marker IS shown, Chrome paints the
      // triangle in the computed `::marker` color, at the `::marker` font-size,
      // and (for the UA-default `list-style-position: inside`) at the summary's
      // content-start — not in the summary's text color at a fixed 0.7em
      // outside the padding. Capture those three so the renderer can match it.
      summaryMarkerColor: mk != null && !mk.suppressed ? mk.color : undefined,
      summaryMarkerFontSize: mk != null && !mk.suppressed ? mk.fontSize : undefined,
      summaryMarkerInside: mk != null && !mk.suppressed ? mk.inside : undefined,
      // Native chevron only when the select keeps UA chrome — appearance:
      // none means the page draws its own arrow via background-image, and
      // we should not stack our default chevron on top. DM-308.
      selectChevron: tag === 'select' && el.size <= 1 && !el.multiple
        && cs.appearance !== 'none' && cs.webkitAppearance !== 'none',
      selectDisplayText: tag === 'select' && el.size <= 1 && !el.multiple
        ? (el.selectedOptions && el.selectedOptions.length > 0
            ? (el.selectedOptions[0].textContent || '').trim()
            : (el.options && el.options.length > 0 ? (el.options[0].textContent || '').trim() : ''))
        : undefined,
      // Listbox-mode selects (size > 1 or multiple) flatten their option /
      // optgroup children into a captured row list. The renderer walks this
      // list and paints one row per entry inside the select's content rect.
      // Optgroup labels are emitted as italic+bold rows that don't count
      // against selection. DM-282.
      selectListboxOptions: tag === 'select' && (el.size > 1 || el.multiple)
        ? (function () {
            const list = [];
            const kids = el.children;
            for (let ki = 0; ki < kids.length; ki++) {
              const c = kids[ki];
              if (c.tagName === 'OPTGROUP') {
                list.push({ text: c.label || '', selected: false, disabled: !!c.disabled, isOptgroupLabel: true });
                const og = c.children;
                for (let gi = 0; gi < og.length; gi++) {
                  const o = og[gi];
                  if (o.tagName !== 'OPTION') continue;
                  list.push({ text: (o.textContent || '').trim(), selected: !!o.selected, disabled: !!o.disabled, isOptgroupChild: true });
                }
              } else if (c.tagName === 'OPTION') {
                list.push({ text: (c.textContent || '').trim(), selected: !!c.selected, disabled: !!c.disabled });
              }
            }
            return list;
          })()
        : undefined,
      accentColor: (tag === 'input' || tag === 'progress' || tag === 'meter') ? normColor(cs.accentColor || 'auto') : undefined,
      caretColor: (tag === 'input' || tag === 'textarea') ? normColor(cs.caretColor || 'auto') : undefined,
      inputValue: tag === 'input' ? (el.value || '') : undefined,
      inputMin: tag === 'input' ? (el.min || '') : undefined,
      inputMax: tag === 'input' ? (el.max || '') : undefined,
      inputStep: tag === 'input' ? (el.step || '') : undefined,
      inputMultiple: tag === 'input' ? !!el.multiple : undefined,
      inputFileName: (tag === 'input' && el.type === 'file' && el.files && el.files.length > 0) ? el.files[0].name : undefined,
    };

    // ::-webkit-progress-bar / ::-webkit-progress-value pseudos — resolved
    // via the stylesheet walker. getComputedStyle(el, pseudo) returns the
    // host <progress>'s style for these UA pseudos, not the pseudo's
    // cascaded value, so author rules like
    // ::-webkit-progress-value { background: green } were silently dropped.
    // Walking document.styleSheets restores them. SK-1222.
    if (tag === 'progress') {
      const bar = resolvePseudo(el, 'progress-bar');
      const val = resolvePseudo(el, 'progress-value');
      out.progressBarBg = bar.matched && bar.backgroundColor !== '' ? normColor(bar.backgroundColor) : undefined;
      out.progressBarBgImage = bar.matched && bar.backgroundImage !== '' ? bar.backgroundImage : undefined;
      out.progressBarRadius = bar.matched && bar.borderRadius !== '' ? bar.borderRadius : undefined;
      out.progressValueBg = val.matched && val.backgroundColor !== '' ? normColor(val.backgroundColor) : undefined;
      out.progressValueBgImage = val.matched && val.backgroundImage !== '' ? val.backgroundImage : undefined;
      out.progressValueRadius = val.matched && val.borderRadius !== '' ? val.borderRadius : undefined;
    }

    // <meter> pseudos via the stylesheet walker (same Chromium quirk).
    if (tag === 'meter') {
      const bar = resolvePseudo(el, 'meter-bar');
      const opt = resolvePseudo(el, 'meter-optimum');
      const sub = resolvePseudo(el, 'meter-suboptimum');
      const elg = resolvePseudo(el, 'meter-even-less-good');
      out.meterBarBg = bar.matched && bar.backgroundColor !== '' ? normColor(bar.backgroundColor) : undefined;
      out.meterBarBgImage = bar.matched && bar.backgroundImage !== '' ? bar.backgroundImage : undefined;
      out.meterBarRadius = bar.matched && bar.borderRadius !== '' ? bar.borderRadius : undefined;
      out.meterOptimumBg = opt.matched && opt.backgroundColor !== '' ? normColor(opt.backgroundColor) : undefined;
      out.meterOptimumBgImage = opt.matched && opt.backgroundImage !== '' ? opt.backgroundImage : undefined;
      out.meterSuboptimumBg = sub.matched && sub.backgroundColor !== '' ? normColor(sub.backgroundColor) : undefined;
      out.meterSuboptimumBgImage = sub.matched && sub.backgroundImage !== '' ? sub.backgroundImage : undefined;
      out.meterEvenLessGoodBg = elg.matched && elg.backgroundColor !== '' ? normColor(elg.backgroundColor) : undefined;
      out.meterEvenLessGoodBgImage = elg.matched && elg.backgroundImage !== '' ? elg.backgroundImage : undefined;
    }

    // ::-webkit-color-swatch / -wrapper / -inner-spin-button /
    // -search-cancel-button pseudos via the stylesheet walker (SK-1223 —
    // same Chromium quirk as progress / meter). color-swatch is the most
    // commonly authored; the others land their fields for future renderer
    // work.
    if (tag === 'input' && el.type === 'color') {
      const swatch = resolvePseudo(el, 'color-swatch');
      const wrap = resolvePseudo(el, 'color-swatch-wrapper');
      out.colorSwatchBg = swatch.matched && swatch.backgroundColor !== '' ? normColor(swatch.backgroundColor) : undefined;
      out.colorSwatchBgImage = swatch.matched && swatch.backgroundImage !== '' ? swatch.backgroundImage : undefined;
      out.colorSwatchBorder = swatch.matched && swatch.border !== '' ? swatch.border : undefined;
      out.colorSwatchRadius = swatch.matched && swatch.borderRadius !== '' ? swatch.borderRadius : undefined;
      out.colorSwatchWrapperPadding = wrap.matched && wrap.padding !== '' ? wrap.padding : undefined;
    }

    if (tag === 'input' && el.type === 'number') {
      const spin = resolvePseudo(el, 'inner-spin-button');
      out.numberSpinButtonBg = spin.matched && spin.backgroundColor !== '' ? normColor(spin.backgroundColor) : undefined;
      out.numberSpinButtonBorder = spin.matched && spin.border !== '' ? spin.border : undefined;
      out.numberSpinButtonRadius = spin.matched && spin.borderRadius !== '' ? spin.borderRadius : undefined;
    }

    if (tag === 'input' && el.type === 'search') {
      const cancel = resolvePseudo(el, 'search-cancel-button');
      out.searchCancelButtonBg = cancel.matched && cancel.backgroundColor !== '' ? normColor(cancel.backgroundColor) : undefined;
      out.searchCancelButtonBorder = cancel.matched && cancel.border !== '' ? cancel.border : undefined;
      out.searchCancelButtonRadius = cancel.matched && cancel.borderRadius !== '' ? cancel.borderRadius : undefined;
    }

    // input[type=range] custom pseudos (SK-1131 / SK-1137 / SK-1138).
    // Resolved by walking document.styleSheets — getComputedStyle(el,
    // pseudo) is unreliable for these UA-internal pseudos in Chromium
    // (returns the host element's style instead of the pseudo's). A pseudo
    // is treated as author-styled when at least one matching rule was
    // found OR the host has -webkit-appearance: none (the .r-custom
    // pattern always pairs the two and we want the renderer to drop UA
    // chrome even if only the track is rule-styled).
    if (tag === 'input' && el.type === 'range') {
      const ts = resolvePseudo(el, 'track');
      const ms = resolvePseudo(el, 'thumb');
      const elAppearance = cs.webkitAppearance || cs.appearance;
      const customAppearance = elAppearance === 'none';
      const styledTrack = ts.matched || customAppearance;
      const styledThumb = ms.matched || customAppearance;
      out.rangeTrackBg = styledTrack && ts.backgroundColor !== '' ? normColor(ts.backgroundColor) : (styledTrack ? 'rgba(0, 0, 0, 0)' : undefined);
      out.rangeTrackHeight = styledTrack ? ts.height : undefined;
      out.rangeTrackRadius = styledTrack ? ts.borderRadius : undefined;
      out.rangeTrackBgImage = styledTrack && ts.backgroundImage !== '' ? ts.backgroundImage : undefined;
      out.rangeThumbBg = styledThumb && ms.backgroundColor !== '' ? normColor(ms.backgroundColor) : (styledThumb ? 'rgba(0, 0, 0, 0)' : undefined);
      out.rangeThumbWidth = styledThumb ? ms.width : undefined;
      out.rangeThumbHeight = styledThumb ? ms.height : undefined;
      out.rangeThumbRadius = styledThumb ? ms.borderRadius : undefined;
      out.rangeThumbBgImage = styledThumb && ms.backgroundImage !== '' ? ms.backgroundImage : undefined;
      out.rangeTrackBorder = styledTrack && ts.border !== '' ? ts.border : undefined;
      out.rangeThumbBorder = styledThumb && ms.border !== '' ? ms.border : undefined;
      out.rangeThumbBoxShadow = styledThumb && ms.boxShadow !== '' ? ms.boxShadow : undefined;
    }

    // ::file-selector-button — read directly via getComputedStyle (not the
    // stylesheet walker) because the pseudo cascades cleanly here. The
    // label-width measurement is the same pseudo font Chrome paints —
    // canvas.measureText with the resolved pseudo font matches Chrome's
    // sub-pixel exact width and lets the renderer place the trailing
    // 'No file chosen' placeholder at the same x. DM-288.
    if (tag === 'input' && el.type === 'file') {
      const pseudoCs = window.getComputedStyle(el, '::file-selector-button');
      out.fileButtonBg = normColor(pseudoCs.backgroundColor);
      out.fileButtonColor = normColor(pseudoCs.color);
      out.fileButtonBorder = pseudoCs.border;
      out.fileButtonBorderRadius = pseudoCs.borderRadius;
      out.fileButtonPadding = pseudoCs.padding;
      out.fileButtonFontWeight = pseudoCs.fontWeight;
      out.fileButtonFontSize = pseudoCs.fontSize;
      out.fileButtonFontFamily = pseudoCs.fontFamily;
      out.fileButtonMarginRight = pseudoCs.marginRight;
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      if (ctx != null) {
        const weight = pseudoCs.fontWeight || '400';
        const size = pseudoCs.fontSize || '13px';
        const family = pseudoCs.fontFamily || 'sans-serif';
        ctx.font = weight + ' ' + size + ' ' + family;
        const label = el.multiple ? 'Choose Files' : 'Choose File';
        out.fileButtonLabelWidth = ctx.measureText(label).width;
      }
    }

    return out;
  };

  return { captureFormControls };
};
