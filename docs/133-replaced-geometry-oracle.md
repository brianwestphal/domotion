---
id: "requirements/replaced-geometry-oracle"
title: "133 — Replaced elements, controls, and generated-content ownership gate"
kind: "evidence"
status: "current"
owners: ["images-media","layout","platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2364","DM-2380"]
code: [".github/workflows/replaced-ownership-transitions.yml","tools/replaced-ownership-transition-gate.ts"]
aliases: ["docs/133-replaced-geometry-oracle.md","doc-133"]
---

# 133 — Replaced elements, controls, and generated-content ownership gate

`npm run replaced:geometry-oracle` is the focused DPR-1 live-Chromium gate.
`npm run replaced:ownership-gate` is its hard DPR-1/2 release form. DM-2364
replaces the old 11-row sampler with 42 source-owned rows per DPR and a pure,
mutation-tested adjudicator.

## Source decisions

At Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`,
`LayoutReplaced::ComputeObjectFitAndPositionRect` begins with the physical
content box, chooses the concrete object size for `fill`, `contain`, `cover`,
`none`, or `scale-down`, then resolves object-position against remaining free
space. `LayoutImage::UpdateNaturalSizeIfNeeded` passes
`StyleRef().EffectiveZoom()` to `GetNaturalDimensions`. The latter detail is
observable: an intrinsic 80×40 image at `zoom:1.25` paints a 100×50 `none`
object, not an 80×40 object inside a zoomed box.

Capture therefore stores unzoomed `imageIntrinsic` plus
`imageEffectiveZoom`. Rendering multiplies only the concrete object-fit input;
the source SVG coordinate system remains unzoomed. Serialized trees predating
this fact default to one. No platform constant or fixture lookup participates.

Control ownership follows `LayoutTheme::AdjustAppearanceWithAuthorStyle` and
`ThemePainter`'s `EffectiveAppearance` dispatch. Whole native hosts reserve a
Chromium surface, authored structural controls stay vector, authored selects
split at the menulist-button decoration, and appearance-base checkmarks use
the source-owned generated-pseudo route. The gate records final raster SHA,
effective appearance, decoration kind, pseudo status, color scheme, accent,
writing mode, direction, zoom, and transform facts rather than assuming that
macOS, Linux, and Windows share pixels.

Generated boxes no longer read the retired `pseudoBoxes` approximation. Their
geometry is the union of exact `CapturedPseudoFragmentSet.boxFragments`
created from one DOMSnapshot epoch plus real pseudo content quads. Source ink
bounds use connected, anti-aliased color coverage; tolerance remains at most
one device pixel.

## Matrix and fail-closed rules

Every DPR run contains paired evidence for:

- all object-fit modes, arbitrary/calc positions, landscape→portrait intrinsic
  changes, effective zoom, fractional boxes, RTL, and vertical writing;
- loaded→loading→failed images and the resulting vector versus Blink
  broken-fallback ownership;
- two captured canvas frames and two video poster frames inside zoomed,
  vertical, nested-affine geometry, requiring the source PNG SHA to change;
- checkbox, radio, button, select, progress, and meter native→author ownership,
  plus appearance none/base, accent, color scheme, zoom, DPR, and vertical RTL;
- positioned before/after, in-flow, vertical RTL, and nested-affine generated
  boxes through authoritative pseudo fragments.

`tools/replaced-ownership-transition-gate.ts` rejects a missing family or pair,
duplicate role, wrong owner, partial/inferred capture, source warning, inert
mutation, absent decision facts, invalid platform fingerprint, or geometry
error over one device pixel. The producer records Chromium, Playwright, OS,
architecture, OS release, launch arguments, DPR/media state, exact pinned
source revisions, and a canonical SHA-256 of that environment.

`.github/workflows/replaced-ownership-transitions.yml` runs the pure mutations
and live DPR-1/2 matrix independently on macOS, Linux, and Windows, records the
runner image identity, and uploads each platform-local JSON report. Reports are
never compared to a cross-platform native-control bitmap baseline.

## Boundaries

The gate proves ownership activation, exact capture records, object geometry,
and same-run state discrimination. It deliberately freezes canvas/video at the
capture frame; live playback remains outside SVG. Dedicated gates still own
final transformed-snapshot pixels (doc 17/DM-2380), generated glyph ink and
paint slots (docs 157/176/178), broken-image icon/text/AX output (doc 156), and
native source-frame materialization/isolation (docs 167/170/171/172/182).
