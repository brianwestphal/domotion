# Domotion: custom-styled input pseudos

Requirements for honoring author CSS on `<input>` shadow-DOM pseudos in Domotion. Origin: SK-1125 (follow-up from SK-1094). Today `src/render/form-controls.ts` synthesizes the UA-default chrome for `<input type="range">` (track + thumb), `<input type="checkbox">`, `<input type="radio">`, `<input type="color">`, etc. When an author overrides those pseudos with custom backgrounds, sizes, or shadows, our pipeline keeps painting the default look.

## Why now

`06-forms-style-range.html` and similar tests show a styled range slider — a flat green track with a custom thumb circle — but our output paints the standard sky-blue UA range chrome. The visual mismatch is large because the author rewrote the appearance. Same shape applies to checkbox/radio with author-set `accent-color`, and color-picker swatches.

## Goals

- Capture the per-pseudo computed style block for each WebKit input pseudo:
  - `::-webkit-slider-runnable-track`
  - `::-webkit-slider-thumb`
  - `::-webkit-color-swatch`
  - `::-webkit-color-swatch-wrapper`
  - `::-webkit-inner-spin-button` (number inputs)
  - `::-webkit-search-cancel-button`
- Apply the captured backgrounds, borders, border-radius, padding, dimensions, and box-shadow when synthesizing the chrome in `src/render/form-controls.ts`.
- Keep current UA-default behavior when no author override is detected (compare pseudo style against the default and emit only when distinct).

## Capture changes

`CapturedElement` already has `progressBarBg` / `progressBarBgImage` / `progressBarRadius` and analogous fields for `<progress>` and `<meter>`. Mirror that structure for input pseudos:

- `rangeTrackBg`, `rangeTrackBgImage`, `rangeTrackRadius`, `rangeTrackHeight`, `rangeTrackBorder`, `rangeTrackBoxShadow`.
- `rangeThumbBg`, `rangeThumbBgImage`, `rangeThumbRadius`, `rangeThumbWidth`, `rangeThumbHeight`, `rangeThumbBorder`, `rangeThumbBoxShadow`.
- `colorSwatchBg`, `colorSwatchRadius`, `colorSwatchBorder`.
- `numberSpinButtonBg`, `numberSpinButtonBorder` (less commonly styled — capture but apply only when distinct).
- `searchCancelButtonBg`, `searchCancelButtonBorder`.

Each field comes from `getComputedStyle(el, '::-webkit-foo').<prop>`. Do this only when `el.tag === 'input'` and the type matches.

> **Update (SK-1138):** for `::-webkit-slider-runnable-track` and `::-webkit-slider-thumb`, `getComputedStyle(el, pseudo)` is unreliable in Chromium — it returns the host input's computed style rather than the pseudo's cascaded value, so `width: 22px` on the thumb came back as the host's `width: 100%` ≈ 544px and the renderer drew a giant pill instead of a small thumb. The current capture walks `document.styleSheets`, finds rules whose selector matches `<hostSel>::?-webkit-slider-(runnable-track|thumb)`, evaluates `el.matches(hostSel)`, and applies the matching rules in source order (later wins per property). This sidesteps the Chromium quirk but loses CSS variable / `calc()` resolution, gradient track fills (reduced to the first color stop), and `:hover`/`:focus` state rules (skipped). When the input pseudos in this doc's Goals list (`::-webkit-color-swatch`, `::-webkit-color-swatch-wrapper`, `::-webkit-inner-spin-button`, `::-webkit-search-cancel-button`) are implemented, they must also use stylesheet inspection.

> **Update (SK-1193):** the SK-1138 quirk was confirmed by direct probe to apply to every WebKit-internal input/progress/meter pseudo — `::-webkit-color-swatch`, `::-webkit-color-swatch-wrapper`, `::-webkit-inner-spin-button`, `::-webkit-search-cancel-button`, `::-webkit-progress-bar`, `::-webkit-progress-value`, `::-webkit-meter-bar`, and the meter value pseudos all return the host element's computed style rather than the pseudo's cascaded value. The lone exception is `::file-selector-button`, which Chromium implements as a real shadow DOM element rather than a UA-internal pseudo and resolves correctly via `getComputedStyle(el, pseudo)`.
>
> **Update (SK-1222 / SK-1223):** all the affected pseudos now flow through a generalized stylesheet walker (`_pseudoRules` / `_collectPseudoRules` / `_resolvePseudo` in `src/capture/script/` `CAPTURE_SCRIPT`). Each pseudo is keyed by short kind name (`'track'`, `'thumb'`, `'progress-bar'`, `'progress-value'`, `'meter-bar'`, `'meter-optimum'`, `'meter-suboptimum'`, `'meter-even-less-good'`, `'color-swatch'`, `'color-swatch-wrapper'`, `'inner-spin-button'`, `'search-cancel-button'`). Var/calc resolution (SK-1191), state-rule support (SK-1192), and gradient-def emission (SK-1224 / SK-1225 / SK-1226) all share that walker. Renderer pickup for the new color-swatch fields (`colorSwatchBg`, `colorSwatchBgImage`, `colorSwatchBorder`, `colorSwatchRadius`, `colorSwatchWrapperPadding`) lives in `renderColorSwatch`. `numberSpinButton*` and `searchCancelButton*` fields are captured but the renderer still emits text-input chrome — see SK-1227 for adding specialized renderers when authored fixtures appear.

## Render changes

`src/render/form-controls.ts` `renderRange()` currently emits a fixed-style track + thumb. Change to:

1. If `el.rangeTrackBg` differs from the UA default (which we hardcode as `rgb(231, 231, 231)` or similar), use the captured value for the track fill. Same for the thumb.
2. If `el.rangeTrackHeight` is set, use it for the track rect height (currently fixed 4px).
3. If `el.rangeThumbWidth/Height` is set, use them for the thumb circle/rect dimensions (currently fixed 16x16).
4. `box-shadow` on track/thumb routes through the existing `parseBoxShadow` + filter pipeline added in SK-1113.

## Edge cases

- Authors can hide the thumb with `appearance: none; ::-webkit-slider-thumb { display: none }` — detect and skip the thumb emission.
- Per-side CSS on the track (e.g. gradient fill) — already handled if `rangeTrackBgImage` is captured the same way as `progressBarBgImage`.
- `::-webkit-slider-runnable-track` may have height that exceeds the input's bounding rect — clip to the input's content box.

## Follow-ups to file

- Implementation ticket: "SK-???: range/color/spinner pseudo-style capture + apply".
- "Author-styled checkbox / radio tick" — distinct work item; the `accent-color` is already captured but the pseudo-styled tick mark is a separate beast.

## Acceptance criteria

`06-forms-style-range.html` diff drops below 1.5% avg. A range slider with `::-webkit-slider-runnable-track { background: green; height: 8px }` renders with a green 8px-tall track. UA-default range sliders elsewhere don't regress.
