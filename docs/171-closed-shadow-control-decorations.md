---
id: "requirements/closed-shadow-control-decorations"
title: "171 — Source-owned closed-shadow control decorations"
kind: "contract"
status: "current"
owners: ["text-fonts","paint-effects"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2455", "DM-2624"]
code: ["src/capture/native-control-decoration.ts","src/capture/script/index.ts","src/render/form-controls.ts","tests/native-control-decoration.e2e.test.ts","tests/select-display-geometry.e2e.test.ts"]
aliases: ["docs/171-closed-shadow-control-decorations.md","doc-171"]
---

# 171 — Source-owned closed-shadow control decorations

DM-2455 splits a Chromium-owned control decoration from an otherwise
structural form control. The host background, border, shadows, selected/value
text, descendants, opacity, transforms, and clips remain SVG. Only the pixels
whose geometry or paint belongs to Blink's theme/closed UA shadow tree become a
transparent `<image>` overlay.

## Source boundary

Pinned Chromium revision:
`7d859f271cbda744098ac69f44978d4edfa62be3`.

- `third_party/blink/renderer/core/paint/theme_painter_default.cc:520-604`
  paints `menulist-button` as the platform menu-list part with a transparent
  host surface. Arrow direction, border-relative position, theme padding,
  zoom, size, and color are inputs to the native theme engine. They are not one
  portable chevron.
- `theme_painter_default.cc:726-760` passes spin direction, up/down state,
  readonly, scheme, forced colors, contrast, and accent to the platform theme.
- `theme_painter_default.cc:819-906` sizes the search cancel image from the
  closed part's physical content box and selects platform resources by active,
  color-scheme, and contrast state.
- `html/resources/html.css:541-610` owns search/spin visibility and pointer
  activation. `html.css:1106-1139,1625-1671` owns temporal picker layout,
  calendar/time resources, scheme, focus ring, and disabled/readonly hiding.
- `html/forms/menu_list_inner_element.cc:20-118` builds the non-base selected
  text's anonymous style from the host. It is a closed shadow child, not an
  author-stylable surrogate for the arrow.
- `paint/box_fragment_painter.cc:1685-1741` fixes paint order: CSS background,
  theme decoration, inset shadow, border. Selected text paints later as child
  content.

## Routing

| Effective owner | Result |
| --- | --- |
| default `select` / complete native appearance | existing exact whole-host `nativeControlRaster` |
| styled `select` with `menulist-button` | vector host/text plus Chromium arrow overlay |
| `date`, `time`, `datetime-local`, `month`, `week` structural host | vector host/value plus retained calendar/time indicator overlay |
| structural `search` / `number` host | vector host/value plus retained cancel/spin overlay when its used state paints |
| `appearance:none`, `base`, `base-select`, listbox | structural route; no sampled native decoration is reopened |
| disabled/readonly/rest state whose retained part is hidden/zero-opacity/zero-size | explicit `empty` decoration reservation |

The classifier in `src/capture/native-control-decoration.ts` contains no
platform dimensions, colors, or glyph paths. A reservation remains fail-closed:
if materialization fails, `form-controls.ts` still suppresses its sampled
chevron/calendar/clock/cancel/spin fallback and capture emits a named
`native-control-decoration-raster` warning.

## Authoritative capture

`pseudo-style-cdp.ts` asks CDP for a pierced document and retains the actual
calendar-picker, search-cancel, inner-spin, and select-inner JavaScript nodes on
their correlated host. The synchronous capture records the candidate's used
rect, visibility, opacity, and identity. For every closed select, it also reads
the `Range` glyph-cell origin from the retained `select-inner` node. That is the
authoritative selected-text baseline input: Blink's UA line-height can differ
from the host's font bounding box for native, `base-select`, and
`appearance:none` routes. Missing, hidden, detached, rebuilt, or zero-area nodes
are never replaced with metrics inferred from the host.

`native-control-decoration-raster.ts` creates one page-wide transparent
isolation frame for all non-overlapping candidates:

1. Keep each host visible so focus/hover/active state cannot be lost. Preserve
   its dimensions, padding, writing mode, zoom, `color`, and `appearance`.
2. Neutralize only SVG-owned host paint: background, border colors/image,
   shadows, outline, caret, and text fill. Effects which the outer SVG wrapper
   owns are neutralized for the readback.
3. Re-expose the exact closed-shadow node without modifying its resource,
   opacity, state, or theme inputs.
4. A select arrow has no part node. Freeze the used host box and detach the
   exact anonymous selected-text node for the single readback, preserving its
   parent and next sibling. Restore it to that exact slot immediately.
5. Verify interaction state, host/part quads, node identity, every inline-style
   restoration, exact select sibling slot, and active element. Any mismatch is
   a required warning and no bitmap is emitted.
6. Crop at the captured DPR with a transparent one-CSS-pixel guard. Reject
   invalid alpha, overlapping owners, viewport/clip disagreement, or ink which
   reaches an unclipped guard edge.

Projective subtrees retain their existing single outer Chromium raster owner;
the partial overlay is not emitted a second time. Materialized overlay bounds
participate in renderer reference/culling geometry, while an unavailable
reservation makes culling unknown rather than silently dropping expected ink.

## Composition and evidence

The menulist arrow overlay is emitted after background layers and before inset
shadow/border/text. Calendar/search/spin overlays paint at the control-content
position after structural value text. Both stay inside the host's captured
opacity, clip, filter, stacking, and animation wrappers.

Focused evidence:

- pure classifier, fingerprint, overlap/guard, fail-closed renderer, culling,
  and paint-phase unit tests;
- `tests/native-control-decoration.e2e.test.ts`: whole vs split vs base-select,
  all five temporal types, search, number, disabled/readonly/empty states,
  author host and pseudo styles, light/dark/forced colors, LTR/RTL,
  horizontal/vertical/sideways writing, focus/hover/active, zoom, fractional
  origins, and DPR 1/2;
- byte-identical full-page screenshots before capture and after restoration;
- `tests/select-display-geometry.e2e.test.ts`: native, `base-select`, and
  `appearance:none` closed selects retain the live UA-shadow glyph-cell origin
  and font ascent rather than deriving a baseline from host padding;
- forced screenshot failure proving a warning plus no sampled fallback;
- the focused browser spec runs in the macOS, Linux, and Windows visual-test
  jobs. `niche-select-customizable` remains on the structural `base-select`
  route.
