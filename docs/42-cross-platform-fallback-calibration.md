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
`src/render/text-to-path.ts` decides, for a codepoint the primary font lacks,
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

Implemented as `linuxFallbackChain` in `src/render/text-to-path.ts` (the macOS
body is preserved verbatim as the darwin path). `LINUX_FONT_PATHS` was corrected
from the original DejaVu/Noto assumptions to these real faces.

**Verification** (`npm run demos:test` in the container): feature suite went
**89 → 91 passing**. `text-mixed-script` renders glyph paths (43 `<use>` + 37
defs, 0 `<text>`) at **0.00 %** vs Chromium-on-Linux. Fixed by the switch from
`<text>` fallback to real glyph paths: `text-decorations`,
`pseudo-before-gradient-badge`, `inline-box-decoration-break`.

**Known residual (follow-up)**: `mathml-mi-greek-italic` / `mathml-mi-italic-letters`
still fail (~0.4–0.8 %, also failing pre-change). The Math-Alphanumeric glyphs
(𝑎 U+1D44E, 𝛼 U+1D6FC) fall back to `<text>` because **fontkit can't extract
those glyphs from FreeSans on Linux** even though Chromium paints them there —
a glyph-extraction gap, not a chain-routing gap. Tracked separately.

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

Recommendation was **(B)**, but DM-259 was calibrated against **(A) the bare
Playwright `*-noble` image** — because that is exactly what `npm run
demos:test` (and the future CI visual job) diffs against, so the calibration and
the baselines must agree on the same font set. The image's CJK is WenQuanYi Zen
Hei, not Noto. **If the project later wants the mainstream Noto baseline (B),
it's an `apt install fonts-noto-core fonts-noto-cjk` step in the container/CI
plus a re-probe of the CJK/symbol blocks** (the Latin primaries stay Liberation).
Left as a decision for DM-262 (CI wiring), where the font-install policy lives.

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
