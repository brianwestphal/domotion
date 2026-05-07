/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/fonts",
  title: "Fonts & non-Latin scripts",
  subtitle: "Picking fonts the path renderer can find — and what to expect for Arabic, Devanagari, CJK, emoji.",
};

export const content: SafeHtml = raw(`
<p>Domotion's path renderer needs to find a real font file on disk to extract
glyph outlines from. This page covers how the lookup works, how to handle web
fonts, and what to expect for non-Latin scripts.</p>

<h2>Where Domotion looks for fonts</h2>

<p>Path mode reads outlines using <a href="https://github.com/foliojs/fontkit"
rel="noopener" target="_blank">fontkit</a>. The lookup table mapping
<code>font-family</code> values to font files on disk is tuned for macOS
system fonts: SF Pro, SF Mono, New York, Helvetica Neue, etc.</p>

<ul>
  <li><strong>macOS:</strong> the bundled mapping covers the standard system
    fonts. Author your demos in those families and the path renderer will
    "just work" with no font config.</li>
  <li><strong>Linux / Windows:</strong> the mapping table is much sparser. The
    capture still works, but path-mode glyphs whose font isn't found fall
    back to native SVG <code>&lt;text&gt;</code> with the captured CSS font
    properties, which means the result depends on whatever the rendering
    browser has installed.</li>
</ul>

<div class="callout note">
  <span class="icon">ⓘ</span>
  <div class="body">
    <p>If you need cross-platform path rendering, do your captures on macOS
    (or in a CI runner with macOS images) and ship the resulting SVGs. The
    glyph outlines are baked in — Linux and Windows viewers will see them
    correctly even though they lack the source fonts.</p>
  </div>
</div>

<h2>Picking a font that captures cleanly</h2>

<p>Three rules of thumb:</p>

<ol>
  <li><strong>Stay in the system stack when you can.</strong>
    <code>-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif</code>
    — the resolved system font is one Domotion knows.</li>
  <li><strong>If you use a web font, wait for it.</strong> Always
    <code>await page.evaluate(() =&gt; document.fonts.ready)</code> before
    capturing — otherwise you'll capture the fallback typeface and the
    layout will be subtly wrong.</li>
  <li><strong>Avoid rare display faces.</strong> A handful of decorative fonts
    use OpenType features Domotion doesn't shape (variable-axis interpolation
    along axes other than weight, certain SVG-in-OpenType color tables);
    those fall back to raster.</li>
</ol>

<h2>Non-Latin scripts</h2>

<p>Domotion handles complex scripts by detecting fallback-font runs (Chromium
has already chosen a different font for them) and shaping each run as a unit
with <code>font.layout(runText)</code>. That means contextual joining,
ligature clusters, and mark-on-base positioning all survive — Latin,
Cyrillic, Greek, Arabic (initial / medial / final / isolated forms; bidi via
<code>bidi-js</code>), Hebrew, Devanagari (cluster reordering, ligatures),
Thai (mark-on-base), and CJK (Han, Hiragana, Katakana, Hangul; GPOS positioning)
all round-trip. Other complex scripts (Tibetan, Khmer, Burmese) flow through
the same pipeline.</p>

<p>Mixed-script lines like "Hello مرحبا नमस्ते" work — each contiguous
fallback run is shaped as a unit, and the per-character anchor offsets keep
the runs aligned with what Chromium painted.</p>

<p>Emoji and colour-bitmap glyphs are the exception: each unique glyph is
screenshotted once and embedded as a base64 PNG, then referenced via
<code>&lt;use&gt;</code> for dedup.</p>

<h2>Verified shaping accuracy</h2>

<p>fontkit's shaping is within ~1% of HarfBuzz on Arabic and Thai, and
pixel-identical on Devanagari and CJK ideographs at typical body sizes. The
test suite includes one fixture per script that diffs the SVG render against
the Chromium PNG — the path renderer is within Domotion's overall 3%
pixel-diff threshold for all of them.</p>

<h2>Web fonts</h2>

<p>If you load a web font via <code>&lt;link rel="stylesheet" href="..."&gt;</code>
or <code>@import url(...)</code>:</p>

<ol>
  <li>Wait for <code>document.fonts.ready</code> before capturing.</li>
  <li>If the web font isn't in Domotion's bundled mapping table (most aren't),
    the path renderer will fall back to native <code>&lt;text&gt;</code> with
    the captured CSS font-family. The text will still render, just not as
    embedded outlines.</li>
  <li>For self-contained output with a custom font, you can pre-process the
    SVG and inject a base64-embedded <code>@font-face</code>. That's outside
    Domotion's current public surface; file an issue if this matters for
    your use case.</li>
</ol>

<h2>Decoration handling</h2>

<p>Underlines and strike-throughs are positioned using the font's own
<code>post.underlinePosition</code> / <code>OS/2.yStrikeoutPosition</code>
tables, not as a fraction of font size. This matches Chromium and avoids the
slight "underline too low" effect you sometimes see in rasterised SVG
output.</p>

<h2>See also</h2>

<ul>
  <li><a href="../../concepts/text-rendering/">Text rendering</a> — the
    behind-the-scenes story.</li>
  <li><a href="../../css/text-and-fonts/">CSS support: text &amp; fonts</a></li>
</ul>
`);
