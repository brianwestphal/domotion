# 80 — Cross-platform live system-fallback resolver

Status: **macOS shipped** (CoreText, DM-1018) · **Linux shipped, default-on** (fontconfig, DM-1403, calibrated + flipped on in DM-1416) · **Windows shipped, default-on** (DirectWrite `IDWriteFontFallback::MapCharacters`, DM-1403, calibrated + flipped on in DM-1424) — **and genuinely reaching DirectWrite only since DM-1889; see the correction immediately below.**

> ### Correction (DM-1889): the Windows resolver was inert from its flip until DM-1889
>
> Everything this document says about the Windows resolver's *design* held. What
> did not hold is that it ran. Between the default-on flip and DM-1889, the
> Windows path returned "no fallback font" for every codepoint, and the platform's
> measured numbers were scoring the **static** `win32FallbackChain` alone.
>
> The mechanism was a two-part interaction, neither half visibly wrong on its own:
>
> 1. The request envelope declared a base font (`postscriptName: "Helvetica"`, no
>    `fontPath`). On macOS that is essential — `CTFontCreateForString` resolves
>    *from* a base face. On Windows it is meaningless: the helper's
>    `runFallbackQuery(query, factory)` is not handed the envelope's font map at
>    all, because `MapCharacters` takes no base font.
> 2. It was not merely ignored. The helper cannot open a font by family name, and
>    **one-shot mode treats an unopenable *declared* font as fatal** — it calls
>    `die()` before running a single query. The persistent channel was disabled on
>    Windows (a spawned pipe has no OS fd there), so one-shot was the only
>    transport. Every call therefore came back as an error envelope with no
>    `results`, which the caller correctly read as "no fallback font".
>
> **Why nothing caught it, which is the part worth carrying forward.** A resolver
> that answers "nothing" everywhere does not look broken from outside. It looks
> like a platform whose static chain does all the work, and it produces a stable,
> plausible, reproducible number every run — including through the conformance
> oracle, which is the instrument specifically built to catch wrong-font bugs. The
> oracle was not at fault: it faithfully compared what the renderer does. The gap
> is that neither it nor any fixture asserts that *a mechanism is in the loop at
> all*. That is what CLAUDE.md's standing advice — disable the resolver and require
> the answer to move — is for, and it was not run on Windows after the flip.
>
> Fixed in DM-1889 by declaring no base font on Windows, and separately by giving
> Windows a working persistent channel over a named pipe. The two are independent:
> the first makes the resolver answer at all, the second makes it ~83x cheaper per
> call. Any Windows conformance figure recorded before DM-1889 describes the
> static chain, not this resolver, and is not comparable to one recorded after.

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

**The other two `MapCharacters` arguments are now the run's as well.** Both were
constants for a long time, and both were invisible for the same reason: the call
still returned a plausible font, so nothing looked broken.

- **`baseFamilyName`** — the run's primary family. Blink takes
  `font_description.Family().FamilyName()` and Skia forwards it
  (`GetDWriteFallbackFamily`); it is what lets a family's own font linking
  participate in the answer. We passed null; we now pass the family, derived from
  the file the primary key resolves to (`system-ui` comes from the OS instead,
  since it has no literal name). Note the calibration note further down measured
  the **null-base** behavior, so its numbers predate this.
