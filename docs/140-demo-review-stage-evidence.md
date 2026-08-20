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

Related: [Chromium parity verification program](129-chromium-parity-verification-program.md),
[semantic coverage inventory](136-semantic-coverage-inventory.md), and
[specialized-path activation ledger](137-specialized-path-activation-ledger.md).
