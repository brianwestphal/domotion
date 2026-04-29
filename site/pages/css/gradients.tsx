/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/gradients",
  title: "Gradients",
  subtitle: "linear-gradient and radial-gradient round-trip; conic does not.",
};

export const content: SafeHtml = raw(`
<p>Domotion converts CSS gradients to native SVG
<code>&lt;linearGradient&gt;</code> and <code>&lt;radialGradient&gt;</code>
elements. The conversion preserves stop colours, positions, and angles
in pixels — there's no floating-point approximation in the output.</p>

<figure style="margin:20px 0;">
  <img src="../../assets/img/gradient-gallery.svg" alt="Three swatches showing a linear, radial, and repeating-linear gradient — all converted to native SVG gradients." style="width:100%;height:auto;border-radius:10px;border:1px solid var(--line);" />
  <figcaption style="font-size:13px;color:var(--fg-muted);text-align:center;margin-top:8px;">Linear, radial, and repeating gradients — captured from CSS into native SVG.</figcaption>
</figure>

<h2>Support matrix</h2>

<table>
  <thead><tr><th>CSS</th><th>SVG output</th><th>Status</th></tr></thead>
  <tbody>
    <tr>
      <td><code>linear-gradient(angle, c1, c2, ...)</code></td>
      <td><code>&lt;linearGradient&gt;</code> with px-positioned stops, angle converted to <code>(x1, y1) → (x2, y2)</code></td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>linear-gradient(to right top, ...)</code> and other keywords</td>
      <td>Same — keywords resolve to angles before emission</td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>repeating-linear-gradient(...)</code></td>
      <td><code>&lt;linearGradient spreadMethod="repeat"&gt;</code></td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>radial-gradient(shape, c1, c2, ...)</code></td>
      <td><code>&lt;radialGradient&gt;</code> with computed centre, focal point, and radii</td>
      <td>Full — circle and ellipse shapes both work.</td>
    </tr>
    <tr>
      <td><code>radial-gradient(... at &lt;position&gt;, ...)</code></td>
      <td>Centre offset honoured</td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>radial-gradient(closest-side / closest-corner / farthest-side / farthest-corner, ...)</code></td>
      <td>Sizing keyword resolved to pixel radii</td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>repeating-radial-gradient(...)</code></td>
      <td><code>&lt;radialGradient spreadMethod="repeat"&gt;</code></td>
      <td>Full</td>
    </tr>
    <tr>
      <td><code>conic-gradient(...)</code></td>
      <td>—</td>
      <td>None — no SVG equivalent in <code>&lt;img&gt;</code>-rendered SVG. Layer skipped, warning logged.</td>
    </tr>
  </tbody>
</table>

<h2>Stop placement</h2>

<p>Stops are positioned in <em>pixels</em> in the SVG output, computed from the
element's box dimensions at capture time. That means a gradient captured at
600&nbsp;px wide stays correct when the SVG is scaled — the
<code>viewBox</code> takes care of proportional scaling.</p>

<p>Implicit-position stops (no percentage given) are resolved to evenly-spaced
positions before emission, matching CSS.</p>

<h2>Multi-stop interpolation</h2>

<p>CSS allows hint stops (e.g. <code>linear-gradient(red, 30%, blue)</code>
where <code>30%</code> is the colour-interpolation midpoint) and
double-position stops (<code>red 0% 50%, blue 50% 100%</code> for hard
edges). Both are honoured — Domotion expands them to the equivalent SVG
gradient stops.</p>

<h2>Colour interpolation</h2>

<p>Gradients interpolate in sRGB in the SVG output. CSS Colour Module 5 lets
you pick alternate interpolation spaces (<code>linear-gradient(in oklch, ...)</code>);
Domotion samples the resolved gradient at fixed positions and emits sRGB stops,
so the output is visually close but not identical for OKLCH-interpolated
gradients with widely-separated colours.</p>

<h2>Gradient on text (<code>background-clip: text</code>)</h2>

<p>Fully supported. The text becomes a mask and the gradient renders inside
that mask; output is a pixel-correct copy of what Chromium painted.</p>

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
