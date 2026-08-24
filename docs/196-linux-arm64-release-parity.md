# Linux arm64 published-helper and parity gate

DM-2353 closes a release-validation blind spot: building an arm64 helper on an
arm64 producer proves that the source compiles, but it does not prove that a
fresh **consumer** can acquire and execute the bytes attached to the release.
The dedicated `.github/workflows/linux-arm64-release-parity.yml` workflow runs
only on demand on GitHub's native `ubuntu-22.04-arm` runner, inside the same
pinned Playwright Noble image used by Linux visual CI.

## Release facts and trust boundary

The current package release, `v0.24.0`, contains
`domotion-glyph-paths-linux-arm64` and its checksum sidecar. The producer job
(`release-helpers.yml` run 31917759532, job 95092429915) completed successfully.
The independently versioned `icu-v78.2-domotion.1` release contains both the
arm64 executable and `icudtl.dat`, again with sidecars. The ratified bytes are:

| Artifact | SHA-256 |
| --- | --- |
| glyph helper | `68546de5c29a60efbe1bdb86e61d14d9ba10f00020c5b50583f5bc336718c250` |
| ICU executable | `dcb7be05a66b98530d0eee0759bc79d8670fe383c338a73e873f0a346b13e6bf` |
| ICU data | `9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe` |

Linux ELF helpers are not code-signed. The gate therefore requires four facts
to agree before execution: the checked-in ratified digest, the release
sidecar, GitHub's asset digest, and the downloaded bytes. It additionally
requires executable mode and a little-endian ELF64 header whose `e_machine` is
183 (AArch64). A changed release asset is a source/integrity failure, never a
reason to update a visual envelope.

The release audit preceding this workflow found zero downloads for all three
arm64 assets. That is why producer success is not recorded as consumer proof.
The first native workflow artifact with verdict
`exact-arm64-release-parity` is the evidence that closes that final operational
claim; until it is dispatched after integration, the gate exists but the live
consumer result remains pending.

## Clean-cache acquisition leg

`tools/linux-arm64-release-evidence.ts acquire` refuses any process other than
native `linux/arm64` and refuses a non-empty cache root. It calls the same async
`acquireGlyphHelper` and `acquireIcuCompanion` exports available to a published
consumer—there is no helper build in the workflow. It then:

1. authenticates the three downloaded artifacts as described above;
2. runs glyph-helper version and Fontations/fontconfig readiness probes;
3. exercises `familyMatch` at the discriminating Arial weight, batched Latin +
   Han `fcfallback`, metadata, and a real `H` outline;
4. checks the ICU protocol/version and exhaustive property digest;
5. acquires both companions a second time and requires identical paths, bytes,
   and mtimes, proving reuse rather than a hidden second install; and
6. exports the acquired paths to later workflow steps.

The acquisition report fingerprints the native architecture, OS/kernel/glibc,
GitHub image, Node/ICU/Unicode, launched Chromium, Playwright, fontconfig, full
font inventory, checkout, and all release asset digests. Volatile timestamps
remain outside the fingerprint.

The source portion is fail-closed: the checkout plus the governing Chromium,
HarfBuzz, Skia, and ICU inputs must each be a full 40-hex revision inside the
fingerprinted environment. The acquisition leg rejects an absent or abbreviated
revision, and the finalizer repeats that semantic check rather than trusting an
`acquisition-exact` label. Native run `32688604271` passed every parity leg but
recorded a null Chromium revision (and omitted the other upstream revisions),
so it is retained as evidence of the gate defect and is not release-consumer
proof.

## Parity matrix and verdict

After acquisition succeeds, the workflow runs eight independently named legs:

- helper-in-renderer-loop activation;
- exact ICU classification;
- the synthetic corpus's deterministic 13-stack prefix: one CSS-initial row
  for every generic family. The dedicated font-conformance workflows own the
  351-stack single-axis and 50,544-stack exhaustive matrices; the release job
  keeps enough budget to execute shaping, decoration, paint, HTML, and Unicode
  rather than duplicating those sweeps;
