/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/form-controls",
  title: "Form controls",
  subtitle: "Inputs, checkboxes, range sliders, progress bars, color pickers — synthesised SVG that mimics Chromium.",
};

export const content: SafeHtml = raw(`
<figure style="margin:0 0 24px;">
  <img src="../../assets/img/form-controls.svg" alt="Six-tile gallery showing checkbox, radio, range slider, progress bar, meter, and colour input — each captured by Domotion." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="margin-top:8px;font-size:13px;color:var(--fg-muted);">All six rendered by Domotion from the same plain-HTML inputs.</figcaption>
</figure>

<p>Form controls render their UI through Chromium's user-agent shadow DOM,
which isn't directly captured by walking the visible DOM. Domotion handles
this by detecting form-control tags and synthesising matching SVG markup
that mimics what Chromium paints, including support for the most common
author-styled <code>::-webkit-*</code> pseudos.</p>

<p>What round-trips: <code>&lt;input&gt;</code> with <code>value</code>
(rendered as path-mode text), <code>::placeholder</code> styling
(color / font-style / font-weight), disabled and readonly visual states,
<code>&lt;input type="checkbox"&gt;</code> (checkmark or indeterminate dash),
<code>&lt;input type="radio"&gt;</code> (dot when checked),
<code>&lt;input type="range"&gt;</code> (track + thumb with author-styled
<code>::-webkit-slider-runnable-track</code> and
<code>::-webkit-slider-thumb</code>), <code>&lt;input type="color"&gt;</code>
(swatch shows the picker value), <code>&lt;progress&gt;</code> (bar + fill
at <code>value / max</code>; author-styled <code>::-webkit-progress-bar</code>
and <code>::-webkit-progress-value</code>), <code>&lt;meter&gt;</code>
(three-zone colouring based on <code>low</code> / <code>high</code> /
<code>optimum</code>), and any <code>&lt;button&gt;</code> with author CSS
applied (it captures as a normal styled element).</p>

<h2>The exceptions</h2>

<ul>
  <li><strong><code>&lt;input type="file"&gt;</code></strong> — button chrome
    only; the selected filename text doesn't render yet.</li>
  <li><strong><code>&lt;textarea&gt;</code> content</strong> — captured via
    <code>page.screenshot</code> and embedded as a raster <code>&lt;image&gt;</code>
    so word-wrap is pixel-perfect to Chromium. Sharp at 1× but doesn't scale
    crisply like path-mode text.</li>
  <li><strong>Bare <code>&lt;button&gt;</code> / <code>&lt;select&gt;</code>
    with no author CSS</strong> — the UA chrome is partially synthesised.
    Style the control with CSS for full fidelity.</li>
  <li><strong>Open <code>&lt;select&gt;</code> dropdowns</strong> — can't be
    captured. The open dropdown lives in OS chrome, not in the page DOM.
    Closed selects (showing the selected option text + chevron) work.</li>
  <li><strong>Cursor and focus ring at capture time</strong> — captures don't
    simulate focus / hover / selection state. Set the desired state in
    Playwright before capturing if you need it.</li>
</ul>

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
  <li><code>docs/04-input-pseudos.md</code> in the repo — design notes on which
    shadow pseudos are recognised.</li>
  <li><code>docs/05-progress-meter-pseudos.md</code> — progress / meter pseudos.</li>
</ul>
`);
