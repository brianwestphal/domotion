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
`resolveSystemFallbackKeyForCp(cp)` asks CoreText (`CTFontCreateForString`, via
the native Swift helper) which on-disk font it would pick for `cp`, registers
that face under a dynamic `sysfb:<postscriptName>` key
(`registerDynamicSystemFont`), and returns the key so the normal chain walker
opens it. Each first-seen codepoint costs one resolution; results are memoized.

Linux and Windows had no equivalent — the resolver was hard-gated
`process.platform !== "darwin" → null`. So on those platforms an
out-of-table codepoint always tofu'd, regardless of what the system could paint.

## Design — symmetric per-platform backend behind one entry point

`resolveSystemFallbackKeyForCp(cp)` is the single entry point. It memoizes per
codepoint, then dispatches by platform:

| Platform | Backend | Status |
|---|---|---|
| macOS | CoreText `CTFontCreateForString` (native helper) | shipped, always on |
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

So **0 of 4,899 sampled codepoints move under the flip** — even cleaner than Linux,
because the win32 static table (derived from a full Chromium CDP sweep in DM-987) is
comprehensive enough to own every drawable codepoint in the fixtures. When the
resolver *does* fire — a cp the static table genuinely misses, outside the sampled
coverage — it calls Chromium's own DirectWrite fallback API with the helper's
`HasCharacter` coverage guard, so it can only register the covering face Chromium
itself would paint, or report `found:false` and correctly tofu (matching Chromium).
Orphaned variation selectors are stripped upstream by `stripOrphanedDefaultIgnorables`
(DM-1158) before the resolver runs, exactly as on Linux, so the flip paints no
last-resort boxes.

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
