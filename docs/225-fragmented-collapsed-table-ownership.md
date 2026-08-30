---
id: "requirements/fragmented-collapsed-table-ownership"
title: "Fragmented collapsed-table physical ownership"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2526","DM-2557","DM-2558","DM-2559","DM-2560","DM-2571"]
code: [".github/workflows/fragmented-collapsed-table-release.yml","src/capture/collapsed-border-fragment-cdp.e2e.test.ts","src/capture/collapsed-border-fragment-cdp.ts","src/capture/collapsed-border-fragment-record.ts","src/capture/paged-collapsed-table-cdp.ts","src/capture/paged-collapsed-table-record.ts","src/capture/script/walker/borders-backgrounds.ts","tests/border-collapse-conflict.e2e.test.ts","tools/collapsed-border-fragmentation-oracle.ts","tools/fragmented-collapsed-table-release-gate.ts","tools/paged-collapsed-table-ownership-audit.ts"]
aliases: ["docs/225-fragmented-collapsed-table-ownership.md","doc-225"]
---

# Fragmented collapsed-table physical ownership

**Tickets:** DM-2526, DM-2557, DM-2558, DM-2559, DM-2571
**Status:** Screen physical section-fragment and repeated-section occurrences authenticated; public paged-media ownership explicitly fails closed
**Source pin:** Chromium `7d859f271cbda744098ac69f44978d4edfa62be3`

## Verdict

DM-2557 closes the earliest screen gap before vector paint. Capture now builds
a versioned private record from the same physical table, section, row, cell,
and caption nodes observed independently through ordered
`Element.getClientRects()` and CDP `DOM.getContentQuads`. Every CSS transform on
the candidate subtree and ancestor chain is neutralized for one settled layout
epoch; both channels must agree exactly after Blink LayoutUnit 1/64 CSS-pixel
canonicalization. The original style attributes and live protocol quads must
then restore exactly before the record is promoted.

The authenticated record retains physical table-fragment identity, section
source/table-child/paint slots, consecutive global row identity, exact logical
row and column offsets, content-before/after and continued-row state, caption
paint slots, writing direction, source revision, and collection provenance.
`borders-backgrounds.ts` validates and consumes that record once before
collapsed-border vector paint. Wrong-row, wrong-fragment, wrong-axis,
CSSOM/CDP-drift, incomplete-column, and restore mutations fail closed; the old
overlap/median/coordinate-translation reconstruction is not a fallback.

DM-2558 closes the repeated-section screen gap without treating coordinate
aliases as occurrences. The first computed `table-header-group` and
`table-footer-group` are selected in Blink grouped-child order; later groups
remain bodies. A repeated section is promoted only when the known column
fragmentainer size, one-quarter limit, applicable `break-inside: avoid`, no
internal break, no late start, non-nested repeatable ownership, and enabled
layout-side-effects route all authenticate. Blink's first physical result is
the clone prototype, but every predicted header/footer slot must also be
independently witnessed by intrinsic `Document.elementsFromPoint` membership
of every source cell. The collector restores scroll and transforms exactly.
The record then owns the source section, physical fragment, global rows,
original/repeated role, occurrence index, first/last table-box state, paint
slot, and exact reserved collapsed-edge/table-edge space. Missing, duplicated,
reordered, wrong-source, wrong-row, or wrong-edge evidence fails closed. No
pixel comparison or tolerance participates.

Paged media is a separate proven gap. In the headless logical print control,
`Page.printToPDF` produced seven page objects while ordinary screen CSSOM
exposed one table rectangle and one header rectangle. A screen
`getClientRects()` capture cannot infer the print fragment tree.

DM-2559 closes that boundary without inventing a transport. Pinned Chromium
enters print mode with `PrintBegin`, constructs anonymous page containers and
their private physical fragment trees, serializes the selected pages, and calls
`PrintEnd` before the `Page.printToPDF` callback receives anything. The public
protocol result contains only PDF bytes or an IO stream. It exposes none of the
page/table/section occurrence ids, global row intervals, break tokens, repeated
section roles, row/column offsets, collapsed-edge traversal, or joint decisions
that `TablePainter` consumes.

