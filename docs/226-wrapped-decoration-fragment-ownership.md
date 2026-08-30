---
id: "requirements/wrapped-decoration-fragment-ownership"
title: "Wrapped text-decoration fragment ownership"
kind: "contract"
status: "current"
owners: ["text-fonts","layout"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2527"]
code: ["tools/wrapped-decoration-fragment-oracle.ts"]
aliases: ["docs/226-wrapped-decoration-fragment-ownership.md","doc-226"]
---

# Wrapped text-decoration fragment ownership

DM-2527 replaces the last merged-line input in decoration propagation with a
line-local logical record. It changes no raster tolerance: the existing 0.3px
decoration geometry contract remains authoritative.

## Source decision

Pinned Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`
rebuilds `InlinePaintContext::DecoratingBoxes()` on every line. Its
`DecorationBoxSynchronizer` finds the relevant `FragmentItem` (including a
culled inline's first fragment on the current line), pushes ancestors first,
and stores that fragment's `ContentOffsetInContainerFragment`, exact `UsedFont`
and applied-decoration vector in `DecoratingBox`. `TextDecorationInfo` then
computes `offset_from_decorating_box` from that physical fragment offset.

The relevant files are:

- `core/paint/inline_paint_context.cc:187-258,275-302`;
- `core/paint/decorating_box.h:20-61`;
- `core/paint/text_decoration_info.cc:248-250,325-335`;
- `core/paint/decoration_line_painter.cc:181-212,288-345` for the wave phase.

Therefore a union rectangle, DOM-order continuation, or rounded list of line
baselines cannot authenticate Blink ownership. Each captured text fragment now
produces an ordered `blink-decorating-box-fragment-v1` record with writing mode,
direction, line-relative inline interval, line-over offset, exact baseline,
used-font ascent/descent and an explicit zero continuation phase. Rendering
joins by line identity and inline overlap; equal candidates fail closed. Older
captures and wrappers without a direct text witness retain the legacy baseline
fallback instead of inventing a fragment.

## Gate

`tools/wrapped-decoration-fragment-oracle.ts` has eight exact logical rows:
wrapped and same-line bidi horizontal fragments plus `vertical-rl` and
`vertical-lr`, each at declared DPR 1 and 4. Six destructive controls merge
lines, substitute decorator metrics, carry phase across a continuation, drop a
fragment, collapse bidi ownership, and swap the writing axis. The native
workflow runs the same pixel-free record on macOS, Linux and Windows. It neither
captures nor compares screenshots and cannot authorize a geometry-envelope
change.

The adjacent headless Chromium test additionally compares capture's ordered
decoration-only `inlineFragments` against the browser's live `getClientRects()`
for horizontal and vertical wrapping at DPR 1 and 4. It authenticates the
record input without using screenshots or grading consumer rasterization.
