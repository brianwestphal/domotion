export const meta = {
  slug: "css/text-and-fonts",
  title: "Text & fonts",
  subtitle: "What's supported across font families, weights, decorations, scripts.",
};

export const content = `
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/scripts-line.svg" alt="A line of text mixing Latin, Arabic, Devanagari, Chinese, and an emoji — all rendered as path-mode glyphs." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">Latin, Arabic, Devanagari, CJK and emoji on one line — all path-mode shaping.</figcaption>
</figure>

<p>For the design rationale (path mode, run-based shaping, decoration metrics)
see <a href="../../concepts/text-rendering/">Text rendering</a>. The
<a href="../../guides/fonts/">Fonts &amp; non-Latin scripts</a> guide covers
practical font choices. This page is the support matrix.</p>

<h2>Font selection</h2>

<table>
  <thead><tr><th>Aspect</th><th>Status</th><th>Notes</th></tr></thead>
  <tbody>
    <tr><td>Apple system fonts (SF Pro, SF Mono, New York)</td><td>Full</td><td>Bundled mapping table covers these.</td></tr>
    <tr><td>Common web-safe fallbacks (Helvetica, Arial, Times New Roman, Menlo, Monaco)</td><td>Full on macOS</td><td>Resolved through the system stack.</td></tr>
    <tr><td>Web fonts (Google Fonts, Adobe Fonts, self-hosted)</td><td>Partial</td><td>Capture works; path-mode glyphs fall back to <code>&lt;text&gt;</code> if the font isn't in the bundled mapping.</td></tr>
    <tr><td>Italic styles (SFNSItalic.ttf)</td><td>Full</td><td>Discovered via the same lookup table.</td></tr>
    <tr><td>Variable fonts</td><td>Partial</td><td>Weight axis works (variable SF). Other axes interpolate to nearest static instance.</td></tr>
  </tbody>
</table>

<h2>Sizing &amp; metrics</h2>

<table>
  <thead><tr><th>Property</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>font-size</code></td><td>Full</td></tr>
    <tr><td><code>font-weight</code> (100–900, normal, bold)</td><td>Full</td></tr>
    <tr><td><code>font-style</code>: italic</td><td>Full (uses dedicated italic file when available)</td></tr>
    <tr><td><code>font-variant-numeric</code> / <code>font-feature-settings</code></td><td>Partial — features that don't change layout work; layout-affecting features (e.g. tabular-nums) are honored via Chromium's measurement.</td></tr>
    <tr><td><code>letter-spacing</code></td><td>Full — captured in per-character offsets.</td></tr>
    <tr><td><code>word-spacing</code></td><td>Full</td></tr>
    <tr><td><code>line-height</code></td><td>Full — multi-line capture honours computed line-height.</td></tr>
  </tbody>
</table>

<h2>Alignment &amp; wrapping</h2>

<table>
  <thead><tr><th>Property</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>text-align: left / right / center / start / end</code></td><td>Full</td></tr>
    <tr><td><code>text-align: justify</code></td><td>Partial — text is left-aligned in the SVG (no inter-word stretching). Warning logged.</td></tr>
    <tr><td>Word wrap (<code>overflow-wrap</code>, <code>word-break</code>, <code>hyphens</code>)</td><td>Full — the visual line breaks Chromium chose are captured directly.</td></tr>
    <tr><td><code>white-space: pre / pre-wrap / nowrap</code></td><td>Full</td></tr>
  </tbody>
</table>

<h2>Decorations</h2>

<ul>
  <li><strong>Underline, line-through, overline</strong> — full support. Position
    and thickness are read from the font's
    <code>post.underlinePosition</code> / <code>OS/2.yStrikeoutPosition</code>
    tables to match Chromium exactly.</li>
  <li><strong>Decoration colour, style, thickness</strong> — captured from
    <code>text-decoration-color</code>, <code>-style</code>,
    <code>-thickness</code> and applied to the SVG decoration.</li>
  <li><strong>Wavy underline</strong> — falls back to a straight line. Warning
    logged.</li>
</ul>

<h2>Scripts</h2>

<table>
  <thead><tr><th>Script</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Latin (incl. accented forms)</td><td>Full</td></tr>
    <tr><td>Cyrillic</td><td>Full</td></tr>
    <tr><td>Greek</td><td>Full</td></tr>
    <tr><td>Arabic (incl. contextual forms, ligatures)</td><td>Full — run-based shaping with bidi-js mirroring.</td></tr>
    <tr><td>Hebrew (incl. niqqud)</td><td>Full</td></tr>
    <tr><td>Devanagari (Hindi, Marathi, Sanskrit)</td><td>Full — cluster reordering preserved.</td></tr>
    <tr><td>Thai (mark-on-base)</td><td>Full</td></tr>
    <tr><td>CJK (Han, Hiragana, Katakana, Hangul)</td><td>Full — GPOS positioning honoured.</td></tr>
    <tr><td>Emoji / colour-bitmap glyphs</td><td>Raster fallback (base64 PNG, deduped per glyph).</td></tr>
    <tr><td>Other complex scripts (Tibetan, Khmer, Burmese)</td><td>Should work via the same fallback-run pipeline; not in the visual-regression suite.</td></tr>
  </tbody>
</table>

<h2>Pseudo elements</h2>

<table>
  <thead><tr><th>Pseudo</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>::before</code> / <code>::after</code></td><td>Full — captured as text segments with per-pseudo color / size / weight overrides. Image content (<code>content: url(...)</code>) honoured.</td></tr>
    <tr><td><code>::first-letter</code></td><td>Full — drop caps with different font-size are rasterised at the correct dimensions.</td></tr>
    <tr><td><code>::first-line</code></td><td>Full</td></tr>
    <tr><td><code>::placeholder</code></td><td>Full — color, font-style, font-weight applied to placeholder text in inputs.</td></tr>
    <tr><td><code>::marker</code></td><td>Full — color, font-weight, font-size honoured on list markers.</td></tr>
    <tr><td><code>::selection</code></td><td>None — captures don't include user selection state.</td></tr>
  </tbody>
</table>

<h2>Common pitfalls</h2>

<ul>
  <li><strong>Web font not loaded yet.</strong> Always <code>await
    page.evaluate(() =&gt; document.fonts.ready)</code>. Without it you'll
    capture the fallback typeface and the layout will shift the next time
    you render.</li>
  <li><strong>Font-family isn't in the bundled mapping.</strong> The path
    renderer falls back to <code>&lt;text&gt;</code>. Either switch to a
    system font for the demo or accept the cross-engine font differences.</li>
</ul>
`;
