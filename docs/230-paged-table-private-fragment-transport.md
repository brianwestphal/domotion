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

## DM-2573 helper contract

The selected transport is implemented by
`tools/chromium-paged-table-evidence/renderer-helper.patch` against the exact
Chromium pin above. The patch adds an experimental
`Page.printToPDF.domotionPagedTableEvidence` request flag whose default is
false. An ordinary Chromium print therefore takes the unchanged route. When a
pinned evidence runner explicitly sets the flag, the response gains an
optional JSON sidecar and browser/renderer process identities.
The build helper verifies that the complete dirty-source delta matches the
retained patch byte-for-byte; a matching base revision plus probe string is not
sufficient to authenticate a build. Its isolated outer Chromium worktree
reuses the already authenticated DM-2575 DEPS checkout through clone-on-write
copies without overwriting outer source, then independently rechecks Chromium,
Skia, depot_tools, and the complete patch delta before GN or Ninja runs.
It may reuse DM-2575's clone-on-write object graph only when that seed has its
exact known outer/Skia dirty sets and hook-enabled GN arguments. The helper
invalidates every seed-drift and DM-2573 patch input, regenerates GN, and rejects
the result unless `headless_shell` is relinked after the authenticated build
starts; cached objects cannot substitute for that final link.

The structural JSON is produced inside Blink immediately after
`WebLocalFrame::PrintBegin`, while the paginated `PhysicalBoxFragment` tree is
alive. It walks page-area fragments and reads table/section/row/cell break
tokens, fragment occurrence indices, repeated-root state, caption slots,
`TableBorders` span-interior markers, collapsed-edge paint order/joint
precedence, and writing direction from their owning source objects. The
renderer hard-caps the sidecar at 8 MiB and does not use trace logging. After
page painting, `PrintEnd` runs before the Mojo result is returned; a screen
state token captured before `PrintBegin` must compare exactly after `PrintEnd`.

`PrintWithParamsResultData` carries that bounded string, renderer PID, and
restoration result through `PdfPrintJob` to the headless DevTools handler. The
collector requests `ReturnAsStream`, closes the stream without `IO.read`, and
uses neither PDF bytes, vector commands, raster output, nor pixels as logical
input. It binds the sidecar to the live CDP frame/loader epoch, Blink document
and frame tokens, exact effective `WebPrintParams`, protocol/browser version,
an exact before/after hash of DOM, stylesheet, computed screen-state, scroll,
viewport/media, and every element's client-rect state, and SHA-256 of the
launched browser/renderer image. It retains the exact sidecar string and
recomputes its byte length and SHA-256 before comparing the parsed document
URL/tokens, effective parameters, and pages with the retained fields. Those
screen facts prove restoration only and never supply paged logical ownership.
The patched `headless_shell` uses the same executable for both process roles;
the collector resolves the live executable mapping for every `SystemInfo` PID
before accepting that identity.

The shared corpus lives in `tools/paged-table-evidence-fixtures.ts`; it is used
by both the public fail-closed audit and the private helper so expected facts do
not leak into fixture-specific browser code. A matrix label counts only when
the retained Blink record contains its matching break/repeat/caption/span/
writing-mode/terminal-page fact. Exact validators actively reject
dropped pages, duplicated physical occurrences, reordered edge decisions,
wrong fragmentation axes, source drift, document/loader epoch drift, and
failed teardown. No tolerance or production rendering behavior changes.

## Platform packaging assessment

- macOS packages `headless_shell`, `icudtl.dat`, `headless_lib_data.pak`,
  `headless_lib_strings.pak`, `snapshot_blob.bin`, the architecture-named V8
  context snapshot, and the exact GN `runtime_deps`-selected ANGLE/SwiftShader
  dylibs and ICD JSON while preserving executable mode, relative paths,
  code-sign state, and quarantine state. The
  later packaging artifact must hash every file; the live renderer is the same
  executable with `--type=renderer`.
- Linux preserves the ELF executable, symlinks/rpaths, ICU, both headless PAKs,
  snapshot, V8 context snapshot, locales, and the exact GN
  `runtime_deps`-selected ANGLE/SwiftShader
  libraries and ICD JSON. The retained run records kernel, distribution, glibc,
  sandbox mode, the `DT_NEEDED` closure, file hashes, and live `/proc` mappings.
- Windows retains `headless_shell.exe`, ICU, both headless PAKs, snapshot,
  V8 context snapshot, locales, and the complete GN
  `runtime_deps`-selected DLL/SwiftShader closure
  with their relative layout.
  The manifest records Authenticode state, Windows build and architecture,
  SHA-256 for every member, and browser/renderer PIDs from `SystemInfo`.

DM-2573 authenticates the helper on the provisioned macOS builder. DM-2574
remains responsible for independent proposal/validation collection and retained
binary manifests on macOS, Linux, and Windows; this packaging assessment does
not substitute for those three runs.
