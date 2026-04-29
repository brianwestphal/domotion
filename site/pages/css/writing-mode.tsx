/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/writing-mode",
  title: "Writing mode (RTL / vertical)",
  subtitle: "RTL is fully supported. Vertical writing-mode falls back to horizontal for now.",
};

export const content: SafeHtml = raw(`
<h2>Right-to-left scripts — full support</h2>

<p>Arabic, Hebrew, and other RTL scripts round-trip faithfully. Domotion uses
<a href="https://github.com/lojjic/bidi-js" rel="noopener" target="_blank">bidi-js</a>
to apply paired-bracket mirroring on RTL embedding levels before the text
reaches the path renderer, then run-based fontkit shaping to produce the
correct contextual glyph forms.</p>

<p>Pure RTL paragraphs, mixed LTR / RTL on the same line ("Hello مرحبا
world"), bracket and quote mirroring (<code>(</code> / <code>)</code> swap
visual direction inside RTL runs), numerical digits in RTL contexts, and
RTL alignment via <code>direction: rtl</code> on the parent all work as
authored.</p>

<h2>The exception: vertical writing modes</h2>

<p><code>writing-mode: vertical-rl</code>, <code>vertical-lr</code>, and
<code>sideways-rl</code> / <code>sideways-lr</code> currently render as
horizontal-tb. <code>text-orientation</code> only matters in vertical modes
and is therefore also unsupported. A warning is logged whenever a vertical
writing mode is captured.</p>

<h3>Why this is hard</h3>

<p>Vertical writing changes per-glyph orientation rules, line-break direction,
and how decorations attach. The element-raster fallback is the planned path
forward — capturing the vertical region as a screenshot and embedding it as
an SVG <code>&lt;image&gt;</code> — but it isn't yet wired up. See
<code>docs/02-writing-mode.md</code> in the repo for the design notes.</p>

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
`);
