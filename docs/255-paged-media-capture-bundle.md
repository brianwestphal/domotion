---
id: "requirements/paged-media-capture-bundle"
title: "Paged-media capture bundles"
kind: "contract"
status: "partial"
owners: ["layout", "cli"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2325","DM-2573","DM-2708","DM-2709","DM-2710","DM-2711","DM-2712","DM-2713"]
code: ["src/capture/paged-capture-bundle.ts","src/capture/paged-capture-bundle-json-schema.ts","schemas/paged-capture-bundle.schema.json","src/capture/paged-capture-helper.ts","src/capture/paged-capture-helper-json-schema.ts","schemas/paged-capture-helper-bundle.schema.json","tools/package-paged-capture-helper.ts","src/capture/paged-collapsed-table-record.ts","tools/chromium-paged-table-evidence/renderer-helper.patch","tools/paged-table-renderer-evidence-collector.ts"]
aliases: ["docs/255-paged-media-capture-bundle.md","doc-255"]
---

# Paged-media capture bundles

## Decision

Paged capture is an explicit product surface, separate from ordinary viewport
capture. Its durable output is a static JSON manifest plus one deterministic,
self-contained SVG for every selected physical page. PDF is a downstream
conversion of those SVGs; neither PDF operators nor raster pixels may provide
layout or paint facts.

The source of page-local geometry is an opt-in, separately distributed Chromium
helper pinned to the exact source revision understood by Domotion. Stock
Playwright Chromium remains the default for screen capture. It does not become
eligible for paged capture merely because it implements `Page.printToPDF`.

This contract records the maintainer's DM-2325 decision. Delivery is split into
the bounded DM-2708 through DM-2713 slices so the data model, authenticated
runtime, Blink transport, SVG renderer, public interface, and release evidence
can each fail independently.

## Source boundary

At Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`, public
`Page.printToPDF` accepts page and margin controls and returns only PDF bytes or
an `IO.StreamHandle`
(`third_party/blink/public/devtools_protocol/domains/Page.pdl:922-985` and
`headless/lib/browser/protocol/page_handler.cc:37-115`). It does not expose the
private `PhysicalBoxFragment` tree.

Blink creates that tree after `WebLocalFrame::PrintBegin`, consumes it while
serializing pages, and destroys print mode at `PrintEnd`
(`components/printing/renderer/print_render_frame_helper.cc:799-944,
1085-1135,1368-1420,2273-2398`). The anonymous page containers and their break
tokens are built by
`third_party/blink/renderer/core/layout/paginated_root_layout_algorithm.cc`.
Any trustworthy capture must therefore serialize source-owned facts while the
print tree is alive, then prove the screen document was restored before the
response is accepted.

DM-2573 proves this lifetime and transport for paged collapsed-table ownership:
an experimental, default-off response sidecar carries a bounded record during
the `PrintBegin`-to-`PrintEnd` epoch. That helper is evidence, not yet a public
runtime. It also does not contain the complete page-local geometry and paint
records needed to render general page SVGs. DM-2709 and DM-2710 own those two
separate promotions.

## Product surface

Paged capture must be impossible to invoke accidentally.

- Library callers use a paged-capture entry point distinct from
  `captureElementTree`.
- CLI callers choose a dedicated paged mode and an output manifest path or
  directory. Existing `domotion capture` behavior and bytes remain unchanged
  when paged mode is absent.
- The caller explicitly supplies or selects an authenticated helper bundle.
  Domotion does not silently download a multi-gigabyte browser, substitute a
  stock browser, or fall back to screenshot/PDF reconstruction.
- Page size, orientation, CSS-page-size preference, margins, page ranges,
  background printing, and source selector are explicit manifest inputs.
- Unsupported combinations fail before navigation when possible. A failure
  never leaves a manifest that claims authenticated output.

## Bundle layout

The manifest is the commit point for a bundle. Page SVGs are written first to
temporary sibling paths, verified, atomically renamed, and only then referenced
by an atomically written manifest. A consumer that can read the manifest must
therefore be able to read every declared page asset.

The first schema uses deterministic relative POSIX paths:

```text
report.domotion-pages.json
report.pages/
  page-0001.svg
  page-0002.svg
```

Absolute paths, backslashes, empty components, `.`/`..`, URL schemes, and paths
outside the bundle root are invalid. Page indices are zero-based and strictly
consecutive in the manifest; filenames are one-based for human readability.
Duplicate filenames are invalid. Selected page ranges preserve document order,
matching Chromium's `Page.printToPDF` contract.

## Manifest contract

An authenticated manifest contains:

- a fixed schema version and ABI;
- `status: "authenticated"`;
- the source URL and selected root identity;
- the exact requested and effective print parameters;
- the Chromium, Skia, helper ABI, source-patch, executable, runtime-dependency,
  browser-process, renderer-process, protocol, document, loader, and print-epoch
  identities needed to authenticate the source;
- proof that logical facts came from the private print fragment tree and never
  from PDF/vector/raster output;
- proof that `PrintEnd` restored the observed top-level print-layout state and
  frame/loader epoch. This intentionally does not claim equality for arbitrary
  JavaScript heap state, canvas pixels, shadow trees, nested scrollers, or
  child-frame state;
- ordered page records with page index/name/empty state, CSS dimensions, the
  authenticated page-record digest, SVG relative path, SVG byte length, and SVG
  SHA-256;
- bundle-level hashes sufficient to detect reordering, omission, replacement,
  and parameter drift.

An unavailable result uses `status: "unavailable"`, carries a stable reason
code plus actionable detail, source pins, requested parameters, and all missing
capabilities. It references no SVG assets and makes no authenticated geometry
claim. Stock Chromium, helper version drift, corrupt sidecars, absent page-local
paint facts, failed teardown, and unsupported paint all use this route.

The schema rejects unknown fields. Hashes use lowercase hexadecimal SHA-256.
Byte lengths are non-negative safe integers. Dimensions and coordinates use
finite CSS-pixel numbers canonicalized from Blink `LayoutUnit` at 1/64 CSS px;
no JSON `NaN`, infinity, or epsilon normalization is allowed.

## Page record and SVG ownership

Every SVG represents exactly one physical page in that page's own coordinate
space. It has the page's concrete width, height, and viewBox, contains no
external runtime assets, and carries the manifest/page/epoch identities needed
to detect cross-bundle substitution.

Page-local records retain physical fragment occurrence identity rather than
aliasing generated or repeated content to a DOM prototype. At minimum they
carry:

- page-area, content-area, bleed, and clip geometry;
- DOM source identity and physical occurrence order;
- physical fragment offsets, clips, transforms, zoom, writing mode, direction,
  and fragmentation progression;
- generated-content and repeated-section occurrence identity;
- text, image, background, border, effect, and stacking paint facts consumed by
  the existing SVG renderer, or an explicit unsupported-paint status;
- table, section, row, cell, caption, span, break-token, global row/column, and
  collapsed-edge/joint records required by the DM-2322 model.

Collapsed table borders keep one global Blink conflict graph. Each page-local
occurrence feeds its exact section slices and offsets through
`collapsedBorderFragmentLogicalRects`; whole-row fragment boundaries paint the
source-owned half edge, continued-row seams omit it, adjacent sections share the
global winner, and span interiors stay empty. Repeated `thead`/`tfoot` clones
are independent physical occurrences witnessed by Blink, not positions inferred
from a PDF or screenshot.

## Helper distribution and authentication

The helper is a separate, opt-in bundle. Its manifest covers the executable and
the complete GN `runtime_deps` closure with relative paths, byte lengths,
SHA-256 values, executable modes, platform/architecture, and platform-specific
loader metadata. It also binds Chromium, Chromium-pinned Skia, depot_tools,
the exact Domotion patch, protocol schema, helper ABI, and license/update
metadata.

Before capture, Domotion verifies every bundle member and refuses symlinks or
path escapes not explicitly represented by the platform manifest. After launch,
it authenticates the live browser and renderer images and binds the response to
the active frame, document, loader, effective print parameters, and helper ABI.
The sidecar remains default-off at runtime and hard-bounded. Ordinary
`Page.printToPDF` responses expose no Domotion fields.

The first production path may require a caller-supplied local helper bundle.
Automatic installation, hosted artifacts, retention policy, update cadence,
code signing, and redistribution/license UX are later explicit decisions; none
may weaken integrity checks.

### DM-2709/DM-2711 runtime boundary

`verifyPagedCaptureHelperBundle` is the only locator for the first runtime. It
requires both a local manifest path and the expected lowercase SHA-256 of those
exact manifest bytes; the manifest is not allowed to authenticate itself. Its
strict version-2 schema binds the pinned Chromium, Skia, depot_tools, cumulative
Chromium and deterministic-SVG Skia patches, combined transport ABI, DevTools
product/protocol, operating system, architecture,
loader metadata, update policy, source offer, and complete member inventory.
The executable and runtime-dependency entries have one canonical closure digest.

Verification resolves the bundle root, rejects absolute/backslash/dot-component
paths, undeclared symlink parents, unlisted symlink substitution, escapes,
member kind/mode/length/hash drift, an ambiguous executable, missing license
members, and host platform mismatch. Explicit symlink members bind the literal
link text and must still resolve inside the bundle. Files are streamed through
SHA-256 so authenticating a large helper does not require retaining its bytes.

The current source contract advertises both `paged-table-ownership-v1` and
`paged-page-svg-v1`, backed by the combined version-2 helper ABI and the private
table transport ABI. Callers select capabilities explicitly, so a historical
table-only helper cannot be mislabeled as a general paged renderer.

`launchPagedCaptureHelper` is a distinct opt-in launch path. It always passes
the verified executable path directly to Playwright, forces headless operation,
and contains no install, download, channel, stock-Chromium, or retry fallback.
Launch creates a renderer, compares live `Browser.getVersion` facts to the
manifest, resolves the browser and every renderer PID reported by
`SystemInfo.getProcessInfo`, and requires each process to map to and re-hash as
the single declared executable. It then reverifies the complete bundle. The
returned `authenticateLiveProcesses` hook lets the later capture transaction
repeat process authentication after its target page exists.

Launch also executes the transport handshake. A print without the experimental
flag must expose no `domotion*` response fields. A second print explicitly asks
for table evidence, closes the returned PDF stream without reading it, validates
the bounded source/ABI/lifetime sidecar and complete collapsed-table ownership
record, checks the observed top-level print-layout state plus frame/loader
restoration, and binds the response's browser/renderer PIDs to the live image
authentication. It does not claim equality for arbitrary JavaScript heap,
canvas, shadow-tree, nested-scroll, or child-frame state. `Schema.getDomains`
is canonically hashed and must match the protocol-schema digest in the manifest.

The required distribution metadata is deliberately explicit: bundles are
caller-supplied, updates are manual and pin-specific, automatic downloads are
false, and at least one packaged license file plus a source-archive URL is
required. There is no installer in this slice. A hosted installer can be added
only with a separately reviewed signing, retention, license-display, and update
policy; it cannot bypass the manifest trust anchor or member checks.

`npm run paged-capture:helper:package -- --config <json> --smoke` is the only
producer for this schema. It authenticates the complete installed Chromium
source delta, invokes `gn desc ... //headless:headless_shell runtime_deps
--all`, deduplicates that source-owned list, preserves relative paths/modes and
links, invokes Chromium's `tools/licenses/licenses.py license_file` action,
retains GN args/build-evidence/runtime-deps/protocol/source/patch receipts, and
refuses a nonempty destination. The current producer is intentionally limited
to the reviewed macOS arm64 build and pins the complete 4,923-member executable
and runtime-dependency closure; DM-2713 owns additional platform receipts. The
optional smoke gate launches the packaged copy through the public verifier and
transport handshake. Chromium sandboxing is forced on for this build, and no
inherited dynamic-loader or Node injection controls reach the child process.

The retained macOS DM-2573 build passed the historical table-only producer and smoke gate on
2026-09-10: 4,923 unique GN runtime dependencies, 4,930 total manifest members,
manifest SHA-256
`a147e797995f7a546fca5c0f8bbae577071e156fa8b10f191473929b5aa8a6c8`,
and an authenticated default-off/active handshake. That immutable receipt does
not authenticate the later page-SVG/Skia deltas; the combined producer refuses
it until a separately retained current build receipt is supplied. The temporary
bundle was removed after the reproducible acceptance run; it is not a hosted installer.

## Failure and compatibility rules

- Ordinary screen capture is behaviorally and byte-for-byte isolated from this
  opt-in route.
- A helper/source/protocol/ABI mismatch fails closed before page rendering.
- Missing or ambiguous page occurrences, nonconsecutive indices, invalid
  physical geometry, duplicate paint slots, record/hash drift, or failed source
  restoration invalidates the complete bundle.
- Partial page output may be retained only as clearly named diagnostic scratch
  data. It is never published behind an authenticated manifest.
- Unsupported SVG paint may use an existing bounded Chromium-owned raster only
  when that fallback has its own authenticated source surface and negative
  activation control. The raster may represent paint; it cannot invent layout.
- PDF remains optional downstream output. Its bytes, object tree, operators, or
  pixels are never read to populate the manifest or page records.
- Schema evolution is versioned and additive only within a version. Readers
  reject unknown versions rather than guessing.

## Delivery slices

1. **DM-2708 — bundle schema.** Typed authenticated/unavailable records,
   generated JSON Schema, canonical validation and hostile mutations.
2. **DM-2709 — helper runtime.** Package manifest, locator, integrity checks,
   live process authentication, and explicit opt-in launch.
3. **DM-2710 — Blink page records.** Complete page-local physical geometry and
   paint facts captured during the private print epoch.
4. **DM-2711 — page rendering.** One exact self-contained SVG per authenticated
   page, including collapsed-table fragment ownership.
5. **DM-2712 — public API and CLI.** Atomic bundle writing and paged print
   controls with ordinary-capture isolation.
6. **DM-2713 — release evidence.** Logical mutations and native page coverage
   for repeated headers/footers, breaks, continuation, spans, captions, zoom,
   writing modes, page rules, and all three platforms.

DM-2325 owns the approved product decision and this decomposition. It does not
claim the final capture feature shipped until the delivery tickets complete.

## Acceptance

The feature is complete only when all of the following hold:

1. The manifest and every page SVG validate and re-hash exactly after a clean
   checkout build.
2. Stock Chromium and a default-off helper both reject paged capture without
   emitting authenticated page assets.
3. The authenticated helper proves exact source, process, print-epoch, effective
   parameter, record, and teardown identity.
4. Repeated headers and footers, break-before/after, whole-row and continued-row
   breaks, captions, spans, zoom, named/CSS-sized pages, and horizontal/vertical
   writing pass exact logical gates.
5. Final native-versus-SVG page evidence passes on macOS, Linux, and Windows
   without changing existing screen tolerances.
6. Every output SVG is self-contained; optional PDF export consumes the page
   SVGs and is absent from logical evidence.
7. Omitting paged mode leaves the current public API, CLI, generated SVG, and
   browser-install behavior unchanged.