`paged-collapsed-table-record.ts` defines the complete private transport that
would be required to promote print ownership. Its public-CDP producer always
returns a structured `unavailable` record naming every missing fact. Screen
CSSOM, PDF operators, vector geometry, and raster pixels are all forbidden as
substitutes. This is the requested exact rejection route: paged collapsed-table
vectors cannot be claimed until Chromium exposes, or a pinned native helper
serializes, the transient `PhysicalBoxFragment` facts directly.

No production renderer, pixel threshold, phase envelope, or tolerance changed.
The logical oracle reads no screenshot pixels; its print leg reads only PDF
page structure.

## Pinned Blink decision trace

| Decision | Pinned source | Required consequence |
| --- | --- | --- |
| Collapsed conflict graph | `core/layout/table/table_borders.cc:23-260` | Blink builds one global edge graph. Cells merge first, followed by row, section, column, column-group, and table contributions. Row/column spans leave their interior edges unfilled. |
| Section fragment rows | `core/layout/table/table_section_layout_algorithm.cc:47-164` | Each physical section fragment stores `actual_start_row_index` and exact fragment-local `row_offsets`, beginning from the incoming row break token. |
| Grouped section selection | `core/layout/table/table_layout_algorithm_types.cc:297-326` | The first layout child with computed header/footer-group display is selected; later header/footer groups join the body list, and paint/layout order is selected header, bodies, selected footer. |
| Repetition eligibility and placement | `core/layout/table/table_layout_algorithm.cc:1002-1151,1271-1339,1452-1528,1701-1719` | Header/footer repetition requires a known fragmentainer block size, a section no larger than one quarter of it, applicable `break-inside: avoid`, no break inside the candidate, no late-start or nested-repeat ownership, and enabled layout side effects. Repeated headers reserve the block-start collapsed border; footers reserve end space and participate in last-table-box relayout. |
| Repeat cloning | `core/layout/block_node.cc:722-796`; `core/layout/fragment_repeater.cc:117-205` | The first repeatable-root result is the prototype and later occurrences are deep physical-fragment clones with their own repeat break tokens. Source-relative row/cell geometry may be cloned exactly, but occurrence presence still requires independent ownership evidence. |
| Collapsed-border paint | `core/paint/table_painters.cc:35-328,490-727` | Paint iterates physical table fragments and child section fragments, consumes the section's global start row and row offsets, distinguishes whole-row from continued-row breaks, paints half an inline edge at whole-row fragmentainer boundaries, omits that edge at continued-row seams, carries block edges through continuation without joint adjustment, and suppresses the shared row of adjacent sections with `previous_painted_row_index`. Physical writing conversion precedes pixel snapping. |
| Repeated-section traversal | `core/paint/pre_paint_tree_walk.cc:1290-1312` | Repeated headers and footers receive physical fragment traversal; they are occurrences in the paint tree, not coordinate aliases to be expanded blindly. |
| CSSOM rectangles | `core/dom/element.cc:3419-3485`; `core/layout/layout_box.cc:1199-1216` | `getClientRects()` returns bounding boxes derived from `AbsoluteQuads()` over physical fragments. It does not serialize global table row identity, section paint slots, row break tokens, or repeat ownership. |
| Paginated root | `core/layout/paginated_root_layout_algorithm.cc:28-155` | Print creates one anonymous page-container fragment per page, linked by fragmentainer break tokens; page containers have independent coordinate systems and may be rebuilt after total-page-count discovery. |
| Print lifetime | `components/printing/renderer/print_render_frame_helper.cc:799-944,1085-1135,1368-1420,2273-2398` | `PrintBegin` creates the print layout, page serialization consumes it, and `PrintEnd` destroys print mode before the browser callback completes. The layout tree is a transient renderer-owned object, not persistent screen CSSOM state. |
| Public print protocol | `third_party/blink/public/devtools_protocol/domains/Page.pdl:922-985`; `headless/lib/browser/protocol/page_handler.cc:37-115` | `Page.printToPDF` accepts paper/range/template controls and returns only base64 PDF data or an IO stream. There is no logical page-fragment result field. |

The source fixtures are the pinned Blink WPT horizontal-tb/LTR,
vertical-lr/RTL, and vertical-rl/LTR collapsed-border fragmentation cases under
`third_party/blink/web_tests/external/wpt/css/css-break/table/`. Their reference
pages explicitly omit the continuation edge on the physical top, left, or
right side appropriate to the writing mode. The corpus preserves their four
fragmentainers, 120 px caption, two `tbody` sections, and a 145 px continued
row.

## Current Domotion boundary

