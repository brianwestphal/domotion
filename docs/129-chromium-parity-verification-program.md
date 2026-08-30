---
id: "requirements/chromium-parity-verification-program"
title: "129 — Chromium parity verification program"
kind: "evidence"
status: "current"
owners: ["platform-release"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2315","DM-2316","DM-2317","DM-2355","DM-2557","DM-2558","DM-2568","DM-2575","DM-2586"]
code: ["src/capture/table-geometry.e2e.test.ts","tools/parity-program.json","tools/semantic-coverage.json"]
aliases: ["docs/129-chromium-parity-verification-program.md","doc-129"]
---

# 129 — Chromium parity verification program

## Goal

Domotion must match Chromium's logical rendering decisions wherever SVG can
represent the result. Repeated screenshot review remains the final integration
gate, but screenshots alone cannot prove that the correct decision procedure
ran or that an unobserved input would take the correct branch.

The program therefore establishes confidence in this order:

1. read Chromium, Chromium-pinned Skia, or HarfBuzz and identify the governing
   decision procedure;
2. classify Domotion's corresponding branch as an identical platform call, a
   cited transcription, an unavoidable SVG adaptation, or an unverified
   approximation;
3. compare the closest observable intermediate decisions with a stage oracle;
4. prove the intended mechanism is active with a negative control that must
   move a declared discriminator;
5. exercise combinations with generated transition matrices and metamorphic
   invariants; and
6. run the feature, HTML, Unicode, and real-world visual suites on all supported
   platforms, classifying remaining regions only after the logical stages.

This order is mandatory. A favorable pixel change cannot justify logic that
does not match upstream, and an exact logical result must not be distorted to
compensate for Skia-versus-SVG rasterization differences.

## Durable inventory

[`tools/parity-program.json`](../tools/parity-program.json) is the
machine-readable parity matrix. Each rendering area records:

- Domotion and upstream source surfaces;
- source-audit status;
- the current decision-level oracle, if one exists;
- generated/adversarial and platform coverage;
- the known confidence boundary; and
- the next action needed to strengthen the claim.

`npm run check:parity-program` rejects missing references, invalid states,
duplicate areas, and entries that hide their known gap or next action. CI runs
that check so the matrix cannot silently point at removed tools or documents.

The matrix is an inventory, not a scoreboard. `audited` means the governing
upstream mechanism has been traced; it does not imply exhaustive inputs.
`exact-stage-gate` means the observable logical output is compared exactly; it
does not imply pixel equality. `visual-only` explicitly identifies areas where
the present evidence cannot establish algorithmic parity.

The area matrix is complemented by the state-level inventory in
[`tools/semantic-coverage.json`](../tools/semantic-coverage.json). The area
matrix owns pipeline-wide source and oracle programs; the semantic inventory
links public feature IDs and fixture IDs to explicit `before -> after` cases,
partitions them into exact and uncovered states, and prevents broad area status
from hiding an untested decision branch.

Parity tickets whose governing logic is genuinely ambiguous carry Hot Sheet's
`Deep Thought` tag before work begins. The tag selects Max reasoning effort for
source-heavy reconstruction, multi-subsystem architectural analysis, competing
hypotheses without a cheap discriminator, and high-regression-risk audits. It
is not a size or duration label: a long CI sweep or a straightforward
transcription from a clear upstream branch does not qualify by itself. Ticket
creation and auto-prioritization both reassess this threshold so newly exposed
deep investigations receive the context automatically.

## Evidence required for a strong parity claim

An area approaches complete logical confidence only when all of the following
are true:

- every semantic branch is tied to an upstream file, revision, and decision;
- every approximation is removed, explicitly unsupported, or justified as an
  SVG representation boundary rather than fitted to screenshots;
- an exact intermediate oracle covers every observable output of that stage;
- negative controls prove each helper, resolver, cache, and specialized path is
  actually exercised;
- generated tests cover individual states and transitions between states;
- metamorphic tests cover equivalences such as neutral wrappers, node splits,
  translations, equivalent CSS syntax, and normalized 1x/2x geometry;
- macOS, Linux, and Windows reports carry comparable environment fingerprints;
  and
- visual residuals are classified as logical, paint/compositing, unsupported,
  or accepted rasterization-only rather than treated as one percentage. The
  demos-review ticket flow requires and persists that human classification; it
  never infers a pipeline stage from a pixel percentage.

No finite fixture set proves all CSS behavior. “Near 100% certainty” therefore
means exact agreement by construction for inventoried decisions, exhaustive or
rule-derived coverage over their finite input domains, and explicit boundaries
for everything not yet proven.

## Work streams

### Source-transcription audit

Audit by subsystem rather than by screenshot. Search Domotion for predicates,
tables, constants, platform branches, and raster-fallback triggers. For each,
locate the upstream decision at the recorded revision. A visual-review ticket
is a hypothesis until this audit identifies the source-backed mismatch.

### Decision-level oracles

Extend the staged model already established by docs 107, 108, 112, 116, 120,
127, and 128. Prioritize any matrix area still marked `visual-only`, then the
explicit gaps in `partial-stage-gate` and `documented-classifier` areas. The
initial geometry/order/replaced and raster-activation audits have exact stage
gates; the remaining partial text/paint domains are the next gaps.
Oracles emit structured records that can be attached to demo-review results.

The macOS SFNS split in [doc 168](168-sfns-mask-baseline-oracle.md) illustrates
the terminal-raster boundary. Exact source bytes, axes, gids, phases, baselines,
and variable-outline commands already have an independent logical gate.
DM-2568 pins the next Skia stages: Chromium's live draw matrix enters mask
strike construction and phase packing, CoreGraphics smoothing is classified at
runtime, and Skia performs its own RGB-to-A8/LCD conversion and preblend. That
source path selects a 13px scaler for the zoom-2/transform-.5 cancellation row,
and the previously drifted explicitly headless Chrome command log remains
corroboration only. The private pinned-Skia proposal collector builds at the
exact source revision and retains 26 isolated observations: exact raw/filtered
recs, `[26,26]` and cancellation `[13,13]` factorization, runtime smoothing,
gamma/preblend, embedded A8 bytes, two cold/two warm samples per scenario, and
six active controls. Collection launches no browser. DM-2575's independent
test-only pinned-headless Chromium arm now retains the browser-constructed raw
and filtered records, matrix/phase inputs, selected typeface and axes,
surface/gamma/preblend state, and every post-conversion mask byte across the
same five lifecycles and six active controls. Its 26 browser processes are all
explicitly headless; normal rows explicitly enable Chromium's macOS headless
LCD route while the surface control disables it and reaches unknown pixel
geometry/A8. The pinned browser result confirms `[13,13]` cancellation rather
than a 26px mask followed by resampling. Its false-default hook changes no
production build. The exact cross-arm adjudicator now reauthenticates both
artifacts and pairs all 26 observations without launching a browser. It
confirms the `[13,13]` cancellation decision but returns **NOT READY**:
proposal and validation reuse scenario observation IDs, do not share one
OTS/typeface, paint/surface, placement/phase, offset/gamma-table evidence
envelope, and disagree on every post-conversion mask byte. A manual-only CI
workflow therefore stays fail-closed until aligned independent artifacts are
recollected. DM-2586 now supplies the proposal-side correction: both collectors
consume a source-owned input-only manifest; an independently executed pinned
Chromium OTS wrapper authenticates the proposal's decoded SFNT; and proposal v2
uses Chromium's exact white-paint/surface/matrix envelope with arm-qualified
IDs, separately retained shaped/strike placement, normalized CoreText metrics,
full gamma/preblend buffers, records, phases, and masks. Validation v1 remains
the historical insufficient input. Validation v2 now recollects the same 26
arm-qualified cases in fresh, explicitly headless Chromium processes. It adds
direct Blink shaped advance/offset facts at the paint-owned `ShapeResultView`
seam, normalized CoreText metrics, and the complete gamma table and three
preblend buffers, while retaining the exact record/run/phase/mask evidence.
The v3 re-adjudication authenticates and pairs every observation with zero
input-integrity errors. Formerly absent shaped offsets agree everywhere and
full gamma agrees in 25 of 26 pairs; `[13,13]` cancellation remains exact. The
gate is still **NOT READY** with 498 literal mismatches in typeface, shaped
advance, placement, phase, metrics, records, gamma, and mask bytes. The next
ratification must reach zero exact mismatches rather than relabeling them. The
boundary remains partial; no screenshot tolerance or production route may
stand in for exact cross-arm equality.

Animated viewBox culling uses the one-sided optimization form of this contract
([doc 166](166-animated-culling-geometry-oracle.md)): an unculled production SVG
is the Chromium paint reference, and the compared SVG carries the production
cull decision on the same final timeline. Every painted reference instant must
remain visible; a conservative no-paint interval may remain visible. The gate
persists transformed quads, alpha ink, emitted visibility, platform/browser
fingerprints, and mutations for reference-box selection, ancestor composition,
function-first interpolation, fixed sampling, and fail-closed retention.

The border oracle separately records Chromium's paint-path decision before it
compares pixels.  At Chromium revision `7d859f271c`,
`BoxBorderPainter::PaintBorderFastPath` selects rectangular, double-rounded,
solid rounded, and partial-transparent fast paths; the complex path then splits
rounded sides between `ClipBorderSidePolygonCloseToEdges` and the general
quad/pentagon hull in `ClipBorderSidePolygon`.  Domotion's current annular-wedge
SVG now transcribes the ordinary round-curvature branch: each corner miter is
bounded by the opposite `UnionInnerCornersAndEdge()` extent derived from the
captured inner radii. A required negative control moves when the former
aspect-ratio/perpendicular-apex fallback is substituted, while the 50%-radius
mixed-side discriminator remains byte-identical and the dedicated radius and
overlap fixtures remain clean. DM-2315 adds the separate non-round path:
computed physical `corner-shape` capture, Blink's `2^parameter` curvature,
source-fitted two-cubic contours, concave inversion, opposite-corner hull
constraint, and `AlignedToOrigin` inset construction. Its composed fixture is
an activation gate across keywords, custom values, asymmetric corners, and
overlapping concave corners; pixels validate that transcription but do not
supply its constants.
DM-2316 adds the corresponding mixed-side discriminator and transcribes the
general hyperellipse side quad by normalizing each physical side, intersecting
both miters with its inner bevel hull, and rotating the result back. Concave
and mixed-curvature sides retain the close-edge branch. DM-2317 represents
`PathBuilder::AddContouredRect`'s target-rect/four-corner intersection as four
nested vector clip paths inside the border-ring mask. The narrow overlapping
scoop discriminator now passes with the entire composed fixture at 0.00%.

Collapsed table borders remain a separate model, not another per-box contour.
At the pinned revision, `TableBorders::ComputeTableBorders` builds one logical
edge graph for the table, merges cell, row, section, column, column-group, and
table sources in traversal order, and marks spanned-cell interiors
`kDoNotFill`. `TablePainter::PaintCollapsedBorders` then resolves four-way
joint ownership, converts each logical edge rectangle through the table's
writing direction, and pixel-snaps the resulting physical rectangle before
calling `DrawBoxSide`. Domotion now performs those stages once at the owning
table: its pure logical graph and joint functions have exact decision tests,
capture records the resulting physical rectangles, and the renderer paints the
single edge layer after table-part backgrounds. The generated visual fixture
crosses spans, unequal tracks, conflicts, joints, vertical-rl, and RTL at 0
regions / 0.00%. The phase oracle now runs a parameterized zoom/device-scale
matrix and records separate snap-geometry and paint-profile sections with OS,
architecture, Node, Chromium, source, corpus, and artifact fingerprints.
DM-2355/doc 191 reviewed the macOS/Linux/Windows evidence and established the
hard per-platform envelope. The later uniform `border.double` correction
pixel-snaps one reference rect before deriving both stripe boxes, so all 128
rows per scenario are now source-exact. All 144 local double rows across the
DSF/zoom matrix are zero-error, and the existing ceilings did not widen.

Fragmented collapsed tables keep that same global winner graph. DM-2557 now
authenticates a versioned physical table/section fragment record before vector
paint by requiring ordered `getClientRects()` and CDP `DOM.getContentQuads` to
agree exactly in one transform-neutral epoch at Blink LayoutUnit granularity,
then proving exact source restoration. The record carries physical fragment
ids, section source/paint slots, global rows, exact row/column offsets,
continuation state, caption slots, writing direction, and pinned provenance.
The table walker validates and consumes it once for half edges, continued-row
omissions, adjacent-section deduplication, spans, joints, and physical writing
conversion; ambiguity withholds vectors instead of reviving CSSOM inference.

Repeatable header/footer rectangles still alias every occurrence to the source
prototype, but DM-2558 no longer treats the aliases as occurrence evidence.
It authenticates Blink's first header/footer group selection, known
fragmentainer/one-quarter/applicable-avoid/no-break/no-late-start/non-nested
eligibility path, derives exact clone slots from the prototype, and requires
intrinsic source-cell hit-test membership in every physical table fragment.
The schema-3 explicit-headless, pixel-free corpus passes 21 logical
discriminators and 15 mutations across header-only/footer-only/both,
oversize/non-avoid negatives, multiple groups, monolithic overflow,
caption-only/empty table-box states, and horizontal/vertical writing. Each
record carries global rows, original/repeated role, occurrence index,
first/last table-box state, paint slot, and reserved collapsed/table edge;
drop/duplicate/reorder/wrong-source/wrong-edge evidence fails closed. The
independent paged-media
audit now pins Chromium's transient `PrintBegin`/anonymous-page-fragment/
`PrintEnd` lifetime and the `Page.printToPDF` protocol result. Public CDP returns
only PDF bytes or a stream, so the paged collapsed-table record explicitly
withholds all fourteen page/table/section/row/break/repeat/caption/span/edge/
joint/writing facts. Its seven-case, eight-cell, fifteen-mutation headless audit
passes only when every route stays unavailable, screen state restores exactly,
and no PDF/vector/raster fact is promoted. `@page` output therefore remains
outside vector ownership until a pinned private fragment transport supplies the
complete logical record; this is a bounded fail-closed result, not inferred
geometry.

The fragmented-table release workflow keeps three evidence layers independent
on macOS, Linux, and Windows. It requires the complete screen logical
discriminator/mutation set, the complete public-print fail-closed matrix, and
the existing reviewed native border-phase envelope as nine separate reports.
Its aggregate rejects a missing platform, logical drift, pixel use in a logical
leg, incomplete mutations, changed native scenarios, or missing artifact
identity; terminal ink cannot excuse a logical failure.

Captioned tables preserve a second, independent box boundary. At the pinned
revision, `TableLayoutAlgorithm` records `TableGridRect` after top captions and
before bottom captions, and `TablePainter::PaintBoxDecorationBackground` uses
that caption-excluding rect for the table's own box decoration. Domotion now
captures the same logical block interval from the laid-out caption fragments
and adjoining margins while retaining the caption-inclusive wrapper rect for
layout, descendants, and outline painting. The browser gate in
`src/capture/table-geometry.e2e.test.ts` derives the expected grid independently
from the section and table-border geometry, checks that the retired wrapper
route moves, and verifies SVG background ownership. The same gate transcribes
`FinalizeTableCellLayout`'s `builder->Children().empty()` decision for
`empty-cells: hide`: real in-flow text/element/pseudo fragments count, collapsed
whitespace and display-none/out-of-flow descendants do not, and collapsed-border
tables ignore the property. This is fragment classification, not a codepoint or
font table.

The expanded matrix's first negative control exposed a coordinate-space error:
CSSOM returns border/outline paint lengths divided by Blink's effective zoom,
while DOMRects are already physical. Capture now restores the internal zoomed
length once before SVG emission. The same DSF/zoom run moved from 309 failures
to 9 DSF=1 dotted-outline paint residuals, with all four HTML/SVG snap-model
decisions agreeing. Those final residuals were the separate thin-dotted paint
branch: widths 1--3 use square intervals plus modulo-specific endpoint dots,
whereas thicker dotted lines use inset round caps. After transcribing
`EnforceDotsAtEndpoints` and the integer outline-region boundary, all four
expanded scenarios pass 128/128 without changing a threshold or adding a
per-case offset.

The paint-geometry gate now also transcribes Blink's negative radial-gradient
domain rather than relying on SVG stop clamping. Non-repeating gradients
interpolate the zero-radius boundary color and resize the radius interval;
repeating gradients shift a negative interval forward by an integral number of
its own periods so the phase is unchanged and both radii are non-negative. The
structured oracle compares the radii, normalized stops, and boundary color,
while a mutation control proves the retired clamp moves. A live Chromium ring
probe and a composed visual fixture independently validate wholly negative,
zero-straddling, and non-repeating cases.

Conic gradients now have structured rows for center/from-angle/stop domains,
negative repeating domains, CSS-effective-zoom tile sizing, and the mandatory
Chromium raster boundary. The independent live-browser leg paints a binary
hard-quadrant sweep, while an advanced-color zoomed visual fixture verifies
that the supported capture path embeds Chromium's pixels rather than the
helper-absent CPU approximation.

SVG effect geometry boxes now transcribe Blink's object-bounds, stroke-bounds,
and local-viewport class selection. Capture preserves computed CSS-only
`clip-path` and mask declarations on cloned SVG descendants, then delegates
actual stroke joins, markers, and nested viewport resolution to the output
browser's native SVG engine. A retired HTML-box mapping control, binary live
browser samples, capture-contract E2E, and strict composed fixture validate the
boundary without adding a Domotion stroke-bounds approximation.

### Generated and metamorphic coverage

Generators enumerate rules, not handpicked “interesting” values. Keep their
seed and normalized case description in every result. Transition matrices must
cross state boundaries—nested transforms, isolation changes, adjacent fallback
runs, wrapping changes, and equivalent syntax—not merely render each state from
a clean document.

Metamorphic checks assert relationships independent of a golden image. At a
minimum, generators should test neutral-container invariance, text-node split
invariance where shaping context is unchanged, translation covariance,
equivalent computed-style syntax, helper-path movement, and scale-normalized
geometry.

The macOS font-selection leg additionally treats Blink's ideograph fallback
cache as a state machine. Its browser/helper oracle compares an isolated target,
an ordered Ext-A-plus-common-Han sequence, and navigation in the same renderer;
the matching Domotion arm uses an owned `FontRendererSession`. The oracle fails
unless the ordered sequence activates the cache and the selected face survives
navigation, while a separately launched Chromium process supplies the isolated
control. Key unit rows independently cross raw weight, full oblique slope,
orientation, and effective size.

The external `html-test` integration corpus also carries composed pages rather
than only one-property fixtures. Its real-world slice includes editorial,
pricing, mobile-app, dense admin-dashboard, multilingual messaging, and
checkout/form layouts. These pages deliberately cross otherwise independent
decisions—fallback and bidi runs inside flex/grid UI, native controls inside
responsive fieldsets, and clipping/masking/gradients inside stacking contexts.
They remain discovery inputs: a failure must be reduced to the earliest stage
that diverges before it can justify a renderer change.

The pinned composed/metamorphic pack adds seven focused repository rows and one
html-test page spanning those crossings plus SVG effects, zoom/transforms,
same-origin iframe recursion, and capture-frozen canvas state. Live Chromium
must first prove six declared relations—neutral wrapper, equivalent syntax,
node split, translation, scale, and DOM order—are active. Independent
source-versus-SVG rows then run in fresh processes on native macOS, Linux, and
Windows so cache history is not an unrecorded fixture-order axis. See
[doc 183](183-composed-metamorphic-parity-corpus.md).

### Platform and environment matrix

Every logical report records Chromium, OS image and architecture, font
inventory, locale/preferences, helper and ICU/HarfBuzz versions, scale/zoom,
corpus identity, and oracle isolation. A changed fingerprint withholds a
regression verdict rather than comparing incomparable results. Altered font
inventories are deliberate conformance profiles, not noise to normalize away.

### Visual integration and classification

Run broad sweeps on CI per the repository policy. Demo review consumes the
stage evidence under the [demo-review stage-evidence contract](140-demo-review-stage-evidence.md)
and classifies each region as:

1. wrong selection/shaping/layout decision;
2. wrong SVG geometry;
3. wrong paint/compositing order;
4. explicit unsupported behavior; or
5. accepted rasterization/hinting/antialiasing variance after logical proof.

Only the fifth class may remain without a renderer fix. A low `diffPct` does not
override an earlier logical mismatch, while a high `diffPct` is not by itself
evidence that a source-transcribed rule is wrong.

## Completion discipline

Work proceeds from the matrix's weakest evidence toward exact stage gates.
Each completed unit updates the matrix, relevant numbered requirement doc,
tests/oracle, and CI wiring in the same commit. Newly discovered gaps become
Hot Sheet tickets before the parent unit is completed. Broad all-platform
visual review follows logical changes; it does not substitute for them.
