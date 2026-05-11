/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "api/overview",
  title: "API overview",
  subtitle: "Every export from `domotion`, with one-line summaries.",
};

export const content: SafeHtml = raw(`
<p>Domotion's public surface is intentionally small — five functions, one
class, and a handful of types. Everything is imported from the package root:</p>

<pre><code><span class="tk-k">import</span> {
  captureElementTree,
  elementTreeToSvg,
  wrapSvg,
  generateAnimatedSvg,
  DemoRecorder,
  optimizeSvg,
  getLastCaptureWarnings,
  logCaptureWarnings,
  <span class="tk-k">type</span> CapturedElement,
  <span class="tk-k">type</span> CaptureWarning,
  <span class="tk-k">type</span> AnimationConfig,
  <span class="tk-k">type</span> AnimationFrame,
  <span class="tk-k">type</span> Overlay,
  <span class="tk-k">type</span> TypingOverlay,
  <span class="tk-k">type</span> TapOverlay,
  <span class="tk-k">type</span> CaptureOptions,
} <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;</code></pre>

<h2>The two-step API</h2>

<p>The core capture pipeline is two functions:</p>

<table>
  <thead>
    <tr><th>Function</th><th>What it does</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="../capture-element-tree/"><code>captureElementTree(page, selector?, viewport)</code></a></td>
      <td>Walks the DOM under <code>selector</code> in a Playwright page and returns a serialisable <code>CapturedElement[]</code> tree.</td>
    </tr>
    <tr>
      <td><a href="../element-tree-to-svg/"><code>elementTreeToSvg(tree, w, h, idPrefix?, includeGlyphDefs?)</code></a></td>
      <td>Pure function: converts the captured tree into an SVG fragment (defs + groups).</td>
    </tr>
    <tr>
      <td><a href="../element-tree-to-svg/#wrapsvg"><code>wrapSvg(inner, w, h)</code></a></td>
      <td>Wraps a fragment in the standard <code>&lt;svg xmlns="..."&gt;</code> shell so the result is a standalone, browser-loadable document.</td>
    </tr>
  </tbody>
</table>

<h2>Animation</h2>

<table>
  <thead>
    <tr><th>Function</th><th>What it does</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="../generate-animated-svg/"><code>generateAnimatedSvg(config)</code></a></td>
      <td>Composes multiple captured frames into one animated SVG with CSS keyframes.</td>
    </tr>
  </tbody>
</table>

<p>The shape passed to <code>generateAnimatedSvg</code> is documented under
<a href="../animation-config/"><code>AnimationConfig</code></a>; overlay types
under <a href="../overlays/">Overlay types</a>.</p>

<h2>The convenience class</h2>

<table>
  <thead>
    <tr><th>Class</th><th>What it does</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="../demo-recorder/"><code>DemoRecorder</code></a></td>
      <td>Wraps Playwright bring-up + the two-step capture API. Best when capturing several pages from a running server.</td>
    </tr>
  </tbody>
</table>

<h2>Optimisation</h2>

<table>
  <thead>
    <tr><th>Function</th><th>What it does</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><a href="../optimize-svg/"><code>optimizeSvg(svg)</code></a></td>
      <td>Runs SVGO with a structure-preserving plugin set — typically 30–50% size reduction without changing semantics.</td>
    </tr>
  </tbody>
</table>

<h2>Types</h2>

<table>
  <thead>
    <tr><th>Type</th><th>Used with</th></tr>
  </thead>
  <tbody>
    <tr><td><a href="../captured-element/"><code>CapturedElement</code></a></td><td>Returned by <code>captureElementTree</code>; consumed by <code>elementTreeToSvg</code>.</td></tr>
    <tr><td><a href="../animation-config/"><code>AnimationConfig</code></a></td><td>Argument to <code>generateAnimatedSvg</code>.</td></tr>
    <tr><td><a href="../animation-config/#animation-frame"><code>AnimationFrame</code></a></td><td>Element of <code>AnimationConfig.frames</code>.</td></tr>
    <tr><td><a href="../overlays/"><code>Overlay</code> / <code>TypingOverlay</code> / <code>TapOverlay</code></a></td><td>Per-frame overlays.</td></tr>
    <tr><td><code>CaptureOptions</code></td><td>Options to <a href="../demo-recorder/"><code>DemoRecorder</code></a>.</td></tr>
  </tbody>
</table>

<h2>Stability</h2>

<p>Domotion is at <code>0.x</code>. Patch and minor releases may change return
shapes (especially <code>CapturedElement</code>'s style fields, which track
new CSS support) and tighten warning behavior. The <em>functions and class
listed above</em> are stable; the function signatures aren't expected to
change before <code>1.0</code> without a deprecation notice.</p>
`);