- `src/capture/collapsed-border-fragment-cdp.ts` owns the private live-node
  registry, animation freeze, transform-neutral same-epoch CSSOM/CDP
  collection, intrinsic source-cell occurrence witnesses, reversible scrolling,
  exact restoration check, and fail-closed warning.
- `src/capture/collapsed-border-fragment-record.ts` owns LayoutUnit
  canonicalization, ordered channel authentication, record construction, and
  hostile-record validation. It contains no pixel comparison or fitted
  tolerance.
- `src/capture/script/walker/borders-backgrounds.ts` accepts only an
  authenticated record matching the live table's rows, columns, fragments,
  writing mode, and direction. It passes exact section slices to the existing
  logical edge/joint algorithm, emits physical rects tagged by fragment index,
  and serializes the consumed provenance on the table.
- Missing, ambiguous, stale, or unauthenticated alias records serialize an unavailable
  reason, suppress cell/structural collapsed borders, and return an empty table
  vector list. There is no CSSOM heuristic fallback.
- `src/capture/paged-collapsed-table-record.ts` defines the only promotable
  paged record: one authenticated `PrintBegin`-to-`PrintEnd` epoch with page and
  table occurrence order, section/global-row/break/repeat/caption/span facts,
  writing progression, global offsets, and collapsed edge/joint decisions.
- `src/capture/paged-collapsed-table-cdp.ts` exercises real print layout but
  returns `unavailable` because public CDP carries PDF bytes only. It verifies
  the screen source restores exactly and permanently records that neither the
  PDF nor screen rectangles supplied logical ownership.

The screen repeat boundary is now explicit and authenticated. Paged media keeps
an exact fail-closed contract rather than an unbounded inference. The later
all-platform logical and final-ink release leg (DM-2560) must preserve both
states unless a complete private print transport is present.

## Headless logical corpus

`tools/collapsed-border-fragmentation-oracle.ts` launches Chromium with
`headless: true`, captures no pixels, and emits schema-3 fingerprinted JSON.
The DM-2558 run passed all twenty-one source-logical discriminators and all fifteen
destructive controls with verdict
`screen-section-fragment-record-authenticated`:

| Family | Observed logical facts |
| --- | --- |
| Whole-row multicol breaks | Three table fragments and four source-required 2 px half-edge witnesses from 4 px borders; no duplicate captured rectangle. |
| Pinned horizontal WPT shape | Four table fragments, two caption fragments, four section fragments, and three continued-row pieces. All four continuation seams omit a black row-axis edge; the adjacent-section boundary has exactly one shared edge. |
| Pinned vertical-lr/RTL shape | Four table fragments and three continued-row pieces. Every row-axis border is physically x-thin, and all four physical-x continuation seams omit the edge. |
| Pinned vertical-rl/LTR shape | The same physical-x ownership holds with the reversed block direction; all four continuation seams omit the edge. |
| Repeated sections | Header-only, footer-only, both, first-of-multiple group selection, monolithic overflow, and horizontal/vertical writing all carry explicit source-cell-witnessed occurrences, cloned rows, roles, table-box state, paint slots, and block-edge reservations despite CSSOM prototype aliases. |
| Repeat negatives | Oversized and non-avoid headers remain independently authenticated as non-repeating, matching Blink's one-quarter and applicable-break rules. Caption-only before-table-box and empty trailing states have exact pure-record controls. |
| Continued spans and fractional tracks | `colspan` interiors stay empty; fractional column offsets, `rowspan`, multiple `tbody` sources, and consecutive global row identity remain exact. |
| Captions and provenance | Caption/table-child paint slots, physical fragment ids, section ids, rows, continuations, writing state, neutral CSSOM/CDP binding, source revision, and exact restoration are present. |
| Screen versus print | Screen CSSOM reports one table and one header rectangle; the print PDF contains seven page objects. `pixelsRead` is permanently `false`. |

The controls collapse fragments, erase continuation, promote half edges,
double-paint a section edge, drop/duplicate/reorder a repeat occurrence, move it
to the wrong edge or source, fill a span interior, horizontalize vertical
writing, substitute the wrong global row/physical fragment/writing axis, and
treat screen CSSOM as print fragments. Every
mutation moves its asserted logical result.

Run it with:

```sh
npm run borders:collapsed-fragmentation-audit -- --json /tmp/collapsed-border-fragmentation.json
npx vitest run tests/collapsed-border-fragmentation-oracle.test.ts
```

