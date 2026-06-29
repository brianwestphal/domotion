# Domotion: cross-platform fallback-chain calibration (Linux + Windows)

Requirements for calibrating `fallbackFontChain` against Chromium-on-Linux
(DM-259) and Chromium-on-Windows (DM-260). Both share one methodology and one
code structure — only the candidate font set differs — so they're documented
together here and cross-referenced from each ticket.

> **Prerequisite (done)**: `docs/40-cross-platform-font-paths.md` (DM-258) made
> font *path discovery* platform-aware, so every logical key already resolves to
> a real file on Linux/Windows. This doc is about *routing* — which logical key
> Chromium actually paints for each Unicode block on each platform.

## The problem this solves

`fallbackFontChain(codepoint, primaryKey, lang?)` in
`src/render/font-resolution.ts` decides, for a codepoint the primary font lacks,
which fallback face to shape it with. Today every branch is reverse-engineered
from **Chromium-on-macOS's CoreText cascade** (Hiragino Sans GB for CJK, Apple
Symbols for math operators, Zapf Dingbats for ✂✈, STIX Two Math for 𝐀𝒜,
Lucida Grande for ←→, …). Chromium-on-Linux (fontconfig) and
Chromium-on-Windows (DirectWrite) cascade through entirely different faces, so
the macOS routing applied over Linux/Windows fonts produces the wrong glyph
(wrong width, wrong ink) for every fallback block — even though, post-DM-258,
*a* glyph now paints instead of tofu.

## Methodology (identical to the macOS calibration — DM-241 / DM-256 / DM-257)

For each representative codepoint in each Unicode block:

1. **Measure Chromium's painted width.** In a Playwright page *running on the
   target platform*, wrap the single character in a tight inline span and read
   `Range.getBoundingClientRect().width` at a known font-size with a known
   primary family (`sans-serif`, `serif`, `monospace`). This is the ground
   truth — what Chromium-on-that-platform actually paints.
2. **Match against candidate faces.** For each candidate platform font (tables
   below), open it with fontkit, `glyphForCodePoint(cp)`, and compare its
   natural advance (scaled to the font-size) against the measured width. The
   face whose advance matches to within a sub-pixel tolerance is the one
   Chromium picked.
3. **Also confirm via CDP** where ambiguous: `CSS.getPlatformFontsForNode`
   reports the actual font family Chromium used for a rendered node — a direct
   cross-check against the width-match.
4. Record the winning face per block; assemble the ordered chain (primary face
   first, then the safety-net faces for codepoints the winner lacks).

**This step requires Chromium running on the target OS.** macOS Playwright
paints through CoreText, so it cannot stand in for Linux/Windows widths. See
"Execution environment" below.

## Code structure: platform-aware `fallbackFontChain`

The chain walker and all callers stay unchanged — only the per-block routing
becomes platform-keyed. Recommended shape:

```
export function fallbackFontChain(cp, primaryKey?, lang?): string[] {
  switch (process.platform) {
    case "linux":  return linuxFallbackChain(cp, primaryKey, lang);
    case "win32":  return win32FallbackChain(cp, primaryKey, lang);
    default:       return darwinFallbackChain(cp, primaryKey, lang); // the current body, verbatim
  }
}
```

