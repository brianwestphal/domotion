# 80 — Cross-platform live system-fallback resolver

Status: **macOS shipped** (CoreText, DM-1018) · **Linux shipped, default-on** (fontconfig, DM-1403, calibrated + flipped on in DM-1416) · **Windows shipped, default-on** (DirectWrite `IDWriteFontFallback::MapCharacters`, DM-1403, calibrated + flipped on in DM-1424).

Related: [42 — cross-platform fallback-chain calibration](42-cross-platform-fallback-calibration.md).

## Problem

Domotion routes a codepoint to a fallback font through a **static, generated
per-block table** (`FONT_PATHS` / `LINUX_FONT_PATHS` / `WIN32_FONT_PATHS` in
`src/render/font-resolution.ts`). The table is necessarily incomplete: a
codepoint it misses drops to `LastResort` — i.e. renders as **tofu** — even when
the host actually has a font that covers it and the browser would have painted a
real glyph.

macOS already closes that gap with a **live, per-codepoint resolver**:
`resolveSystemFallbackKeyForCp(cp, weight, slant, fontSize)` asks CoreText
(`CTFontCreateForString`, via the native Swift helper) which on-disk font it
would pick for `cp`, registers that face under a dynamic `sysfb:<postscriptName>`
key (`registerDynamicSystemFont`), and returns the key so the normal chain walker
opens it. Each first-seen codepoint costs one resolution; results are memoized.

The resolver takes the run's CSS description because on macOS the answer depends
on it. `CTFontCreateForString` nominates one member of a family regardless of the
requested weight, and Blink then re-selects within that family at the requested
traits + weight before painting — so the same character resolves to Songti SC
Regular at weight 400 and Songti SC Black at 900. The helper performs that second
step with the same `CTFontCreateWithFontDescriptor` call Blink makes; without it
every fallback family was pinned to the nominated cut, which is the wrong face
for 29% of codepoints at weight 700. See the "macOS: the fallback answer is
weight-dependent" section of
[the font-resolution diagram](font-resolution-diagram.md) for the transcription
and its Chromium citations.

**Windows is style-dependent too, but through one step rather than two.**
DirectWrite selects the cut *inside* `MapCharacters`, so there is nothing to
re-select afterwards — the style has to be in the call. The win32 helper takes the
run's `cssWeight` / `italic` (optionally `cssSlant` / `cssStretch`) and converts
them with `dwriteWeightFromCss` / `dwriteSlantFromCss` / `dwriteStretchFromCss`,
which transcribe `FontDescription::SkiaFontStyle()`
(`fonts/font_description.cc:477-521`, plus the nine width boundaries in
`fonts/font_selection_types.h:221-245`) and Skia's `DWriteStyle`
(`third_party/skia/src/utils/win/SkDWrite.h:83-97`) — Skia being how Blink reaches
`MapCharacters` at all (`win/font_cache_skia_win.cc:238-240` →
`SkFontMgr_win_dw.cpp:621-653` → `:928-939`). Chromium rev `7d859f27`.

The call previously hardcoded `NORMAL/NORMAL/NORMAL`, so a bold or italic run
resolved the regular upright cut and the result was reported as Chrome's pick.
Every style field is optional and defaults to the old value, so an older helper
binary or an older Node side degrades to the previous behavior rather than
mismatching.

One divergence in the same call is still open (tracked separately): Blink passes
the run's primary family name as `MapCharacters`' `baseFamilyName`
(`GetDWriteFallbackFamily`: `font_description.Family().FamilyName()`), which is
what lets a family's own font linking participate in the answer; we pass null. See
the calibration note further down — the null-base choice is what the DM-1424
sweep measured. Re-measuring it is now possible: the conformance oracle runs on
Windows with its own committed baseline (`tests/baselines/font-conformance-windows.json`,
doc 107), so the base-family change can be scored rather than argued.

