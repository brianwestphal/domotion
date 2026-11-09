---
id: "requirements/closed-shadow-control-decorations"
title: "171 — Source-owned closed-shadow control decorations"
kind: "contract"
status: "current"
owners: ["text-fonts", "paint-effects"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2455", "DM-2615", "DM-2624", "DM-2628", "DM-2634", "DM-CVTZNR", "DM-A93KQZ"]
code:
  [
    "src/capture/control-pseudo-viewport.ts",
    "src/capture/control-pseudo-viewport.test.ts",
    "src/capture/control-pseudo-viewport.e2e.test.ts",
    "src/capture/input-value-geometry.ts",
    "src/capture/native-control-decoration.ts",
    "src/capture/pseudo-style-cdp.test.ts",
    "src/capture/pseudo-style-cdp.ts",
    "src/capture/script/index.ts",
    "src/capture/script/walker/form-controls.ts",
    "src/capture/script/walker/input-value.test.ts",
    "src/capture/script/walker/input-value.ts",
    "src/render/form-controls.test.ts",
    "src/render/form-controls.ts",
    "tests/input-value-geometry.e2e.test.ts",
    "tests/native-control-decoration.e2e.test.ts",
    "tests/select-display-geometry.e2e.test.ts",
  ]
aliases: ["docs/171-closed-shadow-control-decorations.md", "doc-171"]
---

# 171 — Source-owned closed-shadow control decorations

DM-2455 splits a Chromium-owned control decoration from an otherwise
structural form control. The host background, border, shadows, selected/value
text, descendants, opacity, transforms, and clips remain SVG. Only the pixels
whose geometry or paint belongs to Blink's theme/closed UA shadow tree become a
transparent `<image>` overlay. DM-2615 and DM-2628 extend the same ownership
rule to structural facts: `base-select`'s CSS `::picker-icon` stays vector, while
the used input-value text top comes from Blink's closed-shadow layout.

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
- `html/resources/html.css:424-507` applies
  `-internal-align-content-block:center` to controls, and
  `layout/block_layout_algorithm_utils.cc:188-205` moves child fragments by
  LayoutUnit `free_space / 2`. A host `line-height:normal` estimate cannot
  reproduce that used input-value position at half-pixel boundaries.
- `html/resources/html.css:2283-2301` makes a closed select's `::picker-icon` a
  disclosure counter, gives it block layout, pushes it to the inline end, and
  suppresses it for listboxes. This is portable structural CSS paint, not a
  platform theme glyph.

## Routing

| Effective owner                                                                   | Result                                                                                                             |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| default `select` / complete native appearance                                     | existing exact whole-host `nativeControlRaster`                                                                    |
| styled `select` with `menulist-button`                                            | vector host/text plus Chromium arrow overlay                                                                       |
| `date`, `time`, `datetime-local`, `month`, `week` structural host                 | vector host/value plus retained calendar/time indicator overlay                                                    |
| structural `search` / `number` host                                               | vector host/value plus retained cancel/spin overlay when its used state paints                                     |
| `appearance:none`, `base`, `base-select`, listbox                                 | structural route; no sampled native decoration is reopened; a captured base-select picker icon may paint as vector |
| disabled/readonly/rest state whose retained part is hidden/zero-opacity/zero-size | explicit `empty` decoration reservation                                                                            |

The classifier in `src/capture/native-control-decoration.ts` contains no
platform dimensions, colors, or glyph paths. A reservation remains fail-closed:
if materialization fails, `form-controls.ts` still suppresses any renderer
chevron/calendar/clock/cancel/spin substitute and capture emits a named
`native-control-decoration-raster` warning.

## Structural closed-shadow facts

### Viewport selection

For captures with at least sixteen top-frame control hosts, one Chromium
`DOMSnapshot` selects which closed-UA-shadow subtrees need exact pseudo and
value-text probes (DM-A93KQZ). A positive-area host box proven outside the
capture viewport may omit those probes. Snapshot document coordinates are
bound to the DOM agent's main-document backend identity and translated by its
captured scroll offset before selection. Missing or
degenerate bounds, child frames, unavailable snapshot facts, transformed
ancestry, and non-empty `data-domotion-anim` ancestry keep the exact reads.
The latter two match the capture walker's offscreen-subtree retention rules.
The same proof selects anonymous scrollbar and resizer hosts before their
matched-style queries. UA roots owned by media elements are included, because
their closed controls can contain internal range inputs even when no range
input exists in the author DOM. Omitting the optional viewport from the
low-level capture API retains the full-document probe path.

#### 2026-11-09 pass measurements

DM-A93KQZ compared the low-level pseudo-style pass with and without its
viewport argument, replaying the same freshly recorded responses in each arm.
The host was macOS 27.2 arm64 with Node 26.13, Playwright 1.59.1 and Chromium
147.0.7727.15. Both arms used the same instrumentation and the real-world
harness's DOM/WebGL freeze helpers. These are
isolated pass timings, not complete SVG capture or full-scroll runtime claims.
The earlier DM-D5ZFVN report of 24–25 seconds used a different recording and
host state; the fresh Resend baseline here was about 10.4 seconds.

| Cached page    | Scroll Y | Unfiltered pass (ms) | Selected pass (ms) | Matched-style requests, before → after |
| -------------- | -------: | -------------------: | -----------------: | -------------------------------------: |
| Resend desktop |        0 |            10446.665 |           1308.994 |                                 23 → 4 |
| Resend desktop |      800 |            10410.770 |           1330.669 |                                 23 → 4 |
| Resend desktop |    11468 |            10394.679 |           1484.622 |                                 23 → 4 |
| Stripe mobile  |        0 |               95.154 |             90.916 |                                  6 → 3 |
| Stripe mobile  |      844 |               71.630 |             63.822 |                                  6 → 2 |
| Stripe mobile  |    19401 |               75.472 |             67.598 |                                  6 → 2 |

Resend's reduction came from offscreen media-owned UA ranges and anonymous
scrollbar/resizer hosts. Selecting only author-DOM input UA roots left its 23
expensive matched-style requests unchanged and did not materially improve the
pass. Stripe's absolute cost was already small; these samples do not establish
a meaningful Stripe speedup. Snapshot collection cost about 12–28 ms on these
pages. The raw records, profiling source and exact commands are retained in the
ticket's verification evidence. Fresh archive SHA-256 identities:

- Resend desktop: `2a1590f36a1d4d11f260f26afb3f162ff4478ba5be3926e17f6015fe8083575f`
- Stripe mobile: `226a7f6fed6f1106a40505f28cf5bab31752fd1fc6142f3215c7c0e3291cb005`

### Single-line input value geometry

`pseudo-style-cdp.ts` pierces the input's closed UA shadow tree in the same
source frame used for control pseudo capture. It admits only one painted
non-empty text node candidate, one host quad, and one text FragmentItem quad.
A text node whose content quads CDP refuses or returns empty paints nothing and
is not a candidate: this is how a filled input's placeholder looks, because
Blink keeps the `#placeholder` div with inline `display: none`
(`TextControlElement::UpdatePlaceholderVisibility`, `text_control_element.cc:295-307`
at chromium `7d859f27`). Both quads must be finite, positive-area, and
axis-aligned within 0.05 CSS px. The compact record stores the host
width/height, text height, and translation-invariant text-top offset; it does
not store a platform font metric guess.

The synchronous input walker consumes that offset only for a single-line
`input` with the authenticated source tag, finite dimensions, and a current
host width/height matching the recorded box within 0.05 CSS px. That last check
proves the CDP and DOM-walk geometry remained in the same axis-aligned scale.
A uniformly scaled host passes, because both sides see the same transformed
box. Any other outcome omits the authority, and the walker keeps the
line-height/font-box estimate rather than choosing an arbitrary closed-shadow
candidate. Textareas keep their separate measured per-line path.

The estimate is not silent. Capture stores a named rejection on the host, and
the walker emits one `input-value-geometry` capture warning per rejected input
(`closed-shadow value text quad rejected (<reason>); value text top estimated
from line-height and font metrics`). The reasons are:

| Reason                  | Meaning                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `multiple-text-labels`  | More than one painted text node, so no candidate is the editing value.                                 |
| `text-quad-unavailable` | The only text node had no content quads.                                                               |
| `host-quad-unavailable` | CDP refused the host's own content quads.                                                              |
| `non-axis-aligned-quad` | The host or text quad is rotated or skewed, or the text spans more than one quad.                      |
| `host-box-changed`      | The live host box no longer matches the recorded quad (relayout, or a transform the walk neutralized). |
| `invalid-record`        | The stored record is missing a finite dimension or offset.                                             |

Skipped input types (file, temporal, color, range, and the other native-chrome
types) never reach the value walker, so their compound labels do not warn. An
input with no record at all (a capture run without the CDP pass) also stays
silent. The maintainer chose this policy over silent estimation and over a
Chromium raster of every rejected value area (option B of the requirements
audit's closed-shadow question, 2026-11).

This procedure is identical on macOS, Linux, and Windows and contains no
platform constants. DM-2628 ratified the exact-pixel effect on Linux's
`06-deep-field-sizing` fixture, where the old reconstruction placed two labels
0.5 CSS px (one device pixel) too low.

### Base-select picker icon

The form-control walker records the resolved `::picker-icon` `currentColor` for
a closed, non-multiple select whose appearance has not suppressed the pseudo.
For the structural `base-select` route, `form-controls.ts` emits the disclosure
triangle at the logical inline end (LTR or RTL) using that captured color, with
the host color as the CSS inheritance fallback. Missing both colors omits the
path. A native-decoration raster reservation always suppresses this vector, so
native `auto`/`menulist-button` arrows remain exact Chromium pixels and cannot
fall through to a generic glyph. Listboxes and `appearance:none` do not receive
the structural disclosure.

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

- `src/capture/pseudo-style-cdp.test.ts`: accepted host-relative input text
  geometry and rejection of a non-axis-aligned host quad;
- `src/render/form-controls.test.ts`: captured base-select icon color and
  inline-end geometry, plus suppression when native decoration owns the arrow;
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
