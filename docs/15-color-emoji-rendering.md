# Domotion: Color emoji rendering

Requirements for color emoji glyphs (✨😀🚀⛔🎉 …) in Domotion's SVG output. Origin: DM-278 / DM-334 / DM-335.

> **Cross-platform note**: This doc describes the macOS implementation. Apple Color Emoji's `sbix` table is the on-disk source of truth for color emoji on macOS. Linux uses Noto Color Emoji (CBDT/CBLC) and Windows uses Segoe UI Emoji (COLR/CPAL). Each platform needs a different bitmap-extraction path; the macOS implementation here is the reference and the Linux/Windows ports are tracked under the broader DM-258 → DM-262 cross-platform roadmap.

## Why color emoji are special

fontkit can read the path glyph for almost every Unicode codepoint we care about, but emoji are stored as bitmap tables (`sbix` on macOS, `CBDT/CBLC` on Linux, `COLR/CPAL` on Windows). The path tables for emoji codepoints contain only `.notdef` (the hollow-rectangle tofu) — there's no vector geometry to extract. The renderer therefore can't emit `<path>` data for emoji and must instead embed a bitmap as `<image>`.

## Capture pipeline

`src/capture/script/::CAPTURE_SCRIPT::needsRaster(cp, nextCp, font)` is the predicate that decides whether a codepoint needs the bitmap path. It covers:

- The Misc Symbols block (U+2600..26FF) chars with default emoji presentation per Unicode emoji-data v15.1 (☔ ☕ ⛏ ⛹ ♈..♓ ⛏️ etc.).
- Dingbats Chrome on macOS routes to Apple Color Emoji rather than Zapf Dingbats: ✨ ❌ ❎ ❓ ❔ ❕ ❗ ➕ ➖ ➗ ➡ ➰ ➿.
- VS-16 (U+FE0F) follow-on: any base emoji codepoint paired with U+FE0F is forced to color presentation regardless of its default.
- Regional-indicator pairs (flag emoji).
- The main pictograph blocks U+1F300..U+1FAFF.

When `needsRaster` returns true for a char, the capture pass appends a `rasterGlyphs` entry to the segment with the char's viewport-relative rect (taken straight from `Range.getBoundingClientRect()`). Each entry holds `{ charIndex, rect, dataUri? }`.

## Bitmap source: Apple Color Emoji sbix table (DM-335)

`rasterizeBitmapGlyphs` in `src/capture/emoji.ts` walks the captured tree post-capture and fills in each `dataUri`. There are two sources:

1. **Apple Color Emoji's `sbix` table** (preferred on macOS). `extractEmojiBitmap(codepoint, paintedWidthPx)` opens `/System/Library/Fonts/Apple Color Emoji.ttc` once (lazy + cached), looks up the glyph via `font.glyphForCodePoint(cp)`, and calls fontkit's `glyph.getImageForSize(ppem)` which returns the embedded PNG bytes for that strike directly. The strike is picked adaptively as `max(64, paintedWidthPx × 3)` rounded up to the nearest available strike (20, 26, 32, 40, 48, 52, 64, 96, 160 ppem). For a typical 18-20px painted rect this lands on the 64-ppem strike (~6KB embedded) which gives ~3× supersampling — sharp through 1×-2× DPR rasterization without bloating file size. Going larger (160-ppem ~24KB) would supersample 8× but adds 18KB per emoji for diminishing visual gain.

2. **Page screenshot** (fallback, was previously the only source). For codepoints Apple Color Emoji doesn't cover (text-presentation dingbats like ✓ U+2713 / ✗ U+2717, ZWJ sequences, regional-indicator pairs that need pair-shaping) and for non-darwin platforms where the .ttc isn't available, fall back to `page.screenshot({ clip: rect })`. The screenshot is at the page's capture DPR (typically 1×) so it matches Chrome's painted output exactly but is visibly soft when the SVG is rasterized at >1×.

The sbix path activates only when:

