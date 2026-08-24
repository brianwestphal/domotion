# Native scrollbar release gate

**Status:** strict adjudicator, source-owned custom/native paint, and the
six-role native evidence workflow are implemented; fresh native evidence must
still adjudicate `READY` before release

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

`tools/native-scrollbar-release-gate.ts` defines schema version 2. Independent
proposal and validation reports are required from each of native macOS, Linux,
and Windows. Every report must
retain:

- its role, independent observation UUID, architecture, OS release, runner
  image/version, runner name, native boot identity, workflow/job/run/attempt;
- Chromium version and executable SHA-256, Playwright version, launch
  arguments, the ignored default argument list, and the affirmative fact that
  `--hide-scrollbars` was removed;
- observed overlay/classic preference;
- every fixture at DPR 1 and 2 crossed with CSS zoom 1, 1.25, and 2; and
- a zoom-scaled clip inside one authenticated maximum-zoom viewport, so the
  complete target, scrollbar, corner, and resizer remain observable at every
  Cartesian cell (the deliberately clipped-border row scales its own source
  clip by the same zoom); and
- row-level scheme, forced-colors state, capture route/status, source state,
and lossless source/generated PNG metadata and SHA-256; and
- byte-exact equality for every authenticated native horizontal, vertical, and
  corner raster region in the generated PNG (the rest of the screenshot stays
  available as evidence but is not falsely assigned to scrollbar ownership);
  and
- canonical hashes over logical rows, complete rows, and the artifact manifest,
  plus an explicit declaration that dynamic overlay fade is a separate
  platform-terminal leg rather than an observational success route.

An unsupported platform state remains a row. It may prove no ink, but it may
not disappear from the Cartesian product.

For classic native scrollbars, the authenticated raster owner is the complete
layout-reserved gutter, not the connected components left by diagnostic pseudo
markers. Blink's `ScrollbarTheme::PaintTrackBackgroundAndButtons` paints both
native end buttons and the track within the scrollbar display-item rectangle;
the thumb is composed in that same strip. Capture therefore derives the full
horizontal and vertical strips from the live border/client/gutter geometry,
including their shared corner, before hashing and embedding the source pixels.
This prevents a theme button that did not respond to marker CSS from silently
disappearing in the generated result.

## Strict adjudication

`tools/check-native-scrollbar-release.ts` recursively loads the six reports,
re-hashes and decodes every PNG, and rejects a path escaping its report
directory, a non-PNG crop, a digest mismatch, or a dimension mismatch. The
pure adjudicator then requires:

- exactly one proposal and one validation report per platform and the pinned
  source revisions;
- matching workflow/run provenance but different role-bound jobs, native boot
  identities, and observation UUIDs (the hosted runner name is retained but is
  not treated as a unique physical-machine identifier);
- recomputed canonical row, logical-row, and artifact-manifest hashes, with
  proposal/validation logical-row agreement;
- the complete scenario/DPR/zoom product with no duplicate rows;
- no warnings, missing facts, observational route, or failed producer row;
- exactly one lossless source/generated artifact pair per row; and
- every ownership and destructive-mutation control remains active, including
  custom marker identity and one-device-pixel geometry, native same-frame
  raster authentication, one output transform, top/mid/max movement, axis and
  RTL ownership, corner/resizer order, and rejection of a missing native hash.

There is no common macOS/Linux/Windows color envelope. A reviewed exception
cannot match after any platform or environment fingerprint changes.

## Workflow and mutation controls

`.github/workflows/native-scrollbar-parity.yml` crosses `macos-latest`,
`ubuntu-latest`, and `windows-latest` with proposal/validation, records runner
image and native boot identity, and always uploads each role-owned producer
directory. A separate aggregate downloads and losslessly reauthenticates all
six inputs before `npm run scrollbars:parity-gate`. It remains dispatch-only
until a fresh strict aggregate reaches `READY`.

The focused unit suite constructs a complete green six-role report set, then
mutates schema, role completeness, canonical hashes, artifact integrity,
boot/observation/job independence, logical agreement, and control
activation. Each mutation is required to fail; the producer's focused suite
separately owns the geometry and state mutations listed above.

## Current result and follow-up

The adjudicator implementation is green against its complete synthetic
contract. The source-run ownership producer is also exact again: its serialized
discovery callback carries a lexical esbuild name helper instead of depending
on a page global, its 24-row explicit-headless macOS run authenticates every
custom vector/native raster/absence owner, and six destructive controls reject
frozen position, swapped axis, wrong RTL side, missing corner/resizer order and
missing native raster digest. Dynamic fade/platform fingerprints remain a
separate terminal evidence leg.

Release evidence is still deliberately withheld pending a fresh native run.
The workflow now emits six independent role-bound schema-v2 artifacts and the
aggregate reauthenticates the complete Cartesian artifact set. Only a retained
macOS/Linux/Windows run whose proposal and validation arms agree may move the
gate to `READY`; the workflow does not authorize an observational route,
scalar screenshot cap, or tolerance change.

Focused checks:

```sh
npx vitest run tests/native-scrollbar-release-gate.test.ts tests/native-scrollbar-parity-workflow.test.ts
npm run scrollbars:parity-gate -- --reports tests/output/native-scrollbar
```
