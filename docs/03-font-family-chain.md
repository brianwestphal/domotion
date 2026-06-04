# Domotion: CSS font-family chain resolution

Requirements for honoring author-specified font-family chains in Domotion. Origin: SK-1124 (follow-up from SK-1095). Today `resolveFontKey` in `src/text-to-path.ts` only distinguishes mono from sans-serif, so a page declaring `font-family: "Helvetica Neue", "Times New Roman", monospace` always paints with SF Pro regardless of the requested family.

> **Cross-platform note (DM-258 / DM-259 / DM-260)**: This doc describes the macOS calibration of the chain resolver and `FONT_PATHS`. The same logic must work on Linux (fontconfig — Noto / DejaVu / Liberation) and Windows (DirectWrite — Arial / Consolas / Times New Roman / Segoe UI Symbol / Cambria Math / Yu Gothic).
>
> **Path discovery is now platform-aware (DM-258, done).** `getFontInstance` no longer reads `FONT_PATHS` directly — it calls `resolveFontSpec(key)`, which on macOS returns the `FONT_PATHS` entry unchanged, on Linux resolves via canonical `/usr/share/fonts/...` paths + `fc-match`, and on Windows via `%WINDIR%\Fonts`. So each logical key resolves to a real face on every platform instead of tofu. See `docs/40-cross-platform-font-paths.md` for the full per-platform key→font mapping.
>
> **Fallback-chain *calibration* is still macOS-only.** `fallbackFontChain` (which logical key handles which Unicode block) is reverse-engineered from Chromium-on-macOS painted widths (DM-241 / DM-256 / DM-257). That empirical-probe methodology must be re-run on each target platform to populate per-platform chains: Linux is DM-259, Windows is DM-260. Until then, Linux/Windows render with macOS's *routing* over their *own* fonts — primaries are faithful, symbol/CJK/RTL blocks are approximate.

## Why now

Editorial pages (Times for body, Helvetica for headings), branded UIs that pin a specific family, and the existing `20-font-family.html` test all suffer measurable diff because Chrome resolved a different family. Diff here is metrics-based (different glyph widths, x-heights) so it cascades into wrong line breaks for paragraphs.

## Goals

- Walk the author's `font-family` list in order, pick the first match for which we have a font file on disk, fall through to SF Pro as the universal fallback.
- Italic + bold variants per matched family (we already do this for SF Pro / SF Mono via sibling files; extend the pattern).
- Generic-family keywords (`serif`, `sans-serif`, `monospace`, `cursive`, `system-ui`) map to a single canonical macOS font each.
- Glyph cache keys must include the resolved family name so the same logical glyph in different families stays distinct.

## Capture changes

No new fields. CAPTURE_SCRIPT already records `cs.fontFamily` (the computed string Chrome reports — already the *requested* chain, not the resolved one).

## Render changes

In `src/text-to-path.ts`:

