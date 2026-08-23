# Cross-platform text-decoration geometry (DM-2345)

## Decision

Text-decoration geometry is a logical Blink layout/paint contract, not a
platform raster-tolerance problem. The oracle keeps its exact three-way gates
and unchanged `0.3px` SVG geometry envelope. This audit added effective-zoom
discriminators and a reproducible environment fingerprint; it did not tune a
pixel threshold.

The new discriminator found one source-owned renderer defect: computed CSSOM
keeps absolute `px` decoration lengths unzoomed, while Blink's used paint state
applies effective zoom. Domotion now derives the decorating box's effective
zoom from captured used/logical font sizes and scales only absolute `px`
`text-decoration-thickness` and `text-underline-offset` values. Percentage and
`em` values already resolve against the used font size and are not scaled twice.
Propagated decorations retain the scale of the decorating box.

## Source reconstruction

Pinned Chromium revision `7d859f271c` establishes the ownership chain:

- `third_party/blink/renderer/core/paint/text_decoration_info.cc` computes used
  thickness and applies the decorating box's effective zoom to absolute lengths.
- `third_party/blink/renderer/core/layout/text_decoration_offset.cc` resolves
  underline offsets and the auto gap from the same used state.
- `third_party/blink/renderer/core/paint/decoration_line_painter.cc` and Skia's
  styled-stroke implementation own style-specific snapping and raster phase
  after logical bars have been resolved.

That division is why acceptance compares Chrome paint, a direct rule
transcription, and emitted SVG geometry separately. A consumer-raster residual
cannot justify changing logical geometry.

## Linux evidence

The pinned Playwright Noble arm64 image (`mcr.microsoft.com/playwright:v1.59.1-noble`,
Chromium `147.0.7727.0`) ran the complete DPR-4 corpus after the fix:

- transcription: **109/109** exact;
- skip-ink/pattern segments: **30/30** exact;
- rule versus emitted SVG geometry: **109/109** exact.

The three new rows cover `zoom: 0.8`, `1.25`, and `2`, including auto,
explicit `px`, double-line, and skip-ink geometry. Before the production fix,
the `zoom: 1.25` Times double-underline row passed transcription but failed
rule-versus-SVG: Chrome/rule painted a 4px first bar at y=910 and the second at
y=915, while SVG emitted 3px at y=909 and y=913. Scaling absolute lengths once
made the entire matrix exact. This is a logical discriminator, not a widened
envelope.

Every JSON artifact records OS type/release, architecture, Node and ICU
versions, Chromium version, Chromium executable SHA-256, corpus SHA-256, and
the Chrome/capture device-scale ownership record.

## Windows evidence lane

`.github/workflows/windows-fidelity.yml` now has a `decoration-geometry` job.
It builds the repository's DirectWrite helper, runs the exact oracle at DPR 1
and DPR 4, and uploads both fingerprinted JSON reports even on failure. A unit
contract rejects demoted gates, tolerance flags, missing helper construction,
or missing artifacts.

The workflow must run from an integrated revision before its artifacts can be
ratified; this dirty shared-worktree audit intentionally did not publish a
temporary branch containing other tickets' changes. Any Windows mismatch is to
be reduced as a logical geometry, raster phase, font-metric, or environment
fingerprint difference before a renderer change is proposed.

## Audited residual: vertical writing

The source audit found a separate pre-existing logical divergence in
`src/render/vertical-text.ts`. Blink resolves vertical decorations around the
central baseline and makes `left`/`right` script-sensitive (Japanese/Hangul
reverse the default side relationship), then flips underline/overline when the
resolved side is over. The current renderer instead uses an empirical
`fontSize / 18` auto thickness, a fixed 1px offset, and simplified side rules.

This is not covered up by the horizontal envelope. DM-2514 tracks the dedicated
source transcription because it requires a vertical family/script/
writing-mode matrix and a line-relative paint oracle rather than a small patch
to the horizontal path.

## Validation

- pinned Linux arm64 oracle: 109/109 + 30/30 + 109/109;
- focused unit contracts for zoom resolution, propagation, report fingerprint,
  Linux release evidence, and Windows workflow wiring;
- text-to-path decoration metric tests;
- decoration coordinate-ownership browser test at coherent DPR 1 and DPR 4;
- TypeScript typecheck and lint.

See [doc 112](112-decoration-geometry-oracle.md) for oracle design and
[doc 200](200-linux-arm64-decoration-coordinate-ownership.md) for DPR ownership.