**Windows also asks a question BEFORE this resolver.**
`FontCache::PlatformFallbackFontForCharacter` consults Blink's hardcoded
per-script table first and only falls through to
`GetDWriteFallbackFamily`/`MapCharacters` on a miss
(`win/font_cache_skia_win.cc:286-296`). That first stage is transcribed in
`src/render/win-font-fallback.ts` and reached through `win32FallbackChain`, i.e.
the static chain the walker runs *ahead* of this resolver — which puts the two
stages in Blink's order. See
[the font-resolution diagram §7c](font-resolution-diagram.md#7c-win32fallbackchain--blinks-hardcoded-windows-stage-transcribed).

Linux and Windows had no equivalent — the resolver was hard-gated
`process.platform !== "darwin" → null`. So on those platforms an
out-of-table codepoint always tofu'd, regardless of what the system could paint.

## Design — symmetric per-platform backend behind one entry point

`resolveSystemFallbackKeyForCp(cp, weight, slant, fontSize)` is the single entry
point. It memoizes per codepoint **and CSS description** (the macOS answer is
weight- and style-dependent), then dispatches by platform:

| Platform | Backend | Status |
|---|---|---|
| macOS | CoreText `CTFontCreateForString` + in-family cut re-selection (native helper) | shipped, always on |
| Linux | fontconfig `fc-match :charset=<hex>` | shipped, **default-on** (DM-1416) |
| Windows | DirectWrite `IDWriteFontFallback::MapCharacters` | shipped, **default-on** (DM-1424) |

Each backend resolves `cp` → an on-disk font, registers it as a `sysfb:<name>`
key, and returns the key. The chain walker is unchanged: it tries the key and
keeps it only if the opened font actually has a glyph for `cp`
(`glyphForCodePoint(cp).id !== 0`) — so a backend that returns a non-covering
face is harmless (it falls through to tofu exactly as before, never a *wrong*
glyph).

### Linux (shipped, default-on) — `resolveLinuxSystemFallbackKeyForCp`

Uses the established `fc-match` path (the same `fcMatch()` helper the Linux
static table already uses for path discovery — no new native code):

```
fc-match -f '%{file}\t%{postscriptname}' ':charset=<hex>'
```

fontconfig returns the best-priority installed font whose charset covers `cp`.
The face is registered with `extractor: "fontkit"` (the Linux chain's default
extraction), not the darwin `"native"` extractor. Verified against the
Playwright `*-noble` image (`scripts/test-linux-docker.sh`): every script
resolves to a real face — CJK→WenQuanYi Zen Hei, Devanagari→FreeSans,
Arabic→FreeSerif, Thai→Loma — rather than tofu.

**Coverage guard (DM-1416).** `fc-match :charset` ALWAYS returns a font — when
nothing actually covers `cp` it returns fontconfig's default face (e.g. WenQuanYi
Zen Hei for U+17000 Tangut, which WenQuanYi does not contain). So the resolver
opens the matched face and verifies `glyphForCodePoint(cp).id !== 0`
(`fontFileCoversCodepoint`) **before** registering it; a non-covering pick
returns null (→ tofu, as before) rather than registering a face the chain walker
would only reject downstream. The resolver therefore registers ONLY covering
faces — the calibration goal (step 3 below).

**Default-ON as of DM-1416** (set `DOMOTION_SYSTEM_FALLBACK=0` to force off — e.g.
to reproduce the pre-flip bare-table baseline). It originally shipped opt-in
(off) so DM-1403 could land with zero baseline churn until calibrated; the
calibration below proved the flip is fidelity-safe on the noble image.

> **Flag wiring note (DM-1416).** The opt-in env gate alone was inert in real
> renders: the caller checks the process-global `_systemFallbackResolutionEnabled`
> first, which was initialized `process.platform === "darwin"` only — so on Linux
> the resolver never fired in a real render (only via the `__resolveSystemFallback
> KeyForCpForTest` hook, which bypasses that gate). DM-1416 fixed the init to
> include Linux (`|| (process.platform === "linux" && DOMOTION_SYSTEM_FALLBACK !==
> "0")`) so the default-on actually takes effect.

### Windows (shipped, default-on) — DirectWrite `MapCharacters`