- exact logical shaping with host movement controls plus pinned, source-owned
  variable-axis and `ptem` applicability rows (doc 199);
- coherent-DPR decoration geometry with the unchanged source-owned `0.3px`
  rule-to-SVG envelope (doc 200);
- the complete source-transcribed paint corpus plus the live browser source
  discriminator;
- known-exact Linux HTML font/text fixtures; and
- known-exact Linux Unicode fixtures spanning IPA, Greek, Kawi, and variation
  selectors.

Each leg is allowed to finish red so its log/report/PNG/SVG evidence survives.
The finalizer independently checks required reports, logical verdicts,
non-empty visual results, native arm64 identity, step outcomes, and recursive
artifact hashes. Artifacts upload under `if: always()` before a separate step
enforces `exact-arm64-release-parity`.

Logical gates are exact. The HTML/Unicode legs retain the repository's existing
Linux native-raster acceptance floor and fixture classifications; this work
does not add a threshold, widen a tolerance, or fit pixels. A logical mismatch
cannot be reclassified as raster noise.

Run `32611751700` proved the first workflow reached the shaping leg and compared
686 host face/sample pairs, but its static installed faces yielded `axes: 0` and
`ptem: 0`; schema 2 therefore withheld, as designed. The current gate passes
the repository-owned Open Sans variable subset and pinned HarfBuzz `TRAK.ttf`
explicitly, requires their omission mutations to change only exact logical
advances, and records inapplicable, non-moving, and unexpected mutations
separately in schema 3. The workflow also supplies pinned source revisions to
the fingerprint. These changes activate the logical inputs; they do not add
fixture rows to the host comparison corpus or alter any raster threshold. A
fresh retained native artifact is still required after integration.

The same retained run also exposed a decoration-oracle ownership defect rather
than a renderer defect. Its Chrome paint/rule legs used DPR 4, while its
Domotion SVG leg captured a separately laid-out DPR-1 fragment; pinned Linux
arm64 placed that fragment at y=122 and y=123 respectively. DM-2501 binds both
full-matrix legs to DPR 4 and records the scales in `decoration.json`; the
aggregate finalizer refuses a cross-DPR report, a widened `0.3px` envelope, or
anything short of the full 106-row/29-pattern-row matrix. The pinned Noble
arm64 container now passes 106/106 transcription, 29/29 skip-ink/pattern, and
106/106 SVG geometry. A focused browser gate also passes coherent DPR 1 and
DPR 4. No capture or renderer behavior changed. See [doc 200](200-linux-arm64-decoration-coordinate-ownership.md).

The same run's sole significant HTML region was a separate logical ownership
finding, not native raster noise. DM-2507 now intersects pinned Chromium's
`SymbolsIterator` source-priority ranges with independently resolved
bidi/script ranges before per-item fallback allocation. The strict native
matrix is order-invariant for `✗ ❗` / `❗ ✗`, preserves opposite-CSS VS15/VS16
and declared-family precedence, and routes bare U+2757 to Noto Color Emoji.
The unchanged `02-text-emoji` fixture is clean with zero significant regions.
`.github/workflows/emoji-presentation-ownership-audit.yml` gates the exact
source partition and native route without a pixel threshold. See
[doc 201](201-emoji-presentation-item-ownership.md); DM-2508 owns only aggregate
activation of this resolved evidence.

## Maintainer commands

The pure ELF/fingerprint/finalizer and workflow-structure contracts run on any
host:

```sh
npx vitest run tests/linux-arm64-release-evidence.test.ts \
  tests/linux-arm64-release-parity-workflow.test.ts
```

The acquisition command is intentionally not runnable on macOS/x64. Dispatch
`Linux arm64 release parity` after the workflow is present on the remote ref,
then retain `final.json`, `acquisition.json`, `run-env.json`, all logical
reports, visual results, and images as one evidence artifact.