1. Replace `resolveFontKey(fontFamily: string): string` with `resolveFontKey(fontFamily: string): string` that splits on top-level commas, trims quotes, and matches each token in priority order:
   - Quoted family names (`"Helvetica Neue"`, `"Times New Roman"`) match against an explicit table.
   - Unquoted system-default keywords (`-apple-system`, `system-ui`, `BlinkMacSystemFont`) → SF Pro.
   - Generic keywords (matching Chrome on macOS, per `third_party/blink/renderer/platform/fonts/mac/font_cache_mac.mm`):
     - `serif` / `ui-serif` → Times New Roman.
     - `sans-serif` / `ui-sans-serif` → **Helvetica** (NOT SF Pro — Chrome's macOS sans-serif default is Helvetica; SF Pro is the `system-ui` / `-apple-system` mapping).
     - `system-ui` / `-apple-system` / `BlinkMacSystemFont` → SF Pro.
     - `monospace` / `ui-monospace` → **Courier** (NOT SF Mono or Menlo — Chrome's macOS monospace default per Blink's `kMonospaceFamily → kCourier`. SF Mono is ~3% wider and has a 2px taller rounded ascent at 13px, which misaligns `<code>` baselines vs surrounding text).
     - `cursive` → Snell Roundhand (if present, else SF Pro).
     - `fantasy` → SF Pro (warning logged).
   - Anything else → next token, then SF Pro.

2. New `FONT_PATHS` entries for the common families. Initial set (all macOS system fonts). Helvetica is a TTC with separate sub-fonts per weight×slant; pick the right sub-font in `getFontInstance` based on weight (≥600 → Bold) and slant.

   ```ts
   "helvetica":             { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica" },
   "helvetica-bold":        { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Bold" },
   "helvetica-italic":      { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Oblique" },
   "helvetica-bold-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-BoldOblique" },
   "times":            { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Roman" },
   "times-italic":     { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Italic" },
   "courier":              { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier" },
   "courier-bold":         { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Bold" },
   "courier-italic":       { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Oblique" },
   "courier-bold-italic":  { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-BoldOblique" },
   "georgia":          { path: "/System/Library/Fonts/Georgia.ttc", postscriptName: "Georgia" },
   "georgia-italic":   { path: "/System/Library/Fonts/Georgia.ttc", postscriptName: "Georgia-Italic" },
   "arial":            { path: "/Library/Fonts/Arial.ttf" },
   "verdana":          { path: "/Library/Fonts/Verdana.ttf" },
   "menlo":              { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Regular" },
   "menlo-bold":         { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Bold" },
   "menlo-italic":       { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Italic" },
   "menlo-bold-italic":  { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-BoldItalic" },
   "monaco":           { path: "/System/Library/Fonts/Monaco.ttf" },
   "new-york":         { path: "/System/Library/Fonts/NewYork.ttf" },
   ```

3. Glyph-def cache key (`ensureGlyphDef` in text-to-path.ts) currently keys on `${fontKey}-${weight}-${fontSize}-${slant}-${glyphId}`. The existing `fontKey` covers the new cases since each matched family gets its own logical key.

## Per-codepoint fallback within the chain (DM-1083)

`resolveFontKey` above collapses the author's `font-family` list to ONE key — the
primary font for the run. But a single run can contain codepoints the primary
doesn't cover (a CJK ideograph in a Latin-primary paragraph, a symbol the body
face lacks). For those, the renderer walks the WHOLE declared stack, not just the
primary. `resolveFontKeyChain(fontFamily)` returns the full ordered list of
resolvable keys (the same calibration table `resolveFontKey` uses, but keeping
every match instead of the first), and the per-codepoint resolver
(`resolveFontForCodepoint` in `src/render/text-to-path.ts`) walks it in Blink's
`FontFallbackIterator` order:

1. **Primary literal** — the run's primary font covers the codepoint (the common
   case; fast path).
2. **kFontFamily** — walk every DECLARED family in order. For each, test the
   literal cmap, then (mirroring HarfBuzz's default-composed normalizer) the
   canonical NFD singleton WITHIN THAT SAME FONT. This reaches later-declared
   families the primary-only resolver dropped — e.g. a stack of
   `"Hiragino Sans","Arial Unicode MS",…` picks up CJK compatibility ideographs
   (U+2F800–2FA1F, U+F900–FAFF) whose canonical Han only the second family
   covers, via in-font decomposition. Crucially, decomposition is confined to the
   DECLARED cascade, so it never paints a glyph in a deep fallback face Chrome's
   cascade can't reach (a whole-fallback-chain canonical search over-rendered
   cells Chrome leaves as tofu — that is the bug this ordering avoids).
3. **kSystemFonts** — the per-char OS fallback: the calibrated `fallbackFontChain`
   table (literal only), then the live CoreText `CTFontCreateForString` (literal +
   in-font decomposition, which catches residue whose canonical form only a system
   CJK face covers). Platform-specific (CoreText on macOS; fontconfig / DirectWrite
   are the Linux / Windows roadmap); the rest of the loop is platform-agnostic.
4. **Math-Alphanumeric** — NFKD compatibility decomposition (a deliberately
   separate axis: render the base letter/digit in the matching FreeFont sibling).
