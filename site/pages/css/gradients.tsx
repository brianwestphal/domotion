/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "css/gradients",
  title: "Gradients",
  subtitle: "Linear, radial, and repeating gradients all round-trip natively.",
};

export const content: SafeHtml = raw(`
<p>CSS gradients convert to native SVG <code>&lt;linearGradient&gt;</code> and
<code>&lt;radialGradient&gt;</code> elements. Stop colours, positions, and
angles are emitted in pixels — there's no floating-point approximation in
the output, and the gradient stays correct under any zoom level because
the SVG <code>viewBox</code> handles proportional scaling.</p>

<figure style="margin:20px 0;">
  <img src="../../assets/img/gradient-gallery.svg" alt="Three swatches showing a linear, radial, and repeating-linear gradient — all converted to native SVG gradients." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="font-size:13px;color:var(--fg-muted);text-align:center;margin-top:8px;">Linear, radial, and repeating gradients — captured from CSS into native SVG.</figcaption>
</figure>

<p>What works without caveats: angle-based and keyword-based linear gradients
(<code>linear-gradient(135deg, ...)</code>, <code>linear-gradient(to right top, ...)</code>);
radial gradients with circle and ellipse shapes, sizing keywords
(<code>closest-side</code> / <code>closest-corner</code> / <code>farthest-side</code>
/ <code>farthest-corner</code>), and offset centres (<code>at &lt;position&gt;</code>);
both <code>repeating-*</code> variants (<code>spreadMethod="repeat"</code>);
hint stops and double-position stops; gradients applied via
<code>background-clip: text</code>.</p>

<h2>The exceptions</h2>

<ul>
  <li><strong><code>conic-gradient</code></strong> — no SVG equivalent in
    <code>&lt;img&gt;</code>-rendered SVG. The layer is skipped and a warning
    is logged.</li>
  <li><strong>Non-sRGB interpolation.</strong> CSS Color Module 5 lets you
    pick alternate interpolation spaces
    (<code>linear-gradient(in oklch, ...)</code>); Domotion samples the resolved
    gradient at fixed positions and emits sRGB stops. The output is visually
    close but not identical for OKLCH-interpolated gradients with widely-separated
    colours.</li>
</ul>

<h2>Examples</h2>

<p>Each of these captures cleanly:</p>

<pre><code><span class="tk-c">/* Diagonal accent */</span>
background: linear-gradient(<span class="tk-n">135</span>deg, #79b8ff <span class="tk-n">0</span>%, #d2a8ff <span class="tk-n">100</span>%);

<span class="tk-c">/* Gradient text */</span>
background: linear-gradient(<span class="tk-n">90</span>deg, #79b8ff, #56d364);
-webkit-background-clip: text;
color: transparent;

<span class="tk-c">/* Glow */</span>
background: radial-gradient(circle at center, #79b8ff <span class="tk-n">0</span>%, transparent <span class="tk-n">70</span>%);

<span class="tk-c">/* Stripes */</span>
background: repeating-linear-gradient(<span class="tk-n">45</span>deg, #1a2029 <span class="tk-n">0</span>px <span class="tk-n">10</span>px, #21262d <span class="tk-n">10</span>px <span class="tk-n">20</span>px);</code></pre>
`);
