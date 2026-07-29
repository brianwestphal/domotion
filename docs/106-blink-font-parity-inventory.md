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
| — | **`fallbackFontChain`** — static per-block chains + the generated `unicode-font-routing.*.generated.ts` tables | **No Blink counterpart at all** — see §4 |
| `kSystemFonts` | `resolveSystemFallbackKeyForCp` → `resolveSystemFallbackFonts` → native helper (`CTFontCreateForString` on macOS, `main.swift:482`) | **Same API, wrong argument** — we pass a hardcoded `"Helvetica"` base (DM-1852) |
| `GetLastResortFallbackFont` | `last-resort` key → bundled `LastResortHE-Regular.ttf` | **No** — Blink returns **Times** on macOS; ours paints Unicode LastResort's per-block frames |
| `kFirstCandidateForNotdefGlyph` | paths mode pins the last chain entry's `.notdef`; embedded mode renders the primary's | **Partial** — Blink uses the **first** candidate; ours uses the last (paths) |

## 4. The core structural divergence

**`fallbackFontChain` has no counterpart in Blink.** Blink goes declared families → (segments) → system fallback. We interpose a static per-Unicode-block table between them, so on any codepoint that table covers, we answer *before* ever asking the OS the question Chrome asks.

That single interposition is the root of the whole 2026-07 wrong-font cycle:

- the table was **sampled** from one Mac's CoreText replies, so it froze that machine's font inventory into source — it names `SF Pro Text`, a separate Apple download, for Cyrillic (DM-1844);
- where the table and the live resolver disagreed, the table won, and the live one was the one matching Chrome (DM-1811);
- and because the table usually answers, the live path's own defects (wrong base font) stayed invisible.

Each was fixed as an instance. The structural fix is to stop interposing: let `kSystemFonts` be the stage that answers, as it is in Blink.

**Note the asymmetry** this creates with Windows, and do not "simplify" it away: on Windows a hardcoded per-script table **is** Blink's behavior, consulted before DirectWrite. The principle is not "no tables" — it is **transcribed from Chromium, not sampled from a machine**.

## 5. Verdict summary

Stages matching by construction today: **none of the font-selection stages**. The closest is `kSystemFonts` on macOS, which calls the identical CoreText function but with the wrong base argument and is usually pre-empted anyway.

Ordered by expected impact:

1. **Remove the interposed table** so `kSystemFonts` answers (macOS/Linux), keeping a transcribed table only where Blink has one (Windows).
2. **Fix the macOS base-font argument** (DM-1852) — cheap, evidenced, and it makes the live path trustworthy enough to rely on for step 1.
3. **Audit the Linux locale argument** against `gfx::GetFallbackFontForChar`.
4. **Port the Windows table** ahead of our `MapCharacters` call.
5. **Correct the terminal**: Blink's last resort is Times on macOS, and the notdef comes from the *first* candidate.
6. **Model `kFallbackPriorityFonts`** as the one-shot stage it is.

Each has corpus-wide blast radius and needs a full-sweep A/B before landing, measured against the conformance oracle rather than fixture scores.

## 6. Not in scope

**Rasterization.** Chrome rasterizes with Skia; our output is rasterized by the consumer browser (embedded mode) or emitted as vector outlines. That difference is accepted by the maintainer and is the documented hinting floor ([docs/42](42-cross-platform-fallback-calibration.md), [docs/99](99-hinted-embedded-subset.md)) — a separate concern from the matching mechanism.

**Shaping** is in scope for parity but tracked separately, since it is the largest single item: Blink shapes with **HarfBuzz on every platform**, while we use fontkit's `layout()` generally and `harfbuzzjs` in only three narrow NFD branches — despite `harfbuzzjs` already being a dependency with a wrapper at `src/render/harfbuzz-shaper.ts`. The native helper's CoreText `shape` query is a third shaping path that would also need collapsing.
