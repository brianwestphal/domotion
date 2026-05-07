/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "help/troubleshooting",
  title: "Troubleshooting",
  subtitle: "The handful of issues people hit first.",
};

export const content: SafeHtml = raw(`
<h2>"Cannot find module 'domotion'" or "ERR_MODULE_NOT_FOUND"</h2>

<p>Domotion is ESM-only. Make sure your project is set up to load ESM modules:</p>

<ul>
  <li>In <code>package.json</code>, set <code>"type": "module"</code>.</li>
  <li>If you can't (e.g. you're inside a CommonJS project), run scripts with
    <code>tsx</code>: <code>npx tsx your-script.ts</code>.</li>
</ul>

<h2>"browserType.launch: Executable doesn't exist..."</h2>

<p>Playwright's Chromium binary isn't installed yet. Run:</p>

<pre><code>npx playwright install chromium</code></pre>

<p>On Linux servers, install the system libraries Chromium needs in addition:</p>

<pre><code>npx playwright install --with-deps chromium</code></pre>

<h2>Captured text uses the wrong font / falls back</h2>

<p>Two likely causes:</p>

<ol>
  <li><strong>The web font hasn't loaded yet.</strong> Add
    <code>await page.evaluate(() =&gt; document.fonts.ready)</code> after
    your <code>page.setContent</code> or <code>page.goto</code>.</li>
  <li><strong>Domotion can't find the font on disk.</strong> The bundled
    mapping table is tuned for macOS system fonts. For other fonts the path
    renderer falls back to native <code>&lt;text&gt;</code>. Either author
    your demos in system fonts, or accept the cross-engine font differences.
    See <a href="../../guides/fonts/">Fonts &amp; non-Latin scripts</a>.</li>
</ol>

<h2>Captured text drifts left/right across long lines</h2>

<p>This usually means the per-character <code>xOffsets</code> array on the
text segment is missing — most often because the segment's text was mutated
between capture and render. The renderer fell back to summing fontkit
advance widths, which accumulates ~0.5px of drift per character against
Chromium's sub-pixel positioning.</p>

<p>Fix: avoid mutating <code>el.text</code> after capture. If you need to
substitute text, also clear <code>el.textSegments</code> so the renderer
re-shapes from scratch with consistent metrics.</p>

<h2>Animated SVG flickers between frames</h2>

<p>Three possible causes, in order of likelihood:</p>

<ol>
  <li><strong>An overlay is preventing the merge fast path.</strong> Even one
    overlay anywhere in the sequence forces every frame onto the per-frame-
    atomic path, which can show a one-frame dark flash on transitions.
    Where you can express the overlaid content as a captured frame instead,
    it'll both look better and be smaller.</li>
  <li><strong>You're using a non-crossfade transition.</strong>
    <code>push-left</code> and <code>scroll</code> use different rendering;
    they don't flicker but they also can't merge. If you don't need the
    spatial transition, switching to <code>crossfade</code> usually fixes
    visual glitches and shrinks the file.</li>
  <li><strong>Two frames defined the same SVG ID.</strong> Always pass a unique
    <code>idPrefix</code> per frame to <code>elementTreeToSvg</code> — without
    it, clip-path / gradient / glyph IDs collide and the wrong shapes get
    referenced.</li>
</ol>

<h2>Output SVG is huge (&gt; 200 KB)</h2>

<p>Three quick wins:</p>

<ol>
  <li>Run <code>optimizeSvg(svg)</code> if you haven't.</li>
  <li>Crop to the visible region — capture the smallest viewport that
    contains the demo content.</li>
  <li>Cut frames. Each animation frame is one capture's worth of glyph
    outlines; aim for 3–5 frames maximum.</li>
</ol>

<p>See <a href="../../guides/optimization/">Optimize output size</a> for the
full toolkit.</p>

<h2>Captured page is missing dynamic content</h2>

<p>You captured before the content was rendered. Common pre-capture waits:</p>

<pre><code><span class="tk-c">// Wait for a known element to appear</span>
<span class="tk-k">await</span> page.<span class="tk-f">waitForSelector</span>(<span class="tk-s">".product-list .item"</span>);

<span class="tk-c">// Wait for fonts</span>
<span class="tk-k">await</span> page.<span class="tk-f">evaluate</span>(() =&gt; document.fonts.ready);

<span class="tk-c">// Wait for network to settle</span>
<span class="tk-k">await</span> page.<span class="tk-f">goto</span>(url, { waitUntil: <span class="tk-s">"networkidle"</span> });

<span class="tk-c">// Wait for an app-specific signal</span>
<span class="tk-k">await</span> page.<span class="tk-f">waitForFunction</span>(() =&gt; <span class="tk-k">window</span>.__appReady === <span class="tk-k">true</span>);</code></pre>

<h2>Captured page has running animations frozen at random frames</h2>

<p>Pause CSS animations and transitions before capturing so the result is
reproducible:</p>

<pre><code><span class="tk-k">await</span> page.<span class="tk-f">addStyleTag</span>({
  content: <span class="tk-s">\`*, *::before, *::after {
    animation-play-state: paused !important;
    transition: none !important;
  }\`</span>,
});</code></pre>

<h2>Some elements render as solid rectangles</h2>

<p>Likely because the element uses a feature Domotion can't reproduce in
SVG: <code>backdrop-filter</code>, conic gradient, complex
<code>clip-path: path(...)</code>. Check the capture warnings:</p>

<pre><code><span class="tk-k">import</span> { logCaptureWarnings } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;
<span class="tk-f">logCaptureWarnings</span>();</code></pre>

<p>Each warning identifies the offending selector and feature. See the
<a href="../../css/overview/">CSS support overview</a> for the current matrix.</p>

<h2>Filing a bug</h2>

<p>If you've hit something that isn't on this page or in the FAQ:</p>

<ol>
  <li>Run with capture warnings enabled and include the output.</li>
  <li>Include the input HTML and the produced SVG in the report.</li>
  <li>Note the Node version, Playwright version, and OS.</li>
  <li>If you can, include a Chromium screenshot of the same content (so the
    expected vs. actual is unambiguous).</li>
</ol>
`);
