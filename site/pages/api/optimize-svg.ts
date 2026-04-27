export const meta = {
  slug: "api/optimize-svg",
  title: "optimizeSvg()",
  subtitle: "Run a structure-preserving SVGO pass over the captured SVG.",
};

export const content = `
<h2>Signature</h2>

<pre class="sig"><span class="tk-k">function</span> <span class="tk-f">optimizeSvg</span>(svg: <span class="tk-t">string</span>): <span class="tk-t">string</span></pre>

<h2>What it does</h2>

<p>Runs <a href="https://github.com/svg/svgo" rel="noopener" target="_blank">SVGO</a>
4.x with a focused, structure-preserving plugin set:</p>

<ul>
  <li><code>convertPathData</code> — shorten path commands, switch to relative,
    drop unneeded precision (1 decimal for floats, 3 for transforms,
    <code>makeArcs: false</code> to keep glyph fidelity).</li>
  <li><code>convertTransform</code> — collapse adjacent
    <code>translate</code> / <code>scale</code> / <code>rotate</code> into a
    single matrix when smaller.</li>
  <li><code>minifyStyles</code> — collapse whitespace and shortcuts in inline
    <code>&lt;style&gt;</code> blocks.</li>
  <li><code>removeComments</code>.</li>
  <li><code>removeEmptyAttrs</code>.</li>
</ul>

<p>Crucially, the default SVGO plugins that <em>change structure</em> —
removing IDs, collapsing groups, inlining defs — are <strong>not</strong>
enabled. The captured SVG uses IDs to wire up clip paths, gradients, and
glyph deduplication, and structural changes can break the rendering.</p>

<h2>Effect</h2>

<p>Typical reduction: 30–50% smaller. For path-heavy text the wins are biggest;
for capture output that's mostly rectangles the wins are smaller.</p>

<table>
  <thead>
    <tr><th>Capture</th><th>Before</th><th>After <code>optimizeSvg</code></th></tr>
  </thead>
  <tbody>
    <tr><td>Single line of text + a button</td><td>~14 KB</td><td>~9 KB</td></tr>
    <tr><td>Hero card with badge + gradient</td><td>~30 KB</td><td>~17 KB</td></tr>
    <tr><td>Three-frame animated SVG (terminal demo)</td><td>~140 KB</td><td>~75 KB</td></tr>
  </tbody>
</table>

<p>Numbers are illustrative; your mileage will vary based on text length and
whether path-mode glyphs dominate.</p>

<h2>Example</h2>

<pre><code><span class="tk-k">import</span> { writeFileSync } <span class="tk-k">from</span> <span class="tk-s">"node:fs"</span>;
<span class="tk-k">import</span> { wrapSvg, optimizeSvg } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-k">const</span> svg   = <span class="tk-f">wrapSvg</span>(<span class="tk-f">elementTreeToSvg</span>(tree, w, h), w, h);
<span class="tk-k">const</span> small = <span class="tk-f">optimizeSvg</span>(svg);
<span class="tk-f">writeFileSync</span>(<span class="tk-s">"hero.svg"</span>, small);
console.<span class="tk-f">log</span>(<span class="tk-s">\`\${svg.length} → \${small.length} bytes\`</span>);</code></pre>

<h2>When not to use it</h2>

<ul>
  <li><strong>While iterating</strong>, especially when diffing captures —
    optimisation reduces decimal precision, which makes SVG diffs noisier.
    Save it for the final ship step.</li>
  <li><strong>If you need to post-process the SVG yourself</strong> (e.g. find
    an element by ID, walk the markup), do that before optimisation. The IDs
    are preserved either way, but path data is much harder to reason about
    after compression.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../../guides/optimization/">Optimize output size</a> — broader
    techniques beyond running SVGO.</li>
</ul>
`;
