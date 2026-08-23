# Paths-mode native-raster floor matrix

DM-2352 separates logical text identity from the terminal raster difference
between Chromium's native Skia glyph masks and consumer-rasterized SVG
outlines. DM-2499 adds the missing authenticated collector. This remains an
evidence and ratification gate; it does not change the scalar caps in the
HTML/Unicode visual harness.

## Ordering contract

Each row carries one complete environment fingerprint, matrix dimensions, lossless native/paths PNG provenance, expected Chromium logical facts, actual Domotion logical facts, and terminal residual measurements. `tools/paths-native-raster-gate.ts` checks in this order:

1. Reject partial evidence, warnings, or a byte-identical/inert raster arm.
2. Require the exact cell-owned requested/computed CSS family, sole
   `@font-face` source bytes, custom-font state, face index, variation axes,
   glyph IDs, clusters, advances, offsets, source-outline hashes,
   renderer-emitted baseline and affine matrix, and synthetic paint plan.
   CDP platform-family and PostScript strings remain diagnostic display
   metadata, not face identity.
3. Require a ratified envelope keyed by the complete environment fingerprint
   and a canonical SHA-256 of the complete declared corpus cell.
4. Require proposal and independent-validation native/path hashes to be among
   the reviewed source artifacts, then compare per-cell edge/ink/bounds/channel
   measurements.

A zero-pixel row with the wrong face, gid, outline, advance, baseline, matrix,
or paint plan is therefore `logical-mismatch`; a visually close wrong answer
can never become `accepted-rasterization-only`. Fingerprints are not portable
between OS images/releases, architectures, authenticated Chromium binaries,
font inventories, production-renderer source hashes, oracle-source hashes,
consumer rasterizers, Node/ICU,
Sharp/libvips, metric algorithms, launch flags, or locales. Chromium does not
report embedded Skia/HarfBuzz revisions at runtime, so the fingerprint names
the executable SHA for both binary-owned components and records the logical
oracle source revisions separately; it does not mislabel source pins as the
browser's binary provenance.
The two source hashes are computed from the files that can affect production
path output and adjudication respectively. Review docs and the envelope JSON
are excluded, so recording a review cannot circularly invalidate its evidence;
changing renderer or oracle logic always does.

## Source-owned corpus and complete matrix

`tools/paths-native-raster-corpus.ts` pins five upstream test files at HarfBuzz
revision `4de187dd0a915d13c976fa8bd474c084229f3aab`, verifies their SHA-256 values
and table signatures, and derives the sixth face by removing Open Sans glyf
hinting with the repository's pinned `hb-subset` build. The six declared
technologies are hinted and unhinted glyf, static CFF and CFF2, and variable
glyf and CFF2. Each technology independently covers 12/20/32 px, weights
400/600/800, all sixteen quarter-pixel X/Y phases, all five transform classes,
and DPR 1/2. The hinted-glyf anchor additionally crosses every phase with
rotate and affine instead of hiding interactions in a diagonal covering row.
This explicit 348-row union per run is the complete corpus; producer and
aggregate reject missing, duplicate, undeclared, dimension-mutated, or
cell-hash-mutated rows. Static weights above the face's declared 400 cut are
intentional synthetic-bold cells, and that paint-plan bit must agree before
pixels.

