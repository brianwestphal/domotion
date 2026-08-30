---
id: "requirements/fixed-backdrop-paint-order"
title: "Fixed backdrop paint order (DM-2489)"
kind: "contract"
status: "current"
owners: ["paint-effects"]
platforms: []
tickets: ["DM-2487","DM-2488","DM-2489","DM-2490"]
code: ["tools/backdrop-source-surface-audit.ts"]
aliases: ["docs/192-fixed-backdrop-paint-order.md","doc-192"]
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
