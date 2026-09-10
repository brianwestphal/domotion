---
id: "requirements/authenticated-paged-page-svg"
title: "Authenticated per-page SVG rendering"
kind: "contract"
status: "current"
owners: ["layout", "render"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2711"]
code: ["src/render/paged-page-svg.ts", "src/render/paged-page-svg.test.ts", "src/capture/script/walker/collapsed-border.ts", "src/capture/paged-page-record.ts"]
aliases: ["docs/257-authenticated-paged-page-svg.md", "doc-257"]
---

# Authenticated per-page SVG rendering

## Requirements

`renderAuthenticatedPagedSvgPages` accepts only a validated authenticated page
record and returns exactly one result for each selected physical page. It
preserves the native SVG byte-for-byte, original document page index, separate
consecutive selection index, page name, empty classification, dimensions, and
SVG digest. The current live capture API intentionally requests every physical
page; it does not yet expose sparse page ranges or write assets to disk. The
page-record digest is an integrity digest for one authenticated transaction and
therefore includes capture-specific identity; only the SVG digest is expected
to match across repeated identical captures with the same helper runtime and
resolved resources. The reviewed smoke uses a repository-pinned font.

The native SVG is the sole paint authority. For every collapsed table
occurrence, the private record carries a complete source-resolved
`resolvedCollapsedEdgeGrid` in addition to that page occurrence's
`collapsedEdges` paint/disposition ledger. Dependency edges are never labeled
as painted. The renderer reconstructs the full grid from `sourceEdgeIndex`,
converts `LayoutUnit` values to raw 1/64 units, and calls
`collapsedBorderFragmentLogicalRects`. This preserves off-page neighbors that
still decide a painted edge's joint geometry. It checks logical painted-edge
order, fragment-boundary omissions, and recomputed start/end joint winners. The
resulting digest is a logical consistency fingerprint, not a claim that native
pixel-snapped border rectangles were independently serialized. Captions, zoom,
direction, vertical writing, repeated sections, spans, and break state remain
authenticated record inputs; this replay does not independently re-prove all
of them. It is an audit only and is never overpainted onto the SVG.

The function fails closed on unavailable records, validation errors, external
references, invalid canvas dimensions, missing logical pages, an incomplete or
misordered resolved edge grid, bad source-edge indices, or a native/logical
paint-order mismatch. PDF conversion is a later
consumer of the emitted SVGs and never supplies geometry or paint facts.