The native and paths screenshots are generated in the same pinned Chromium
process from the same exact `@font-face` bytes. CDP must report that face as a
custom font. The native arm is SVG `<text>`
and therefore enters Chromium's platform Skia glyph-mask terminal. The paths
arm is production `renderTextAsPath` output consumed by Chromium's SVG path
rasterizer. Corpus strings are deliberately one-glyph-per-Latin-scalar with
kerning and standard ligatures disabled on both arms. That makes glyph IDs,
clusters, advances, and outlines source-table facts rather than an unobservable
claim about Chromium's embedded HarfBuzz build. Before pixels are measured,
the collector reads back the exact cell-derived inline/computed family, the
sole CSSFontFaceRule family and data-URL bytes, computed variation axes, CDP's
custom-font state and painted glyph count, direct source-table facts, and
production provenance for selected registered bytes, request axes, glyph
stream and source outlines. Baseline, outer matrix, and synthetic paint plan
are parsed back from renderer-emitted markup rather than copied from the
requested cell. On Windows variable faces, the fingerprinted DirectWrite
helper independently reopens the exact source bytes and confirms face index
plus every CSS-requested axis. Its full WSS vector is retained separately as
platform metadata because DirectWrite adds standard default `ital`/`slnt` and
sometimes `wdth` coordinates that were not CSS variation requests; those
defaults must not be misrepresented as requested font-instance identity.
CDP's platform family/PostScript name and the
helper's name-ID-6 value are retained as possibly empty display metadata:
DirectWrite may expose different WSS aliases for the same source face, so
equality, prefixes, and suffix allowlists are not identity evidence.

## Producer and workflow

`tools/paths-native-raster-collector.ts` creates the complete same-run bundle.
`tools/paths-native-raster-producer.ts` then resolves real paths and confines
artifact paths to that bundle, rejects path reuse, reopens every PNG, verifies its dimensions, recomputes both SHA-256
values, and recomputes the residual from bytes; caller-supplied hashes or
metrics are not trusted. The residual records exact changed pixels, both
role-specific ink areas and `{x,y,width,height}` bounds, absolute area/size
deltas, symmetric edge Hausdorff distance in device pixels, an exact integer
total channel delta, and its normalized severity projection. These are independent
per-cell quantities, not a global image percentage.

`.github/workflows/paths-native-raster-floor.yml` checks out the pinned font
files directly, runs separate proposal and validation jobs/browser processes for
all 348 cells on macOS, Linux, and Windows, preserves all lossless PNGs, and
aggregates only after all six evidence arms finish. The
aggregate reauthenticates downloaded PNG bytes rather than trusting the
producer JSON. Missing platform/run artifacts, a non-homogeneous fingerprint,
or any incomplete 348-row matrix fails closed; no external observation bundle
is accepted.

The committed `tools/paths-native-raster-envelopes.json` is ratified from
GitHub Actions run `32621780121`. It lists the exact fingerprint/canonical cell
hash, all four proposal and validation native/path role hashes, the proposal
maxima, reviewer, and UTC review time for 1,044 platform/cell identities. Same-
role hashes may be byte-identical across independent runners (reproducibility);
native and paths hashes must differ within each run. The envelope maxima equal
the authenticated proposal residual, and
the independent validation run must remain inside those values;
if it exceeds one, proposal evidence must be recollected rather than widening
an already-reviewed envelope in place. A logical mismatch,
warning, inert pair, missing artifact, or unreviewed hash is never an envelope
candidate. Existing scalar visual-harness caps remain unchanged.

The reviewed matrix contains 2,088 rows: 348 proposal plus 348 independent
validation rows on each of macOS, Linux, and Windows at DPR1/2. All rows have
exact logical identity, zero warnings, active non-identical raster arms, and
validation residuals no greater than their proposal values. Representative
worst-residual native/path pairs were visually reviewed as aligned glyph
geometry with terminal antialiasing/hinting differences only.

Source boundary: authenticated sfnt cmap/HVAR/outline tables own this corpus's
substitution-free glyph IDs, clusters, advances, and outlines; renderer
provenance owns the selected source, axes, and emitted placement/paint plan;
Blink `core/layout/inline` owns native line placement and baseline; Skia
`src/core/SkGlyph.cpp` and `SkScalerContext.cpp` dispatch native image
generation to `SkFontHost_FreeType.cpp`, `SkScalerContext_mac_ct.cpp`, and
`SkScalerContext_win_dw.cpp`. Only that terminal platform-mask difference is
eligible for an envelope.
