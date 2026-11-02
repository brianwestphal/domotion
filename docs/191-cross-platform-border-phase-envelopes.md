---
id: "requirements/cross-platform-border-phase-envelopes"
title: "Cross-platform border phase envelopes"
kind: "contract"
status: "current"
owners: ["paint-effects", "platform-release"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2355", "DM-N6XJRS", "DM-RQBPPP", "DM-PPT418", "DM-132FV4"]
code: [".github/workflows/border-phase-oracle.yml", "tools/border-phase-oracle.ts", "tools/border-phase-ratifier.ts"]
aliases: ["docs/191-cross-platform-border-phase-envelopes.md", "doc-191"]
---

# Cross-platform border phase envelopes

The oracle and ratifier write the [versioned tool report envelope](267-tool-report-envelope.md) for `--json` destinations. The ratifier validates an oracle envelope before using it and temporarily accepts the flat version 2 oracle report; unknown versions fail. Baseline and run-environment inputs keep their independent formats.

The oracle accepts `--json`, `--keep`, `--dsf`, `--zoom`, and `--report-only`;
unknown options or missing values fail before capture starts.

The ratifier CLI validates `--report`, `--baseline`, `--run-env`,
`--artifact-dir`, and `--json` before reading evidence. Importing the module
does not run adjudication.

DM-2355 turns the diagnostic border/outline phase matrix from docs 127 and 129
into a hard, source-scoped regression gate. The important qualification is
**source-scoped**: a stable screenshot is not enough to ratify geometry that
does not follow Chromium's paint ownership. The gate now approves all 128 rows
in each DSF/zoom scenario because every branch has a source-owned reference
rectangle; no paint envelope substitutes for that decision.

## Source decision

The audit is pinned to Chromium
`7d859f271cbda744098ac69f44978d4edfa62be3` and its DEPS-pinned Skia
`62efacd37737505732dbe3d8daa62abd679626a1`.

- `ContouredBorderGeometry::PixelSnappedContouredBorder` converts the outer
  border to `gfx::RectF(ToPixelSnappedRect(border_rect))` before it constructs
  the paint contour. `BoxBorderPainter` initializes its outer and inner
  contours from that pixel-snapped geometry.
- The simple outline path converts its outline rectangles to integer
  `gfx::Rect`s and delegates to `BoxBorderPainter::PaintSingleRectOutline`.
  Outline width and offset are integer paint values. Thus `outline: double`
  belongs to the same source-exact square-outline geometry as solid, dashed,
  and dotted outlines.
- Dashed/dotted residuals are paint-profile evidence, not alternate reference
  geometry. Blink hands styled strokes through `StyledStrokeData` and Skia's
  dash path effect; thin dotted borders also have endpoint handling in
  `box_border_painter.cc`.

Domotion's straight solid, dashed/dotted, and outline emitters round the
reference edges consistently with that decision. Uniform double borders now
call `pixelSnappedBorderReferenceRect` once, independently rounding near and
far CSS edges, then derive both centerline boxes from that single result with
Blink's integer big-third partition. Collapsed table borders keep their
separate already-shared grid-edge ownership. Outline double remains on its
existing integer outline path and is unchanged.

The focused geometry test crosses widths 1/2/3/5 with phases 0/0.25/0.5/0.75
and compares the production input against an explicit unsnapped mutation. A
non-integral phase moves both stripe boxes by exactly the reference-edge delta;
the integral phase is the neutral control. The ratifier also rejects a
double-border paint row that drifts beyond the unchanged envelope.

## Reviewed native evidence

The unchanged producer on `main` at `8531038c3a3b48c4353d332fa6d660bf0666b2f3`
ran the full 128-row corpus at DSF 1/2/4 and zoom 0.8/1/1.25. Run
`32604023290` completed on all three desktop runners. Every one of the 27 native
HTML, emitted SVG, and img-rendered SVG scenario sets was reviewed, and the
complete artifact-set digest was byte-identical across operating systems:
`0bc025a5d57791ccf4aeaf7a6fd2b6fc9ed4aeeb17806a3faf3c0e47915c96ac`.
The visual grids had the expected 128 boxes, no clipped/missing rows, no
unrelated ink, and matching style/phase ordering. The visible residual at DSF 1
is confined to the expected thin dotted-outline coverage profile; it is not a
box displacement.

| Runner  | Fingerprint reviewed                                             | Repeat evidence                                                                                       |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| macOS   | `macos26-arm64` / `20261026.0455.2`; Darwin `25.6.0`; arm64      | Runs `41401746566` and `41401758928` (2026-11-02) produced artifact set `ab2f8e50…` byte-identically. |
| Linux   | `ubuntu24-x64` / `20261026.354.1`; Linux `7.0.0-1017-azure`; x64 | Runs `41401746566` and `41401758928` produced the same artifact set byte-identically.                 |
| Windows | `win25-vs2026-x64` / `20261021.278.1`; Windows `10.0.26100`; x64 | Runs `41401746566` and `41402137611` produced the same artifact set byte-identically.                 |

All runners used Node `v22.21.0` and Chromium `147.0.7727.15`. The report also
records platform, architecture, OS release, source pins, corpus SHA-256, and
the SHA-256 of every PNG/SVG. The adjudicator re-hashes the uploaded files and
fails if a report is detached from its evidence. A source-pin, corpus,
scenario, row, or artifact mismatch is drift and requires a fresh review;
another platform's envelope is never substituted.

A runner-fingerprint mismatch (image, image version, OS release, Node,
Chromium, or architecture) is accepted only when the run's artifact set is
byte-identical to the reviewed `repeatedArtifactSetSha256`. The artifact files
must also re-hash to the reported values. The platform's reviewed evidence must
still be stable (two or more runs with one hash). GitHub rolls runner images out
gradually, so consecutive runs land on different images. On 2026-11-02, 2 of
8 platform-runs landed on an image other than the pinned one, and every run
produced the reviewed artifact set `ab2f8e50…`. Identical native PNGs, SVGs, and
SVG rasters mean the image change cannot have affected the measured output. The
adjudication records the accepted mismatch in `fingerprint.drift` with status
`artifact-set-match`. A fingerprint change that also changes any artifact
remains drift and needs a fresh review.

## Ratified envelope

Each scenario contains 128 ratified rows and no unratified family. Thus one
platform execution ratifies 1,152 rows, and the three-platform workflow
evaluates 3,456 source-exact rows.
Both the native and SVG arms must independently select `css-edge-round` as the
best geometry model before a paint profile is considered.

The complete local 3 × 3 matrix was repeated twice after the uniform-double
change. Both runs produced artifact-set SHA-256
`e0693e707f0ae983585a7f3cf364662ac653547d62c80b07447d64e2ab31145e`;
all 144 double rows were exact at zero edge error and zero profile RMSE. The
whole-matrix maxima stayed byte-for-byte at the values below, so no envelope
changed. The existing macOS/Linux/Windows workflow is the required native
integration evidence and uploads the same lossless artifacts before a runner
fingerprint is accepted.

The observed maxima below were identical across the complete macOS, Linux, and
Windows evidence. Ceilings round an observed maximum upward to an 8-bit alpha
bucket and add only one further quantization step; they are not inherited from the old broad
0.56/0.48 diagnostic limits.

| DSF / zoom | observed edge (CSS px) | edge ceiling | observed profile RMSE | RMSE ceiling |
| ---------- | ---------------------: | -----------: | --------------------: | -----------: |
| 1 / 0.8    |                      0 |     0.003922 |                     0 |     0.003922 |
| 1 / 1      |                      0 |     0.003922 |                     0 |     0.003922 |
| 1 / 1.25   |               0.003922 |     0.007844 |              0.001538 |     0.007844 |
| 2 / 0.8    |               0.015686 |     0.019609 |              0.009682 |     0.015687 |
| 2 / 1      |               0.001961 |     0.007844 |              0.000818 |     0.007844 |
| 2 / 1.25   |               0.001961 |     0.007844 |              0.001109 |     0.007844 |
| 4 / 0.8    |               0.000980 |     0.007844 |              0.000877 |     0.007844 |
| 4 / 1      |               0.001961 |     0.007844 |              0.001322 |     0.007844 |
| 4 / 1.25   |                      0 |     0.003922 |                     0 |     0.003922 |

The 2026-11-02 refresh measured these maxima on all three platforms, identical
because the artifact set was identical. The DSF 1 residual of the half-covered
outer pixel of one-pixel dotted outlines (formerly 0.501961 / 0.189723) is gone:
dotted outline sides now start at the inset endpoint with Blink's phase-0 dot
period, and their side length is exact. The ceilings were then tightened to the
rule applied to these maxima: each is `ceil(observed × 255) / 255`, written to six
decimals rounded up, plus one 0.003922 step. The DSF 2 / 0.8 and DSF 4 / 1.25
ceilings were already at that value. The others had been derived from the
pre-fix maxima and were up to 129× looser, so a return of the 0.5px dotted
residual would have passed. `tests/border-phase-ratifier.test.ts` now derives
every platform's ceilings from its observed maxima and rejects that residual.

## Gate contract

`tools/border-phase-oracle.ts` remains the independent native producer. Its
schema-2 report serializes source pins, corpus identity, 128/0 ownership, the
source-exact residual summary, and artifact hashes. Large high-DPR pages are
captured as bounded vertical tiles and stitched without resampling device
pixels. Every capture first waits for two animation frames so a frame has been
presented, and it retries only DevTools' empty-surface error ("Unable to
capture screenshot", `PageHandler::ScreenshotCaptured`), at most four
attempts. From 2026-10-08, every hosted Linux run failed on the first capture
of a fresh DSF 4 context, at any tile size; this removed that failure.

`tools/border-phase-ratifier.ts` is a separate fail-closed adjudicator. It
requires the exact 3 × 3 scenario and 128-row inventories, checks every case's
immutable kind/style/width/phase/geometry fields, verifies both snap-model
winners, enforces the fixed source-exact envelope over every row, requires an
empty unresolved-family set, checks repeated reviewed evidence and runner
fingerprints, and verifies the artifact files against the report. Mutation
tests cover ordinary paint drift, the retired unsnapped double-border geometry,
runner/evidence drift, and runner-image rollouts. A rolled-out image passes on a
verified, byte-identical artifact set. It drifts on a changed artifact, a tampered
upload, missing artifact files, unstable evidence, or a missing runner fingerprint.

`.github/workflows/border-phase-oracle.yml` is now a pull-request and `main`
matrix gate on macOS, Linux, and Windows. It always uploads the lossless source
PNG, rendered PNG, emitted SVG, producer report, runner environment, and strict
adjudication. A failure remains visible; there is no `continue-on-error`,
cross-platform substitution, or tolerance-widening path.
