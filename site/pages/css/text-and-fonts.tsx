/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/text-and-fonts",
  title: "Text & fonts",
  subtitle: "Path-mode glyphs, run-based shaping, every common script — with a few caveats.",
};

export const content: SafeHtml = raw(`
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/scripts-line.svg" alt="A line of text mixing Latin, Arabic, Devanagari, Chinese, and an emoji — all rendered as path-mode glyphs." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">Latin, Arabic, Devanagari, CJK and emoji on one line — all path-mode shaping.</figcaption>
</figure>

<p>For the design rationale (path mode, run-based shaping, decoration metrics)
see <a href="../../concepts/text-rendering/">Text rendering</a>. The
<a href="../../guides/fonts/">Fonts &amp; non-Latin scripts</a> guide covers
practical font choices.</p>

<p>Standard CSS typography round-trips: <code>font-size</code>,
<code>font-weight</code> (100–900), <code>font-style: italic</code>,
<code>letter-spacing</code> (captured per character so subpixel offsets land
correctly), <code>word-spacing</code>, <code>line-height</code>,
<code>text-align: left / right / center / start / end</code>, all the
word-wrap properties (<code>overflow-wrap</code>, <code>word-break</code>,
<code>hyphens</code>) since the visual line breaks Chromium chose are
captured directly, and <code>white-space: pre</code> / <code>pre-wrap</code>
/ <code>nowrap</code>. Underline, line-through, and overline use the font's
<code>post.underlinePosition</code> / <code>OS/2.yStrikeoutPosition</code>
tables to match Chromium exactly, and <code>text-decoration-color</code> /
<code>-style</code> / <code>-thickness</code> all flow through.</p>

<p>Pseudo-elements: <code>::before</code> / <code>::after</code> (captured as
text segments with per-pseudo color / size / weight; <code>content: url(...)</code>
honoured), <code>::first-letter</code> drop caps (rasterised when
<code>font-size</code> differs), <code>::first-line</code>,
<code>::placeholder</code> (color / font-style / font-weight applied to
placeholder text), and <code>::marker</code> all work.</p>

<p>Scripts: Latin, Cyrillic, Greek, Arabic with contextual forms and ligatures
(run-based shaping plus bidi-js paired-bracket mirroring), Hebrew with niqqud,
Devanagari with cluster reordering preserved, Thai with mark-on-base
positioning, CJK (Han, Hiragana, Katakana, Hangul) with GPOS positioning, and
other complex scripts (Tibetan, Khmer, Burmese) via the same fallback-run
pipeline (not in the regression suite, but the mechanism is the same).</p>

<h2>The exceptions</h2>

<ul>
  <li><strong><code>text-align: justify</code></strong> — text is left-aligned
    in the SVG output (no inter-word stretching). Warning logged.</li>
  <li><strong>Wavy underline</strong> (<code>text-decoration-style: wavy</code>)
    — falls back to a straight line. Warning logged.</li>
  <li><strong>Web fonts not in the bundled mapping</strong> — capture works,
    but path-mode glyph rendering needs the font file to be discoverable in
    the host system; otherwise the renderer falls back to <code>&lt;text&gt;</code>
    elements that depend on the consumer's font cache. Either switch to a
    system-installed font for the demo or accept the cross-engine font
    differences.</li>
  <li><strong>Variable font axes other than weight</strong> — the weight axis
    works for variable SF Pro; other axes interpolate to the nearest static
    instance.</li>
  <li><strong>Emoji and colour-bitmap glyphs</strong> — embedded as base64 PNGs
    (deduped per glyph). Vector emoji fonts (e.g. COLRv1) collapse to bitmap.</li>
  <li><strong><code>::selection</code></strong> — captures don't include user
    selection state.</li>
</ul>

<h2>Common pitfalls</h2>

<ul>
  <li><strong>Web font not loaded yet.</strong> Always <code>await
    page.evaluate(() =&gt; document.fonts.ready)</code> before capturing.
    Without it you'll capture the fallback typeface and the layout will shift
    the next time you render.</li>
</ul>
`);
