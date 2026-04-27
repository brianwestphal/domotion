export const meta = {
  slug: "css/form-controls",
  title: "Form controls",
  subtitle: "Inputs, checkboxes, range sliders, progress bars, color pickers.",
};

export const content = `
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/form-controls.svg" alt="Six-tile gallery showing checkbox, radio, range slider, progress bar, meter, and colour input — each captured by Domotion." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">All six rendered by Domotion from the same plain-HTML inputs.</figcaption>
</figure>

<p>Form controls render their UI through Chromium's user-agent shadow DOM,
which isn't directly captured by walking the visible DOM. Domotion handles
this by detecting form-control tags and synthesising matching SVG markup
that mimics what Chromium paints, including support for the most common
author-styled <code>::-webkit-*</code> pseudos.</p>

<h2>Text inputs</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>&lt;input&gt;</code> with <code>value</code></td><td>Full — value rendered as path text.</td></tr>
    <tr><td>Placeholder text</td><td>Full — colour, font-style, font-weight from <code>::placeholder</code> honoured.</td></tr>
    <tr><td>Disabled / readonly visual states</td><td>Full</td></tr>
    <tr><td><code>&lt;textarea&gt;</code> content with word-wrap</td><td>Raster — captured via <code>page.screenshot</code> for pixel-perfect Chromium wrap behaviour.</td></tr>
    <tr><td>Cursor / focus ring at capture time</td><td>None — captures don't simulate focus.</td></tr>
  </tbody>
</table>

<h2>Choice inputs</h2>

<table>
  <thead><tr><th>Type</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>type="checkbox"</code></td><td>Full — synthesised checkbox with checkmark or indeterminate dash.</td></tr>
    <tr><td><code>type="radio"</code></td><td>Full — synthesised dot when checked.</td></tr>
    <tr><td><code>type="range"</code></td><td>Full — track + thumb. Author-styled <code>::-webkit-slider-runnable-track</code> and <code>::-webkit-slider-thumb</code> honoured.</td></tr>
    <tr><td><code>type="color"</code></td><td>Full — swatch shows the picker value.</td></tr>
    <tr><td><code>type="file"</code></td><td>Partial — button chrome only; selected filename text TBD.</td></tr>
  </tbody>
</table>

<h2>Progress &amp; meter</h2>

<table>
  <thead><tr><th>Element</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>&lt;progress&gt;</code></td><td>Full — bar + fill at <code>value / max</code>. Author-styled <code>::-webkit-progress-bar</code> and <code>::-webkit-progress-value</code> honoured.</td></tr>
    <tr><td><code>&lt;meter&gt;</code></td><td>Full — three-zone colouring (green / yellow / red) based on <code>low</code> / <code>high</code> / <code>optimum</code>.</td></tr>
  </tbody>
</table>

<h2>Buttons &amp; selects</h2>

<table>
  <thead><tr><th>Element</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td><code>&lt;button&gt;</code> with all-CSS styling</td><td>Full — captured as a normal styled element.</td></tr>
    <tr><td><code>&lt;button&gt;</code> relying on UA chrome (no CSS)</td><td>Partial — UA chrome partially synthesised.</td></tr>
    <tr><td><code>&lt;select&gt;</code> closed (showing selected option)</td><td>Partial — text shown; arrow / chevron approximated.</td></tr>
    <tr><td><code>&lt;select&gt;</code> open dropdown</td><td>None — Domotion can only capture what's painted in the page; the open dropdown lives in OS chrome.</td></tr>
  </tbody>
</table>

<h2>Capturing inputs in specific states</h2>

<p>Because Domotion captures whatever Chromium has painted, you can put an
input into any state before capturing:</p>

<pre><code><span class="tk-k">await</span> page.<span class="tk-f">fill</span>(<span class="tk-s">"input.search"</span>, <span class="tk-s">"design system"</span>);
<span class="tk-k">await</span> page.<span class="tk-f">check</span>(<span class="tk-s">"#dark-mode"</span>);
<span class="tk-k">await</span> page.<span class="tk-f">locator</span>(<span class="tk-s">"#range"</span>).<span class="tk-f">evaluate</span>((el: <span class="tk-t">HTMLInputElement</span>) =&gt; { el.value = <span class="tk-s">"75"</span>; });
<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, vp);</code></pre>

<h2>Author-styled pseudos</h2>

<p>Domotion's stylesheet walker reads author-defined CSS rules for
<code>::-webkit-progress-bar</code>, <code>::-webkit-progress-value</code>,
<code>::-webkit-slider-runnable-track</code>,
<code>::-webkit-slider-thumb</code>, and the input shadow pseudos. Rules
matching the captured element are applied to the synthesised SVG so a
custom-coloured progress bar or a styled slider thumb keeps its appearance
in the SVG output.</p>

<h2>See also</h2>

<ul>
  <li><code>docs/26-input-pseudos.md</code> in the repo — design notes on which
    shadow pseudos are recognised.</li>
  <li><code>docs/27-progress-meter-pseudos.md</code> — progress / meter pseudos.</li>
</ul>
`;
