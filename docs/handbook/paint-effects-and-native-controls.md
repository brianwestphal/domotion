---
id: "handbook/paint-effects-and-native-controls"
title: "Paint, effects, and native controls handbook"
kind: "contract"
status: "current"
owners: ["paint-effects", "text-fonts"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2596", "DM-2615", "DM-2628", "DM-2634", "DM-TPJX3H", "DM-J2WVF3", "DM-H5DDDE", "DM-09GQAV", "DM-7P69DC", "DM-HZPAYY", "DM-1C56DE"]
code:
  [
    "src/render/element-tree-to-svg.ts",
    "src/render/paint-order.ts",
    "src/render/box-shadow-paint.ts",
    "src/capture/script/walker/document-prepass.ts",
    "tests/capture-selected-shadow-root.e2e.test.ts",
    "tests/box-shadow-border-knockout.e2e.test.ts",
    "tests/box-shadow-native-contour-authority.e2e.test.ts",
    "tests/capture-inset-shadow-root-paint-space.e2e.test.ts",
    "src/capture/inset-root-shadow-context.ts",
    "src/capture/inset-root-shadow-context.test.ts",
    "tests/inset-root-shadow-context.e2e.test.ts",
    "src/capture/input-value-geometry.ts",
    "src/capture/native-control-raster.ts",
    "src/capture/pseudo-style-cdp.test.ts",
    "src/capture/pseudo-style-cdp.ts",
    "src/capture/script/walker/form-controls.ts",
    "src/capture/script/walker/input-value.ts",
    "src/render/form-controls.test.ts",
    "src/render/form-controls.ts",
    "tests/feature-coverage.ts",
  ]
aliases: ["docs/handbook/paint-effects-and-native-controls.md"]
---

# Paint, effects, and native controls handbook

## Contract

1. Paint follows Chromium's background, border, content, decoration, outline,
   stacking, blend, filter, mask, and backdrop order. Geometry is derived from
   captured boxes and source-cited decision procedures, not screenshot tuning.
2. SVG-native gradients, masks, clips, filters, borders, and shadows remain
   vector when semantics are representable. URL resources preserve reference
   identity, units, geometry boxes, and transitive dependencies.
3. Effects needing an isolated source surface or browser-only paint operation
   use an authenticated, bounded raster owned by the corresponding element or
   effect. Transparent or unavailable evidence fails closed.
4. Native controls use Chromium-owned source pixels only when the activation,
   state, geometry, and compositor frame are authenticated. Hand-sampled
   platform palettes and approximate chrome are not fallback behavior.
5. Structural controls retain vector ownership, but their browser-owned layout
   inputs are captured rather than inferred. A single-line input may consume
   Chromium's closed-UA-shadow value-text FragmentItem top only after strict
   quad and same-frame host-size validation. A `base-select` disclosure icon is
   vector structural paint using the captured resolved `::picker-icon` color;
   it is never substituted for a native menulist arrow.
6. A render-side degradation is never silent. Wherever the renderer paints
   something other than Chromium did (an unsupported `clip-path` shape left
   unclipped, a `mask-image` whose resource graph cannot be rewritten, an
   approximated gradient, text replaced by a boundary marker) it calls
   `renderWarn(feature, detail)` (`src/render/render-warn.ts`): one `[domotion]`
   line on stderr plus a `CaptureWarning` on the active render's warning sink.
   `elementTreeToSvg(..., { warnings })` and `composeScrollSvg({ warnings })`
   open a synchronous `withRenderWarningSink` scope so a tree's render warnings
   stay with the caller's array; outside any scope the warning falls back to the
   process-global last-capture buffer that `getLastCaptureWarnings()` and the
   CLI's `--warnings` report. Without that scope, rendering an earlier capture's
   tree after a later capture attributed the warnings to the later one.
   `DemoRecorder` scopes each render (and passes the same array to its async
   remote-image and conic-tile pre-passes) and exposes the result as
   `recorder.getLastCaptureWarnings()`; the CLI pipelines keep the global
   fallback (see doc 01). Renderer
   fallbacks for missing measurements (default font size, fallback ascent) are
   named in `src/render/text-defaults.ts`.

## Verified implementation map

| Area                           | Requirements                                                                                                                                                                                                                                                                                        | Code and tests                                                                                                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gradients/masks/clips          | [Gradient fills](../07-gradient-fills.md), [mask emission](../20-css-mask-emission.md), [generated combinations](../188-generated-svg-effect-combinations.md)                                                                                                                                       | render paint builders and paint geometry oracles                                                                                                                         |
| Paint order and filters        | [Paint order](../132-paint-order-oracle.md), [blend/filter stage](../185-blend-filter-pixel-stage-oracle.md), [backdrop ownership](../195-strict-ordinary-backdrop-ownership.md)                                                                                                                    | paint-order/filter modules and strict browser oracles                                                                                                                    |
| Borders and scrollbars         | [Border phase](../127-border-outline-phase-oracle.md), [cross-platform envelopes](../191-cross-platform-border-phase-envelopes.md), [scrollbars](../165-native-scrollbar-layout-paint-ownership-audit.md)                                                                                           | border/scrollbar oracles and native workflows                                                                                                                            |
| Native and structural controls | [Source-frame rasters](../167-native-control-source-frame-rasters.md), [effective appearance](../170-blink-effective-appearance-routing.md), [closed-shadow geometry/decorations](../171-closed-shadow-control-decorations.md), [fallback retirement](../182-native-control-fallback-retirement.md) | native-control capture/routes plus `input-value-geometry.ts`, the input/form-control walkers, `form-controls.ts`, focused unit tests, and cross-platform E2E/visual jobs |

Every new specialized paint route needs a source decision, an activation
record, a hostile movement control, and platform integration evidence.

## Legacy CSS clip (DM-1C56DE)

Chromium `6b5a1b80` builds a CssClip node only for an out-of-flow box with a
non-`auto` `clip: rect()` (`LayoutObject::HasClip`). Its rect is the border box
with each non-`auto` side moved (`LayoutBox::ClipRect`), pixel-snapped for paint
(`UpdateCssClip`). It clips the box's own paint and every descendant, including
fixed ones it does not contain (`UpdateOutOfFlowContext`). Capture records it as
`legacyClipRect` (`src/capture/script/walker/legacy-clip.ts`). The renderer
clips the owner and re-applies it to hoisted descendants in
`paintWithAncestorWrappers`. Owners under a non-translation transform or zoom
warn (`clip`) and stay unclipped. Controls: `tests/legacy-css-clip.e2e.test.ts`
and the `legacy-css-clip-rect` feature fixture.

## Selected shadow-only roots (DM-TPJX3H)

Root selection must reach an element's existing paint producer even when that
ordinary element has no background, border, direct text, or real children.
An empty 20×20 selected div with `box-shadow:inset 0 0 0 20px red` previously
returned no captured roots, while selecting its transparent container or body
reached the same div and matched Chromium. Root admission now retains source
computed all-inset shadow lists, using the existing shadow parser so comma
separated colors and mixed inset/outset lists are distinguished correctly.
The ordinary no-shadow container flattening and capture's visibility/geometry
pruning remain in force; no source styles or geometry are changed.

Actual Chromium 147 revision `6b5a1b80` `BoxPainterBase` invokes inset shadow
paint independently of an opaque background or painted border. Native full-RGBA
controls cover the original solid inset, inset frame, multiple inset layers,
direct/container/body selection, and retained visibility/geometry pruning.
This is a platform-neutral computed-style admission rule; native macOS was
verified locally, without claiming a Linux/Windows execution that was not run.

DM-J2WVF3 repairs the independently demonstrated existing outset producer:
a transparent box's normal shadow must knock out the original border-box
interior. `BoxPainterBase::ClipToBorderEdge` excludes the border contour before
normal-shadow paint when the source background is nonopaque. The renderer now
retains that exclusion after filtering, with an inverse rounded-rectangle mask
for circular coverage and an even-odd clip for sharp corners. Known opaque or
unknown background facts keep their existing producer path; styled control and
resize/scrollbar callers supply their own source background rather than an
unrelated host color. `display:contents` owns no layout box: its selector keeps
flattening to the real child, and the general producer skips its own shadow.

New outset/mixed shadow-only roots remain unadmitted (DM-09GQAV). The existing
container/body producer has exact native integer-origin controls covering
transparent/semitransparent/opaque backgrounds, one-axis/two-axis source
offsets, positive/negative spread, uniform circular corners, group/shadow
opacity, multiple/inset layering and non-box flattening. Those passing controls
do not authenticate fractional paint-space coverage for new selected roots.
Other independently painted roots still reach their existing producer. Source
positions, radii and shadow offsets remain unchanged.

New blurred outset/mixed roots stay unadmitted pending DM-RRWR8E: an unchanged
producer blur control differs at843 pixels, including400 wrong interior pixels
and443 outer sampling pixels. Border knockout fixes the400 interior pixels;
the outer443 remain byte-identical to the old output (max alpha difference7).
That is not full blur parity or a universal raster floor. Elliptical/unequal or
other unauthenticated corner contours remain unadmitted under DM-H5DDDE; strict
probe assertions are retained outside ordinary test discovery. Source-only
fragmented clone/slice shadow ownership remains an investigation (DM-4RGP8Y),
not a native defect inferred from the ordinary-box controls.

DM-H49Z50 and DM-HZPAYY own
separate proved outline-only and pseudo-only root admission defects. These
boundaries are explicit follow-ups, not evidence that all own-paint roots are
already supported.

### Contour authority investigation (DM-H5DDDE)

The [native contour investigation](../277-shadow-contour-authority.md) retains
source geometry, full-RGBA measurements and strict unresolved producer probes.
The repaired knockout does not establish elliptical/unequal contour parity,
subpixel paint-space authority or a universal raster floor. DM-ZNQ7PH,
DM-WYY3ZZ, DM-5KSA83 and DM-TFN8RD own those remaining producer gaps.
DM-09GQAV omits the native-empty coincident normal shadow; it does not change
positive-inset production. Root admission remains separately guarded below.

### Fractional inset admission boundary (DM-7P69DC)

New shadow-only inset roots require an integral border rectangle and an
unambiguous ordinary HTML paint space. A single root fragment is required;
root bounds retain their captured values. Fractional origins or sizes refuse
this admission rather than round DOM geometry. Ancestor origins must also be
integral, and transforms (including identity authored transforms and independent
translate/rotate/scale), perspective, motion paths, non-unit zoom, filters,
sticky positioning and prospective `will-change` paint spaces remain outside
this new admission. Shadow-host ancestry is checked as well as ordinary DOM
parents. Independently painted/content roots keep their existing route, and
unsupported transparent hosts still flatten to their painted children.

Page DOM ancestry alone is insufficient: open and closed slotted author trees
can hide the same0.5px transform, with the closed case exposing neither
`assignedSlot` nor `shadowRoot`. Candidate-only public CDP reads the complete
pierced document, including empty closed hosts. Its private fact binds the
actual selected Element, owner Document and context; author-host chains,
missing/unknown provenance or element replacement refuse the new route.
Preparation/disposal use Node-owned bounds and retain late-session/key cleanup.
The fact describes its source prepass, not arbitrary live-JS atomicity, and is
not an authority for unrelated raster owners or foreign-paint isolation.

This is an eligibility boundary, not an inset producer repair. Native Chromium
147 evidence at a 20.5px margin, 20×20 box and `inset 0 0 0 3px red` differs by
136 full-RGBA pixels (max alpha192) for sharp corners and148 (max181) for
radius5. A fractional20.5px size at integer origin differs70 (max192).
Local20.5px positioning followed by an own or ancestor0.5px translation gives
integer viewport bounds `(21,21,20,20)` but still differs134 pixels (max255).
Therefore viewport-integral bounds alone cannot authorize the shadow path.
Ordinary integral sharp/rounded controls remain byte-exact. Source DOM values
and the existing container renderer remain unchanged, including its measured
preexisting failure; no broad rendering correctness claim follows from refusal.

The exact upstream source is Chromium
`6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`:
`BoxPainterBase::PaintInsetBoxShadowWithBorderRect` calls
`PixelSnappedContouredInnerBorder`, which delegates to
`ContouredBorderGeometry::PixelSnappedContouredBorderWithOutsets` (lines207–254
in `core/paint/contoured_border_geometry.cc`). It rounds the local physical
origin and snaps size allowing zero before deriving rounded-border radii.
Capture's layout rectangle does not provide that separate paint-space basis.
DM-8N1VB2 tracks obtaining authenticated inset paint geometry and repairing the
producer; the related normal-shadow paint rectangle has its own measured record
under DM-WYY3ZZ. These are distinct from this selected-root eligibility guard.
Native verification here is macOS evidence; Linux/Windows execution is not
implied by the platform-neutral Blink rule.

### Selected generated-pseudo-only roots (DM-HZPAYY)

A selected ordinary root whose only paint is a `::before`/`::after` box or
text, such as an empty 20×20 div with a red block `::before`, previously
returned no roots and lost all 400 native pixels. Selecting its container
reached the same pseudo and matched exactly. Root admission now also retains a
root whose source-owned native pseudo record (`blink-pseudo-fragment-v1`)
reports a fragment that is not `unpainted` and whose computed visibility is
`visible`. Computed `content` and stacking heuristics are not consulted, so
hidden and `content: none` pseudos still admit nothing. The admitted root then
takes the ordinary `capture(root)` path, which paints the record exactly as
when an ancestor is selected (`tests/capture-selected-pseudo-root.e2e.test.ts`).


## Structural form-control failure boundaries

- Input value geometry is retained only for one non-empty closed-shadow text
  candidate and one finite, positive-area, axis-aligned host/text quad pair.
  The live DOM walk consumes its host-relative top only when the recorded and
  current host dimensions agree within 0.05 CSS px. Compound controls,
  ambiguous candidates, rotation/skew, invalid geometry, or a changed scale do
  not acquire this authority; old captures and rejected records keep the
  documented metric-based compatibility path.
- Closed single-selects capture the resolved `::picker-icon` color. The renderer
  emits the structural disclosure path at the logical inline end only when the
  control has no native-decoration raster reservation. Missing icon and host
  colors omit the vector. Native `auto`/`menulist-button` arrows remain narrow
  Chromium-owned raster overlays and can never fall through to this path.
- Both decisions are platform-neutral Blink/CDP procedures and contain no
  macOS, Linux, or Windows font, palette, or glyph table. The capture contract
  applies on all three platforms; DM-2628's exact visual ratification was the
  Linux `06-deep-field-sizing` fixture that exposed the half-pixel estimate.
