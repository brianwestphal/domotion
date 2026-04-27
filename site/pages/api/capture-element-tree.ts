export const meta = {
  slug: "api/capture-element-tree",
  title: "captureElementTree()",
  subtitle: "Walk a Playwright page's DOM into a serialisable tree.",
};

export const content = `
<p>Captures the DOM under a CSS selector inside a Playwright <code>Page</code>
and returns a <a href="../captured-element/"><code>CapturedElement[]</code></a>
tree. This is half of the core API — the other half is
<a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a>.</p>

<h2>Signature</h2>

<pre class="sig"><span class="tk-k">function</span> <span class="tk-f">captureElementTree</span>(
  page: <span class="tk-t">Page</span>,
  selector?: <span class="tk-t">string</span>,
  viewport: { x: <span class="tk-t">number</span>; y: <span class="tk-t">number</span>; width: <span class="tk-t">number</span>; height: <span class="tk-t">number</span> },
): <span class="tk-t">Promise</span>&lt;<span class="tk-t">CapturedElement</span>[]&gt;</pre>

<h2>Parameters</h2>

<div class="params">
  <div class="row">
    <div class="name">page</div>
    <div class="type">Page</div>
    <div class="desc">A Playwright page returned by <code>browser.newPage()</code>. The page must already have its content loaded — Domotion does not navigate for you.</div>
  </div>
  <div class="row">
    <div class="name">selector</div>
    <div class="type">string (default <code>"body"</code>)</div>
    <div class="desc">CSS selector identifying the root of the subtree to capture. Anything outside the matched element is ignored.</div>
  </div>
  <div class="row">
    <div class="name">viewport</div>
    <div class="type">{ x, y, width, height }</div>
    <div class="desc">Pixel rectangle (in page coordinates) that defines what counts as "in view". Elements with no overlap with this rect are skipped. The captured tree's coordinates are <em>relative to this rectangle</em>.</div>
  </div>
</div>

<h2>Returns</h2>

<p>A promise resolving to an array of <a href="../captured-element/"><code>CapturedElement</code></a>
nodes. The array is the children of the matched selector — pass it directly
to <code>elementTreeToSvg(tree, vp.width, vp.height)</code>.</p>

<h2>Examples</h2>

<h3>Capture a full page region</h3>

<pre><code><span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, {
  x: <span class="tk-n">0</span>, y: <span class="tk-n">0</span>, width: <span class="tk-n">1200</span>, height: <span class="tk-n">800</span>,
});</code></pre>

<h3>Capture a specific component</h3>

<pre><code><span class="tk-k">const</span> rect = <span class="tk-k">await</span> page.<span class="tk-f">locator</span>(<span class="tk-s">".product-card"</span>).<span class="tk-f">boundingBox</span>();
<span class="tk-k">if</span> (rect == <span class="tk-k">null</span>) <span class="tk-k">throw</span> <span class="tk-k">new</span> <span class="tk-t">Error</span>(<span class="tk-s">"product-card not found"</span>);
<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">".product-card"</span>, rect);</code></pre>

<h3>Capture a long, scrollable page</h3>

<pre><code><span class="tk-k">const</span> pageHeight = <span class="tk-k">await</span> page.<span class="tk-f">evaluate</span>(() =&gt; document.body.scrollHeight);
<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, {
  x: <span class="tk-n">0</span>, y: <span class="tk-n">0</span>, width: <span class="tk-n">1200</span>, height: pageHeight,
});</code></pre>

<h2>Capture warnings</h2>

<p>If the page uses CSS features that fall back to a raster region, Domotion
records warnings on the call. <code>getLastCaptureWarnings()</code> and
<code>logCaptureWarnings()</code> are exported from the package root:</p>

<pre><code><span class="tk-k">import</span> { getLastCaptureWarnings } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, vp);
<span class="tk-k">for</span> (<span class="tk-k">const</span> w <span class="tk-k">of</span> <span class="tk-f">getLastCaptureWarnings</span>()) {
  console.<span class="tk-f">warn</span>(<span class="tk-s">\`\${w.feature} on \${w.selector}: \${w.detail}\`</span>);
}</code></pre>

<p>Warnings are stored on a module-level singleton that resets at the start of
each <code>captureElementTree</code> call. For multi-frame captures, read them
between calls if you care which frame produced which warning.</p>

<h2>Common pitfalls</h2>

<ul>
  <li><strong>Selector matches multiple elements:</strong> only the first match
    is captured. Use a more specific selector or call
    <code>page.locator(...).first()</code> beforehand.</li>
  <li><strong>Calling before content is ready:</strong> if you call right after
    <code>page.goto</code>, you may capture an unstyled or unrendered version of
    the page. Wait on <code>document.fonts.ready</code>, an explicit selector,
    or a short timeout.</li>
  <li><strong>Viewport doesn't match SVG dimensions:</strong> Domotion captures
    in viewport-relative coordinates. If you pass
    <code>{ width: 1200, height: 600 }</code> to capture but
    <code>elementTreeToSvg(tree, 800, 400)</code> to render, content beyond
    the SVG's dimensions is clipped (not scaled).</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a></li>
  <li><a href="../captured-element/"><code>CapturedElement</code></a></li>
  <li><a href="../../start/first-capture/">Your first capture</a></li>
</ul>
`;
