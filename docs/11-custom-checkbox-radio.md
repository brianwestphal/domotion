---
id: "requirements/custom-checkbox-radio"
title: "Domotion: appearance: none checkbox / radio / switch"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2459","DM-247","DM-285"]
code: ["src/capture/pseudo-fragment-cdp.ts","src/render/pseudo-fragments.ts","tests/checkable-pseudo-indicators.e2e.test.ts","tools/pseudo-fragment-render-oracle.ts"]
aliases: ["docs/11-custom-checkbox-radio.md","doc-11"]
---

# Domotion: `appearance: none` checkbox / radio / switch

Requirements for honoring author CSS on `appearance: none` and
`appearance: base` checkboxes, radios, and switch-shaped toggles. Origin:
DM-285 (follow-up from DM-247), completed by DM-2459 through the source-owned
generated-pseudo pipeline. Doc 26 covers `<input>` shadow-DOM pseudos generally;
this doc focuses on checkable indicator ownership.

**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium-pinned
Skia `62efacd37737505732dbe3d8daa62abd679626a1`.

## Why now

`06-forms-style-checkbox-radio.html` exercises three custom patterns:

```css
.cbx { -webkit-appearance: none; appearance: none; ...; border: 2px solid #94a3b8; border-radius: 5px; }
.cbx:checked { border-color: #4f46e5; background: #eef2ff; }

.rdo { -webkit-appearance: none; appearance: none; ...; border-radius: 50%; }
.rdo:checked { border-color: #059669; }

.sw  { -webkit-appearance: none; appearance: none; width: 44px; height: 24px; border-radius: 999px; background: #cbd5e1; }
.sw:checked { background: #16a34a; }
```

Before this work, `renderCheckbox` and `renderRadio` always overlaid the UA-default 13×13 blue-tinted square / circle, ignoring the host's author-styled border + background. Toggle switches got the checkbox treatment, producing a checkmark icon in a 44×24 box rather than a pill with a thumb.

## Capture

`CapturedElement.styles.inputAppearance` carries Blink's resolved
`appearance`/`-webkit-appearance` value. Before the synchronous DOM walk,
`src/capture/pseudo-fragment-cdp.ts` pierces the real pseudo tree and captures
`::checkmark`, `::before`, and `::after` as ordered
`CapturedPseudoFragmentSet` records. An empty array is an authoritative modern
observation that the host has no generated pseudo paint; `undefined` alone
means an older serialized tree that predates this capture contract.

The source boundary is explicit:

- Blink's UA sheet defines the `appearance:base` checkbox/radio indicator on
  `::checkmark` and hides its unchecked state
  (`core/html/resources/html.css:719-786`).
- `Element::AttachPseudoElement` creates `kPseudoIdCheckMark` only for a base
  checkable input (or the other enumerated checkmark hosts), while the element
  attachment order places checkmark before `::before`
  (`core/dom/element.cc:11328-11352`, `core/dom/element.h:2414-2421`).
- Checkbox and radio input types opt into `appearance:base` only behind the
  corresponding Blink feature
  (`core/html/forms/checkbox_input_type.cc:131-136`,
  `radio_input_type.cc:379-384`). If the feature is unavailable, `base`
  computes to a native appearance and never activates the source-pseudo route.
- CDP names the real node `checkmark`; no author-side selector or synthesized
  host geometry is used to infer it
  (`core/inspector/inspector_dom_agent.cc:232-245,336-351`).

## Render

`checkablePseudoFactsOwnIndicator` activates only for checkbox/radio hosts whose
resolved appearance is `none` or `base` and whose `pseudoFragments` field is
authoritative (including `[]`). `renderCheckbox` and `renderRadio` then emit no
generic tick, dot, or switch thumb. `src/render/pseudo-fragments.ts` paints the
captured text, box, gradient/image, transform, radius, and selected-font facts
in Blink order: `::checkmark`, `::before`, host children, then `::after`, with
the existing positioned/z-index slots where applicable. A uniform solid
rounded pseudo border uses the retained outer contour and an inset stroke;
mixed-edge and slice ownership remain per-side.

The host's own background and border remain on the normal element path. Native
`auto`/`checkbox`/`radio` controls do not activate authored-pseudo ownership and
continue through Chromium native-control capture.

## Compatibility boundary

The former fixed tick/dot/pill heuristic remains only for old serialized trees
where `pseudoFragments` is `undefined`. It is never selected when modern
capture explicitly reports records or an empty set. Protocol ambiguity follows
the generated-pseudo fail-closed raster/warning contract in docs 176 and 178;
it does not revive generic synthesis.

## Tests

`tests/checkable-pseudo-indicators.e2e.test.ts` proves exact none/base capture,
explicit-empty ownership, synthesis suppression, and the native-auto negative.
`tools/pseudo-fragment-render-oracle.ts` adds checked, unchecked,
indeterminate, disabled, before/after text and box content, gradients, affine
transforms, switch, base checkmark, fractional origin, zoom, and DPR 1/2 to the
independent Chromium-versus-SVG edge gate. The unchanged acceptance radius is
four **device** pixels. The existing three-OS workflow runs these rows on
macOS, Linux, and Windows and uploads each platform's own source and rendered
surfaces.
