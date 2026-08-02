# 106 — Blink font-resolution parity inventory

Status: **in progress** (DM-1854 step 0). This is the reference the parity work hangs off: for each stage Blink runs, what we do, and whether it matches **by construction** or only **by measurement**.

The goal (DM-1854) is a guaranteed match of the *mechanism*, not less code. A stage matches by construction when it is either transcribed Blink logic or the identical API call with identical arguments. "Scores well on the fixture corpus" is explicitly **not** a passing verdict here — every wrong-font bug in the 2026-07 cycle scored well right up until it didn't.

All Chromium references are to the in-repo checkout, `external/chromium`, at revision **7d859f27 (2026-06-27)**. Re-read it rather than trusting this doc if the two disagree; and when a transcribed constant later disagrees with measured paint, suspect checkout drift first (`git -C external/chromium log -1 --format='%h %cd' --date=short`).

---

## 1. Blink's master sequence

`third_party/blink/renderer/platform/fonts/font_fallback_iterator.h:72-80` declares the stage machine, driven by `FontFallbackIterator::Next()` (`font_fallback_iterator.cc:119`):

```
kFallbackPriorityFonts          emoji / priority face — ONE attempt, then jumps straight to kSystemFonts
kFontGroupFonts                 the declared CSS family list
kSegmentedFace                  @font-face unicode-range segments
kPreferencesFonts               (declared but never entered — see below)
kSystemFonts                    the platform system-fallback procedure (§2)
kFirstCandidateForNotdefGlyph   re-returns the FIRST candidate, to paint its .notdef
kOutOfLuck
```

Two details that are easy to get wrong and that we currently do get wrong:

**`kFallbackPriorityFonts` is one shot.** `font_fallback_iterator.cc:124-133` — it tries a single fallback-priority font and unconditionally sets `fallback_stage_ = kSystemFonts` before doing so. It does not walk a list.

**The terminal is not a "tofu font".** When `kSystemFonts` is exhausted, Blink asks `FontCache::GetLastResortFallbackFont`, and then `kFirstCandidateForNotdefGlyph` returns the **first candidate** so its `.notdef` paints. On macOS `GetLastResortFallbackFont` returns **Times** (`mac/font_cache_mac.mm:376-388`, falling back to Lucida Grande "in the highly unusual case where the user doesn't have it"). The source carries a TODO wishing it used the Unicode LastResort font — i.e. Blink deliberately does **not**:

> `// TODO: crbug.com/42217 Improve this by doing the last run with a last resort font that has glyphs for everything, for example the Unicode LastResort font, not just Times or Arial.`

**`kPreferencesFonts` is dead.** It appears in the enum but there is no `fallback_stage_ = kPreferencesFonts` anywhere in the `.cc`. Do not implement it.

## 2. `kSystemFonts` is three different procedures

This is the single most important row in the inventory. Assuming one shape generalizes is exactly how the Windows gap went unnoticed until a fixture failed.

| Platform | Entry point | Shape |
|---|---|---|
| macOS | `mac/font_cache_mac.mm` → `GetSubstituteFont` → `CTFontCreateForString(ct_font, string, range)` | asks CoreText, **base = the run's current font**; the answer depends on that base |
| Linux | `linux/font_cache_linux.cc` → `FontCache::GetFontForCharacter` → `WebSandboxSupport::GetFallbackFontForCharacter(c, preferred_locale, …)` sandboxed, else `gfx::GetFallbackFontForChar(c, locale, …)` | fontconfig, keyed on **locale**; there is no base font |
| Windows | `win/font_cache_skia_win.cc:286-295` → `GetFallbackFamilyNameFromHardcodedChoices` **first**, `GetDWriteFallbackFamily` only as fall-through | a transcribable table wins whenever it matches; the OS is the backstop, not the primary |

The Windows table is `win/font_fallback_win.cc` (609 lines): `GetFallbackFamily()` → color emoji → text-presentation emoji → `GetFontBasedOnUnicodeBlock` → **74 `USCRIPT_*` → font-list mappings** in `InitializeScriptFontMap` → non-BMP plane routing → last resort `"Lucida Sans Unicode"`.

## 3. Our implementation, mapped