`IDWriteFontFallback::MapCharacters(analysisSource, …)` returns the substitute
font DirectWrite would map a run to — the same API Chrome-on-Windows uses
(`FontFallback::MapCharacters` in `font_fallback_win.cc`). It's implemented as a
new `fallback` query in `tools/win32-glyph-extractor` (`runFallbackQuery`):
`factory->GetSystemFontFallback()` + a minimal `IDWriteTextAnalysisSource` over a
single codepoint, mapped against the system font collection with a **null base
family** (pure system fallback, since the codepoint reaching the resolver is one
the primary couldn't render). It returns the same protocol shape as the macOS
CoreText helper — `{cp, found, postscriptName, familyName, path}` — so the
existing platform-agnostic `resolveSystemFallbackFonts` drives it unchanged.

**Coverage guard**: the mapped font is accepted only if `mappedFont->HasCharacter
(cp)` is true, so a non-covering result is reported `found:false` (the renderer
keeps its own last-resort) — mirroring the macOS LastResort handling and the
Linux fc-list guard.

**Resolved axes (DM-1721)**: when the mapped face is a variable-font instance,
the `fallback` entry (and the win32 `family`-query result — see doc 41) also
carries `axes` — the axis location DirectWrite resolved the face to
(`IDWriteFontFace5::GetFontAxisValues`). `resolveSystemFallbackKeyForCp` /
`resolveInstalledFont` store it on the dynamic `sysfb:` spec (`FontPath.
resolvedAxes`), and the hinted-embedded-subset pin adopts it for the axes CSS
can't derive (notably `opsz`, which DirectWrite pins per named optical
subfamily at every font size — doc 99). macOS/Linux backends report no axes;
their behavior is unchanged.

`resolveSystemFallbackKeyForCp` registers the substitute under a `sysfb:` key
with the native (helper) extractor, like darwin. **Default-on as of DM-1424** (set
`DOMOTION_SYSTEM_FALLBACK=0` to force off — e.g. to reproduce the pre-flip
bare-table baseline). It originally shipped opt-in (off) so DM-1403 could land
with zero CI-baseline churn until calibrated against Chromium-on-Windows paint
(the same staged rollout Linux had before DM-1416); the calibration below proved
the flip fidelity-safe.

Verified on the Parallels desktop Windows 11 VM (`prlctl exec`): the helper
compiles with MSVC (`cl /std:c++17 /O2 /EHsc /MT`, dwrite.lib) and resolves real
covering faces in both one-shot and `--serve` modes — U+4E00→Yu Gothic UI,
U+0905→Nirmala UI, U+0E01→Leelawadee UI, U+1000→Myanmar Text, U+1F600→Segoe UI
Emoji (the *desktop* Windows 11 fonts, vs the narrower Server set CI exposes).

## Calibration (DM-1416) — why the Linux flip is fidelity-safe

`fc-match :charset` answers "a font that covers `cp`", **not** "the font
Chromium-on-Linux would actually pick". Fidelity (doc 01) requires matching
Chromium's choice, so before flipping the flag default-on the resolver's picks
were calibrated against Chromium-on-noble painted output (the same probe-and-match
method doc 42 uses for the static chains).

**Method.** `tools/probe-1416-linux-fcmatch-vs-chromium.mjs` runs inside
the Playwright `*-noble` container: for a sample of drawable codepoints across
every per-block unicode fixture it records Chromium's painted family (CDP
`CSS.getPlatformFontsForNode`) and `fc-match :charset=<hex>`'s pick, then
`probe-1416-refine.mjs` re-checks each divergence's REAL coverage via
`fc-list :charset` (fontconfig's own charset data — only lists fonts that
actually contain the cp).

**Result** (4,899 codepoints sampled, 2,090 fc-match-vs-Chromium divergences):

