# Deterministic fixture faces

Subsetted fonts the frame-sequence compressor's e2e fixtures render with, so
those fixtures paint the same glyph outlines on macOS, Linux, and Windows.

They exist because the compressor e2e tests assert pixel parity between a
compressed run and the uncompressed flipbook of the same state, bounded by the
no-motion caps in `src/review/compare-pngs.ts`. Both images come from our own
renderer, so the caps only absorb the sub-pixel phase difference the
compressor's transform groups introduce — but the size of that drift depends on
which outlines get rasterized. While the fixtures asked for host-dependent
families (`Menlo`, `system-ui`, `Georgia`) the clean drift ceiling moved with
the host (88 px largest strict region on macOS vs 829 px in the Linux
container), overlapping a known compressor break at 3712 px, so no single cap
could both pass a correct build and fail a broken one. Pinning the fixtures to
these files collapses the ceiling to one number everywhere.

Consumed through `tests/fixture-fonts.ts` — never referenced by path from a
test. See that module for the two-halves usage contract (page `@font-face` for
Chrome's layout, `registerWebfont` for Domotion's outlines).

## Provenance

| File | Upstream | License |
|---|---|---|
| `DomotionFixtureMono-Regular.ttf` | [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) Regular | SIL OFL 1.1 — `LICENSE-jetbrains-mono.txt` |
| `DomotionFixtureSerif-Regular.ttf` | [IBM Plex Serif](https://github.com/IBM/plex) Regular | SIL OFL 1.1 — `LICENSE-ibm-plex-serif.txt` |

Both are unmodified apart from being subsetted to the characters the fixtures
paint. The OFL permits redistribution of modified copies under a reserved-name
rule, which is why the outputs carry neutral `DomotionFixture*` names rather
than the upstream family names.

## Regenerating

`tools/build-fixture-fonts.mjs` rebuilds both from the upstream originals (it
prints the download URLs). The subset is deterministic — same inputs and the
same harfbuzzjs version produce byte-identical output, so a re-run must leave
`git status` clean unless an input or the charset actually changed.