| Blink stage | Ours | Matches by construction? |
|---|---|---|
| `kFallbackPriorityFonts` | emoji handling is spread across `isEmojiCp` in `fallbackFontChain` + the raster-overlay path | **No** — not modelled as a distinct one-shot stage |
| `kFontGroupFonts` | `resolveFontKey` / `resolveFontKeyChain` / `matchFamilyNameToKey` | **No** — probe-calibrated against Chrome-macOS, not transcribed |
| `kSegmentedFace` | `webfontRegistry` + unicode-range partitioning (docs/30) | Plausibly; **unaudited** |
| — | **`fallbackFontChain`** — static per-block chains + the generated `unicode-font-routing.*.generated.ts` tables | **No Blink counterpart at all** — but no longer interposed; demoted to the net BELOW `kSystemFonts`, see §4 |
| `FallbackFontForCharacter`'s PUA / noncharacter guard | `isPrivateUseCodepoint(cp) \|\| isNonCharacterCodepoint(cp)` gating both fallback stages in `resolveFontForCodepoint` | **Yes** — transcribed from `font_cache.cc:242-244`, predicates from `character.cc:290-296` |
| `kSystemFonts` | `resolveSystemFallbackKeyForCp` → `resolveSystemFallbackFonts` → native helper (`CTFontCreateForString` on macOS, `main.swift:482`) | **Yes on macOS** — same API, and since DM-1852 the same argument (the run's own primary as cascade base) |
| `GetLastResortFallbackFont` | `last-resort` key → bundled `LastResortHE-Regular.ttf` | **No** — Blink returns **Times** on macOS; ours paints Unicode LastResort's per-block frames |
| `kFirstCandidateForNotdefGlyph` | embedded mode renders the primary's `.notdef`; paths mode does too for private-use / noncharacter codepoints, but still pins the last chain entry's otherwise | **Partial** — correct for the codepoints Blink reaches this stage with *directly*; the residual is the general uncovered case, where ours still uses the last candidate rather than the first |

## 4. The core structural divergence

**`fallbackFontChain` has no counterpart in Blink.** Blink goes declared families → (segments) → system fallback. We interpose a static per-Unicode-block table between them, so on any codepoint that table covers, we answer *before* ever asking the OS the question Chrome asks.

That single interposition is the root of the whole 2026-07 wrong-font cycle:

- the table was **sampled** from one Mac's CoreText replies, so it froze that machine's font inventory into source — it names `SF Pro Text`, a separate Apple download, for Cyrillic (DM-1844);
- where the table and the live resolver disagreed, the table won, and the live one was the one matching Chrome (DM-1811);
- and because the table usually answers, the live path's own defects (wrong base font) stayed invisible.

Each was fixed as an instance. The structural fix is to stop interposing: let `kSystemFonts` be the stage that answers, as it is in Blink.

### Status: fixed (DM-1868)

`resolveFontForCodepoint` now runs the two stages in Blink's order **on macOS and Linux** — the live system-fallback resolver answers, and `fallbackFontChain` is consulted only for what the OS declines. The chain is **not removed**, because it is genuinely load-bearing as a fall-through: a host without the glyph helper, a platform whose live resolver is flagged off, or a codepoint the platform engine has no answer for would otherwise drop straight to tofu. It is a net, not a competitor. `DOMOTION_LIVE_FALLBACK_FIRST=0` restores the old order for an A/B.

**Windows is excluded, which is the §4 asymmetry honored rather than simplified away.** `kSystemFonts` bottoms out in `FontCache::PlatformFallbackFontForCharacter`, and that is a different procedure per platform: macOS goes straight to `CTFontCreateForString`, Linux straight to fontconfig (`linux/font_cache_linux.cc:89-97`, no table stage before it), but Windows consults `GetFallbackFamilyNameFromHardcodedChoices` **first** and only "fall[s] through to running the API-based fallback" on a miss (`win/font_cache_skia_win.cc:285-295`). Since `win32FallbackChain` now transcribes that hardcoded table, running the static chain ahead of the live resolver is exactly what matches Chrome on Windows — flipping it there would put `MapCharacters` in front of the table and invert what the transcription was written to reproduce. Note that no macOS fixture sweep could have caught this; only reading the per-platform source could.

The measurement that justified the flip, against the conformance oracle rather than fixture scores:

| CJK slice (8 corpus stacks × 28,309 codepoints) | mismatches | routes | agree-exact |
|---|---|---|---|
| chain-first, named cascade base (both old) | 113,963 | 27 | 49.4% |
| chain-first + UI-font cascade base | 113,908 | 23 | — |
| OS-first, named cascade base | 113,407 | 16 | — |
| **OS-first + UI-font cascade base (both now default)** | **29,025** | **4** | **86.9%** |

Completed as a full 2×2 in DM-1859, when the UI-font cascade base became the default too; all four cells are one revision measured with one instrument.

Two things this demonstrates, and they are the point of this whole entry. **A correct fix to a shadowed stage is worth almost nothing:** fixing the cascade base — verified 18/18 against Chrome — moved **55 rows out of an expected 83,838**, because `[pingfang-sc, cjk]` covered Han and the walk stopped before the OS was asked. **And neither change is scoreable alone:** separately they are −55 and −556; together they are −84,938, so 84,327 rows exist only when both are on, and all three `.PingFangUI*` routes collapse to zero only with both.

That is also a reporting hazard worth naming, because this entry fell into it: the 29,025 figure was first recorded as the ordering flag's own result, when it in fact required a second flag that was still off by default. When two stages shadow each other, an A/B of either one measures near zero and reads as "not the problem".

The full 818-fixture macOS unicode sweep moved 4 fixtures out of 818. The one that moved the wrong way is instructive: on the cell in question Chrome paints PingFang SC, the old order painted PingFang **HK** (the wrong regional variant), and the new order paints SC — yet the tile's pixel diff went *up*, because the wrong face's outline happened to rasterize nearer Chrome's Skia-hinted raster than the correct face's does. That is the §6 rasterization floor masquerading as a regression, and it is precisely why parity is gated on the oracle: a pixel metric cannot distinguish "right font" from "lucky wrong font".

**Note the asymmetry** this creates with Windows, and do not "simplify" it away: on Windows a hardcoded per-script table **is** Blink's behavior, consulted before DirectWrite. The principle is not "no tables" — it is **transcribed from Chromium, not sampled from a machine**.

## 5. Verdict summary

Stages matching by construction today: **`kSystemFonts` on macOS** and **its private-use / noncharacter guard**. The first calls the identical CoreText function, with the identical base argument, and — since the ordering fix — actually gets to answer. The second is the cheapest transcription in this document and closed two live wrong-glyph defects at once: it is a three-line early return, and not having it meant asking the OS a question Chrome never asks. Worth noting *why* it survived so long unnoticed — the private-use ranges are excluded from the 819-block unicode corpus, so no fixture had ever exercised the path. It became visible the day one fixture did. The remaining font-selection stages do not yet match.

Ordered by expected impact:

1. ~~**Remove the interposed table** so `kSystemFonts` answers (macOS/Linux), keeping a transcribed table only where Blink has one (Windows).~~ **Done** — reordered rather than removed, see §4. The table survives as the fall-through for what the OS declines.
2. ~~**Fix the macOS base-font argument**~~ **Done** — the cascade base is the run's own primary, matching `CTFontCreateForString(ct_font, …)`.
3. **Audit the Linux locale argument** against `gfx::GetFallbackFontForChar`.
4. **Port the Windows table** ahead of our `MapCharacters` call.
5. **Correct the terminal**: Blink's last resort is Times on macOS, and the notdef comes from the *first* candidate. Now done for the private-use / noncharacter codepoints (item 7 below), which is where Blink reaches the terminal *directly*; the general uncovered case still pins the chain's last entry in paths mode.
7. ~~**Skip system fallback for private-use and noncharacter codepoints**~~ **Done** — `font_cache.cc:242-244`. Cost nothing to transcribe; the ranges are absent from the corpus, so measure it with a purpose-built fixture rather than expecting the sweep to speak.
6. **Model `kFallbackPriorityFonts`** as the one-shot stage it is.

Each has corpus-wide blast radius and needs a full-sweep A/B before landing, measured against the conformance oracle rather than fixture scores.

## 6. Not in scope

**Rasterization.** Chrome rasterizes with Skia; our output is rasterized by the consumer browser (embedded mode) or emitted as vector outlines. That difference is accepted by the maintainer and is the documented hinting floor ([docs/42](42-cross-platform-fallback-calibration.md), [docs/99](99-hinted-embedded-subset.md)) — a separate concern from the matching mechanism.

**Shaping** is in scope for parity but tracked separately, since it is the largest single item: Blink shapes with **HarfBuzz on every platform**, while we use fontkit's `layout()` generally and `harfbuzzjs` in only three narrow NFD branches — despite HarfBuzz already being vendored (`vendor/harfbuzzjs/`, rebuilt with Chromium's own HarfBuzz configuration — see its README) with a wrapper at `src/render/harfbuzz-shaper.ts`. The native helper's CoreText `shape` query is a third shaping path that would also need collapsing.