| Bucket | Count | Why it's safe |
| --- | --- | --- |
| fc-match returns a **non-covering default** | 1,899 (91%) | `fc-list :charset` is empty (or excludes the pick) → the coverage guard rejects it → tofu, **which matches Chromium** (Chromium also tofus these: Tangut, cuneiform, hieroglyphs, CJK ext-B…) |
| Chromium painted a **covering** face (covers=true) | ~178 | The static chain already covers these (Chromium itself used Liberation Sans, which the chain's primary/generated route also uses) → the resolver **never fires** there |
| Chromium tofus but fc finds a covering face (covers=false) | 13 | **All orphaned variation selectors** (U+FE00–FE05, U+E0100–E0105) + the non-breaking hyphen U+2011. The variation selectors are stripped upstream by `stripOrphanedDefaultIgnorables` (DM-1158) **before** the resolver runs, so no last-resort box is painted |

So every divergence is harmless: a non-covering pick the guard rejects, a covered
codepoint the static chain already owns, or an invisible format char stripped
upstream. The flip turns genuinely-uncovered-by-the-static-table codepoints from
tofu into the real glyph Chromium's own fontconfig fallback would paint — the
intended improvement — with no case where the resolver paints a glyph Chromium
renders differently. This is calibrated to the **bare noble image** (matching
what the CI visual suite diffs against); a Noto desktop-Linux profile is DM-1404.

## Calibration (DM-1424) — why the Windows flip is fidelity-safe

The win32 resolver is the *strongest* of the three by construction:
`IDWriteFontFallback::MapCharacters` is the **exact** API Chromium-on-Windows uses
(`FontFallback::MapCharacters` in `font_fallback_win.cc`), so on the same host the
resolver asks the identical question Chromium's own fallback asks. The calibration
confirms this and quantifies it.

**Method.** `tools/probe-1424-win32-mapchars-vs-chromium.mjs` runs on the desktop
Win11 VM (`prlctl exec`, as SYSTEM): for a sample of drawable codepoints across
every per-block unicode fixture it records Chromium's painted family (CDP
`CSS.getPlatformFontsForNode`) and the family the built `tools/win32-glyph-extractor`'s
`fallback` query (MapCharacters) picks, then `tools/probe-1424-refine.mts` (host,
tsx) evaluates `win32FallbackChain(cp)` — pure routing logic, no font reads — for
every divergence to learn whether the **static** win32 chain already owns the cp
(resolver never fires) or misses it (resolver fires; the cp that matters).

**Result** (4,899 codepoints sampled): MapCharacters' null-base-family pick differs
from Chromium's painted family on 2,200 cps, plus 549 where MapCharacters tofus
(coverage guard) but Chromium painted Arial — **but every single one is a cp the
static win32 chain already owns**:

