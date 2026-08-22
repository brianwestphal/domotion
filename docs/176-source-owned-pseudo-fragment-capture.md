# 176 — Source-owned generated-pseudo fragment capture

**Ticket:** DM-2467
**Status:** production capture complete; DM-2468 direct record rendering and native gate are complete (doc 178)
**Source pins:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`,
HarfBuzz `4de187dd0a915d13c976fa8bd474c084229f3aab`, and Chromium-pinned
Skia `62efacd37737505732dbe3d8daa62abd679626a1`
## Outcome

Live `::before`, `::after`, and checkable `::checkmark` capture no longer obtains normal-path geometry
from a detached clone, host first/last text anchors, font-size half-leading, or
the old bottom-gap wrap threshold. `src/capture/pseudo-fragment-cdp.ts` now
discovers the real Blink pseudo backend nodes and installs immutable
`CapturedPseudoFragmentSet` records into a private per-frame registry before
the synchronous DOM walk.

Each exact record retains:

- the ordered anonymous text/image content items and their item-local UTF-16
  slices;
- DOMSnapshot visual order and fragmentainer-local rectangles;
- ordered physical `DOM.getContentQuads` planes and their fragmentainer
  translations;
- shaped inline advances, primary-font ascent/descent, selected platform face
  observations, writing mode, direction, and the exact physical baseline
  segment;
- computed typography and pseudo-owned paint; and
- physical margin/border/padding dimensions, logical edge ownership, and
  `box-decoration-break` mode for every box fragment.

The serialized record deliberately contains no correlation id or temporary DOM
attribute. The host identity is the containing `CapturedElement`; the pseudo
identity is `::checkmark`, `::before`, or `::after` on the record.

DM-2459 extends the same real-node/CDP decoder to Blink's generated checkmark.
Capture queries it before `::before`, matching Blink's pseudo attachment order.
An explicit empty `pseudoFragments: []` is retained as authoritative absence;
only `undefined` denotes a pre-contract serialized tree.

## Capture boundary

For each accessible frame, capture retains the selected root and descendants
in a private `globalThis` registry with a `WeakMap<Element, index>`. It reads
computed pseudo activation and style in that frame, then uses the registry's
default Runtime context to resolve each host. `DOM.describeNode` supplies the
real `checkmark`/`before`/`after` pseudo identity. One paused-layout
`DOMSnapshot.captureSnapshot` call covers all frame documents in the epoch;
there is never one snapshot per pseudo.

The production decoder lives at
`src/capture/pseudo-fragment-protocol.ts`. The diagnostic import at
`tools/pseudo-fragment-protocol.ts` is only a compatibility re-export, so the
DM-2466 oracle and production execute the same source transcription.
Snapshot-local anonymous rows are grouped in protocol visual order and paired
one-for-one with ordered physical content quads. A transformed row retains the
full four-corner map. A fragmented row retains both local coordinates and its
physical column/page translation. Text offsets are sliced as JavaScript UTF-16
units and restart for each anonymous text content item; an anonymous generated
image remains a separate item between surrounding text rows.

Chromium canvas measurement supplies an independent shaped advance at the
computed effective zoom. `CSS.getPlatformFontsForNode` records every selected
face and glyph count on text-bearing pseudos. The baseline decoder follows the
pinned `TextFragmentPainter`/`LineRelativeRect` transforms:

- horizontal text starts at `left, top + primary ascent` and advances right;
- vertical-rl, vertical-lr, and sideways-rl start at
  `right - primary ascent, top` and advance down; and
- sideways-lr starts at `left + primary ascent, bottom` and advances up.

No line-height/font-size fit or host baseline participates in that decision.

## Failure ownership

An unavailable CDP session, uncorrelatable pseudo identity, invalid protocol
geometry, or snapshot/quad cardinality mismatch does not reactivate the legacy
clone path. Capture hides ordinary page paint without changing layout, makes
only the target pseudo visible, takes one transparent Chromium screenshot,
alpha-crops it, restores every frame and marker, and emits one
`status: "terminal-raster"` record plus a structured
`generated-pseudo-fragment-geometry` warning. A real pseudo with no observable
layout remains an explicit `unpainted` record.

The isolation stylesheet is temporary and frame-aware. Ancestor iframe chains
remain visible with their background/border/shadow paint neutralized; the
target pseudo alone overrides inherited hidden visibility. Cleanup runs in a
`finally` block, and focused tests assert that neither target nor ancestor
attributes survive.

## Legacy boundary and downstream ownership

`src/capture/script/index.ts` checks for a source-owned record before invoking
`capturePseudoContent` or `injectPseudoSegments`. Thus new live captures never
use the clone/host-anchor result as geometry authority.

DM-2468 removed the transitional `pseudo-fragment-compat.ts` projection. New
captures leave legacy `textSegments`, `pseudoImages`, and `pseudoBoxes`
unpopulated and `src/render/pseudo-fragments.ts` consumes the source-owned
record directly. Older serialized trees that contain only legacy fields remain
readable through the existing old-tree renderer paths. Direct paint ordering
and the macOS/Linux/Windows visual gate are documented in doc 178.

## Evidence

The production matrix exercises before/after, content absence, empty and text
content, mixed text/image/text, item-local astral UTF-16 spans, mixed bidi,
horizontal/vertical/sideways writing transforms, line-height and font changes,
asymmetric logical edges, slice/clone decoration, zoom, affine transforms,
wrapping, multicol fragmentation, child-first/child-only hosts, same-origin
iframes, and forced protocol failure.

Fresh focused results on macOS/Chromium 147:

```text
DM-2466 structural oracle: 80/80 live DPR rows; 10/10 mutations rejected
protocol + renderer units: green
production CDP exact/fail-closed rows: 2/2
full capture + same-origin-frame route: 1/1
TypeScript: clean
```

The forced-unavailable row requires a non-empty alpha-bearing isolated raster,
an empty vector-fragment array, one warning, and no leaked attributes. The
full-capture row requires two exact host records, an exact nested-frame record,
selected pseudo style/font facts, and source-record-only serialization with no
legacy fields repopulated. Direct rendered pixels and cross-platform promotion
are supplied by DM-2468/doc 178.
