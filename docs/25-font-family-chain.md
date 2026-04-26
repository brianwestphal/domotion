# Domotion: CSS font-family chain resolution

Requirements for honoring author-specified font-family chains in Domotion. Origin: SK-1124 (follow-up from SK-1095). Today `resolveFontKey` in `src/text-to-path.ts` only distinguishes mono from sans-serif, so a page declaring `font-family: "Helvetica Neue", "Times New Roman", monospace` always paints with SF Pro regardless of the requested family.

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
   - Generic keywords:
     - `serif` → New York or Times.
     - `sans-serif` → SF Pro.
     - `monospace` → SF Mono.
     - `cursive` → Snell Roundhand (if present, else SF Pro).
     - `fantasy` → SF Pro (warning logged).
   - Anything else → next token, then SF Pro.

2. New `FONT_PATHS` entries for the common families. Initial set (all macOS system fonts):

   ```ts
   "helvetica":        { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica" },
   "helvetica-italic": { path: "/System/Library/Fonts/Helvetica.ttc", postscriptName: "Helvetica-Oblique" },
   "times":            { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Roman" },
   "times-italic":     { path: "/System/Library/Fonts/Times.ttc", postscriptName: "Times-Italic" },
   "courier":          { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier" },
   "courier-italic":   { path: "/System/Library/Fonts/Courier.ttc", postscriptName: "Courier-Oblique" },
   "georgia":          { path: "/System/Library/Fonts/Georgia.ttc", postscriptName: "Georgia" },
   "georgia-italic":   { path: "/System/Library/Fonts/Georgia.ttc", postscriptName: "Georgia-Italic" },
   "arial":            { path: "/Library/Fonts/Arial.ttf" },
   "verdana":          { path: "/Library/Fonts/Verdana.ttf" },
   "menlo":            { path: "/System/Library/Fonts/Menlo.ttc", postscriptName: "Menlo-Regular" },
   "monaco":           { path: "/System/Library/Fonts/Monaco.ttf" },
   "new-york":         { path: "/System/Library/Fonts/NewYork.ttf" },
   ```

3. Glyph-def cache key (`ensureGlyphDef` in text-to-path.ts) currently keys on `${fontKey}-${weight}-${fontSize}-${slant}-${glyphId}`. The existing `fontKey` covers the new cases since each matched family gets its own logical key.

## Edge cases

- `@font-face` web fonts are out of scope — we don't have the font file. Warn and fall through.
- Weight-axis fonts (variable-weight files): only SF Pro currently exposes `wght`. Others would use the closest-weight sibling (TTC `getFont(name)` per weight).
- Italic + bold combined: e.g. `helvetica-bold-italic` postscriptName `Helvetica-BoldOblique`. Handle in the `getFontInstance` route — the slant flag picks `-italic`, weight selects sibling.
- Files that don't ship on a given macOS install (Arial, Verdana are installed by Office, not the OS) — guard the `openSync` call with try/catch (already does), continue to next family in chain.

## Follow-ups to file

- Implementation ticket: "SK-???: font-family chain resolver implementation".
- "Bundle a small fallback font set" — for CI environments without the host's macOS fonts, ship a small set of OFL-licensed fonts (e.g. Inter, Noto Serif, JetBrains Mono) and fall through to those before SF Pro. This matters for Linux CI specifically.

## Acceptance criteria

`20-font-family.html` test diff drops below 1.5% avg. A page declaring `font-family: "Times New Roman", serif` renders glyphs that match Chrome's Times rendering. SF Pro keeps working as the universal fallback when none of the requested families is installed.
