export const meta = {
  slug: "api/element-tree-to-svg",
  title: "elementTreeToSvg()",
  subtitle: "Convert a captured tree into a self-contained SVG string.",
};

export const content = `
<p>Pure function: takes a captured element tree (no Playwright, no I/O) and
returns the SVG markup. Always paired with
<a href="../capture-element-tree/"><code>captureElementTree()</code></a>.</p>

<h2>Signature</h2>

<pre class="sig"><span class="tk-k">function</span> <span class="tk-f">elementTreeToSvg</span>(
  elements: <span class="tk-t">CapturedElement</span>[],
  width: <span class="tk-t">number</span>,
  height: <span class="tk-t">number</span>,
  idPrefix?: <span class="tk-t">string</span>,
  includeGlyphDefs?: <span class="tk-t">boolean</span>,
): <span class="tk-t">string</span></pre>

<h2>Parameters</h2>

<div class="params">
  <div class="row">
    <div class="name">elements</div>
    <div class="type">CapturedElement[]</div>
    <div class="desc">A tree from <code>captureElementTree</code> (or one you've programmatically built / mutated).</div>
  </div>
  <div class="row">
    <div class="name">width</div>
    <div class="type">number</div>
    <div class="desc">SVG <code>viewBox</code> and <code>width</code> attribute. Content beyond this is clipped.</div>
  </div>
  <div class="row">
    <div class="name">height</div>
    <div class="type">number</div>
    <div class="desc">SVG <code>viewBox</code> and <code>height</code> attribute.</div>
  </div>
  <div class="row">
    <div class="name">idPrefix</div>
    <div class="type">string (default <code>""</code>)</div>
    <div class="desc">Prefix added to every clip-path, gradient, and glyph ID generated for this SVG. Required when you'll be combining several rendered SVGs into one (e.g. animation frames) so IDs from different captures don't collide.</div>
  </div>
  <div class="row">
    <div class="name">includeGlyphDefs</div>
    <div class="type">boolean (default <code>true</code>)</div>
    <div class="desc">When <code>true</code>, the returned markup includes a <code>&lt;defs&gt;</code> with every glyph path used in this SVG. Set to <code>false</code> when you'll hoist shared glyph defs to an outer SVG (e.g. a multi-frame animated SVG).</div>
  </div>
</div>

<h2>Returns</h2>

<p>An SVG <em>fragment</em>: a <code>&lt;defs&gt;</code> block (when defs are
present) followed by the rendered element groups. The function does
<strong>not</strong> wrap the output in an outer <code>&lt;svg&gt;</code> root
or an XML declaration — that's left to the caller, because Domotion's
own animated-SVG composer
(<a href="../generate-animated-svg/"><code>generateAnimatedSvg()</code></a>)
needs to combine fragments from multiple captures into one root SVG.</p>

<p>To get a standalone, browser-loadable SVG, wrap the fragment with the
<a href="#wrapsvg"><code>wrapSvg()</code></a> helper:</p>

<pre><code><span class="tk-k">import</span> { elementTreeToSvg, wrapSvg } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-k">const</span> svg = <span class="tk-f">wrapSvg</span>(<span class="tk-f">elementTreeToSvg</span>(tree, w, h), w, h);</code></pre>

<p>Then run it through
<a href="../optimize-svg/"><code>optimizeSvg()</code></a> for production
size. The output is human-readable and diff-friendly.</p>

<h2 id="wrapsvg">wrapSvg(inner, width, height)</h2>

<p>One-liner that wraps an inner SVG fragment in the standard
<code>&lt;svg xmlns="..." viewBox="0 0 W H" width="W" height="H"&gt;...&lt;/svg&gt;</code>
shell. Use it for every standalone capture; <code>generateAnimatedSvg()</code>
already handles wrapping internally.</p>

<h2>Examples</h2>

<h3>Standalone capture</h3>

<pre><code><span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, vp);
<span class="tk-k">const</span> svg  = <span class="tk-f">elementTreeToSvg</span>(tree, vp.width, vp.height);
<span class="tk-f">writeFileSync</span>(<span class="tk-s">"capture.svg"</span>, svg);</code></pre>

<h3>Multiple frames sharing one SVG</h3>

<pre><code><span class="tk-k">const</span> frames = [];
<span class="tk-k">for</span> (<span class="tk-k">let</span> i = <span class="tk-n">0</span>; i &lt; <span class="tk-n">3</span>; i++) {
  <span class="tk-k">await</span> page.<span class="tk-f">setContent</span>(buildHtml(i));
  <span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, vp);
  <span class="tk-k">const</span> svgContent = <span class="tk-f">elementTreeToSvg</span>(
    tree, vp.width, vp.height,
    <span class="tk-s">\`f\${i}-\`</span>,   <span class="tk-c">// idPrefix prevents ID collisions across frames</span>
  );
  frames.<span class="tk-f">push</span>({ svgContent, duration: <span class="tk-n">1500</span> });
}
<span class="tk-k">const</span> animated = <span class="tk-f">generateAnimatedSvg</span>({ width: vp.width, height: vp.height, frames });</code></pre>

<h2>Pitfalls</h2>

<ul>
  <li><strong>Forgetting <code>idPrefix</code> for multi-frame captures.</strong>
    Without unique prefixes, two frames will both define
    <code>&lt;clipPath id="clip0"&gt;</code> and the SVG will render the wrong
    geometry on later frames.</li>
  <li><strong>Mismatch between viewport and SVG size.</strong> The renderer
    paints at the captured coordinates and clips at <code>width</code> /
    <code>height</code>. To fit a smaller region, capture with a tight viewport
    box first; don't try to scale at the SVG level.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../capture-element-tree/"><code>captureElementTree()</code></a></li>
  <li><a href="../optimize-svg/"><code>optimizeSvg()</code></a></li>
  <li><a href="../generate-animated-svg/"><code>generateAnimatedSvg()</code></a></li>
</ul>
`;