| Bucket | Count | Why it's safe |
| --- | --- | --- |
| Divergence on a **static-owned** cp | 2,200 | The static chain (block routes + the DM-987 generated per-block table) wins first, so the resolver **never fires** there — e.g. CJK Ext-B `SimSun-ExtB` (static) vs `MingLiU-ExtB` (null-base MapCharacters); CJK BMP `Microsoft YaHei` (static) vs `Yu Gothic UI`. The difference is purely null-base-family-vs-CSS-base-family and is moot. |
| MapCharacters-tofu on a **static-owned** cp | 549 | All Latin/symbol cps Chromium paints with Arial; the static chain routes them to `helvetica` (Arial) and paints exactly what Chromium does. (Pure system fallback with a null base family doesn't resolve a basic-Latin cp to Arial — a base family, not a fallback target — but the static chain already handles these, so the resolver never runs.) |
| Divergence/tofu on a cp the static chain **misses** (resolver fires) | **0** | None in the sample. |

> **This sweep's conclusion has been partly invalidated by design, on purpose.**
> Its "safe" column rests on the static chain *owning* those codepoints — i.e. on
> the DM-987 per-block table answering first and the resolver never firing. That
> table is no longer the static chain: `win32FallbackChain` now transcribes Blink's
> hardcoded stage instead, and the generated table has moved *behind* the live
> resolver. So the shadowing this sweep relied on is gone, and the resolver now
> fires on many of those 2,200 codepoints.
>
> That is the correction, not a regression: the sweep was measuring
> `MapCharacters` **with a null base family and NORMAL weight** against Chromium's
> painted family, and calling the disagreement "moot" because a sampled table
> intercepted it. Two of the three ingredients have since changed — the style is
> now the run's real one, and Blink's own first stage now runs ahead of the
> resolver as it does in Chrome. The base-family argument is the remaining one.
> Re-running this comparison needed a Windows conformance-oracle baseline, which
> now exists (`tests/baselines/font-conformance-windows.json`, doc 107) — but it
> has not been re-run. The numbers below should be read as a record of the
> DM-1424 flip decision, not as a current measurement.

So **0 of 4,899 sampled codepoints move under the flip** — even cleaner than Linux,
because the win32 static table (derived from a full Chromium CDP sweep in DM-987) is
comprehensive enough to own every drawable codepoint in the fixtures. When the
resolver *does* fire — a cp the static table genuinely misses, outside the sampled
coverage — it calls Chromium's own DirectWrite fallback API with the helper's
`HasCharacter` coverage guard, so it can only register the covering face Chromium
itself would paint, or report `found:false` and correctly tofu (matching Chromium).
Orphaned variation selectors are stripped upstream by `stripOrphanedDefaultIgnorables`
(DM-1158) before the resolver runs, exactly as on Linux, so the flip paints no
last-resort boxes. That strip does **not** consult font coverage: HarfBuzz hides
every default-ignorable after shaping whether or not the font has a glyph for it
(`hb_ot_hide_default_ignorables` rewrites it to the invisible/space glyph with a
zero advance), so a selector an emoji font happens to carry in its cmap must be
dropped just the same — keeping those painted a tofu box where Chrome paints
nothing.

The `features-windows.json` baseline gate (covered text) is unaffected: every
codepoint it exercises is static-owned, so the resolver never fires for it. There
is no committed win32 unicode/html baseline yet (the analog of the Linux
DM-1419 baseline work), so nothing else needs re-seeding for the flip.

## Testing

- `__resolveSystemFallbackKeyForCpForTest(cp)` (test-only export) drives the
  resolver directly, honoring the platform routing + the flag, so a
  Docker/Parallels probe can exercise it end to end.
- macOS path + the chain walker: existing `src/render/*.test.ts`.
- Linux (DM-1416): verified in the noble container that the flag defaults ON,
  that covering codepoints register a covering `sysfb:` key (CJK→WenQuanYi,
  Thai→Loma, Devanagari→FreeSans), and that the coverage guard returns null for
  codepoints nothing covers (Tangut U+17000, Egyptian Hieroglyph U+13000) so the
  resolver never registers a non-covering face. The full `src/render` unit suite
  and `npm run demos:test` feature visual suite pass on Linux with the resolver
  default-on (the resolver only fires on otherwise-tofu codepoints, so covered
  text is byte-identical to the pre-flip output).
- Windows (DM-1424): the helper's `fallback` query resolves real covering faces
  on the desktop Win11 VM (U+4E00→Yu Gothic UI, U+0905→Nirmala UI, U+1F600→Segoe
  UI Emoji) and correctly returns `found:false` (HasCharacter guard) for
  Tangut U+17000. The 4,899-codepoint MapCharacters-vs-Chromium sweep proved 0
  sampled codepoints move under the flip (every divergence is static-owned) — the
  measured analog of "covered text is byte-identical".
- Re-running the calibration: `tools/probe-1416-*.mjs` (Linux, in the `*-noble`
  image) / `tools/probe-1424-*` (Windows, on the desktop Win11 VM + host refine);
  see the two Calibration sections above.

## Code

- `src/render/font-resolution.ts` — `resolveSystemFallbackKeyForCp` (dispatch:
  darwin CoreText / linux fc-match / **win32 helper**),
  `resolveLinuxSystemFallbackKeyForCp` (fontconfig, with the DM-1416 coverage
  guard), `fontFileCoversCodepoint` (the coverage check),
  `registerDynamicSystemFont` (takes the extractor), `fcMatch` (the `fc-match`
  primitive), and the `_systemFallbackResolutionEnabled` init (default-on for
  Linux **and win32** unless `DOMOTION_SYSTEM_FALLBACK=0`; darwin always).
- `src/render/glyph-helper.ts` — `resolveSystemFallbackFonts` (the
  platform-agnostic `fallback`-query caller; drives the macOS Swift helper AND
  the win32 DirectWrite helper).
- `tools/win32-glyph-extractor/src/main.cpp` (DM-1403) — `runFallbackQuery`
  (`IDWriteFontFallback::MapCharacters`), `SingleStringAnalysisSource`
  (`IDWriteTextAnalysisSource`), `fontFacePath` / `fontFamilyDisplayName`
  (substitute-face path + family). Build with `tools/win32-glyph-extractor/build.ps1`
  (CMake + MSVC) or directly with `cl /std:c++17 /O2 /EHsc /MT main.cpp`.
