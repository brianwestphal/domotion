# Demo-review stage evidence

Status: **Shipped**

CI visual artifacts include `stage-evidence.json`. It binds logical oracle
reports and the exact runner environment to visual fixtures through the
explicit `visualFixtures` and `parityAreas` links in
`tools/semantic-coverage.json`. The binding function does not accept image
scores, so neither `diffPct` nor region severity can imply a logical cause.

The first shard on every enabled platform runs the representative unified face/shaping,
layout, paint-geometry, transform, paint-order, replaced-element, and raster
boundary oracles. Missing or crashed reports remain visibly `missing`; they are
never converted into positive evidence. Unified shaping supplies Chromium
painted-face evidence plus concrete helper/HarfBuzz records for the
font-selection stage while the broader
font-conformance program remains independently owned by that parity area.

The review UI displays the applicable semantic transitions and report status on
each fixture card. These apply to every selected region on that card. Filing a
ticket still requires a human logical-stage classification; a supporting
comment remains optional. The classification survives page reloads until filing, then the ticket
permanently records it together with the evidence summary, source revision,
runner fingerprint, visual metrics, selected rectangles, and PNG attachments.

CI aggregation carries the evidence manifest through both Actions metadata and
the disposable image repository, so lazy and eager review staging preserve the
same provenance. Artifacts produced before this contract remain reviewable but
say that evidence and environment fingerprints are unavailable.

Linux Unicode raster-floor rows do not inherit a generic shaping report. The
24 non-Vedic acceptance fixtures persist their own production run evidence in
`results.json`; `src/review/linux-unicode-evidence.ts` validates its required
spans/identities and refuses raster-only classification if the controlled
hinting mutation changes face, glyph, cluster, advance, offset, or outline.
The structural Vedic Extensions row uses the same fixture-scoped transport but
is never admitted to that raster-floor set: its dedicated validator requires
the exact 14 selected-face HarfBuzz streams, Chromium's FreeSans/FreeSerif
census, and no unexpected U+25CC gid in the remaining Vedic cells.

The manually dispatched `linux-unicode-mutation-evidence.yml` workflow runs
that closed 24-row corpus in one pinned Linux container under three conditions:
production baseline, the fontconfig helper removed, and hinted subsetting
disabled. `tools/linux-unicode-mutation-matrix.ts` writes a complete matrix and
a sidecar beside every baseline fixture. It emits the logically exact
`dm-2352-raster-floor-candidates.json` feed only from rows whose helper-off arm
moves face selection and whose hint-off arm removes hint tables and changes the
raster without changing face/gid/cluster/metrics/source-outline evidence. A
logical change is reported as `logical-mismatch` and fails adjudication; pixel
percentages cannot override it.

Related: [Chromium parity verification program](129-chromium-parity-verification-program.md),
[semantic coverage inventory](136-semantic-coverage-inventory.md), and
[specialized-path activation ledger](137-specialized-path-activation-ledger.md).
