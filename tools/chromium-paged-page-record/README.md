# Pinned Chromium paged-page record patch

`renderer-page-record.patch` is the complete zero-context source delta from Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3`. It includes DM-2573's table
ownership transport and extends it with DM-2710's default-off, per-page
post-paint record.

The hook lives in `ChromePrintContext::SpoolPage` after the page-specific
`LocalFrameView::PrintPage` call. It finalizes the inner paint record, captures
it before that same record is handed to the outer print canvas, and walks
`PostLayoutChildren()` and `FragmentItems`,
recursively preflights nested `cc::PaintRecord` operations, and converts only a
supported record through `SkSVGCanvas` with text outlines. An unsupported
operation produces `status: unavailable` and no `vectorPaintSvg`.

The renderer caps the aggregate sidecar at 64 MiB. The existing private
`domotionPagedTableEvidence` request switch gates collection; ordinary
`Page.printToPDF` calls retain their generated protocol shape and do no page
record work.

Each collapsed-table occurrence also serializes the complete logical
TableBorders edge grid as source-resolved dependency facts. The existing
`collapsedEdges` array remains the page-local decision/disposition/paint-order
ledger; grid-only dependencies are not painted-page claims.

Verify the retained delta and compile the directly affected translation units:

```sh
npm run paged-page-record:verify-patch
npm run paged-page-record:compile
```

The full helper link and live-CDP fixture are release evidence rather than a
substitute for the exact record validators in `src/capture/paged-page-record.ts`.
