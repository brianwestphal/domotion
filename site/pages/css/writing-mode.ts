export const meta = {
  slug: "css/writing-mode",
  title: "Writing mode (RTL / vertical)",
  subtitle: "RTL is fully supported. Vertical writing-mode falls back to horizontal for now.",
};

export const content = `
<h2>Right-to-left scripts</h2>

<p>Arabic, Hebrew, and other RTL scripts are fully supported. Domotion uses
<a href="https://github.com/lojjic/bidi-js" rel="noopener" target="_blank">bidi-js</a>
to apply paired-bracket mirroring on RTL embedding levels before the text
reaches the path renderer, then run-based fontkit shaping to produce the
correct contextual glyph forms.</p>

<p>What works:</p>

<ul>
  <li>Pure RTL paragraphs.</li>
  <li>Mixed LTR / RTL text on the same line ("Hello مرحبا world").</li>
  <li>Bracket and quote mirroring (<code>(</code> / <code>)</code> swap visual
    direction inside RTL runs).</li>
  <li>Numerical digits in RTL contexts.</li>
  <li>RTL text alignment via <code>direction: rtl</code> on the parent.</li>
</ul>

<h2>Vertical writing modes</h2>

<table>
  <thead><tr><th>Mode</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>writing-mode: horizontal-tb</code> (default)</td><td>Full</td></tr>
    <tr><td><code>writing-mode: vertical-rl</code></td><td>None — currently rendered as horizontal. Warning logged.</td></tr>
    <tr><td><code>writing-mode: vertical-lr</code></td><td>None — same.</td></tr>
    <tr><td><code>writing-mode: sideways-rl / sideways-lr</code></td><td>None — same.</td></tr>
    <tr><td><code>text-orientation</code></td><td>None — only meaningful in vertical writing modes.</td></tr>
  </tbody>
</table>

<h3>Why this is hard</h3>

<p>Vertical writing changes per-glyph orientation rules, line-break direction,
and how decorations attach. The element-raster fallback is the planned path
forward — capturing the vertical region as a screenshot and embedding it as
an SVG <code>&lt;image&gt;</code> — but it isn't yet wired up. See
<code>docs/24-writing-mode.md</code> in the repo for the design notes.</p>

<h3>Workarounds</h3>

<ul>
  <li>If you have a small vertical region (a side label, a vertical badge),
    pre-render it as an inline SVG and let it pass through unchanged.</li>
  <li>If you have a large vertical block (a vertical-Japanese article),
    Domotion is not the right tool today — capture as a static PNG instead.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../../guides/fonts/">Fonts &amp; non-Latin scripts</a> — script
    coverage and shaping behaviour.</li>
</ul>
`;
