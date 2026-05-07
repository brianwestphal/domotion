/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "api/generate-animated-svg",
  title: "generateAnimatedSvg()",
  subtitle: "Compose multiple captured frames into one animated SVG.",
};

export const content: SafeHtml = raw(`
<p>Stitches a list of captured frames into a single SVG with CSS
keyframes between them. The output loops infinitely and runs without
JavaScript — drop it into <code>&lt;img src="demo.svg"&gt;</code>.</p>

<h2>Signature</h2>

<pre class="sig"><span class="tk-k">function</span> <span class="tk-f">generateAnimatedSvg</span>(config: <span class="tk-t">AnimationConfig</span>): <span class="tk-t">string</span></pre>

<p>See <a href="../animation-config/"><code>AnimationConfig</code></a> for the
full input shape. The minimum viable call is:</p>

<pre><code><span class="tk-k">const</span> svg = <span class="tk-f">generateAnimatedSvg</span>({
  width: <span class="tk-n">800</span>,
  height: <span class="tk-n">400</span>,
  frames: [
    { svgContent: frame0Svg, duration: <span class="tk-n">2000</span> },
    { svgContent: frame1Svg, duration: <span class="tk-n">2000</span> },
    { svgContent: frame2Svg, duration: <span class="tk-n">2000</span> },
  ],
});</code></pre>

<h2>What it does</h2>

<ol>
  <li>Sums up frame durations and per-frame transition durations into a total
    animation length.</li>
  <li>If every transition is <code>crossfade</code> (or unset) <em>and</em> there
    are no overlays, takes the <strong>merge fast path</strong> —
    de-duplicates elements across frames and emits per-element visibility
    timelines (smaller, no flicker).</li>
  <li>Otherwise, emits each frame as an <code>opacity</code>-animated
    <code>&lt;g&gt;</code> with the right transition keyframes
    (<code>push-left</code> uses <code>translateX</code>;
    <code>scroll</code> stays visible, fades only at the end).</li>
  <li>Renders every overlay (typing reveals, tap ripples) as additional
    <code>&lt;g&gt;</code> + <code>@keyframes</code> blocks on top of the
    relevant frame.</li>
  <li>Wraps everything in a viewport-clipped SVG with a dark background
    fill.</li>
</ol>

<h2>Returns</h2>

<p>An SVG document string starting with the XML declaration. Pipe it through
<a href="../optimize-svg/"><code>optimizeSvg()</code></a> for production.</p>

<h2>Example: three-frame crossfade</h2>

<pre><code><span class="tk-k">import</span> { chromium } <span class="tk-k">from</span> <span class="tk-s">"@playwright/test"</span>;
<span class="tk-k">import</span> {
  captureElementTree, elementTreeToSvg, generateAnimatedSvg, optimizeSvg,
} <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;
<span class="tk-k">import</span> { writeFileSync } <span class="tk-k">from</span> <span class="tk-s">"node:fs"</span>;

<span class="tk-k">const</span> WIDTH = <span class="tk-n">600</span>, HEIGHT = <span class="tk-n">300</span>;

<span class="tk-k">const</span> stages = [
  { html: <span class="tk-s">"&lt;div style='padding:24px'&gt;Step 1: install&lt;/div&gt;"</span> },
  { html: <span class="tk-s">"&lt;div style='padding:24px'&gt;Step 2: configure&lt;/div&gt;"</span> },
  { html: <span class="tk-s">"&lt;div style='padding:24px'&gt;Step 3: ship 🚀&lt;/div&gt;"</span> },
];

<span class="tk-k">const</span> browser = <span class="tk-k">await</span> chromium.<span class="tk-f">launch</span>();
<span class="tk-k">const</span> page    = <span class="tk-k">await</span> browser.<span class="tk-f">newPage</span>();
<span class="tk-k">const</span> frames  = [];

<span class="tk-k">for</span> (<span class="tk-k">let</span> i = <span class="tk-n">0</span>; i &lt; stages.length; i++) {
  <span class="tk-k">await</span> page.<span class="tk-f">setContent</span>(stages[i].html);
  <span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, {
    x: <span class="tk-n">0</span>, y: <span class="tk-n">0</span>, width: WIDTH, height: HEIGHT,
  });
  frames.<span class="tk-f">push</span>({
    svgContent: <span class="tk-f">elementTreeToSvg</span>(tree, WIDTH, HEIGHT, <span class="tk-s">\`f\${i}-\`</span>),
    duration: <span class="tk-n">1500</span>,
    transition: { type: <span class="tk-s">"crossfade"</span>, duration: <span class="tk-n">300</span> },
  });
}

<span class="tk-k">await</span> browser.<span class="tk-f">close</span>();
<span class="tk-k">const</span> svg = <span class="tk-f">optimizeSvg</span>(<span class="tk-f">generateAnimatedSvg</span>({ width: WIDTH, height: HEIGHT, frames }));
<span class="tk-f">writeFileSync</span>(<span class="tk-s">"steps.svg"</span>, svg);</code></pre>

<h2>Pitfalls</h2>

<ul>
  <li><strong>Forgetting unique <code>idPrefix</code>es per frame.</strong>
    Frames re-use clip / gradient IDs by default; without distinct prefixes
    you'll get the wrong shapes after frame 0.</li>
  <li><strong>Overlays disable the merge fast path.</strong> If you want the
    smallest possible output and no flicker, capture overlay-style content
    (typed text, ripples) into the captured frames themselves rather than
    as overlays. Overlays are best for content that needs to span a transition
    or that wasn't in the captured DOM at all.</li>
  <li><strong>Transitions outside <code>crossfade</code> can't merge.</strong>
    A single <code>push-left</code> transition forces every frame onto the
    slower per-frame-atomic path. Keep all-crossfade sequences when you can.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../animation-config/"><code>AnimationConfig</code> reference</a></li>
  <li><a href="../overlays/">Overlay types</a></li>
  <li><a href="../../concepts/animation/">Animation model</a></li>
  <li><a href="../../guides/animated-demo/">Build an animated demo</a></li>
</ul>
`);
