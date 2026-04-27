export const meta = {
  slug: "css/overview",
  title: "CSS support overview",
  subtitle: "What round-trips, what falls back to raster, what's not yet supported.",
};

export const content = `
<p>Domotion targets Chromium on macOS as the canonical reference render. The
goal is sub-3% pixel-diff fidelity for everything in the "supported" column —
in practice many features are pixel-identical. This page is the at-a-glance
support matrix; the per-area pages in this section have the details and
the known caveats.</p>

<h2>Reading the matrix</h2>

<ul>
  <li><strong>Full</strong> — round-trips faithfully, &lt; 3% pixel-diff vs. Chromium capture.</li>
  <li><strong>Partial</strong> — works for the common cases listed; edge cases below threshold.</li>
  <li><strong>Raster</strong> — captured but emitted as a screenshot
    <code>&lt;image&gt;</code> instead of native SVG primitives.</li>
  <li><strong>None</strong> — captured but not emitted, or emitted approximately;
    a warning is logged.</li>
</ul>

<h2>Layout &amp; box model</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>position: static / relative / absolute</code></td><td>Full</td></tr>
    <tr><td><code>position: fixed / sticky</code></td><td>Partial — paint order correct, no scroll-following.</td></tr>
    <tr><td><code>display: block / inline / inline-block / flex / grid / table</code></td><td>Full</td></tr>
    <tr><td><code>float</code> + <code>clear</code></td><td>Full — text wraps via per-line capture.</td></tr>
    <tr><td><code>box-sizing</code>, margin, padding, sizing</td><td>Full</td></tr>
    <tr><td><code>overflow: hidden / clip</code></td><td>Full — children clipped to padding box.</td></tr>
    <tr><td><code>overflow: scroll / auto</code></td><td>Partial — content clipped, native scrollbar chrome not yet emulated.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../layout/">CSS support: layout</a>.</p>

<h2>Backgrounds &amp; colors</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Modern color formats (hex, rgb, hsl, hwb, lab, lch, oklab, oklch, color(), color-mix())</td><td>Full</td></tr>
    <tr><td>Solid + transparent backgrounds</td><td>Full</td></tr>
    <tr><td><code>linear-gradient</code>, <code>radial-gradient</code> (incl. <code>repeating-*</code>)</td><td>Full</td></tr>
    <tr><td>Multiple background layers</td><td>Full — first-on-top semantics preserved.</td></tr>
    <tr><td><code>conic-gradient</code></td><td>None — no SVG equivalent; layer skipped, warning logged.</td></tr>
    <tr><td><code>background: url(...)</code></td><td>Partial — center / cover approximated.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../colors-bg/">Colors &amp; backgrounds</a>, <a href="../gradients/">Gradients</a>.</p>

<h2>Borders &amp; effects</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Uniform borders + per-side borders + per-corner radius</td><td>Full</td></tr>
    <tr><td><code>border-style</code>: solid / dashed / dotted / double / groove / ridge / inset / outset</td><td>Full</td></tr>
    <tr><td><code>border-radius: 50%</code> on a square box</td><td>Full — circle output.</td></tr>
    <tr><td><code>border-image</code></td><td>None</td></tr>
    <tr><td><code>outline</code> incl. dashed / dotted</td><td>Full</td></tr>
    <tr><td><code>box-shadow</code> outset and inset, blur, multi-layer</td><td>Full — uses SVG <code>feGaussianBlur</code>.</td></tr>
    <tr><td><code>text-shadow</code> incl. multi-layer</td><td>Full</td></tr>
    <tr><td><code>opacity</code></td><td>Full — applies to whole subtree.</td></tr>
    <tr><td><code>filter</code> (blur, brightness, drop-shadow, grayscale, hue-rotate, etc.)</td><td>Full</td></tr>
    <tr><td><code>mix-blend-mode</code></td><td>Full</td></tr>
    <tr><td><code>backdrop-filter</code></td><td>None — no SVG equivalent in <code>&lt;img&gt;</code>-rendered SVG.</td></tr>
    <tr><td><code>clip-path</code>: <code>inset</code>, <code>circle</code>, <code>ellipse</code>, <code>polygon</code></td><td>Full</td></tr>
    <tr><td><code>clip-path: path()</code></td><td>None — warning logged.</td></tr>
    <tr><td><code>mask</code></td><td>None — captured but not yet emitted.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../borders/">Borders &amp; radius</a>.</p>

<h2>Transforms</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>transform: translate(...)</code></td><td>Partial — bounding box absorbs the translation.</td></tr>
    <tr><td><code>transform: rotate / scale / skew / matrix</code></td><td>None — currently rendered as axis-aligned bounding box.</td></tr>
    <tr><td>3D transforms</td><td>None — out of scope.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../transforms/">Transforms</a>.</p>

<h2>Typography</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>SF Pro / SF Mono families</td><td>Full</td></tr>
    <tr><td>Other families</td><td>Partial — fall back when not in lookup table.</td></tr>
    <tr><td>Weight / size / style / variant / stretch</td><td>Full</td></tr>
    <tr><td><code>letter-spacing</code>, <code>word-spacing</code>, <code>line-height</code></td><td>Full</td></tr>
    <tr><td>Multi-line wrapped paragraphs</td><td>Full — per-visual-line capture.</td></tr>
    <tr><td><code>text-align: left / right / center / start / end</code></td><td>Full</td></tr>
    <tr><td><code>text-align: justify</code></td><td>Partial — does not space-stretch.</td></tr>
    <tr><td>RTL / bidi shaping</td><td>Full — Arabic / Hebrew / Devanagari / Thai / CJK supported.</td></tr>
    <tr><td><code>writing-mode: vertical-*</code></td><td>None — currently rendered as horizontal.</td></tr>
    <tr><td>Emoji / colour-bitmap glyphs</td><td>Raster — embedded as base64 PNG.</td></tr>
    <tr><td><code>::first-letter</code> drop caps</td><td>Full — rasterised when font-size differs.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../text-and-fonts/">Text &amp; fonts</a>,
<a href="../writing-mode/">Writing mode (RTL / vertical)</a>.</p>

<h2>Form controls</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>&lt;input&gt;</code> with value</td><td>Full</td></tr>
    <tr><td><code>&lt;input&gt;</code> placeholder</td><td>Full — <code>::placeholder</code> color / font-style honoured.</td></tr>
    <tr><td><code>&lt;textarea&gt;</code> content</td><td>Raster — pixel-perfect Chromium word-wrap.</td></tr>
    <tr><td><code>&lt;input type="checkbox" / radio / range / color"&gt;</code></td><td>Full — synthesised SVG mimics Chromium's UA chrome.</td></tr>
    <tr><td><code>&lt;progress&gt;</code>, <code>&lt;meter&gt;</code></td><td>Full incl. author-styled <code>::-webkit-*</code> pseudos.</td></tr>
    <tr><td><code>&lt;button&gt;</code>, <code>&lt;select&gt;</code> chrome</td><td>Partial — author-styled <code>::-webkit-*</code> pseudos partially supported.</td></tr>
  </tbody>
</table>

<p>Details: <a href="../form-controls/">Form controls</a>.</p>

<h2>Out of scope (today)</h2>

<ul>
  <li><code>&lt;canvas&gt;</code>, <code>&lt;video&gt;</code>, <code>&lt;iframe&gt;</code>,
    <code>&lt;object&gt;</code>, <code>&lt;embed&gt;</code> — bodies not rendered, warning logged.</li>
  <li>CSS animations / transitions — Domotion captures a static frame; multi-frame
    animation is composed at a higher layer
    (<a href="../../api/generate-animated-svg/"><code>generateAnimatedSvg</code></a>).</li>
  <li><code>@page</code> print-media rules.</li>
</ul>

<h2>Warnings</h2>

<p>When a capture encounters a feature that doesn't round-trip fully, Domotion
records a warning so you can find it. The helpers are exported from the
package root:</p>

<pre><code><span class="tk-k">import</span> { getLastCaptureWarnings, logCaptureWarnings } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-f">logCaptureWarnings</span>();                  <span class="tk-c">// to stderr</span>
<span class="tk-k">const</span> warnings = <span class="tk-f">getLastCaptureWarnings</span>(); <span class="tk-c">// or programmatic</span></code></pre>

<p>Each warning has a <code>selector</code> (short ancestor-path identifier),
a <code>feature</code> name, and a one-sentence <code>detail</code>. They're
deduped by <code>(feature, selector)</code> per capture.</p>
`;
