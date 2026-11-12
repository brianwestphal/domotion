---
id: "requirements/fixed-backdrop-paint-order"
title: "Fixed backdrop paint order (DM-2489)"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: []
tickets: ["DM-2487", "DM-2488", "DM-2489", "DM-2490", "DM-RN0T12"]
code: ["tools/backdrop-source-surface-audit.ts", "src/render/stacking.ts", "src/render/paint-order.ts"]
aliases: ["docs/192-fixed-backdrop-paint-order.md", "doc-192"]
---

# Fixed backdrop paint order (DM-2489)

## Source boundary

Chromium `7d859f271cbda744098ac69f44978d4edfa62be3` is authoritative. Blink gives
an active backdrop its own effect node, while CSS stacking order remains the
order defined by the enclosing stacking context. A `data-domotion-anim`
attribute is only Domotion correlation metadata and cannot create a Blink
stacking context. Likewise, positioned `z-index:auto` plus overflow clipping
does not become an atomic Blink stacking context; the clip applies to the
owner's paint, while viewport-fixed descendants escape unless a real fixed
containing block traps them. Skia's pinned `internalSaveLayer` backdrop input
remains the prior parent device described in doc 187.

The renderer previously made both metadata-only animation owners and every
positioned overflow owner atomic. Its separate viewport-fixed pass then
appended the backdrop target after that group, placing it above a later
positioned sibling. The fix makes animation atomicity conditional on actual
`animatedProperties` and treats positioned `z-index:auto` overflow owners as
overflow-only pass-through contexts. Explicit z-index, transforms, filters,
containment, opacity and real animation tracks remain atomic; transformed
fixed-containing-block behavior is unchanged.

## Fixed boxes inside genuine stacking contexts (DM-RN0T12)

A viewport-fixed box escapes overflow clips whose owner is not its containing
block, but it still paints in its nearest ancestor stacking context. That
context's opacity, `mix-blend-mode`, `clip-path` and mask apply to it, and its
`z-index` bounds the box's order against the context's siblings. The
viewport-fixed pass used to stop only at fixed containing blocks, so it hoisted
the box to the document root past every such context. Native probes showed it
losing a single or nested `opacity: .5`, a `multiply` blend and an
`inset(0)` clip-path, and painting a `z-index: 1000` box above a `z-index: 2`
sibling of its `z-index: 1` wrapper.

The pass now also stops at a genuine (not overflow-only) stacking context
(`trapsFixedDescendants` in `src/render/stacking.ts`). That context's own
gather hoists the box and already skips overflow-only clips for fixed boxes.
The context's own overflow clip is escaped by closing and reopening the
innermost open clip groups around the box. When a fixed box in the context's
plan escapes it, the context's border-box overflow clip moves to its own
innermost group so it can be closed the same way, while the context's own text
stays clipped. The cursor hit-test (`src/render/paint-order.ts`) mirrors this:
a fixed box keeps only its containing block's clips. One limitation remains
(DM-X4W03B): a clip cannot be escaped when a nested stacking context's effect
group is open inside it. `tests/fixed-effect-ownership.e2e.test.ts` holds the
native pixel controls.

## Evidence

- Focused renderer controls prove raster -> retained target vector -> later
  sibling order and keep real transform/opacity animation subtrees atomic.
- The independent `DOMSnapshot.captureSnapshot(includePaintOrder:true)`
  comparator in `tools/backdrop-source-surface-audit.ts` now agrees with the
  SVG planner for the fixed row at DPR 1 and 2.
- The fixed case changed-pixel fraction fell from 14.76% / 14.62% to 0.45% /
  0.22% at DPR 1 / 2 without changing tolerance. Both destructive raster
  ownership mutations remain discriminating.

This closes only fixed/hoisted sibling ordering. Ancestor effect-space,
generated-pseudo ownership, and warning adjudication remain owned by
DM-2487, DM-2488 and DM-2490 respectively.
