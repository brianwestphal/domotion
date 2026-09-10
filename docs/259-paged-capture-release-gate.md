---
id: "requirements/paged-capture-release-gate"
title: "Authenticated paged-capture release gate"
kind: "evidence"
status: "current"
owners: ["layout", "platform-release"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2713"]
code: [".github/workflows/paged-capture-release.yml", "tools/paged-capture-release-gate.ts", "tools/paged-capture-release-collector.ts", "tools/package-paged-capture-helper.ts", "tools/paged-page-record-smoke.mjs", "src/capture/paged-collapsed-table-record.ts", "src/capture/paged-page-record.ts"]
aliases: ["docs/259-paged-capture-release-gate.md", "doc-259"]
---

# Authenticated paged-capture release gate

## Release boundary

Paged capture has one terminal, fail-closed release gate. It accepts exactly a
proposal and an independent validation report from macOS, Linux, and Windows.
Every report authenticates the same pinned Chromium, Skia, depot_tools, helper
ABI, renderer patch, and deterministic-SVG patch. Missing, duplicate, malformed,
or cross-role-drifting reports withhold `READY`; no platform borrows another
platform's binary or page evidence.

The stage order is fixed:

1. authenticate the source-owned logical print record and all negative controls;
2. parse and re-hash the public bundle and every declared page SVG;
3. render every verified SVG at DPR 1 and 2 and require exact repeat PNG bytes;
4. create optional PDFs only from those already-published SVG files.

PDF bytes and screenshots never populate a logical fact. The release code does
not change or parameterize the ordinary screen comparator, so paged evidence
cannot broaden a screen tolerance.

## Exact matrix

The native fixture must prove all 18 named cells: repeated header and footer;
oversized header and footer that do not repeat; `break-before` and `break-after`;
whole-row and continued-row seams; top and bottom captions; rowspan and colspan
interiors; non-unit zoom; named pages; authored CSS page size; and horizontal,
vertical-rl, and vertical-lr writing. Each cell carries a digest tied to the
complete logical ledger. Thirteen destructive mutations independently remove
or corrupt matrix, ordering, activation, source, helper, bundle, page, DPR,
screen-isolation, and PDF-ownership evidence.

The oversized-footer fixture exposed a legitimate whole-row seam between two
distinct sections on adjacent physical table fragments. In that case neither
section owns a break token: Blink's table fragment owns the break. The record
validator now accepts the half edge only when its global row is exactly the
leading/trailing row of a non-first/non-last physical table fragment. It does
not relax continued-row validation or accept an interior edge.

## Source authority

The matrix follows the pinned Chromium checkout, not CSSOM reconstruction:

- `third_party/blink/renderer/core/layout/table/table_layout_algorithm.cc:1032-1504`
  owns repeat eligibility and repeated section layout;
- `third_party/blink/renderer/core/paint/table_painters.cc:35-727` owns global
  border winners plus fragment-boundary half-edge and joint paint;
- `third_party/blink/renderer/core/layout/paginated_root_layout_algorithm.cc:36-283`
  propagates page names and resolves page styles;
- `third_party/blink/renderer/core/layout/pagination_utils.cc:490-550` and
  `components/printing/renderer/print_render_frame_helper.cc:226-394` own
  effective CSS/default page descriptions;
- `third_party/skia/include/svg/SkSVGCanvas.h` and the pinned
  `src/svg/SkSVGDevice.cpp` delta own deterministic native page SVG output.

## Portable helper packaging

`paged-capture:helper:package` now works from the exact current patched source
and GN `runtime_deps` closure on Darwin, Linux, or Windows. It no longer imports
the historical macOS-only DM-2573 table-helper receipt. Instead it embeds a
fresh DM-2713 receipt containing platform/architecture, all source pins, exact
patch identities, GN args, executable bytes, and runtime-dependency path digest,
then rechecks the source, executable, and receipt immediately before publishing
the helper manifest. The manifest still hashes every packaged byte, preserves
platform loader identity, remains caller-supplied/manual-only, and performs no
runtime download.

The manual workflow accepts one explicitly supplied `.tar.gz` and archive
SHA-256 for each OS. Each archive must contain the packager's files directly at
its root, including `paged-capture-helper.json`. The workflow authenticates the
archive before extraction, computes the manifest trust anchor, runs the native
smoke and public CLI twice, assembles both role reports, retains page PNG/PDF and
manifest evidence per platform, and fan-ins all six reports through the strict
gate. Supplied archives are release inputs, not an implicit product installer.

## Local acceptance receipt

The Darwin/arm64 dry run on 2026-09-10 used the current patched
`headless_shell` SHA-256
`228befe1ecb53e21ac4cab40c8ddc118da02cdc6e8e4d90656e1e953e3a1c9d6`.
Packaging authenticated 4,922 runtime-dependency members plus the executable,
license, and seven metadata receipts. The resulting helper manifest SHA-256 was
`6fd3dda246e4b989373306832d75d2e5f27e31764b54f1e9078866c9f9a147f5`.
Two distinct 15-page print transactions agreed on logical ledger SHA-256
`2656513506809e32f0f3a722e2cba5a9e50d8056dde42d34009803a85c90d98e`
and on every exact native page SVG. Public API capture then reproduced those 15
SVG hashes through the packaged helper, and both release collectors passed
helper re-verification, bundle rehash, self-containment, DPR 1/2 ink, stock
Chromium rejection, and SVG-to-PDF downstream controls.

That local receipt proves the collector and Darwin route; it is not a substitute
for retained Linux and Windows reports. The product-level all-platform release
claim remains gated on running the manual workflow with independently packaged
archives for all three operating systems.
