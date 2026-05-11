/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/optimization",
  title: "Optimize output size",
  subtitle: "Get from a 60 KB hero to a 25 KB one without sacrificing fidelity.",
};

export const content: SafeHtml = raw(`
<p>SVG output from Domotion is moderately sized by default — a hero card runs
20–60&nbsp;KB, a multi-frame animation 80–200&nbsp;KB. If that's good enough for
your context, ship it. If you need it smaller, the techniques on this page
typically halve the file size.</p>

<h2>Always run optimizeSvg()</h2>

<p>The single highest-leverage step is one line:</p>

<pre><code><span class="tk-k">import</span> { optimizeSvg } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;
<span class="tk-k">const</span> small = <span class="tk-f">optimizeSvg</span>(svg);</code></pre>

<p>This runs SVGO with a structure-preserving plugin set: shorter path
commands, lower decimal precision, collapsed transforms. Typical reduction
is 30–50%, with bigger wins on path-heavy text. See
<a href="../../api/optimize-svg/"><code>optimizeSvg()</code></a> for plugin
details.</p>

<h2>Capture only what you'll show</h2>

<p>The biggest cost is glyph outlines, and you only pay for glyphs that
appear in the captured tree. Two patterns:</p>

<ul>
  <li><strong>Crop to the visible region.</strong> Don't capture a 1200×800
    body when the demo is a 600×300 card. Use the bounding box of the card
    as the viewport.</li>
  <li><strong>Strip irrelevant subtrees.</strong> Hide the cookie banner /
    nav / footer with <code>page.evaluate(() =&gt; el.remove())</code> before
    capturing.</li>
</ul>

<h2>Lean into glyph deduplication</h2>

<p>Path mode emits each unique glyph once into <code>&lt;defs&gt;</code> and
references it with <code>&lt;use&gt;</code>. So 100 instances of the letter
"e" in body text cost ~one path's worth of bytes, not 100. Two implications:</p>

<ul>
  <li>Repeating UI patterns (a list of items with similar text) compress
    well — repeated glyphs share defs.</li>
  <li>Mixing many fonts and weights on one capture costs more than sticking
    with one or two — different weights are different glyphs.</li>
</ul>

<h2>Prefer crossfade transitions in animated SVGs</h2>

<p>An all-crossfade animation hits the merge fast path:
<code>generateAnimatedSvg</code> de-duplicates elements across frames,
emitting stable elements (logo, header, things that don't change) once
with a permanent <code>opacity: 1</code>. Changing elements get a small
visibility timeline. The output is dramatically smaller than the
"emit each frame as a clipped group" fallback used for
<code>push-left</code> and <code>scroll</code>.</p>

<p>If you can express your story as a series of state changes within the
same screen, all-crossfade will give you the smallest result.</p>

<h2>Skip overlays when state can be captured</h2>

<p>Any overlay disables the merge fast path. If the typed text or click
state could just be part of the captured HTML for the next frame, it's
both smaller and (slightly) cleaner.</p>

<h2>Keep frame count modest</h2>

<p>Each frame is one capture's worth of glyph outlines. Even with
deduplication, going from 4 frames to 12 typically more than doubles the
output. Aim for the smallest number of frames that tells the story —
3–5 is usually enough.</p>

<h2>Round and reduce</h2>

<p>If you're hand-authoring HTML for a demo (not capturing your real
product), round coordinates and avoid sub-pixel positioning where you can.
Per-character x offsets are stored to one decimal place after
<code>optimizeSvg</code> — fewer non-zero decimals compress better.</p>

<h2>Compress for transport</h2>

<p>SVGs are plain text. Two transport-level wins worth knowing:</p>

<ul>
  <li><strong>gzip</strong> — most CDNs and servers gzip text/svg+xml
    responses by default. Path data compresses very well; expect another
    50–70% reduction on the wire.</li>
  <li><strong>Brotli</strong> — even better than gzip when supported,
    typically another 10–15% on top.</li>
</ul>

<p>Concretely: a 60&nbsp;KB SVG often arrives at the browser as ~12&nbsp;KB
over Brotli. Don't over-optimize the source if your transport handles
compression.</p>

<h2>Measure first</h2>

<p>If you're spending time on optimization, instrument it:</p>

<pre><code><span class="tk-k">const</span> raw = <span class="tk-f">elementTreeToSvg</span>(tree, w, h);
<span class="tk-k">const</span> small = <span class="tk-f">optimizeSvg</span>(raw);
console.<span class="tk-f">log</span>(<span class="tk-s">\`raw=\${raw.length} optimized=\${small.length} ratio=\${(small.length/raw.length).<span class="tk-f">toFixed</span>(<span class="tk-n">2</span>)}\`</span>);</code></pre>

<p>Then look at the structure of the SVG itself: which glyph defs are
biggest, which gradients are unused, where the byte count concentrates.
SVG is text — <code>grep</code> and an editor get you a long way.</p>

<h2>See also</h2>

<ul>
  <li><a href="../../api/optimize-svg/"><code>optimizeSvg()</code></a></li>
  <li><a href="../../concepts/animation/">Animation model</a> — explains why
    all-crossfade is special.</li>
</ul>
`);
