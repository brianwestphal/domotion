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
architecture, Node, and Chromium fingerprints. A manual CI matrix collects the
same report and evidence on macOS, Linux, and Windows; only the calibrated
default scenario gates until native artifacts support reviewed per-platform
envelopes.

Fragmented collapsed tables keep that same global winner graph. Matching
`TablePainter::PaintCollapsedBorders`, Domotion obtains physical table, section,
row, and cell fragments from `getClientRects()`, derives section-local row
offsets, and paints the relevant graph slice per table fragment. Whole-row
breaks paint half of the winning inline edge on each side of the break;
continued rows omit that inline edge and suppress the missing joint adjustment
on their block-axis edges. Adjacent sections share one final-row ownership
cursor so their common edge is not double-painted. Pure tests cover each
decision and multicol fixtures exercise both whole-row and inside-row breaks.
For multicolumn repeatable headers and footers, CSSOM exposes the repeat count
but aliases every clone to the prototype section coordinates. Domotion uses
that structural signal to place each header at its physical table fragment's
block start and each footer at its block end, preserving the global row index
and Chromium's full outer-edge ownership. Actual paged-media capture remains a
separate concern because the viewport capture path does not expose page
fragments.

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

The external `html-test` integration corpus also carries composed pages rather
than only one-property fixtures. Its real-world slice includes editorial,
pricing, mobile-app, dense admin-dashboard, multilingual messaging, and
checkout/form layouts. These pages deliberately cross otherwise independent
decisions—fallback and bidi runs inside flex/grid UI, native controls inside
responsive fieldsets, and clipping/masking/gradients inside stacking contexts.
They remain discovery inputs: a failure must be reduced to the earliest stage
that diverges before it can justify a renderer change.

### Platform and environment matrix

Every logical report records Chromium, OS image and architecture, font
inventory, locale/preferences, helper and ICU/HarfBuzz versions, scale/zoom,
corpus identity, and oracle isolation. A changed fingerprint withholds a
regression verdict rather than comparing incomparable results. Altered font
inventories are deliberate conformance profiles, not noise to normalize away.

### Visual integration and classification

Run broad sweeps on CI per the repository policy. Demo review consumes the
stage evidence when available and classifies each region as:

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
