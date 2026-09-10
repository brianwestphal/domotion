---
id: "requirements/paged-page-print-record"
title: "Authenticated paged page print records"
kind: "contract"
status: "current"
owners: ["layout", "capture"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2710"]
code: ["src/capture/paged-page-record.ts", "src/capture/paged-page-record.test.ts", "tools/chromium-paged-page-record/renderer-page-record.patch", "tools/verify-paged-page-record-patch.mjs", "tools/paged-page-record-smoke.mjs"]
aliases: ["docs/256-paged-page-print-record.md", "doc-256"]
---

# Authenticated paged page print records

## Decision

Paged SVG capture uses a versioned, hard-bounded record produced once per
physical page by the authenticated Chromium helper. A page is promotable only
when the record contains both its source-owned physical-fragment geometry and
its complete ordered paint stream. PDF operators, screenshots, and raster
pixels are never inputs.

The helper captures inside `ChromePrintContext::SpoolPage`, after
`LocalFrameView::PrintPage` has selected the page, updated the print lifecycle,
installed the page content transform and clip, and painted. It captures the
finalized inner `PaintRecord` before that same record is consumed by the outer
print canvas. The older DM-2573 hook immediately after
`PrintBegin` remains valid for its table-layout experiment, but is too early to
authenticate final per-page paint.

## Chromium ownership

The contract is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the following source owners:

- `web_local_frame_impl.cc:359-501` owns page spooling and the live inner
  `PaintRecordBuilder`.
- `local_frame_view.cc:4243-4285` selects the page and paints outside the normal
  lifecycle after the print update.
- `pagination_utils.h:32-101` owns page container, border box, page area,
  stitched content rect, description, and target scale geometry.
- `PhysicalBoxFragment::PostLayoutChildren()` and `FragmentItems` own final box,
  line, text, generated-content, and repeated-fragment occurrences. Raw
  `Children()` is not a sufficient general traversal.
- Blink `PaintArtifact` owns display-item ordering and paint chunks; each
  chunk's transform, clip, and effect property state participates in the page
  result.
- Each drawing display item's `cc::PaintRecord` owns the actual ordered Skia
  operations. Debug `ToJSON()` and `LoggingCanvas` output are diagnostics, not
  this release contract: they omit stable ownership and essential glyph/image
  details.

No new shaping or rasterization decision is made here. Glyph IDs and positions
are the result already chosen by Chromium's pinned HarfBuzz route, and the
allowed drawing commands are the result already chosen by Chromium's pinned
Skia route. The record embeds the exact font or image bytes referenced by an
accepted command and authenticates them with SHA-256.

## Record boundary

An authenticated record contains:

- frame, document, loader, print epoch, print-parameter digest, and layout
  generation identities;
- page area, border box, content area, stitched content rect, content clip,
  page transform, target scale, device scale, page name, writing mode, and
  direction;
- preorder physical occurrence records with parent, page-local transform,
  border box, overflow clip, effective zoom, break token, stable DOM backend
  node or synthetic page identity, pseudo/generated role, and paint clients;
- complete transform, clip, and effect property trees referenced by ordered
  paint chunks, plus globally consecutive display-item order and each item's
  range in the flattened Skia operation stream;
- a recursively preflighted replay of that stream through Skia's SVG canvas,
  with text converted to paths, images embedded, and a digest and ordered
  operation-type ledger covering the exact source record;
- table/section/row/cell/caption occurrence rectangles cross-referenced to the
  physical fragment stream; and
- the complete DM-2573 collapsed-table record for global edge winners,
  repeated sections, spanning-cell interiors, whole-row half edges, continued
  row omissions, and joint precedence.

Selected-page indices are consecutive while document page indices remain
strictly increasing, so sparse ranges never relabel source pages. Geometry is
canonical Blink `LayoutUnit` at 1/64 CSS px. Matrix coefficients,
target scale, device scale, and opacity must be finite. Page, chunk, display
item, fragment, and occurrence indices are consecutive and deterministic.
Page-area offsets come from the page-container → border-box → area fragment
links; page pseudo fragments are not CSS boxes and must never be queried with
`OffsetFromOwnerLayoutBox()`. Table-part records carry both their DOM source
index and their physical-fragment occurrence index, including rows and
captions, so repeated and continued boxes remain distinguishable.

## Closed paint preflight

Version 1 does not attempt to restate Skia's full `PaintFlags`, shader, glyph,
image, and nested-record semantics in a reduced JSON vocabulary. The helper
recursively preflights the authoritative `cc::PaintRecord`, then replays that
same record into `SkSVGCanvas` with text converted to outlines. The resulting
SVG is itself the lossless page paint payload; its source-op order and
display-item ranges remain separately auditable.

The preflight rejects any construct for which the pinned SVG device can omit,
rasterize, or approximate source paint, including perspective, vertices/mesh,
inverse paths, unsupported clips/shaders/filters/color glyphs/images, foreign
surfaces, native theme painting, and remote-frame layers. Adding one requires a
new source test and exact SVG-device path before extending the allowlist; an
unknown operation cannot be skipped or inferred from final pixels.

## Completeness and fail-closed behavior

Geometry and paint cross-authenticate each other. Every fragment-declared paint
client must occur in the ordered page stream, every display-item fragment
reference must resolve to that page, property-tree references must resolve, and
table geometry must resolve to both the general fragment stream and the
DM-2573 logical table stream. Different page identity, count, name, empty state,
layout generation, or print parameters rejects the whole capture.

The encoded sidecar is limited to 64 MiB before it crosses the protocol. The
helper returns a typed unavailable record for an unsupported paint operation,
foreign content, size overflow, lifecycle mutation, incomplete geometry, or
invalid record. It reports the failing page and sorted unique unsupported
operation names but exposes no partially authenticated page. The public API
must preserve that status and must not attempt ordinary Chromium, PDF, or
screenshot fallback.

## Verification

`src/capture/paged-page-record.test.ts` proves acceptance of a complete minimal
page and rejection of an early lifecycle capture, unknown operation, missing
font resource, broken fragment/display ownership, over-bound payload, and
non-`LayoutUnit` geometry. Native patch review additionally checks that capture
runs at the live page-spool boundary and that default `Page.printToPDF` behavior
is unchanged unless the authenticated sidecar option is enabled.
