# 111 — Declared-family match conformance oracle (Windows)

`tools/family-match-conformance-win32.ts` · `npm run fonts:family-match:win32`
· baseline `tests/baselines/family-match-windows.json`

Sibling of doc 109 (macOS) and doc 110 (Linux). On Windows the structural
argument was always "the mechanism is the same call" — and this oracle exists
because that argument had never been measured, on the platform where a live
resolver once shipped "default-on" while answering nothing for weeks.

## The mechanism being scored

Windows has **no second in-family re-selection step** the way macOS does.
`FontCache::CreateTypeface` reduces to
`matchFamilyStyle(name, font_description.SkiaFontStyle())`
(`fonts/skia/font_cache_skia.cc:262-295`, `win/font_cache_skia_win.cc:170-176`,
rev `7d859f27`; same shape at tag `147.0.7727.15`), and DirectWrite picks the
cut inside that call:

- Skia (rev `fd139e79`, the revision the tag's DEPS pins):
  `SkFontMgr_DirectWrite::onMatchFamilyStyle` →
  `SkFontStyleSet_DirectWrite::matchStyle` → `FindFamilyName` +
  `GetFirstMatchingFont(weight, width, slant)` inside
  `FirstMatchingFontWithoutSimulations`
  (`src/ports/SkFontMgr_win_dw.cpp:52-92, 861-872`). The simulation-stripping
  loop is ACTIVE in Chrome (`SK_WIN_FONTMGR_NO_SIMULATIONS`,
  `skia/BUILD.gn:65` at the tag): a match that would carry DirectWrite's
  synthetic bold/oblique is retried with that styling removed, and Blink then
  applies its own synthetic-bold decision to the clean face.
- **Blink's Windows-only family-name suffix layer** —
  `FontCache::CreateFontPlatformData`
  (`win/font_cache_skia_win.cc:409-480`, tables at `:335-407`): when the
  family is not a DirectWrite family ("Segoe UI Light", "Arial Narrow"), strip
  a known weight/stretch suffix and retry with the suffix's value **replacing
  that axis of the description**. The name pins the axis: "Segoe UI Light"
  paints SegoeUI-Light at every CSS weight, while an italic run still reaches
  SegoeUI-LightItalic (the slope stays the run's). The table is deliberately
  incomplete upstream (GDI compatibility) and must not be "completed" — e.g.
  " semilight" is not in it.

Our side is the win32 glyph helper's `family` query
(`FindFamilyName` + `GetFirstMatchingFont` — the identical DirectWrite calls),
composed with the suffix layer's shipped transcription
(`src/render/win32-family-suffix.ts`), which the render path uses in
`win32FamilyKey` / `win32PrimaryCutKey` and in `matchFamilyNameToKey`'s
author-declared branch (`src/render/font-resolution.ts`).

## Method

Families are derived from the faces under `%WINDIR%\Fonts` (both the plain and
typographic family names, since DirectWrite's grouping model uses one or the
other per face), keeping only families with at least two faces. Weights are
the CSS ladder plus intermediate rungs (350 / 450 / 550) — the macOS oracle's
canonical-only sweep was blind to exactly the intermediate bands where its
port diverged. Chrome's side is CDP `CSS.getPlatformFontsForNode`
(`postScriptName`, max `glyphCount`); skip and rejection rules are doc 110's.

## Result at the time of writing (Windows 11 arm64, build 26200)

    families 44  cases 528  scored 516  skipped 12
    agreement 516/516 (100.00%)  (agreed rejections: 24)

The first measurement — before the suffix layer was ported — scored 432/516
(83.7%): all 84 misses were style-suffixed family names ("Segoe UI Light",
"Calibri Light", "Franklin Gothic Medium", "Segoe UI Black", "Segoe UI
Semibold", …) that DirectWrite's family model does not expose as families but
Chrome resolves through the suffix layer. That layer was also a real render
gap: an author-declared `font-family: "Segoe UI Light"` previously resolved to
nothing on Windows and fell through to Times.

## In-the-loop verification (disable and require movement)

Measured on the Windows 11 VM through `getFontInstance`:

    helper enabled:                sf-pro@700 → SegoeUI-Bold
                                   "Segoe UI Light" → winfam:SegoeUI-Light
                                     @700 → SegoeUI-Light (weight pinned, as Chrome)
                                     @400 italic → SegoeUI-LightItalic
    DOMOTION_DISABLE_HELPER=1:     sf-pro@700 → SegoeUI (table + synthetic bold)
                                   "Segoe UI Light" → times → TimesNewRomanPS-BoldMT

The answers move, so the DirectWrite matcher — not the static table — is what
the enabled path measures.

## Baseline discipline

Identical to doc 110: `--write-baseline` records the run plus an environment
fingerprint (platform, arch, OS build, font-inventory digest); the comparator
refuses to judge (exit 3) across any fingerprint change. The committed
baseline was recorded on the Parallels Windows 11 VM (arm64); CI's
`win25-vs2026-x64` runner differs in both arch and inventory and must record
its own baseline before the gate can grade it.

## What this oracle cannot see

- The family-nomination stage above `CreateTypeface` (the hardcoded per-script
  fallback table, `resolveFontKey`'s key table) — doc 107's oracle owns that.
- Italic and width axes are not swept.
- Simulation FLAGS. **The divergence itself is closed** — the helper now runs
  Skia's `FirstMatchingFontWithoutSimulations` loop, transcribed at the pinned
  tag rather than from the local checkout (which had restructured it). But this
  oracle still could not have *told* you: the loop only strips styling the
  request forced, so the chosen file and PostScript name coincide in almost
  every row, and a name-comparing sweep is blind to the flags either way.

  Worth keeping as a blind-spot entry rather than deleting, because the closing
  measurement is what shows the size of the blind spot. Porting the loop moved
  exactly **one** answer — `U+2758` at weight 700, `SegoeUI-Light` →
  `SegoeUI-Semilight`, in 2 of ~600k rows and **0 of 4,536 declared-family
  rows**. So the sweep would have reported "nothing changed" for a change that
  did change something, which is the definition of a blind spot rather than an
  absence of one.

  Attribution was by construction, not inference: single-change helper binaries
  were built, and only the simulation one reproduces that row.