- **`locale`** — the fallback locale, and this one has teeth. Blink resolves it
  *per codepoint*:

  ```cpp
  const LayoutLocale* fallback_locale = FallbackLocaleForCharacter(
      font_description, fallback_priority, codepoint);
  Bcp47Vector locales;
  locales.push_back(fallback_locale->LocaleForSkFontMgr());
  ```

  (`win/font_cache_skia_win.cc:228-240`, rev `7d859f27`). Skia takes
  `bcp47[bcp47Count - 1]` and hands it to `MapCharacters` as the analysis
  source's locale name (`SkFontMgr_win_dw.cpp:634-652` → `:900-939`, Skia rev
  `ebf5052`). Our helper's `SingleStringAnalysisSource::GetLocaleName` returned a
  hardcoded `L"en-us"` — the class comment said so outright — so every query was
  asked in English regardless of the page.

  That is the Han-unification trap on the third platform, and the fix is a
  transcription rather than a pass-through of the CSS `lang`:
  `FallbackLocaleForCharacter` composed with `LocaleForSkFontMgr` lives in
  `blinkWinFallbackLocale` (`src/render/win-font-fallback.ts`) and is pinned
  against Blink's own `locale_test_data` table
  (`platform/text/layout_locale_test.cc:60-131`) row for row. Three branches:
  emoji priority → `und-Zsye` / `und-Zsym`; `uscript_getScript(cp) == USCRIPT_HAN`
  → `LocaleForHan(...)` reduced to `ja` / `ko` / `zh-Hans` / `zh-Hant`, or Blink's
  `kChineseSimplified` literal (`"zh-Hant"`, `font_cache_skia_win.cc:153` — the
  identifier and the literal disagree upstream, and we send the literal);
  otherwise the content locale reduced to `language[-Script]`.

  **The reduction is the load-bearing part, and it was measured on DirectWrite
  rather than reasoned from the Linux equivalent.** Same host, same codepoint
  U+6F22, only the tag varying (Win11 VM, stock font set):

  | tag | family DirectWrite maps to |
  | --- | --- |
  | *(none — the old hardcoded `en-us`)* | Yu Gothic UI |
  | `ja` / `ja-JP` | Yu Gothic UI |
  | `ko` / `ko-KR` | Malgun Gothic |
  | `zh-Hans` / `zh-CN` | Microsoft YaHei UI |
  | `zh-Hant` / `zh-TW` / `zh-HK` | Microsoft JhengHei UI |
  | **`zh`** | **Yu Gothic UI** |

  The last row is the one to internalise. Truncating a tag to its primary subtag
  destroys the entire signal and lands on a *Japanese* face — which is what Skia's
  own comment at the call site warns about (`SkFontMgr_win_dw.cpp:641-643`:
  "DirectWrite supports 'zh-CN' or 'zh-Hans', but 'zh' misses completely and may
  produce a Japanese font"), and it would be indistinguishable from never having
  plumbed the argument at all. It is also the **opposite** reduction from the one
  the Linux path needs, where fontconfig speaks language-REGION and does not
  understand `Hans` (see `fcLangProperty`). Two matchers, two answers, measured
  separately — do not carry one platform's conclusion to the other.

  The locale joins the per-codepoint memo key (`fallbackCacheKey` in
  `src/render/glyph-helper.ts`) for the same reason `baseFamilyName` did: the
  answer is a function of it, so a blind key would serve whichever language asked
  first to every later run on a multilingual page.

  Absent field ⇒ the helper keeps its old `en-us`, so an older Node side against a
  newer helper degrades to the previous behavior rather than to no locale at all.

- **The number substitution.** Skia builds an `IDWriteNumberSubstitution` from
  that same tag and returns it from the analysis source's
  `GetNumberSubstitution` (`SkFontMgr_win_dw.cpp:637-641` and `:572-579`, Skia
  rev `fd139e79` — the revision Chromium tag `147.0.7727.15` pins through
  `DEPS`). The helper used to return null there. All three arguments are
  choices: method `DWRITE_NUMBER_SUBSTITUTION_METHOD_NONE`, the locale tag the
  source reports, and `ignoreUserOverride = TRUE`, which deliberately excludes
  the host user's numeral-shape preference from the question. Now transcribed.

  **It is measured answer-neutral, which is a different statement from "method
  NONE means no substitution, so it cannot matter".** The old note reasoned the
  second way and recorded the gap rather than closing it; the argument was
  plausible, and plausible arguments about dropped arguments are what hid the
  hardcoded `en-us` locale, the NORMAL/NORMAL/NORMAL style triple and the null
  `baseFamilyName` before it. A/B on the Win11 VM, one binary with the
  substitution and one without, comparing the full response for every codepoint:

  | sweep | codepoints | answers moved |
  | --- | --- | --- |
  | every Unicode `Nd` digit × 10 locale tags (`en-us`, `ja`, `zh-Hans`, `zh-Hant`, `ko`, `und-Zsye`, `und-Zsym`, `th`, `ar`, `hi`) | 7,700 | 0 |
  | full BMP at weight 400 and at weight 700 italic | 126,976 | 0 |
  | SMP at the emoji locale, astral plane at stride 16 | ~127,000 | 0 |

  So the substitution changes no answer on that host — but it is now the same
  call Chrome makes, rather than an omission defended by an argument.

  **When DirectWrite rejects the tag**, Skia's `HRNM` abandons the whole match
  and returns null, which Blink turns into `return nullptr`
  (`win/font_cache_skia_win.cc:242-244`) — "no DirectWrite fallback family",
  exactly what this protocol's `found:false` means. The helper mirrors that and
  additionally reports `"numberSubstitution":"failed"` on the query so a
  rejected tag is visible rather than looking like universal non-coverage. That
  bail is measured unreachable for our inputs: 66 tags — both emoji
  pseudo-locales, the CJK shortcut set, 50 realistic `language[-Script]`
  reductions, and deliberately malformed shapes (`!!`, `en_US`, a 200-character
  string) — were all accepted.

- **The simulation-stripping loop around `MapCharacters`**
  (`SkFontMgr_win_dw.cpp:645-687`, same revision). When DirectWrite answers with
  a face carrying `DWRITE_FONT_SIMULATIONS_BOLD` / `_OBLIQUE`, Skia re-issues the
  match with that style axis reset, so Blink receives a clean face and makes its
  own synthetic-bold decision. Active in shipping Chrome because Chromium defines
  `SK_WIN_FONTMGR_NO_SIMULATIONS` (`skia/BUILD.gn:65` at the tag). Unlike the
  number substitution this one **does** move an answer: at weight 700, U+2758
  LIGHT VERTICAL BAR resolved to `SegoeUI-Light` before and `SegoeUI-Semilight`
  after — one row in ~600,000 compared, and the same row through the renderer
  seam, not just the binary. See [doc 41](41-windows-glyph-extraction.md) for
  the family-query half of the same transcription.

**Windows also asks a question BEFORE this resolver.**
`FontCache::PlatformFallbackFontForCharacter` consults Blink's hardcoded
per-script table first and only falls through to
`GetDWriteFallbackFamily`/`MapCharacters` on a miss
(`win/font_cache_skia_win.cc:286-296`). That first stage is transcribed in
`src/render/win-font-fallback.ts` and reached through `win32FallbackChain`, i.e.
the static chain the walker runs *ahead* of this resolver — which puts the two
stages in Blink's order. See
[the font-resolution diagram §7c](font-resolution-diagram.md#7c-win32fallbackchain--blinks-hardcoded-windows-stage-transcribed).

> **Ordering correction (DM-1868) — Windows is now the only platform that runs
> the static chain first.** On macOS and Linux this resolver is consulted
> **before** `fallbackFontChain`, because Blink has no static stage there:
> `mac/font_cache_mac.mm` goes straight to `CTFontCreateForString`, and
> `linux/font_cache_linux.cc:89-97` straight to fontconfig. Windows keeps
> chain-first for the reason described just above — there, the hardcoded table
> genuinely is Chrome's first answer.
>
> **Tightened since to a degraded-mode-only net on macOS/Linux:** the static
> chain no longer answers at all while this resolver is in the loop — it is
> gated on the helper binary being absent or the resolver being flagged off
> (`DOMOTION_SYSTEM_FALLBACK=0`). Measured behind the live-first order it
> answered 6 of 916,119 system-stage decisions on macOS (0 of 779,964 on
> Linux), all six of them lone variation selectors routed to Noto Sans —
> divergences from Chrome, not coverage. A codepoint the OS declines on a live
> host now reaches the uncovered terminal, which is Chrome's own answer.
> Windows is unchanged: its chain is Blink's mechanism and stays
> unconditional.
>
> This invalidates a phrase repeated in the validation records below: *"the
> resolver only fires on otherwise-tofu codepoints, so covered text is
> byte-identical."* That was true of the DM-1416 / DM-1424 flips as measured, and
> it remains the right description of **Windows**. It is no longer true of macOS
> or Linux, where the resolver now answers first for every codepoint it can
> resolve. Read those records as history of what each platform flip measured at
> the time, not as a current statement of when the resolver fires.

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
single codepoint, mapped against the system font collection. The query carries the
run's style triple, its primary family as `baseFamilyName`, and its fallback
`locale` (which the analysis source reports from `GetLocaleName`) — see "The other
two `MapCharacters` arguments" above; each is optional and each absent field keeps
the pre-existing constant. It returns the same protocol shape as the macOS
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

> **This verification is the one that let DM-1889's inertness through, and how it
> did is worth keeping.** Every claim in it is true. It exercises the *helper
> binary*, driven by a hand-written envelope that declares no unopenable font — so
> the binary answers correctly, as shown. What it never exercised is the envelope
> the **Node side actually sends**, which declared a base font the binary could not
> open and which one-shot mode treats as fatal. A component test of the far side of
> an interface cannot see a defect that lives in what the near side puts on the
> wire. The lesson generalises past this bug: verify the helper *through the caller*,
> or at minimum assert on the exact bytes the caller emits — which is now pinned by
> `src/render/win32-fallback-envelope.test.ts`.

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

## The macOS answer is order-dependent for ideographs — the document cache

The persistent helper's font cache excludes fallback cascade bases. Node marks
those macOS font specs `requestScoped`, so each envelope opens the current run's
base afresh while glyph, metadata, and shaping fonts remain cached. This mirrors
Blink's per-run `PrimarySimpleFontDataWithSpace` input to
`CTFontCreateForString` (`mac/font_cache_mac.mm:128-150`, Chromium `7d859f27`)
and prevents CoreText state on a reused base handle from crossing runs.

Chrome-on-macOS does not resolve ideograph fallback per codepoint. For any
codepoint with the Unicode property `[:Ideographic=Yes:]`, Blink caches the
result of the system-fallback ask (CoreText cascade + in-family re-selection)
under a `CharacterFallbackKey` — the BASE font's PostScript name, raw weight,
raw style, orientation, and effective font size — and returns that face for any
later ideograph it covers, without re-asking CoreText
(`mac/font_cache_mac.mm:330-372`; `mac/character_fallback_cache.mm`; the
`MacCharacterFallbackCache` runtime feature is `status: "stable"` at the
shipping tag 147.0.7727.15). The insert is first-writer-wins (WTF
`HashMap::insert` does nothing when the key is present), only successful asks
insert, and a dot-prefixed base gets no key at all — the UI font Blink creates
passes a null language, whose descriptor then lacks the language attribute
`BuildIdentifierKey` requires, so `system-ui` runs are never cached.

Measured consequence (CDP `CSS.getPlatformFontsForNode`, `serif`/16px/800):
U+4E9F alone resolves to `STSongti-SC-Black`; preceded by U+3400 (Ext-A, which
Black does not cover) both paint `STSongti-SC-Bold` — the first ideograph's
kept-nominated Bold was cached and answered for every later ideograph it
covers. A context-free resolver paints two Songti cuts on a page where Chrome
paints one.

The mirror is a document-scoped cache around the darwin branch of
`resolveSystemFallbackKeyForCp` — see doc
[font-resolution-diagram § 8b](font-resolution-diagram.md) for scope rules
(explicit `beginCharacterFallbackDocument()` / `end…()` pairs opened per
top-level render, per multi-frame composition, and per oracle sweep; no scope →
context-free, so ordering can only ever be document order, never sweep order).
Two flags A/B the mechanism: `DOMOTION_MAC_CHAR_FALLBACK_CACHE=0` disables the
document cache; `DOMOTION_FALLBACK_BASE_CUT=0` restores the base-entry cascade
base (the base must otherwise be the primary's weight-matched cut —
`Times-Bold` at 800 — because `CTFontCreateForString`'s nomination tracks the
base's own cut, and the cache then propagates that first nomination).

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

## Emoji takes a different question on every platform

Blink does not ask the platform about an emoji-presentation run the way it asks about ordinary text, and the substitution is different on each platform. Both are transcribed rather than approximated.

**macOS** short-circuits before the cascade is consulted at all — a by-name lookup of `Apple Color Emoji` (`mac/font_cache_mac.mm:319-324`), so the cascade base is irrelevant for emoji.

**Linux** keeps the fontconfig query but substitutes **both of its arguments** (`linux/font_cache_linux.cc:71-77` and `:89-93`):

| argument | ordinary run | emoji-presentation run |
| --- | --- | --- |
| character | the run's codepoint | **U+1F46A FAMILY** (`uchar::kFamily`) |
| locale | `font_description.LocaleOrDefault()` | **`und-Zsye`** (`kColorEmojiLocale`, `fonts/font_cache.cc:82`) |

Both matter, for different reasons. Asking about FAMILY is deliberate over-asking — Chromium's own comment says it is "in the hope to find a suitable emoji font", because a font covering FAMILY is a real emoji font where a font covering some *individual* emoji may be an ordinary text face that happens to carry a few. `und-Zsye` is what steers fontconfig toward a colour font instead of toward the page's language.

Measured in the Playwright `noble` image, with and without the substitution:

| codepoint | without | with |
| --- | --- | --- |
| 😀 U+1F600 | Unifont Upper (monochrome bitmap) | **Noto Color Emoji** |
| 👪 U+1F46A | Unifont Upper | **Noto Color Emoji** |
| ⌚ U+231A | FreeSerif | **Noto Color Emoji** |
| ☀ U+2600 (text presentation) | IPAGothic / IPAPGothic per locale | unchanged |
| 漢 U+6F22 | WenQuanYi Zen Hei | unchanged |

`⌚ → FreeSerif` is exactly the failure the FIXME describes. The two bottom rows are the control: non-emoji queries are untouched, and U+2600 still varies with the locale, so the locale substitution is scoped to emoji rather than applied globally.

The predicate is `isEmojiPresentationCp` — `Emoji_Presentation` minus `Emoji_Modifier`, from Unicode properties rather than a hand-listed range set. It is the closest a per-codepoint resolver can come to Blink's `IsEmojiPresentationEmoji`, which is a property of the segmented **run** (`kEmojiEmoji | kEmojiEmojiWithVS`): a text-presentation codepoint followed by U+FE0F is emoji-presentation for Blink and is not here.