- The existing function body becomes `darwinFallbackChain` **unchanged** — zero
  risk to the calibrated macOS baseline (the project's top fidelity priority).
- `linuxFallbackChain` / `win32FallbackChain` are populated from the probe
  results. Until a platform is calibrated, its function may delegate to
  `darwinFallbackChain` (the post-DM-258 status quo: macOS routing over local
  fonts) so the platform still renders *something*.
- The logical keys (`cjk`, `symbols`, `stix-math`, …) are the same; DM-258's
  `resolveFontSpec` already maps them to the right per-platform files.

## Candidate font sets to probe

These are the faces to *test* in step 2 — not pre-calibrated answers. The probe
decides which one each block actually routes to.

### Linux (fontconfig) — DM-259

| Unicode block (representative chars) | Candidate faces (probe order) |
| --- | --- |
| Latin / sans-serif primary | DejaVu Sans, Liberation Sans |
| serif primary | DejaVu Serif, Liberation Serif |
| monospace primary | DejaVu Sans Mono, Liberation Mono |
| Hebrew (U+0590–05FF) | Noto Sans Hebrew, DejaVu Sans |
| Arabic (U+0600–06FF + pres. forms) | Noto Sans Arabic, Noto Naskh Arabic |
| Devanagari (U+0900–097F) | Noto Sans Devanagari |
| Thai (U+0E00–0E7F) | Noto Sans Thai, Garuda/Loma (tlwg) |
| CJK Han / Kana (unmarked + lang-tagged) | Noto Sans CJK {SC,TC,HK,JP,KR}, WenQuanYi Zen Hei, IPAGothic |
| CJK serif | Noto Serif CJK SC |
| Hangul | Noto Sans CJK KR |
| Box Drawing / Block (U+2500–259F) | DejaVu Sans Mono, Noto Sans Mono |
| Geometric Shapes (U+25A0–25FF) | DejaVu Sans, Noto Sans Symbols 2 |
| Misc Symbols (U+2600–26FF) | Noto Sans Symbols, Noto Sans Symbols 2, DejaVu Sans |
| Dingbats (U+2700–27BF) | Noto Sans Symbols 2, DejaVu Sans |
| Arrows (U+2190–21FF) | DejaVu Sans, Noto Sans Symbols 2 |
| Math Operators (U+2200–22FF) | DejaVu Sans, Noto Sans Math |
| Letterlike (U+2100–214F) | DejaVu Sans, Noto Sans Math |
| Math Alphanumeric (U+1D400–1D7FF) | Noto Sans Math, STIX Two Math (if `fonts-stix`) |
| Pictographs / Transport / Emoji | Noto Color Emoji (raster path — handled by the screenshot overlay, doc 15) |

### DM-259 RESULT — calibrated Linux chain (Playwright `*-noble` image)

Probed 2026-05-25 via `tools/probe-fallbacks-linux.mjs` (CDP
`CSS.getPlatformFontsForNode`) inside `mcr.microsoft.com/playwright:v1.59.1-noble`.
**That image has no DejaVu and no Noto** (except Color Emoji) — `fc-list` shows
Liberation, FreeFont, WenQuanYi Zen Hei, IPAGothic, Loma, Unifont. What Chromium
actually paints (baseline = bare image, **option A**):

| Block / sample | Chromium-on-Linux font | `linuxFallbackChain` key → `LINUX_FONT_PATHS` |
| --- | --- | --- |
| sans-serif Latin | Liberation Sans | `helvetica` → Liberation Sans |
| serif Latin | Liberation Serif | `times` → Liberation Serif |
| **monospace Latin** | **WenQuanYi Zen Hei Mono** | `courier` → WenQuanYi Zen Hei Mono *(its fontconfig `monospace` alias — not Liberation Mono)* |
| Hebrew שלום | Liberation Sans | `helvetica` |
| Arabic بحرم | FreeSerif | `sf-arabic` → FreeSerif |
| Devanagari | FreeSans | `devanagari` → FreeSans |
| Thai | Loma | `thai` → Loma |
| CJK Han / Kana / Hangul | WenQuanYi Zen Hei | `cjk` → WenQuanYi Zen Hei |
| Box Drawing (mono) | WenQuanYi Zen Hei Mono | primary; `cjk` safety net |
| Geometric ▲●◆■□○ | Liberation Sans (+ WenQuanYi) | `helvetica`, `cjk` |
| Misc Symbols ☀☂♠♥♦ | Liberation Sans (+ IPAGothic) | `helvetica`, `hiragino-jp`(→IPAGothic), `free-sans` |
| Arrows ←→↑↓ | Liberation Sans | `helvetica` |
| Arrows diag ↗↙ | WenQuanYi Zen Hei | `cjk` |
| Dingbats ✂✈❤ | FreeSans | `free-sans` |
| Chess ♔♚ | FreeSerif | `free-serif` |
| Letterlike ℝ™ℕℤ | FreeSans (+ Liberation Sans) | `free-sans`, `helvetica` |
| Math-italic 𝑎/𝛼, Math-bold 𝐀 | FreeSans | `free-sans`, `free-serif` |
| Math-script 𝒜 / double-struck 𝕊 | FreeSerif | `free-sans`, `free-serif` |
| Emoji 😀🚀 | Noto Color Emoji | raster overlay (doc 15) |

Implemented as `linuxFallbackChain` in `src/render/font-resolution.ts` (the macOS
body is preserved verbatim as the darwin path). `LINUX_FONT_PATHS` was corrected
from the original DejaVu/Noto assumptions to these real faces.

**Verification** (`npm run demos:test` in the container): feature suite went
**89 → 91 passing**. `text-mixed-script` renders glyph paths (43 `<use>` + 37
defs, 0 `<text>`) at **0.00 %** vs Chromium-on-Linux. Fixed by the switch from
`<text>` fallback to real glyph paths: `text-decorations`,
`pseudo-before-gradient-badge`, `inline-box-decoration-break`.

**Math-Alphanumeric on Linux — how it actually renders (DM-838 / DM-876)**: the
Math-Alphanumeric letters (𝑎 U+1D44E, 𝛼 U+1D6FC, …) render via **upright
`FreeSans.ttf`, which carries dedicated glyphs for the whole U+1D400–1D7FF block**
(e.g. 𝑎 → gid 6385, 𝑟 → gid 6401). CDP `CSS.getPlatformFontsForNode` confirms
Chromium-on-noble paints every `<mi>` letter with **FreeSans** too, so the
renderer's fallback chain (which finds the glyph in `free-sans` and stops) and
Chromium agree on the face. `mathml-mi-italic-letters` is pixel-clean (0.00 %)
on Linux as a result.

> **Correction (DM-876):** an earlier DM-838 probe concluded "FreeSans's cmap
> does not contain U+1D400–1D7FF" and that Chromium *synthesizes* the letters
> from base italic. That probe opened the **`FreeSansOblique`** face by mistake —
> the oblique face has none of the block, but the upright `FreeSans.ttf` has all
> of it (verified by `glyphForCodePoint` on each file + CDP). So the chain renders
> the letters directly from FreeSans; no synthesis is needed on this image.

DM-838 also added a **Math-Alphanumeric → base-letter decomposition**
(`mathAlphaToBase` in `src/render/unicode-classification.ts`): when a U+1D400–1D7FF (or
U+210E ℎ) codepoint resolves to `.notdef` across the *whole* fallback chain, it
maps the codepoint to its base char + the implied bold/italic style and renders
that base glyph in a FreeFont sibling. On the noble image FreeSans covers the
block, so this path does not engage — it's a **guarded fallback** for fonts /
platforms that genuinely lack the math block (and never runs on macOS / Windows,
where STIX Two Math / Cambria Math cover it). Both run splitters
(`textToPathMarkup` glyph-path mode and `splitTextIntoFontRuns` embedded-font
mode) honor it.

**MathML stretchy fence operators (DM-874, fixed)**: the matrix fixture's
residual turned out to be stretchy `<mo>` fence parens. Chromium paints a fence
(`(` `)` `[` `]` `{` `}` `|` …) centered on the math axis and stretched to wrap
its content; the `<mo>` element's `getBoundingClientRect` reflects that painted
extent, but placing the glyph on the captured text baseline (the old behavior)
landed it ~5 px too low. `renderStretchyFenceGlyph` (in `src/render/text.ts` /
`text-to-path.ts`) now fits the fence glyph's ink bbox to the captured `<mo>`
box — a vertical scale (= the stretch) + axis-centered placement, natural
horizontal scale. `mathml-mi-italic-letters` went 0.82 % → **0.00 % (clean) on
Linux** and now passes on macOS.

**Known residual (Linux only, DM-876)**: `mathml-mi-greek-italic` still fails
~0.41 % on Linux — but it **passes on macOS**, so there is no `msup` / layout
defect, and CDP confirms both Chromium and the renderer paint its letters with
**FreeSans** (same face). The residual is small per-glyph shape / anti-aliasing
differences between domotion's glyph-path emission and Chromium's native
FreeSans rasterization — most visibly on `𝑟` — i.e. the glyph-path-vs-native
floor for this lower-quality hinted face, not a font-selection or layout bug.
Closing it would need a bundled pixel-faithful math font (bundled-fonts work,
DM-261) or matching Chromium's exact FreeSans `𝑟` glyph/hinting; marginal
(legible, Linux-only, anti-alias-level).

### Windows (DirectWrite) — DM-260

| Unicode block | Candidate faces (probe order) |
| --- | --- |
| Latin / sans-serif primary | Arial (`sans-serif`), Segoe UI (`system-ui`) |
| serif primary | Times New Roman |
| monospace primary | Courier New, Consolas |
| Hebrew | Segoe UI, Arial |
| Arabic | Segoe UI, Arial, Arabic Typesetting |
| Devanagari | Nirmala UI, Mangal |
| Thai | Leelawadee UI, Tahoma |
| CJK Han / Kana | Yu Gothic (ja), Microsoft YaHei (zh-CN), Microsoft JhengHei (zh-TW/HK), Malgun Gothic (ko), MS Gothic |
| CJK serif | SimSun, Yu Mincho |
| Hangul | Malgun Gothic |
| Box Drawing / Block | Consolas, Cascadia Mono (if installed), Courier New |
| Geometric Shapes | Segoe UI Symbol, Arial |
| Misc Symbols | Segoe UI Symbol |
| Dingbats | Segoe UI Symbol, Wingdings/Webdings |
| Arrows | Segoe UI Symbol, Arial |
| Math Operators / Letterlike | Cambria Math, Segoe UI Symbol |
| Math Alphanumeric (U+1D400–1D7FF) | Cambria Math |
| Pictographs / Transport / Emoji | Segoe UI Emoji (color font — raster path, doc 15) |

### DM-836 — first calibrated win32 chain + a methodology correction

First `windows-latest` painted-width probe (run 26430174100, Chromium 147). Two findings:

1. **Advance width alone is insufficient on Windows for the CJK / shaped-script
   blocks.** Every CJK / Hangul / Arabic / Hebrew / Devanagari / Thai sample
   measured exactly one em (`64px` at the 64px probe size) for *every* candidate
   face, so the width can't fingerprint which font Chromium painted. The probe
   was therefore extended to capture `CSS.getPlatformFontsForNode` (the actual
   painted family per cell) — the deterministic signal. (Validated on macOS,
   where it correctly reports Helvetica / PingFang SC / Apple SD Gothic Neo /
   Geeza Pro / Thonburi, matching the hand-calibrated darwin chain.) The next
   `windows-fidelity` run captures this for Windows.
2. **Where advance width *does* discriminate, it proved that Chromium-on-Windows
   paints the symbol / math-operator / geometric-shape / box-drawing / arrow
   codepoints in Arial itself** (the `sans-serif` painted width equals Arial's
   exactly for `∑ ∏ ≠ ∫ ■ ● ◆ ★ ─ ┼`), not in a dedicated symbol face.

`win32FallbackChain` (`src/render/font-resolution.ts`) is populated accordingly:

| Block | Chain | Basis |
| --- | --- | --- |
| Symbols / math operators / geometric / arrows | `helvetica` (Arial), then `symbols`/`stix-math` | **probe-proven** (Arial covers them) |
| Box Drawing | mono primary → `[primary, sf-mono]`; else `[helvetica, symbols]` | probe-proven |
| Math Alphanumeric | `stix-math` (Cambria Math) | Cambria Math covers the block |
| CJK Han/Kana | `cjk` (YaHei); `hiragino-jp` (Yu Gothic) for `ja`; `cjk-serif` (SimSun) for serif | **painted-font confirmed** (Han → Microsoft YaHei) |
| Hangul | `[korean, cjk]` (Malgun Gothic) | **painted-font confirmed** (→ Malgun Gothic) |
| Thai | `[tahoma, thai]` | **painted-font confirmed** (→ Tahoma, not Leelawadee) |
| Arabic / Hebrew | `sf-arabic` / `sf-hebrew` (Segoe UI) | first cut (Arial covers Arabic as primary; Segoe UI is the fallback) |
| Devanagari | `devanagari` (Nirmala UI) | first cut |

The second `windows-fidelity` run (26430730227) added `getPlatformFontsForNode`
capture, which **confirmed** the CJK / Hangul rows and **corrected** Thai
(Chromium falls back to **Tahoma**, not Leelawadee UI, under a `sans-serif`
request). The **proven** rows replace the previous darwin-fallthrough, which
routed these to macOS faces (Hiragino / Zapf Dingbats / STIX) that look wrong or
are absent on Windows.

**Important scope note:** this fallback calibration does *not* move the
`windows-fidelity` feature-regression diffs — those 18 failing fixtures render
their text in the **primary** font (Arial), so the fallback chain is never
consulted. The residual 0.2–3% diffs are a primary-font sub-pixel positioning
drift on Windows (same Arial outlines, drifting x-positions), tracked
separately as an investigation. The fallback chain governs *which* face covers a
block; it can't fix how the primary face is positioned.

### DM-987 — per-Unicode-block sweep (the generated win32 table)

The DM-836 chain above hand-routes the common blocks. DM-987 extends Windows the
same way DM-983 (macOS) and DM-984 (Linux) extended theirs: a per-Unicode-block
`CSS.getPlatformFontsForNode` sweep across **every** block fixture
(`../html-test/unicode/*.html`, 818 blocks), so the long tail of scripts that no
hand-coded rule covers still resolves to the face Chromium actually paints
instead of dropping to tofu.

The sweep ran under Node + Playwright Chromium on a **desktop Windows 11** host
(via a local Parallels VM — `tools/probe-983-sweep.mjs` with
`HTML_TEST_DIR`/`UNICODE_FONTS_OUT`), producing
`tests/output/unicode-fonts.win32.json` (committed, ~70 KB).
`tools/probe-983-genroutes-win32.mjs` maps each block's first-choice DirectWrite
family to a `C:\Windows\Fonts` filename (+ the TTC member's PostScript name for
collections), emitting `src/render/unicode-font-routing.win32.generated.ts` (34
fonts, 326 block ranges). `win32FallbackChain` consults it via
`lookupWin32UnicodeFontRange` **as a last resort**, after every hand-coded rule —
so the DM-836 routes still win where they match.

What the sweep surfaced (net-new coverage over the hand-coded chain):

| Script family | DirectWrite face | File |
| --- | --- | --- |
| Ancient / historic (Old Italic, Gothic, Cuneiform, Egyptian Hieroglyphs, Phoenician, Cypriot, Syriac, …) | Segoe UI Historic | `seguihis.ttf` |
| Ethiopic, N'Ko, Vai, Osmanya | Ebrima | `ebrima.ttf` |
| Cherokee, Canadian Aboriginal, Osage | Gadugi | `gadugi.ttf` |
| Yi | Microsoft Yi Baiti | `msyi.ttf` |
| Myanmar | Myanmar Text | `mmrtext.ttf` |
| Javanese | Javanese Text | `javatext.ttf` |
| Tibetan | Microsoft Himalaya | `himalaya.ttf` |
| Mongolian | Mongolian Baiti | `monbaiti.ttf` |
| Tai Le / New Tai Lue / Phags-pa | Microsoft Tai Le / New Tai Lue / PhagsPa | `taile.ttf` / `ntailu.ttf` / `phagspa.ttf` |
| Thaana | MV Boli | `mvboli.ttf` |
| Georgian / Armenian | Sylfaen | `sylfaen.ttf` |
| Rare CJK ideographs (Ext B/C/D/…, Ext G) | SimSun-ExtB / -ExtG | `simsunb.ttf` / `SimsunExtG.ttf` |
| Broad symbol / pictograph residue | Sans Serif Collection | `SansSerifCollection.ttf` |

Validated on the same Windows 11 host: opening each generated key's font with
fontkit and calling `glyphForCodePoint` for a representative codepoint in its
block returns a real (non-`.notdef`) glyph for the tail scripts above — i.e. the
codepoints that returned `[]` (tofu) from `win32FallbackChain` before now paint a
real glyph.

The same sweep also caught two stale `WIN32_FONT_PATHS` filenames that never
existed on disk (so those keys silently resolved to null): Nirmala UI ships as
`Nirmala.ttc` (not `Nirmala.ttf`) — which had **broken Devanagari/Indic on
Windows entirely** — and Leelawadee UI Semilight is `leeluisl.ttf` with
PostScript `LeelawadeeUI-Semilight` (not `LeelaUIsl.ttf` /
`LeelawadeeUISemilight`). Both are fixed.

**Re-running the sweep:** `tools/probe-983-sweep.mjs` is platform-agnostic — run
it wherever a real Windows Chromium lives. The `windows-fidelity` workflow has a
manual-dispatch `font-routing-sweep` job that runs it on `windows-latest` and
uploads the JSON, but **note that `windows-latest` is Windows Server**, whose
default font set is narrower than desktop Windows 11 (it omits several
supplemental faces). The committed table is the **desktop Windows 11**
calibration — the representative consumer environment — so regenerate it on
desktop Windows, not from the CI artifact.

### Desktop-Win11 regen runbook (DM-1423)

`tools/calibrate-win32-unicode-fonts.sh` documents + drives the desktop regen
on the Parallels "Windows 11" VM; the host-side regen is `--regen`. Two
hard-won requirements (DM-1423):

- **Pin the Chromium to the repo's `@playwright/test`.** The table records which
  face *Chromium* picks per block, so it must be swept with the chromium
  revision the renderer + visual suite use (the repo's pinned Playwright →
  e.g. 1.59.1 → chromium-1217), NOT just any Chromium. A 1.60.0 / chromium-1223
  sweep drifted two recent Latin blocks — `latin-extended-f` (U+10780) and
  `latin-extended-g` (U+1DF00) — from Calibri / Sans Serif Collection to Arial.
  That is a **Chromium-version nuance, not a desktop-vs-Server font-set
  difference**, and the wrong answer for the pinned Chromium — so it must not be
  committed. Install `@playwright/test@<pinned>` in the VM and `npx playwright
  install chromium chromium-headless-shell` before sweeping.
- **Install the headless shell.** `chromium.launch()` uses
  `chrome-headless-shell`, a separate download from the full `chromium` browser;
  if only `chromium-<rev>` is installed the sweep dies with *"Executable doesn't
  exist at …chromium_headless_shell-<rev>…"*. Under `prlctl exec` (which runs as
  `nt authority\system`) the browsers install to the SYSTEM profile's
  `%LOCALAPPDATA%\ms-playwright`; if the shell is reported missing at launch,
  `npx playwright install --force chromium-headless-shell` and confirm the .exe
  actually lands.