5. **Out of luck** — nothing covers it; the caller paints its own tofu terminal.

A Latin-only stack (no CJK family declared) resolves identically to the old
primary-only path — the walk has nothing later to reach, so it stays tofu exactly
where Chrome does. The decomposition step matters only when a covering family is
actually declared.

## Edge cases

- `@font-face` web fonts (DM-227): supported. `discoverAndRegisterWebfonts` (in `capture.ts`) walks the page's same-origin `@font-face` rules AND every font URL captured by the `attachWebfontTracker` `requestfinished` listener (cross-origin fonts from CDNs like Google Fonts, which don't expose resource-timing entries to JS). Each fetched buffer is parsed with `fontkit.create()` and registered via `registerWebfont(family, weight, style, buffer)` into a runtime registry keyed by lowercase family name. The resolver consults this registry before the on-disk `FONT_PATHS` table — `resolveFontKey` returns a `webfont:<family>` key, `getFontInstance` dispatches that prefix to a closest-(weight, italic)-match picker. Caller is responsible for `clearWebfonts()` between captures.
  - **License**: the SVG embeds rendered glyph *outlines* (`<path d="...">` per glyph, deduplicated via `<defs>`/`<use>`), NOT the font file. Functionally equivalent to converting text to outlines in Illustrator or how PDF text-as-outlines works. The font itself is never redistributed in the output. Most font licenses permit this (rendered output is not a font copy), but as with any rendered-text export, it's the user's responsibility to verify their font's terms.
  - **Variable fonts** (DM-228 / DM-229): variation axes are driven through a shared `applyVariationAxes(font, weight, fontSize, slant)` helper used by both the system-font path (`getFontInstance`) and the webfont path (`pickWebfontVariant`). For each registered variable font that exposes the axis, the resolver sets `wght ← weight`, `opsz ← fontSize`, and `slnt ← slant` (when non-zero) and returns `font.getVariation(...)`. This means a single Inter Variable WOFF2 file serves all weights from 100-900 at the requested CSS `font-weight`, instead of substituting the registered base instance every time.
    - **WOFF2 caveat**: fontkit's `getVariation()` on a WOFF2 font returns an instance whose internal stream can't read the parent's tables — `unitsPerEm` / `layout()` throw `Cannot read properties of undefined`. We sidestep this by decompressing WOFF2 to plain TTF via `wawoff2` in `capture.ts` (`ensureNonWoff2`) before passing to `fontkit.create`. Variation axes only work because of this pre-conversion.
    - **Range descriptors** (`font-weight: 100 900`): the @font-face weight is parsed as the lower bound (so `pickWebfontVariant`'s scoring picks this variant for any request), and `applyVariationAxes` then drives the `wght` axis to the actual requested weight.
  - **Color fonts** (sbix/COLR/CBDT): fontkit reads them but the path renderer emits monochrome only — degrades to silhouette glyphs (same as today's behavior for the system Apple Color Emoji file).
- Weight-axis fonts (variable-weight files): only SF Pro currently exposes `wght`. Others would use the closest-weight sibling (TTC `getFont(name)` per weight).
- Italic + bold combined: e.g. `helvetica-bold-italic` postscriptName `Helvetica-BoldOblique`. Handle in the `getFontInstance` route — the slant flag picks `-italic`, weight selects sibling.
- Files that don't ship on a given macOS install (Arial, Verdana are installed by Office, not the OS) — guard the `openSync` call with try/catch (already does), continue to next family in chain.

## Follow-ups to file

- Implementation ticket: "SK-???: font-family chain resolver implementation".
- "Bundle a small fallback font set" — for CI environments without the host's macOS fonts, ship a small set of OFL-licensed fonts (e.g. Inter, Noto Serif, JetBrains Mono) and fall through to those before SF Pro. This matters for Linux CI specifically.

## Acceptance criteria

`20-font-family.html` test diff drops below 1.5% avg. A page declaring `font-family: "Times New Roman", serif` renders glyphs that match Chrome's Times rendering. SF Pro keeps working as the universal fallback when none of the requested families is installed.
