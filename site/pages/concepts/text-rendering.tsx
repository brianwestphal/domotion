/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "concepts/text-rendering",
  title: "Text rendering",
  subtitle: "Path outlines, native <text>, and when each is the right call.",
};

export const content: SafeHtml = raw(`
<p>Text is the part of an HTML capture most likely to look subtly wrong if
you treat it carelessly — fonts shape differently in different engines, sub-pixel
positioning matters, and certain scripts (Arabic, Devanagari, complex Indic)
require contextual shaping. Domotion handles all of this; this page explains
how, and what you can choose to influence.</p>

<h2>Path mode (default)</h2>

<p>By default, Domotion converts every captured glyph into an SVG
<code>&lt;path&gt;</code> using <a href="https://github.com/foliojs/fontkit"
rel="noopener" target="_blank">fontkit</a> to extract outlines from the matching
system font. Identical glyphs are emitted once into <code>&lt;defs&gt;</code> and
referenced via <code>&lt;use href="#g-XX"&gt;</code> across the document, so
text-heavy captures don't bloat linearly with character count.</p>

<p>This mode is the default for two reasons:</p>

<ol>
  <li><strong>Cross-browser consistency.</strong> The shapes are baked into the
    SVG; Firefox, Safari, and Chromium all paint the same thing. With native
    <code>&lt;text&gt;</code> you'd see slight differences from each engine's
    font hinting.</li>
  <li><strong>Self-containment.</strong> Path mode embeds the visible glyphs
    directly. The SVG doesn't need an external font file, doesn't trigger a
    network request, and renders identically when emailed, pasted into a doc,
    or opened offline.</li>
</ol>

<p>Trade-off: path data is bigger than text. A typical hero captures at
~25–60&nbsp;KB in path mode versus ~10&nbsp;KB if it were native text. For most
marketing / docs use cases that's well worth it.</p>

<h2>Per-character anchoring</h2>

<p>The renderer pins each glyph at the exact viewport-relative x position
that Chromium painted it (the <code>xOffsets</code> array on each text
segment). It does <em>not</em> round to integer pixels — Chromium uses
sub-pixel positioning, and rounding accumulates ~0.5&nbsp;px of drift per
character, which becomes visible across long lines of monospaced text.</p>

<p>For the rare case where <code>xOffsets</code> isn't available (input
values, certain pseudo-element content), the renderer falls back to
fontkit advance widths from the run start.</p>

<h2>Run-based shaping for fallback fonts</h2>

<p>When a captured line mixes scripts ("Hello مرحبا"), Chromium uses
different fonts for each script. Domotion detects fallback runs and shapes
each contiguous fallback run as a unit using <code>font.layout(runText)</code>
— which means Arabic initial / medial / final forms, Devanagari ligature
clusters, and Thai mark-on-base positioning all survive the conversion to
SVG paths.</p>

<p>Bidirectional text (mixed LTR / RTL) is handled by
<a href="https://github.com/lojjic/bidi-js" rel="noopener" target="_blank">bidi-js</a>,
which performs paired-bracket mirroring on RTL embedding levels before the
text is shipped to the path renderer.</p>

<h2>Decoration metrics</h2>

<p>Underlines and strike-throughs are positioned and sized using the font's
own typographic tables — <code>post.underlinePosition</code>,
<code>post.underlineThickness</code>, and the
<code>OS/2.yStrikeoutPosition</code> / <code>yStrikeoutSize</code> entries
— rather than as a fraction of font size. This matches what Chromium consults,
so decorations land in the same place in the SVG as in the original render.</p>

<h2>What gets rasterized</h2>

<p>Path mode covers everything that can be expressed as font outlines.
Anything else falls back to a screenshot of that region:</p>

<ul>
  <li><strong>Color-bitmap glyphs</strong> (emoji on macOS, certain symbol
    fonts). Each unique glyph is screenshotted once and embedded as a base64
    PNG, then deduplicated for repeats.</li>
  <li><strong>Color emoji within a text run.</strong> The line still shapes as
    paths; the emoji glyph gets a per-character <code>&lt;image&gt;</code>
    overlay at the captured position.</li>
  <li><strong>Pseudos with bitmap-only content.</strong> If the entire
    <code>::before</code>/<code>::after</code> string is bitmap glyphs, the
    whole pseudo region is one screenshot.</li>
</ul>

<p>This is invisible from the API surface — you just get a slightly larger
SVG.</p>

<h2>Test-mode flags (developers only)</h2>

<p>Domotion's test runners expose a <code>--mode</code> flag with three values:
<code>css</code> (native <code>&lt;text&gt;</code>), <code>path</code> (the default
described above), and <code>font</code> (embed a subsetted woff2). These exist for
visual-regression diffing across rendering strategies, not as user-facing
configuration. The public <code>elementTreeToSvg()</code> entry point always
emits path-mode output today.</p>

<div class="callout note">
  <span class="icon">ⓘ</span>
  <div class="body">
    <p>If you have a use case where you want native <code>&lt;text&gt;</code>
    output (smaller files, accepting cross-engine font differences) or
    embedded-font output (smaller than path, identical across engines but
    larger than CSS), please file an issue. The internal renderer supports
    both modes; exposing them is a question of API design, not implementation.</p>
  </div>
</div>

<h2>Next</h2>
<p><a href="../animation/">Animation model</a> explains how multiple captured
frames are stitched into one animated SVG.</p>
`);
