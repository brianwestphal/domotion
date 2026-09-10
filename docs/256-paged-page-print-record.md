---
id: "requirements/paged-page-print-record"
title: "Authenticated paged page print records"
kind: "contract"
status: "current"
owners: ["layout", "capture"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2710", "DM-2711"]
code: ["src/capture/paged-page-record.ts", "src/capture/paged-page-record.test.ts", "tools/chromium-paged-page-record/renderer-page-record.patch", "tools/chromium-paged-page-record/skia-deterministic-svg.patch", "tools/verify-paged-page-record-patch.mjs", "tools/paged-page-record-smoke.mjs"]
aliases: ["docs/256-paged-page-print-record.md", "doc-256"]
---

# Authenticated paged page print records

## Decision

The separately distributed Chromium helper records the final wrapper
`cc::PaintRecord` for each selected physical page in
`ChromePrintContext::SpoolSinglePage`, after `SpoolPage` has installed the
scroll correction, page transform, clip, and page paint and before that same
record is consumed by the print canvas. The helper replays that record through
the pinned Skia SVG device. PDF and screenshots are downstream evidence only.

The record deliberately does not claim to serialize Blink `PaintArtifact`
property trees, paint chunks, display-item ranges, font files, or image files.
The producer-owned facts are the physical fragment occurrence stream, final
wrapper paint record, source operation ledger, and exact SVG bytes. Any future
expanded vocabulary requires a new ABI.
`sourcePaintOpTypes` is the native ordered ledger; its exposed count is a
derived convenience value, not an additional producer fact.

## Transaction and runtime authentication

An authenticated promotion binds both native response sidecars from one
`Page.printToPDF` transaction. A renderer-generated UUID is carried as
`printCaptureId` in both sidecars. Promotion additionally requires exact
frame/document tokens and URL, stable pre/post loader and URL, normalized print
parameter SHA-256, requested source page indices, response browser/renderer
PIDs, exact restoration of the bounded observed print-layout state, and an
authenticated helper manifest/process image. This is deliberately not a claim
to snapshot closed shadow roots, canvas pixels, media decoders, or arbitrary
application state. ABI v1 rejects any child frame: it binds and fingerprints
only the top document, so it cannot authenticate local-frame paint.

The helper manifest declares `paged-page-svg-v1` and pins both retained deltas:
the cumulative Chromium patch and the nested Skia deterministic-clip-ID patch.
`displayHeaderFooter` is false because browser header/footer paint is added
outside the captured Blink page wrapper. Stock Chromium or the historical
DM-2573-only table patch cannot authenticate this record.

## Record contents

Each authenticated page carries its consecutive selection index and original
strictly increasing document page index; page container, border box, page
area, stitched content rect, target scale, name, and empty-page classification;
preorder post-layout fragments and inline items; source and occurrence indices
for tables, sections, rows, cells, and captions; break-token state, writing
mode, direction, zoom, and DOM backend identity; and the exact self-contained
SVG plus its byte length, SHA-256, and recursive paint-op ledger.

Fragment and inline-item geometry is serialized as native local offsets and
sizes with an explicit coordinate domain for each parent/local relationship.
No synthesized absolute fragment rectangles are promoted. Page-container,
border-box, and page-area rectangles are expressed in page-container target CSS
pixels. `pageRect` is the integer-enclosed, scroll-adjusted layout-space paint
cull rectangle passed to page spooling; the stitched content rectangle also
remains in layout CSS pixels. Collapsed
border logical rectangles additionally retain raw Blink `LayoutUnit` integers
at 1/64 CSS px. Skia rounds the SVG device bounds outward to integer pixels;
root width, height, and viewBox must equal that outward-rounded page-container
extent. Page-area offsets come from fragment links, not
`OffsetFromOwnerLayoutBox()` on anonymous page pseudo fragments.
Occurrence indices are table-owned. Generic boxes retain DOM identity when
available, while `breakToken` describes the fragment's outgoing token; the
record does not claim incoming-token or repeated-fixed-box provenance.
Authenticated collapsed-table replay currently requires non-anonymous,
light-DOM table parts with nonnegative source and physical-occurrence indices;
shadow-tree or generated anonymous tables fail closed instead of being
cross-linked by an invented identity.
The legacy `emptyKind` names classify an empty page-area flow by position
(`forced-blank` for nonterminal and `terminal-empty` for final); they do not
assert that page backgrounds, borders, or margin boxes produce no paint.

## Closed paint boundary

The native preflight is reject-by-default. It recursively inspects nested
records and admits only explicitly listed 2D path/shape/text/state operations
that the pinned Skia SVG device can serialize as a deterministic vector scene.
It rejects foreign display items before PaintArtifact flattening; annotations,
images, shaders, path effects, loopers, filters, non-`src-over` blending,
layers, perspective, inverse paths, complex clips, meshes, scrolling-content,
Skottie, slugs, RSXform-positioned text, and color-glyph typefaces. Unsupported
input makes the whole record unavailable and emits no authenticated page
subset. The SVG is not claimed to be a pixel-identical serialization of native
rasterization: Skia owns vector color conversion, antialiasing semantics, and
curve encoding.

Collapsed-table occurrences carry both a complete source-resolved edge grid
for joint dependencies and a separate page-local paint/disposition ledger.
This prevents an off-page neighbor from disappearing during exact logical
replay without claiming that dependency edge painted on the current page.

Skia text is converted to paths. SVG clip resource IDs use an output-local
counter because Skia's process-global clip generation IDs are not deterministic
across repeated captures. The renderer returns the authenticated SVG bytes
unchanged and uses collapsed-table geometry only as a logical audit oracle; it
does not repaint borders over native output.

## Bounds and failure

Each SVG stream stops accepting bytes at 8 MiB. Table extraction has a
conservative 10,000-unit producer work cap (including the one-pass source and
fragment-occurrence index); the Blink accumulator stops retaining pages before
63 MiB, leaving room for the envelope, and the renderer transport retains the
existing 64 MiB final bound. SVG and accumulated page bytes are bounded during
production. The table sidecar also receives a final 8 MiB transport check after
its bounded in-memory value tree is serialized.

Unsupported paint, foreign layers, a missing or mismatched transaction nonce,
runtime/process drift, observed print-layout-state drift, identity mismatch, incomplete geometry,
external SVG references, or a size overflow yields a typed unavailable record.
There is no ordinary-Chromium, PDF, screenshot, or partial-page fallback.

## Verification

The TypeScript tests cover strict transport/record validation, physical
occurrence validation, exact SVG pass-through, collapsed-border replay ordering,
raw LayoutUnit equality, vertical/RTL logical replay, and hostile unavailable
paths. Native verification byte-compares both retained source deltas. The live
smoke performs default-off and repeated opt-in prints,
requires distinct transaction UUIDs with byte-identical page SVGs, checks page
canvas dimensions against native page containers, binds the background-paint
policy, uses a repository-pinned font, and writes every physical page SVG plus
the full logical ledger as inspectable evidence.