Focused production coverage is explicit-headless:
`src/capture/collapsed-border-fragment-cdp.e2e.test.ts` proves authenticated
consumption and exact source restoration through a transformed ancestor, then
proves aliased prototypes become explicit independently witnessed occurrences.
`tests/border-collapse-conflict.e2e.test.ts`
keeps horizontal/vertical, whole/continued-row, span/joint, empty-fragment, and
repeated-section behavior live.

## Headless paged-media capability audit

`tools/paged-collapsed-table-ownership-audit.ts` launches Chromium with
`headless: true`, invokes its real PDF print path, reads no pixels, and emits a
schema-1 source/runtime/loader/print-parameter fingerprint. Seven fixtures
cover eight required cells: whole-row and continued-row breaks, repeated
header/footer sections, captions, span joints, vertical-lr positive and
vertical-rl negative block progression, and an empty terminal page.

The audit refuses to run as source-authenticated unless the local sparse
Chromium checkout resolves to the pinned revision. The retained local run
matched `7d859f271cbda744098ac69f44978d4edfa62be3` and produced
3/3/5/3/2/2/3 PDF pages while screen CSSOM
reported one table rectangle in every case. Every source observation restored
byte-for-byte after print, every public route returned all fourteen logical
facts as missing, all fifteen hostile mutations moved, and `pixelsRead` stayed
`false`. The verdict is
`public-print-fragment-transport-unavailable-fail-closed`; it is a passing
contract verdict, not a claim that print fragments were captured.

Run the independent screen and print legs with:

```sh
npm run borders:collapsed-fragmentation-audit -- --json /tmp/collapsed-border-fragmentation.json
npm run borders:paged-collapsed-ownership-audit -- --json /tmp/paged-collapsed-table.json
npx vitest run src/capture/paged-collapsed-table-record.test.ts tests/paged-collapsed-table-ownership-audit.test.ts
npx vitest run --config vitest.e2e.config.ts src/capture/paged-collapsed-table-cdp.e2e.test.ts
```

## Three-platform release gate

`.github/workflows/fragmented-collapsed-table-release.yml` runs three separate
legs on macOS, Linux, and Windows. The screen leg must retain all 21 exact
logical discriminators and all 15 destructive controls. The public-print leg
must retain the eight-cell, 15-mutation fail-closed result; a PDF or screenshot
cannot fill any of its 14 missing private facts. Only after those reports pass
does the terminal leg apply the unchanged reviewed border-phase envelope to
the complete DPR 1/2/4 × zoom 0.8/1/1.25 matrix.

`tools/fragmented-collapsed-table-release-gate.ts` requires all nine reports
and refuses promotion if any platform, mutation, logical verdict, artifact-set
identity, or native scenario is absent. Exact terminal ink cannot excuse an
incomplete screen record or a falsely promoted print record. The workflow
retains the complete Cartesian artifact set and every Chromium launch is
explicitly headless.

## Bounded follow-up sequence

1. **DM-2557 — completed.** The versioned source-pinned screen record is
   authenticated and consumed before vector paint; ambiguity fails closed.
2. **DM-2558 — completed.** Repeated header/footer aliases are retained only as
   clone prototypes; explicit per-fragment source-cell witnesses, Blink
   eligibility, rows, roles, table-box state, paint slots, and reserved edge
   ownership extend the DM-2557 record without a second model.
3. **DM-2559 — completed by explicit rejection.** Public CDP has no logical
   print-fragment result, so the source-pinned record refuses promotion and
   names all missing ownership facts. PDF/vector/raster evidence remains
   downstream and cannot fill the record.
4. **DM-2571 — Expose a pinned Blink paged-table physical-fragment
   transport.** This investigation owns the native helper or DevTools bridge
   needed to serialize the complete transient record during the
   `PrintBegin`-to-`PrintEnd` epoch. It may not reconstruct facts from PDF,
   screen geometry, raster output, or tolerance.
5. **DM-2560 — implemented release gate.** The three-platform workflow and
   aggregate require screen logic, public-print rejection, and native final ink
   independently. Promotion waits for its first retained complete artifact.

The dependency order prevents a release gate from blessing today's
CSSOM-only reconstruction and keeps screen fragmentation, repeated-section
ownership, print ownership, and terminal raster evidence independently
falsifiable.
