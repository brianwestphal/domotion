# 99 — Hinting-preserving embedded-font subsets (hb-subset)

Status: **Shipped** (embedded-font render mode; flag-controlled — see [Rollout](#rollout--flag) below).

## Problem

The embedded-font render mode emits `<text>` against a per-instance `@font-face`
subset TTF. Historically that subset was built by **svg2ttf from the captured
glyph outlines** — which writes a `glyf` table from outlines ONLY. The TrueType
hinting program (`cvt `/`fpgm`/`prep` tables plus the per-glyph instruction
bytecode) does not survive, because svg2ttf never sees it.

On macOS that is invisible: CoreText's light hinting ≈ the raw outline. But on
**Windows (DirectWrite/ClearType)** and **Linux (FreeType)** the consumer
browser rasterizes the unhinted subset without grid-fitting, so stems land at
fractional pixel positions with different apparent weight and different
subpixel fringing than Chrome's own HTML paint of the ORIGINAL (hinted) font.
That systematic gap — affecting every embedded `<text>` element — was the
dominant contributor to the embedded-mode share of the per-platform "hinting
floor" documented in [42 — cross-platform fallback calibration](42-cross-platform-fallback-calibration.md).

Pixel evidence (Windows CI, unicode suite): tofu boxes and real glyphs at
IDENTICAL positions/sizes but ~8% lighter ink and heavier color fringing; a
worst-case Hangul syllable with Δcentroid < 0.6px and ink-mass ratio 1.036 —
no layout error at all, purely unhinted stroke rendering.

## Mechanism

When an embedded entry qualifies (see [Purity rules](#purity-rules)), the
builder subsets the **original font file** with harfbuzz's `hb-subset` (the
`harfbuzz-subset.wasm` binary that ships inside the `harfbuzzjs` dependency;
`src/render/hb-subset.ts` is a thin WebAssembly binding to its C API):

1. **`hbSubsetRetainGids(fontBytes, gids, faceIndex, keepHinting, pinAxes)`**
   subsets to exactly the glyph ids the SVG uses, with `RETAIN_GIDS` (output
   glyph ids equal the source font's — which the builder already tracks) and
   hinting KEPT (hb-subset preserves hinting by default; dropping it is the
   opt-in `NO_HINTING` flag). `cvt `/`fpgm`/`prep`, per-glyph instructions,
   `gasp`/`hdmx` all survive. `faceIndex` selects a TTC collection member.
2. **`compactGlyphIds(subsetBytes, wantedGids)`** renumbers the RETAIN_GIDS
   output down to a dense glyph id space — the requested gids plus the
   composite components they reference (walked from the subset's own `glyf`,
   with component ids rewritten in place), notdef staying gid 0. Without this,
   `loca`+`hmtx` are padded to the source font's max retained gid: ~178 KB EACH
   for a CJK font whose gids sit near 52k — a 48-glyph STHeiti entry was
   ~389 KB, and compaction brings it to ~33 KB (~12×). The builder's PUA map is
   translated through the returned old→new mapping. (The bundled wasm has no
   subset-plan API, so hb can't hand us its own mapping — RETAIN_GIDS + own
   compaction keeps the mapping fully under our control.)
3. **`injectPuaCmap(subsetBytes, puaToGid)`** replaces the subset's `cmap` with
   a format-12 (3,10) table mapping Domotion's private-use codepoints → those
   retained gids, rebuilding the sfnt table directory, per-table checksums and
   `head.checkSumAdjustment`. The rest of the embedded pipeline (PUA `<text>`
   stream, explicit per-glyph `x`) is untouched — only the glyph bytes gain
   hinting.

### Variable fonts: full instancing at the resolved axis location

Modern system fonts are variable (SF Pro `wght`/`opsz` on macOS, Segoe UI
Variable on Windows 11), and a naive subset of the FILE would carry the
default master — not the instance the run shaped with. So the resolver records
the **axis location** each font instance resolved to
(`FontSourceInfo.variationAxes` from `getFontSourceInfo()` in
`src/render/font-resolution.ts`):

- fontkit instances: the exact axes `applyVariationAxes` passed to
  `getVariation` (CSS weight → `wght`, font-size → `opsz` for auto optical
  sizing, slant → `slnt`, author `font-variation-settings` on top);
- native-helper instances (CoreText/DirectWrite outlines): the same resolution
  computed against the file's `fvar` axes. **Windows resolved-axes override:**
  DirectWrite does NOT apply automatic optical sizing — named optical
  subfamilies ("Segoe UI Variable Text"/"Display") are pinned at a fixed
  `opsz` at every font size (measured: Text = 10.5, Display = 36,
  width-matched to sub-0.01px). So the win32 helper (≥0.2.0) reports the
  matcher's RESOLVED axis values (`IDWriteFontFace5::GetFontAxisValues`) on
  its `family` and `fallback` query results, and the pin adopts them for
  every axis except `wght`/`slnt` (which keep tracking CSS per run — the
  matcher resolved at weight 400 only). The helper font is also OPENED at
  that axis location (`variations` in the font spec), since DirectWrite
  opening a variable file by path otherwise yields the default `fvar`
  instance — outlines/advances and the embedded pin stay the same instance.
  macOS is unaffected (no axes reported; CoreText genuinely auto-sizes SF;
  validated pixel-exact);
- `{}` when the file is variable but shaping used the default master;
- `null` when the file is static.

At build time the subset is **fully instanced** at that location: every axis is
pinned to its default (`hb_subset_input_pin_all_axes_to_default`), then each
resolved tag is pinned to its value (`hb_subset_input_pin_axis_location`). Full
pinning is deliberate — it drops `fvar`/`gvar` entirely so the consumer browser
cannot re-vary an axis we already resolved (e.g. `font-optical-sizing: auto`
re-applying `opsz` on top of outlines that already carry it). hb's instancer
applies the same `gvar` deltas fontkit's `getVariation` does (verified
outline-identical) and **retains the hinting program across instancing**.

If an axis can't be pinned, `hbSubsetRetainGids` throws and the entry falls
back to svg2ttf — which bakes the correct instantiated outline, just unhinted.

**Non-residual (`cvar`) — measured to be zero:** the bundled hb-subset drops
`cvar` on instancing without re-targeting `cvt ` at the pinned location, which
in principle leaves grid-fitting with the default master's control values. In
practice this contributes NOTHING, measured two ways on the real Segoe UI
Variable (the dominant hinted variable font):

1. Its entire `cvar` is one tuple peaking at `opsz = −1` — **zero variation
   along `wght`** (bold/light instances legitimately share the default cvt) —
   touching 3 of 117 cvt entries only below opsz 10.5 (sub-10.5px text; max
   delta 123 units ≈ 0.4px at 5px).
2. An isolated A/B on Windows 11 (real DirectWrite/ClearType in Chrome):
   two subsets identical except stale-vs-cvar-patched `cvt `, rendered at 5px
   and 8px — **zero differing pixels**. The affected control values are inert
   under DirectWrite's rendering of the embedded font.

So no correction is needed; if a future harfbuzzjs bundles an hb whose
instancer applies cvar (1.4.0, the latest as of 2026-07, does not), it's a
free upgrade, not a fix.

### Purity rules

An embedded entry takes the hinted path only while **every** glyph in it:

- came from ONE openable sfnt file (same path + TTC `faceIndex`),
- at ONE axis location (`variationAxes` deep-equal),
- was NOT synthesized (no faux-bold `emboldenPathCommands` / faux-oblique
  `shearPathCommands` bake — those outlines exist nowhere in the source file),
- and the file actually carries TrueType `glyf` outlines
  (`sfntHasSubsettableOutlines`, TTC-aware). CFF/CFF2 (`OTTO`) faces — common
  among macOS system fonts (Kohinoor, ITF Devanagari, …) — are excluded: the
  bundled harfbuzz-subset.wasm silently DROPS the `CFF ` table, and an
  outline-less "subset" fails the consumer browser's OTS sanitizer, tofu-boxing
  the whole entry (found the hard way on the macOS unicode sweep). Outline-less
  faces (PingFang's Apple-private `hvgl`) are excluded the same way. As a
  second line of defense, `hbSubsetRetainGids` validates its OUTPUT carries an
  outline table and throws otherwise.

The moment one glyph disagrees, the whole entry is disqualified and built with
svg2ttf (`trackGlyphInEmbedFont` tracks this per entry; entries are keyed per
(font, axes-tuple) instance so disqualification is rare in practice). Any
hb-subset failure likewise falls through to svg2ttf — a bad font never breaks a
render.

**Stays on svg2ttf by design:** faux-bold/italic bakes, per-glyph native-helper
outlines (glyphs fontkit couldn't decode), CFF/CFF2 faces, native-only
no-`glyf` fonts (PingFang `hvgl`), webfont buffers (no on-disk file is recorded
for them).

## Speculative composition: snapshot / restore

The builder is module-global and **append-only within a generation**. It hands
out PUA codepoints in order of first glyph use and `dmfN` family names in order
of first instance registration, so what it emits is a function of the ORDER
glyphs were tracked in. Under a nested composition (`manageFonts: false` — the
mode the compressed-run and terminal composers use) that registry is shared with
the whole outer run.

That makes a *speculative* compose — render a variant purely to measure its real
byte size, then throw it away and compose the real thing — impossible by
default: the discarded trial permanently shifts the addressing the real output
goes on to use, and its bytes change. `snapshotGeneration()` /
`restoreGeneration(marker)` close that hole:

```ts
const marker = snapshotGeneration();
const trialBytes = composeVariant(candidate).length;  // measure for real
restoreGeneration(marker);                            // as if it never ran
```

The marker is opaque and holds **values**, not cursors, so the rollback survives
a speculative pass that CLEARED a registry outright (any nested producer that
starts its own generation calls `resetGeneration()`). Markers nest
(`snapshot → snapshot → restore → restore` unwinds to each in turn), are
reusable (restoring one neither consumes it nor invalidates an outer one), and
never throw — restoring a marker taken from a never-used builder simply empties
it.

What is rolled back:

| registry | state restored |
|---|---|
| embedded-font subset builder | tracked instances + their insertion order (the `@font-face` emission order), per-entry glyph outlines, glyph-id → PUA assignments, the per-entry PUA allocation cursor, the tracked weight range (`font-weight: min max` descriptor), the hinted-source disqualification latch, and the global `dmfN` family counter |
| paths-mode glyph defs | the `<path id="gN">` def map, the key → id map, and the `gN` id counter |

Both are bundled because *which* registry is live depends on the process-global
render-text mode, so a caller snapshotting only one is correct right up until
someone flips the mode — the same footgun `resetGeneration()` exists to prevent.
`snapshotEmbeddedFonts()` / `restoreEmbeddedFonts()` are the subset-builder half
alone, for a caller that knows the mode.

Deliberately **not** covered: the webfont registry (session-scoped — only
capture mutates it, and a compose never does) and the font-instance / resolved-
spec / outline caches (memoized deterministic lookups, so they never affect
output bytes). If a speculative pass ever registers a webfont, that registration
outlives the rollback.

**Contract:** whatever the speculative pass emitted must be discarded. Its
`dmfN` names and PUA codepoints are handed straight back out to the next
composition, so keeping both outputs would alias two different subsets onto the
same names.

The intended consumer is per-region trial composition — choosing between a
per-region and a whole-run compression strategy on measured bytes rather than a
heuristic, which needs to compose each candidate for real (see doc 100's
independent-region design notes). This capability is the render-layer half only;
it does not itself make that choice.

Coverage: `src/render/embedded-font-snapshot.test.ts`, whose bar is byte
identity — compose, then snapshot → compose a variant that allocates different
PUA codepoints and family names → restore → recompose, asserting the two are
byte-identical, at both the `@font-face` CSS level and through a real
`elementTreeToSvg` render. Each byte-identity case is paired with an assertion
that the same sequence WITHOUT the restore produces different bytes, so the
test cannot quietly become vacuous.

## Measured payoff

Windows CI, `0000-007F-basic-latin`, same commit, svg2ttf vs hb-subset:

| metric | svg2ttf | hb-subset | Δ |
|---|---|---|---|
| diffPct | 0.239% | **0.018%** | **−92.6%** |
| nonAaPixelPct | 1.19% | 0.05% | −95.5% |
| shiftedPixels | 36484 | 7038 | −80.7% |
| shiftyRegionCount | 147 | **0** | −100% |
| scatteredPixels | 8678 | **0** | −100% |

The grid-fitting *shift* signature (shifty/scattered pixels) is eliminated —
exactly the unhinted-outline floor. macOS stays pixel-exact with the hinted
path on (the subset is glyph-identical; CoreText was never sensitive to the
hinting program).

Note this recovers the **embedded-mode** share of the floor. The `paths`
render mode (feature visual suite) still fills unhinted `<path>` outlines and
keeps the per-platform coverage caps in doc 42 — a hinting engine would be
required there, which is out of scope.

## Rollout / flag

The hinted path is **ON by default**. `DOMOTION_HINTED_SUBSET=0` opts out
(reverts to the svg2ttf-only builder — A/B measurement, escape hatch); the env
is read per call in `src/render/embedded-font-builder.ts` /
`font-resolution.ts`. The CI visual suite dispatches the svg2ttf arm with
`tools/run-ci-visual-tests.mjs --no-hinted-subset` (`hinted_subset` input in
`.github/workflows/visual-tests.yml`; empty = renderer default).

The default was flipped after full-sweep measurement on all three platforms:
Linux unicode went from 815 failing fixtures to 75 (740 fixed, zero
regressions vs the flag-off baseline), Windows halved its average diff on both
suites (unicode 0.505% → 0.291%, html 0.379% → 0.196%, 943/950 fixtures
improved), and macOS stayed at parity once three subset-correctness bugs the
sweep surfaced were fixed (CFF exclusion, notdef-outline retention + gid-0
addressing, TTC faceIndex resolution — see the git history for the details).

## Test coverage

`src/render/hb-subset.test.ts` + the hinted-branch cases in
`src/render/embedded-font-builder.test.ts` run against fonts **synthesized from
scratch** (`src/render/synth-test-fonts.ts`): a static hinted TTF with known
`cvt `/`fpgm`/`prep` contents and per-glyph instruction bytecode, a variable
variant (`fvar` wght 100..400..900 + `gvar` deltas with known magnitudes), and
a `ttcf` wrapper. This keeps the tests platform-independent (no
`/System/Library/Fonts` dependency — they run on the Linux vitest CI) and lets
them assert the EXACT bytes preserved: hinting tables + bytecode survive
subsetting AND instancing, `NO_HINTING` strips them, RETAIN_GIDS holds, the PUA
cmap round-trips (BMP + astral), pinning bakes the expected deltas and drops
`fvar`/`gvar`, unknown axes throw, and the builder's purity/disqualification
branches behave.

## Related docs

- [42 — cross-platform fallback calibration](42-cross-platform-fallback-calibration.md) — the per-platform hinting floor this recovers (embedded-mode share)
- [font-resolution-diagram](font-resolution-diagram.md) §9 — where the hinted/svg2ttf branch sits in the emission flow
- [52 — embedded-mode glyph fallback](52-embedded-mode-glyph-fallback.md) — the per-glyph helper fallback that disqualifies an entry
