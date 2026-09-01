---
id: "requirements/native-control-fallback-retirement"
title: "182 — Native-control sampled-fallback retirement"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2458","DM-2615","DM-2628","DM-2634"]
code: [".github/workflows/native-control-fallback-parity.yml","src/capture/input-value-geometry.ts","src/capture/pseudo-style-cdp.test.ts","src/capture/pseudo-style-cdp.ts","src/capture/script/walker/form-controls.ts","src/capture/script/walker/input-value.ts","src/render/form-controls.test.ts","src/render/form-controls.ts","tests/native-control-fallback-activation.e2e.test.ts","tests/native-control-fallback-gate.test.ts","tools/native-control-fallback-gate.ts"]
aliases: ["docs/182-native-control-fallback-retirement.md","doc-182"]
---

# 182 — Native-control sampled-fallback retirement

DM-2458 removes the last platform-calibrated SVG substitutes for native form
controls. Native paint is now a strict source boundary: Domotion emits the
captured Chromium surface, or emits a named warning and no replacement paint.
Only structural appearances whose geometry and paint are present in the
captured record reach `src/render/form-controls.ts`.

## Chromium ownership

The implementation is pinned to Chromium revision
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `third_party/blink/renderer/core/paint/theme_painter.cc` reads
  `ComputedStyle::EffectiveAppearance()` and dispatches checkbox, radio,
  button, menulist, progress, slider, text-field, and related parts to the
  theme painter. These branches are not portable CSS geometry.
- `theme_painter_default.cc` passes live checked/indeterminate/disabled/
  hovered/active state, effective zoom, writing direction, used color scheme,
  forced-colors mode, accent color, and platform theme parameters into
  `WebThemeEngine::Paint`. A macOS RGB sample or luminance threshold cannot
  reproduce that decision on Linux or Windows.
- `layout_theme.cc::AdjustAppearanceWithAuthorStyle` changes a styled native
  control to `none`, or a styled menulist to `menulist-button`. The capture-side
  EffectiveAppearance route in doc 170 is therefore the authoritative split;
  host tag/type alone is not.
- `html/resources/html.css` and captured pseudo facts retain the structural
  CSS route for `none`, `base`, `base-select`, `listbox`, and
  `menulist-button`. Closed-shadow file/picker/spin/search/select decorations
  remain separate exact surfaces under docs 171 and 172.

## Renderer contract

`formControlRenderRoute` enumerates the complete entry boundary:

| Captured state | Renderer route | Result |
| --- | --- | --- |
| `nativeControlRaster` record present | `native-raster` | The parent emitter handles `dataUri`, authoritative empty, or warned absence and never calls structural paint. |
| Whole-host native EffectiveAppearance without a record | `missing-native-raster` | Warn and emit nothing. |
| Unknown/old capture with no EffectiveAppearance fact | `missing-native-raster` | Warn and emit nothing; old bytes do not authorize a platform guess. |
| `none`, `base`, `base-select`, `listbox`, or `menulist-button` | `structural` | Consume only captured CSS/pseudo geometry and paint. |
| Non-control element | `not-form-control` | No form-control paint. |

The terminal native-raster guard in `element-tree-to-svg.ts` remains before
`renderFormControl`. A missing or empty record cannot fall through.

The structural helpers now require their source inputs:

- checkbox/radio indicators come only from captured generated-pseudo records;
- range track/thumb dimensions, backgrounds, borders, radii, gradients, and
  shadows come from the captured pseudo styles;
- progress/meter paint comes only from captured pseudo colors/images/radii;
- color swatches require captured wrapper padding and swatch paint;
- file buttons require the pierced child rectangle, typography, and captured
  author background/border; localized status text uses the captured closed
  shadow span;
- structural select text requires captured font metrics and content-box
  dimensions; a base-select disclosure is structural vector paint from the
  captured `::picker-icon` color, while native arrows remain exact decoration
  surfaces or author backgrounds;
- single-line input value text may use Chromium's closed-UA-shadow FragmentItem
  top only when its one axis-aligned quad and same-frame host dimensions pass
  the validation contract in doc 171; rejected or old records retain the
  metric-based compatibility estimate;
- search cancel, number spin, and temporal picker glyphs are exact decoration
  surfaces, not renderer drawings; and
- summary disclosure paint is owned by the source-recorded generic list-marker
  route from doc 180.

## Deleted authority

The following native-default mechanisms are removed from
`src/render/form-controls.ts`:

- `STOCK_LIGHT`, `STOCK_DARK`, and `stockPalette`;
- the sampled accent blue, track, meter, disabled, and border aliases;
- `resolveAccent` and the empirically fitted relative-luminance cutoff;
- generic checkbox/radio/checkmark/switch geometry;
- native range track, fill, thumb, radius, and stroke constants;
- progress indeterminate bands and native progress/meter palettes/grooves;
- default color-swatch wrapper padding and surrounding native box;
- English `Choose File` / `No file chosen` labels and file-button geometry;
- calendar/clock/search-cancel/spin glyph geometry;
- native selected-value font/baseline and generic native select-chevron
  approximations (the source-semantic structural base-select icon in doc 171 is
  a separate vector route); and
- the legacy details disclosure triangle.

`src/dark-mode-form-controls.test.ts` was deleted because it asserted the
retired macOS palette. Dark-mode capture and SVG metadata remain supported;
native control colors are now the captured platform pixels selected by
Chromium under the requested scheme.

## Gates

`tools/native-control-fallback-gate.ts` is a static and route gate. Its 24 rows
cover materialized and missing native controls, unknown old captures, and all
structural appearance values. It rejects orphan sampled constants/helpers,
platform-name branches, fixture selectors, test marker checks, a missing
fail-closed warning, or any emitter ordering that can reach structural paint
before the native record terminates it. `tests/native-control-fallback-gate.test.ts`
contains mutations for each family.

`tests/native-control-fallback-activation.e2e.test.ts` exercises checkbox,
radio, range, progress, meter, file, date, select, and details in one live
native/split/structural matrix. It crosses DPR 1/2, light/dark, forced colors,
zoom, LTR/RTL, checked/disabled/value state, and accent color, and requires
every whole-host native row to carry a Chromium PNG while every structural row
has no whole-host raster. File/date/select partial surfaces and shown/suppressed
summary markers are checked independently.

That interaction matrix also guards the ordering boundary with generated
pseudos: a terminal pseudo-surface isolation temporarily hides unrelated page
content, so `preparePseudoFragmentGeometry` retains and restores the original
per-frame active element before decoration/control atlases read `:focus` paint.
Without that restoration, an unrelated `option::checkmark` fallback can turn a
focused search-cancel decoration into an authoritative-empty record.

`.github/workflows/native-control-fallback-parity.yml` runs that matrix plus
the existing EffectiveAppearance, native-source-frame, decoration, checkable,
and summary-marker gates on macOS, Linux, and Windows. Each job uploads a JSON
fingerprint containing runner image, OS/architecture, Chromium and Playwright
versions/revisions, launch arguments, user agent, pinned source revision, and
the requested matrix axes. No cross-platform baseline or sampled tolerance is
used.

Run locally:

```sh
npm run forms:native-fallback-gate
npm run forms:native-fallback-browser
```

## Boundary

This cleanup does not remove exact Chromium raster routes and does not turn
unsupported author pseudo effects into vector paint. Native host and closed-
shadow decoration failures retain their named capture warnings. Structural
helpers still fail closed when complete source facts are unavailable; there is
no versioned native-default compatibility path in the current public capture
format.