DM-1423 re-swept the committed table on a real desktop Win11 host and confirmed
it is the genuine **desktop** calibration (it routes to Yu Gothic / Yu Gothic UI,
SimSun-ExtB/G, Microsoft Yi Baiti, Javanese Text, Myanmar Text — all absent on
Windows Server) and is current for the pinned Chromium (the only diffs were the
two chromium-version-nuance Latin blocks above, correctly left uncommitted).

## The probe script

A `tools/probe-fallbacks-cross-platform.mjs` modelled on the existing
`tools/probe-*.mjs` scripts: takes a primary family + a list of (block,
representative-codepoint) pairs, launches Playwright Chromium, measures each
`Range.getBoundingClientRect().width`, then for each candidate face (resolved
through DM-258's `resolveFontSpec`) prints the fontkit advance and flags the
best width-match. Runs **inside the target-platform environment** (the Linux
container for DM-259; a `windows-latest` runner for DM-260). Output is pasted
into the per-platform chain functions with a one-line calibration comment per
block (matching the macOS chain's comment style).

## Execution environment (the blocker)

- **Linux (DM-259)**: run the probe inside the Playwright Linux container —
  `npm run test:linux-docker` infrastructure already pins the same image CI
  uses. Requires Docker. *(Not available in the sandbox where DM-258 was
  implemented — this is the gating dependency for DM-259's empirical step.)*
- **Windows (DM-260)**: run the probe on a `windows-latest` GitHub runner
  (the `windows-fidelity.yml` workflow already exists and is where DM-835's
  Windows painted-width JSON lands). DM-836 is the ticket that consumes that
  Windows probe data to build the win32 chain — DM-260 and DM-836 overlap and
  should be reconciled (DM-260 = the requirements/methodology; DM-836 = the
  data-driven implementation once a windows-latest run exists).

## Open question — Linux font baseline

The Linux chain depends on **which fonts are installed**, and the Playwright
Linux image does **not** ship Noto Sans CJK by default — it uses WenQuanYi Zen
Hei / IPAGothic for CJK. Two options:

- **(A) Calibrate against the Playwright image as-is** — faithful to what CI
  actually renders, but the CJK faces aren't Noto, so the chain (and the
  baselines) are pinned to that image's specific font set.
- **(B) Explicitly `apt install fonts-noto-core fonts-noto-cjk` in CI** —
  deterministic, matches the most common desktop-Linux Chromium experience, and
  makes the chain portable, at the cost of a CI install step and divergence from
  a bare Playwright image.

DM-259 was calibrated against **(A) the bare Playwright `*-noble` image** —
because that is exactly what `npm run demos:test` (and the CI visual job) diffs
against, so the calibration and the baselines must agree on the same font set.

### Both profiles now ship — runtime-selected (DM-1404)

Option **(B)** is now implemented **alongside** (A), not instead of it: domotion
carries a second, Noto-calibrated routing profile and **selects between them at
runtime** by the host's actual fontconfig CJK pick (`linuxFontProfile()` in
`src/render/font-resolution.ts`):

- **`bare`** (Playwright image / any host without Noto CJK) — the original
  Liberation / WenQuanYi / FreeFont routing. Unchanged; CI baselines still agree.
- **`noto`** (mainstream desktop-Linux: Noto present, prioritized over any
  WenQuanYi) — primaries resolve to **Noto Sans / Noto Serif / Noto Mono**, CJK
  to **NotoSansCJK**, and every other block to the Noto face Chromium-on-a-Noto-
  desktop actually paints, via the generated table
  `src/render/unicode-font-routing.noto-linux.generated.ts`
  (`UNICODE_FONT_PATHS_NOTO_LINUX` / `UNICODE_FONT_RANGES_NOTO_LINUX`,
  `un-...` keys). `DOMOTION_LINUX_FONT_PROFILE=noto|bare` forces the choice.

Detection follows fontconfig's pick for Han U+4E00, which is exactly what
Chromium-on-the-same-host paints (both go through fontconfig), so the chosen
profile matches Chromium by construction. **Calibration is reproducible** via
`tools/calibrate-linux-noto-profile.sh`: inside the noble container it strips the
noble-only fallback fonts (WenQuanYi / FreeFont / IPAGothic / Loma / Unifont) —
which otherwise out-prioritize Noto and contaminate the probe — installs the
mainstream Noto set, re-runs the CDP sweep + an fc-match family→file resolution,
then `tools/probe-983-genroutes-noto-linux.mjs` (host) regenerates the table.

This composes with the DM-1416 live `fc-match :charset` system-fallback resolver
(doc 80): the static Noto table gives deterministic block-level routing, and the
resolver is the per-codepoint net for anything the block route misses. Note the
naive "just `apt install noto` on the noble image" is NOT a faithful desktop
calibration — the image keeps WenQuanYi at higher fontconfig priority, so it
still paints CJK with WenQuanYi; the strip step above is what makes it faithful.

## Per-platform visual-gate hinting floor (DM-262 / DM-884)

Calibrating the fallback chain makes the renderer pick the *right* face, but the
feature visual-regression suite (`tests/runner.tsx`, `paths` mode) still can't
hit per-pixel parity with the native paint on non-macOS platforms — and that
gap is **not** a fallback or positioning bug. The `expected` PNG is the platform
rasterizer painting text natively with grid-fitting/hinting (DirectWrite on
Windows, FreeType on Linux); the `actual` is Domotion filling **unhinted vector
glyph outlines**. DM-884 proved per-char `xOffsets` (Δx = 0) and baseline
(Δ = 0) match Chromium exactly in the same font, so the residual diff is purely
the hinting of the outline raster — irreducible without a hinting engine.

So the runner applies a **per-platform coverage cap** that absorbs the hinting
floor while still failing on gross breakage (missing fonts → tofu → far higher
coverage). macOS stays the strict per-pixel gate (`regionCount === 0`) and is
the real regression catch.

| Platform | Rasterizer | Max observed hinting coverage | Gate |
| --- | --- | --- | --- |
| macOS | CoreText (light) | ~0% (outline ≈ paint) | strict `regionCount === 0` |
| Linux | FreeType | 0.58% (4 fixtures) | `coveragePct ≤ 1%` |
| Windows | DirectWrite (heavy) | 3.34% (18 fixtures) | `coveragePct ≤ 4%` |

Both non-macOS suites are green at these caps (Linux via `npm run
test:linux-docker`; Windows via `windows-fidelity.yml`, 97/97). The cap lives in
`tests/runner.tsx` (`HINTING_FLOOR_PCT`).

## Acceptance criteria

- **DM-259**: probe results documented per Unicode block on Linux; `linuxFallbackChain`
  populated; `02-text-symbols` + other text fixtures pass within the 3.5%
  threshold on Linux (same bar as macOS).
- **DM-260**: same, on Windows; `win32FallbackChain` populated; text fixtures
  pass within threshold on Windows.
- macOS chain byte-for-byte unchanged (regression guard: the existing
  `fallbackFontChain` unit tests still pass on darwin).

## Follow-ups

- DM-261 — bundle OFL fallback fonts for headless CI lacking system fonts.
- DM-262 — wire the calibrated Linux + Windows baselines into CI.
- DM-836 — build the win32 chain from the `windows-latest` probe data (the
  data-driven counterpart to DM-260's methodology here).