- `process.platform === "darwin"` and the .ttc file exists.
- `glyphForCodePoint(cp).id !== 0` (the font has a glyph for the codepoint).
- The captured rect is wider than `0.4 ×` its height (filters out zero-width ZWJ joiner chars whose rect is a thin slice — those need pair-aware shaping the bitmap-per-codepoint path can't provide).

## Bitmap sizing — the advance square (DM-1198)

After the sbix bitmap is resolved, `src/capture/emoji.ts::emojiSquareRect` snaps the captured per-char rect to the **square Chrome actually paints the emoji in**: side = the glyph **advance** (the captured `Range.getBoundingClientRect()` width, minus any letter-spacing Chrome appends to the right of the advance), anchored flush-left at `rect.x` and vertically centered in the rect's line box.

The advance — not the font size — is the correct side because Chrome enforces a **minimum emoji advance** that exceeds the font size at small sizes: at `font-size: 16px` the emoji advance is 20px (≈1.25×). Sizing the overlay to the font size (the earlier behavior) painted every inline emoji ~20% too small. The sbix PNG is a full square em bitmap, so drawing it into an `advance × advance` box reproduces both full-bleed emoji and ones with transparent margins (e.g. 📈) without distortion. Verified empirically against Chromium's painted output across `font-size` 16-48 (the square side tracks the advance to the pixel; the vertical center matches within ~1px). The screenshot fallback path (§2) keeps the literal captured rect — it is already a pixel copy of Chrome's paint.

## Render pipeline

`src/render/text.ts::rasterGlyphOverlays` emits one `<image href="data:image/png;base64,…" x=… y=… width=… height=… preserveAspectRatio="none" clip-path="url(#…)"/>` per `rasterGlyphs` entry. The image is positioned at the captured viewport-relative rect (already snapped to the advance square at capture time); its width/height matches the painted size so the bitmap stretches/squishes to fit if the strike's aspect ratio differs slightly from the painted rect.

## Path-pipeline interaction (DM-334)

The path pipeline still walks the emoji codepoint and, when the resolved font (typically Apple Symbols as the last-resort fallback) returns a `.notdef` tofu, USED to emit the tofu rectangle under the raster overlay. PNG anti-aliasing left visible dark edges around the emoji where the raster's sub-pixel transparency exposed the tofu's outline. `src/render/font-resolution.ts::isEmojiCodepoint` mirrors the capture-side `needsRaster` predicate; the path-pipeline per-char emit loop suppresses any `<use>` whose glyph id is 0 when the codepoint is in an emoji range. Non-emoji unknown-char codepoints (PUA, deeply-exotic scripts) keep emitting their tofu as a "missing glyph" indicator.

## File-size budget

The 20-font-family fixture has 3 emoji (😀 🚀 ✨). With the 64-ppem strike picked adaptively each costs 4-9KB embedded as base64 in the SVG. Sustained at ~10 emoji per fixture this adds 60-90KB which is acceptable for the rendering-fidelity gain. Consumers who need smaller files can post-process the SVG with svgo or a separate optimization pass that re-encodes the data URIs at the lowest acceptable strike.

## Known gaps

- **ZWJ sequences** (👨‍👩‍👧 family emoji, 🏳️‍🌈 flag emoji, 👍🏿 skin-tone modifiers): each codepoint in the sequence has its own `rasterGlyphs` entry; the per-codepoint sbix lookup returns the unjoined glyph (👨, 👩, 👧 separately) which doesn't match Chrome's joined paint. The width-vs-height filter rejects the chars whose rect is a thin slice (ZWJ joiner U+200D, VS-16 U+FE0F) but the lead char still paints alone. Fixing this requires shaping-aware lookup: feed the full sequence to `font.layout` and use the resulting glyph cluster's id for sbix lookup. Scope is broader than the current ticket; the screenshot fallback path is still wired for these cases so the visible result is "Chrome's painted output, soft" rather than "wrong".
- **Linux / Windows**: the .ttc lookup short-circuits on non-darwin, so all emoji currently fall back to the page-screenshot path on those platforms. Re-doing the same plumbing for Noto Color Emoji's CBDT/CBLC tables (Linux) and Segoe UI Emoji's COLR/CPAL (Windows) is tracked under the cross-platform roadmap.
- **Subset / custom emoji fonts**: the path is hardcoded to `/System/Library/Fonts/Apple Color Emoji.ttc`. Author-installed emoji fonts (Twemoji, Fluent UI, etc.) aren't probed; they'd fall back to the screenshot path.

## Test coverage

- `tests/output/html-test/20-font-family.html` `.s12` row exercises the typical case (😀 🚀 ✨ — three single-codepoint emoji from different blocks). Visual regression at 16px shows actual closely matches expected with sharper details than Chrome's 1× paint due to 64-ppem supersampling.
- `src/render/text-to-path.test.ts` `Emoji codepoints suppress .notdef tofu emission (DM-334)` locks the path-pipeline tofu suppression for U+2728 / U+1F600 / U+1F680 / mixed Smile 😀 runs.
