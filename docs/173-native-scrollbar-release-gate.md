# Native scrollbar release gate

**Status:** strict adjudicator and native-platform workflow implemented; the
gate is intentionally **not ready** until DM-2482 and DM-2483 replace the two
remaining paint gaps

**Ticket:** DM-2484

This gate is the release boundary for the hybrid ownership model in
[doc 165](165-native-scrollbar-layout-paint-ownership-audit.md) and the live
capture contract in [doc 169](169-authoritative-scrollbar-capture.md). It does
not turn the DM-2481 observational report into a passing result. The current
renderer still emits neither Chromium-resolved custom parts nor same-frame
native strips, so any `partial`, warning-bearing, `*-current-gap`, or
`native-platform-fingerprint` row is a blocker.

## Source boundary

The authority remains Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and the Skia revision pinned by
that checkout, `62efacd37737505732dbe3d8daa62abd679626a1`:

- `paint_layer_scrollable_area.cc:1488-1528,1732-1848,2148-2180` owns
  existence, physical frames, logical-left placement, and snapping;
- `scrollbar.cc:757-770,930-990` owns native/custom overlay state, used width
  and colors, scheme, range, and animator state;
- `custom_scrollbar.cc:137-214,290-423`,
  `layout_custom_scrollbar_part.cc:108-170`, and
  `custom_scrollbar_theme.cc:154-237` own the custom anonymous boxes and their
  source paint order; and
- `scrollable_area_painter.cc:176-260,265-404` owns phase, clip, root viewport
  transform, horizontal-before-vertical-before-corner-before-resizer order,
  and the native/custom paint split. Native platform pixels eventually enter
  Skia through the active platform theme, including the Windows offscreen
  bitmap route described in doc 165; a shared palette is therefore invalid.

## Evidence schema

`tools/native-scrollbar-release-gate.ts` defines schema version 2. One report
is required from each of native macOS, Linux, and Windows. Every report must
retain:

- architecture, OS release, runner image and image version;
- Chromium version and Playwright browser revision, Playwright version, launch
  arguments, the ignored default argument list, and the affirmative fact that
  `--hide-scrollbars` was removed;
- observed overlay/classic preference;
- every fixture at DPR 1 and 2 crossed with CSS zoom 1, 1.25, and 2; and
- row-level scheme, forced-colors state, capture route/status, source state,
  isolated lossless PNG strip metadata, SHA-256, source frame, source clip,
  output-transform application count, and vector-sibling discriminator.

An unsupported platform state remains a row. It may prove no ink, but it may
not disappear from the Cartesian product.

## Strict adjudication

`tools/check-native-scrollbar-release.ts` recursively loads the three reports,
re-hashes and decodes every PNG, and rejects a path escaping its report
directory, a non-PNG crop, a digest mismatch, or a dimension mismatch. The
pure adjudicator then requires:

- exactly one report per platform and the pinned source revisions;
- the complete scenario/DPR/zoom product with no duplicate rows;
- no warnings, missing facts, partial/unavailable paint, expected-gap route,
  failed producer classification, or legacy 7 px synthetic pill;
- author-custom marker-class equality and at most one device pixel of x/y/
  width/height bound delta per part;
- native source/generated strip SHA equality from the same run, or an explicit
  reviewed envelope keyed to platform, architecture, runner image/version,
  Chromium revision, row, DPR, zoom, part, and the exact allowed SHA pair;
- each crop wholly inside both the source-owned frame and
  `OverflowControlsClip`, with source/generated crops addressing the same
  device-pixel rectangle;
- one output transform application, preserved vector-sibling bounds/pixels,
  live top/mid/max thumb movement, RTL negative offset plus logical-left, and
  corner-before-resizer order.

There is no common macOS/Linux/Windows color envelope. A reviewed exception
cannot match after any platform or environment fingerprint changes.

## Workflow and mutation controls

`.github/workflows/native-scrollbar-parity.yml` collects native artifacts on
`macos-latest`, `ubuntu-latest`, and `windows-latest`, always uploads each
producer directory, then downloads all three into a separate aggregate job and
runs `npm run scrollbars:parity-gate`. It is dispatch-only while the known
paint dependencies are red; automatic pull-request/push triggers must be added
only when the same strict aggregate reaches `READY`.

The focused unit suite constructs a complete green three-platform report and
then independently mutates the facts which commonly make a visual oracle lie:
old schema/current-gap routing, missing part or strip, crop one pixel outside
the owner, double transform, corner after resizer, frozen thumb, custom marker
class/bounds drift, fingerprint substitution, missing platform, corrupt
artifact, and reintroduced legacy pill. Each mutation is required to fail.

## Current result and follow-up

The adjudicator implementation is green against its complete synthetic
contract. Production evidence is deliberately red: the existing ownership
producer still writes the observational DM-2481 shape, custom records retain
`dynamic-scrollbar-pseudo-cascade`, native records retain animator/frame/phase
unknowns, and no final custom/native strip artifacts exist. DM-2482 must land
custom vector paint; DM-2483 must land native same-frame rasters and schema-v2
producer fields. DM-2484 can be called release-ready only after a fresh native
three-platform workflow is `READY` without weakening these checks.

Focused checks:

```sh
npx vitest run tests/native-scrollbar-release-gate.test.ts tests/native-scrollbar-parity-workflow.test.ts
npm run scrollbars:parity-gate -- --reports tests/output/native-scrollbar
```
