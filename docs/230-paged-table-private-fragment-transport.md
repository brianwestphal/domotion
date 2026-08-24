# Paged-table private fragment transport

DM-2571 investigated whether Domotion can authenticate collapsed-table page
fragments through public Chromium DevTools without deriving logical facts from
PDF output. The answer at Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` is no.

## Source boundary

Headless `Page.printToPDF` validates print parameters in
`headless/lib/browser/protocol/page_handler.cc`, calls
`HeadlessPrintManager::PrintToPdf`, and returns only PDF bytes or an IO stream.
The browser-side callback has no renderer fragment-tree payload.

In the renderer, `PrepareFrameAndViewForPrint::EnterPrintModeInternal` calls
`WebLocalFrame::PrintBegin`; only then does Blink build the paginated layout and
its private `PhysicalBoxFragment` tree. `PrintPagesNative` consumes that tree
while painting pages. `LeavePrintModeInternal` calls `PrintEnd`, destroying the
transient print layout before the public CDP command completes. Screen CSSOM,
`DOM.getContentQuads`, PDF objects, vector commands, and raster pixels therefore
cannot authenticate row break tokens, repeated section occurrences, or
collapsed-edge decisions.

## Candidate transports

1. A pinned renderer-side evidence helper is the trustworthy candidate. It
   serializes the source-owned record synchronously after `PrintBegin` and
   before `PrintEnd`, then returns a bounded sidecar through a dedicated Mojo or
   DevTools response field. This has direct access to the exact fragment tree
   and a clear lifetime/teardown invariant.
2. A tracing event is technically cheaper but unsuitable as the primary
   contract: trace category enablement, payload truncation, event loss, and
   cross-renderer correlation add independent ambiguity.
3. Parsing PDF or instrumenting Skia is downstream and cannot recover the
   logical ownership record. It remains final-ink evidence only.

The helper must authenticate browser and renderer binaries, pinned source,
print parameters, frame/document/loader epoch, page order, and exact restoration
after `PrintEnd`. The record must carry physical table and section occurrence
identity, global row intervals and exact offsets, break tokens, repeat
eligibility/roles, captions, spans/interior suppression, collapsed-edge
decisions and paint slots, writing mode and direction. Proposal and validation
builds/runs must be independent.

## Cost and next steps

This is not a normal npm helper: it requires a patched Chromium renderer and
matching browser/renderer binaries. CI therefore needs pinned Chromium builds
for macOS, Linux, and Windows, with platform-specific signing/quarantine and
artifact-size handling. DM-2573 owns the evidence-only helper and transport;
DM-2574, blocked on it, owns the independent three-platform retained run.

Until that transport exists, `collectPagedCollapsedTableEvidence` correctly
returns structured unavailable evidence and the logical release gate must fail
closed. No visual tolerance is involved.
