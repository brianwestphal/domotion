---
id: "requirements/paged-capture-api-cli"
title: "Opt-in paged capture API and CLI"
kind: "contract"
status: "current"
owners: ["layout", "cli"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2712"]
code: ["src/capture/paged-capture.ts", "src/cli/capture.ts", "src/capture/paged-page-record.ts"]
aliases: ["docs/258-paged-capture-api-cli.md", "doc-258"]
---

# Opt-in paged capture API and CLI

## Public API

`capturePagedSvgBundle` is distinct from ordinary element-tree capture. The
caller supplies an authenticated helper manifest path, its external SHA-256
trust anchor, a `.domotion-pages.json` output path, a page preparation callback,
an exact source selector, and print controls. The function launches only that
pinned helper, inspects the selected DOM root and its resolved CSS for the
source identity, captures a live-authenticated print record, passes its native
SVGs through the exact logical audit, and returns the approved manifest after
publication. It never downloads or substitutes a browser and never uses PDF or
screenshot bytes as input.

Closed one-based page ranges use Chromium's `1-3,7` grammar and are normalized
without expanding them. Paper dimensions and margins are inches; scale is a
positive finite number. Orientation, background printing, and authored
`@page` size preference are explicit. Invalid options, helper authentication,
source identity, unavailable paint, output conflicts, and publication errors
have stable `PagedCaptureError.code` values and actionable messages.

`writeAuthenticatedPagedCaptureBundle` is also public for callers that already
hold an approved manifest and rendered pages. It requires exact page index,
byte-length, and digest agreement.

## Atomic output

The writer refuses to overwrite either an existing manifest or page directory.
It writes each SVG into a random temporary sibling directory, revalidates every
asset against the approved manifest, writes the manifest to a temporary sibling,
and renames the complete page directory into place. A no-overwrite hard link
publishes the manifest last as the bundle commit point. On a handled failure it
removes its temporary files and any page directory it just installed. A reader
that can see the manifest can therefore open every declared deterministic path:

```text
report.domotion-pages.json
report.pages/page-0001.svg
report.pages/page-0003.svg
```

Selected page filenames retain physical document page numbers; manifest
`selectionIndex` remains consecutive even when `pageIndex` is sparse.

## CLI

`domotion capture <input> --paged` is the only CLI activation. It requires
`--paged-helper-manifest`, `--paged-helper-sha256`, and an output ending in
`.domotion-pages.json`. Page size, margins, range, scale, landscape,
backgrounds, and CSS page size have dedicated flags. Existing load/settle,
selector, HAR replay, and quiet flags remain useful.

Paged-only flags without `--paged` fail before navigation. Paged mode rejects
viewport size/format, clip, scrolling, optimization, device chrome, mobile,
brand, cross-origin-frame, accessibility-title, debug, and other ordinary
screen-output controls instead of silently ignoring them. With `--paged`
omitted, the ordinary capture branch and output logic are unchanged.

## Verification

Tests cover range normalization, high-level helper orchestration, sparse
deterministic filenames, manifest/asset agreement, staged asset verification,
no-overwrite conflicts, cleanup on failure, CLI option mapping, and pre-launch
CLI incompatibility diagnostics. The page-record suite binds the capture
browser/renderer/frame facts retained for the manifest. DM-2713 adds portable
current-helper packaging plus the strict three-platform proposal/validation
gate in doc 259; it does not change this opt-in contract.
