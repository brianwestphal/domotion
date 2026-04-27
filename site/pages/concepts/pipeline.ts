export const meta = {
  slug: "concepts/pipeline",
  title: "The capture pipeline",
  subtitle: "What actually happens between setContent() and the returned SVG.",
};

export const content = `
<p>Domotion runs three logical stages: capture inside Chromium, raster
fall-back from Node, and render to SVG markup. Knowing where each step
happens makes it easier to debug surprising output and to know which
parts you can intercept or replace.</p>

<figure style="margin:24px 0;">
  <img src="../../assets/img/pipeline.svg" alt="Three labelled boxes connected by arrows: HTML/CSS, Element tree, SVG. The arrows are labelled captureElementTree() and elementTreeToSvg()." style="width:100%;height:auto;" />
  <figcaption style="font-size:13px;color:var(--fg-muted);text-align:center;margin-top:8px;">The capture pipeline at a glance. (This diagram itself is a Domotion-generated SVG.)</figcaption>
</figure>

<h2>Stage 1: in-page capture</h2>

<p>When you call <code>captureElementTree(page, selector, viewport)</code>,
Domotion serialises a self-contained "capture script" and asks Playwright to
<code>page.evaluate()</code> it inside the captured page. That script:</p>

<ol>
  <li>Walks the DOM under <code>selector</code> in paint order.</li>
  <li>Reads <code>getBoundingClientRect()</code> and <code>getComputedStyle()</code>
    for every element.</li>
  <li>For text-bearing nodes, splits text into segments and (where possible)
    measures the per-character viewport-relative <em>x offsets</em> using a
    Range object — so the renderer can place each glyph exactly where Chromium
    placed it.</li>
  <li>Detects un-renderable regions (color-bitmap glyphs, emoji, certain
    backdrop-filter layers, etc.) and tags them with a <em>raster rectangle</em>
    so Stage 2 can fill in a screenshot.</li>
  <li>Returns one big <code>CapturedElement[]</code> tree plus a list of
    <em>capture warnings</em> for unsupported features.</li>
</ol>

<div class="callout note">
  <span class="icon">ⓘ</span>
  <div class="body">
    <p>Because the capture script is serialised and run via
    <code>evaluate()</code>, it can't <code>import</code> from the rest of
    Domotion's source — only globals available in the page (<code>document</code>,
    <code>getComputedStyle</code>, etc.) and the arguments passed in. This is
    why you'll see plain JavaScript, not TypeScript module imports, inside
    the capture stage.</p>
  </div>
</div>

<h2>Stage 2: bitmap glyph rasterisation</h2>

<p>Some glyphs can't be expressed as font outlines: emoji, color-bitmap
codepoints, certain Apple-only typographic shapes. For each such region the
capture script left behind a rectangle; back in Node, Domotion calls
<code>page.screenshot({ clip })</code> on each unique rect, embeds the PNG
as a base64 data URI on the matching tree node, and dedupes by
<code>(text, color, fontSize, fontWeight, size)</code> so the same emoji
used five times in the document only screenshots once.</p>

<p>This stage is invisible to you — it just adds a fraction of a second
to capture latency when there are bitmap glyphs to handle.</p>

<h2>Stage 3: SVG rendering</h2>

<p><code>elementTreeToSvg(tree, width, height, idPrefix?)</code> is pure:
no Chromium, no I/O, just string concatenation. It walks the captured tree
recursively and emits SVG primitives:</p>

<table>
  <thead>
    <tr><th>Captured feature</th><th>SVG output</th></tr>
  </thead>
  <tbody>
    <tr><td>Background colors and per-side borders</td><td><code>&lt;rect&gt;</code> with rounded corners and clip paths.</td></tr>
    <tr><td>Box shadow</td><td>Layered <code>&lt;rect&gt;</code> + <code>&lt;filter&gt;</code> with <code>feGaussianBlur</code>.</td></tr>
    <tr><td>Text segments</td><td><code>&lt;path&gt;</code> + <code>&lt;use&gt;</code> with shared glyph defs (path mode), or <code>&lt;text&gt;</code> with CSS font properties (text mode).</td></tr>
    <tr><td>Linear / radial gradients</td><td><code>&lt;linearGradient&gt;</code> / <code>&lt;radialGradient&gt;</code> with px-positioned stops.</td></tr>
    <tr><td>Clip paths and masks</td><td><code>&lt;clipPath&gt;</code> / <code>&lt;mask&gt;</code> entries hoisted to <code>&lt;defs&gt;</code>.</td></tr>
    <tr><td>Form controls</td><td>Hand-rolled SVG markup mimicking Chromium's user-agent shadow DOM (see <a href="../../css/form-controls/">Form controls</a>).</td></tr>
    <tr><td>Transforms</td><td><code>transform="translate(...) rotate(...) ..."</code> on the wrapping group.</td></tr>
    <tr><td>Raster fall-backs</td><td><code>&lt;image href="data:image/png;base64,..."&gt;</code>.</td></tr>
  </tbody>
</table>

<p>The renderer emits readable, lightly indented SVG so the output diffs
cleanly. If you want it small for production, pipe it through
<a href="../../api/optimize-svg/"><code>optimizeSvg()</code></a>.</p>

<h2>End-to-end timing</h2>

<p>Order-of-magnitude numbers on an M1 MacBook for a typical hero-card capture:</p>

<ul>
  <li><strong>Browser launch:</strong> ~400&nbsp;ms (one-time, amortised across many captures).</li>
  <li><strong>Page load &amp; settle:</strong> 200–800&nbsp;ms depending on
    <code>networkidle</code>, fonts, and your own waits.</li>
  <li><strong>Stage 1 (in-page capture):</strong> 30–120&nbsp;ms for a few hundred
    elements; the bottleneck is per-element <code>getComputedStyle</code>.</li>
  <li><strong>Stage 2 (bitmap rasters):</strong> 0&nbsp;ms when there are no emoji /
    color-bitmap glyphs; ~60&nbsp;ms per unique screenshot otherwise.</li>
  <li><strong>Stage 3 (SVG render):</strong> &lt; 30&nbsp;ms — string ops only.</li>
</ul>

<p>If you're capturing many frames, keep one browser open for the duration of
your script (<code>chromium.launch()</code> once, capture in a loop, then
<code>browser.close()</code>) — relaunching dominates the timing.</p>

<h2>Where to intervene</h2>

<ul>
  <li><strong>Modify the page before capture.</strong> Anything you can do with
    Playwright before <code>captureElementTree</code> works:
    <code>page.addStyleTag</code>, <code>page.evaluate</code>,
    <code>page.click</code>, etc. Hide a cookie banner, click a "show more"
    toggle, swap a colour scheme.</li>
  <li><strong>Inspect or transform the tree.</strong> The
    <code>CapturedElement[]</code> returned from Stage 1 is a plain serialisable
    object. You can mutate it before passing to <code>elementTreeToSvg</code>
    (e.g. clip out an element, replace a text node, scale a region).</li>
  <li><strong>Post-process the SVG.</strong> The output is a string. Pass it
    through <code>optimizeSvg()</code> for size, or run your own regex if you
    need to re-namespace IDs or strip a class.</li>
</ul>

<h2>Next</h2>
<p><a href="../element-tree/">The element tree</a> walks the
<code>CapturedElement</code> shape in detail, then
<a href="../text-rendering/">Text rendering</a> covers the path / text mode
trade-off.</p>
`;
