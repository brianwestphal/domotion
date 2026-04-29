/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "guides/animated-demo",
  title: "Build an animated demo",
  subtitle: "Capture several frames, stitch them together, ship one SVG.",
};

export const content: SafeHtml = raw(`
<p>This is the recipe to reach for when you want a marketing-style "watch
this happen" loop. We'll build a three-frame animation showing a sequence of
states, with a short crossfade between frames.</p>

<p>The CLI handles the most common shape: a list of HTML files (or URLs),
each held for some time, with a transition between them. For anything more
exotic, drop down to the <a href="#api">JS API</a>.</p>

<h2>1. Author one HTML file per frame</h2>

<p>Put each frame's HTML in a sibling directory. Style with whatever you'd
use in the real product — Domotion captures the rendered Chromium frame, not
the source.</p>

<pre><code>demo/
├─ frames/
│  ├─ step-1.html
│  ├─ step-2.html
│  └─ step-3.html
└─ demo.json</code></pre>

<p>Example <code>step-1.html</code>:</p>

<pre><code>&lt;!doctype html&gt;
&lt;html&gt;&lt;body style="margin:0;font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;"&gt;
  &lt;div style="padding:32px;display:flex;gap:20px;align-items:center;"&gt;
    &lt;div style="
      width:64px;height:64px;border-radius:14px;background:#79b8ff;color:#0d1117;
      display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;
    "&gt;Step 1&lt;/div&gt;
    &lt;div style="font-size:24px;font-weight:600;"&gt;Install the package&lt;/div&gt;
  &lt;/div&gt;
&lt;/body&gt;&lt;/html&gt;</code></pre>

<h2>2. Write the config</h2>

<p><code>demo.json</code>:</p>

<pre><code>{
  <span class="tk-s">"width"</span>:  <span class="tk-n">600</span>,
  <span class="tk-s">"height"</span>: <span class="tk-n">240</span>,
  <span class="tk-s">"output"</span>: <span class="tk-s">"steps.svg"</span>,
  <span class="tk-s">"optimize"</span>: <span class="tk-k">true</span>,
  <span class="tk-s">"frames"</span>: [
    {
      <span class="tk-s">"input"</span>:      <span class="tk-s">"./frames/step-1.html"</span>,
      <span class="tk-s">"duration"</span>:   <span class="tk-n">2000</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> }
    },
    {
      <span class="tk-s">"input"</span>:      <span class="tk-s">"./frames/step-2.html"</span>,
      <span class="tk-s">"duration"</span>:   <span class="tk-n">2000</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> }
    },
    {
      <span class="tk-s">"input"</span>:      <span class="tk-s">"./frames/step-3.html"</span>,
      <span class="tk-s">"duration"</span>:   <span class="tk-n">2200</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> }
    }
  ]
}</code></pre>

<h2>3. Render</h2>

<pre><code>domotion animate demo.json</code></pre>

<p>Result: <code>steps.svg</code> — one self-contained file, no JavaScript at
runtime, looping forever.</p>

<h2>Picking a transition</h2>

<table>
  <thead><tr><th>Type</th><th>When to use</th></tr></thead>
  <tbody>
    <tr>
      <td><code>crossfade</code></td>
      <td>Default. State change within the same screen — text updating, badge appearing, list item highlighting. Takes the merge fast path for smaller output and no flicker.</td>
    </tr>
    <tr>
      <td><code>push-left</code></td>
      <td>Stepping through a clearly delimited sequence — onboarding, wizard steps, "before / during / after" stories.</td>
    </tr>
    <tr>
      <td><code>scroll</code></td>
      <td>Long content that logically continues, where the previous frame should remain visible while the next slides up.</td>
    </tr>
  </tbody>
</table>

<h2>Tuning duration</h2>

<ul>
  <li><strong>Hold time</strong> (frame <code>duration</code>) should be long
    enough to read what's on the frame. For text-heavy frames, 1500–3000&nbsp;ms.
    For frames that are the punchline of the previous transition,
    2500&nbsp;ms+.</li>
  <li><strong>Transition time</strong> should be short — 250–400&nbsp;ms.
    Longer transitions feel sluggish; shorter ones feel jumpy.</li>
  <li><strong>Total loop</strong> typically lands at 6–15&nbsp;s. Anything
    longer and viewers leave before seeing the full sequence.</li>
</ul>

<h2>Capturing a real interaction</h2>

<p>Frames don't have to be static HTML — they can be a live URL with actions
run before capture. This is how you record "user clicks the button, then
this happens":</p>

<pre><code>{
  <span class="tk-s">"width"</span>: <span class="tk-n">800</span>, <span class="tk-s">"height"</span>: <span class="tk-n">400</span>,
  <span class="tk-s">"frames"</span>: [
    {
      <span class="tk-s">"input"</span>:    <span class="tk-s">"http://localhost:3000/cart"</span>,
      <span class="tk-s">"duration"</span>: <span class="tk-n">1500</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> }
    },
    {
      <span class="tk-s">"input"</span>:    <span class="tk-s">"http://localhost:3000/cart"</span>,
      <span class="tk-s">"duration"</span>: <span class="tk-n">2000</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> },
      <span class="tk-s">"actions"</span>: [
        { <span class="tk-s">"type"</span>: <span class="tk-s">"click"</span>, <span class="tk-s">"selector"</span>: <span class="tk-s">".checkout-btn"</span> },
        { <span class="tk-s">"type"</span>: <span class="tk-s">"wait"</span>,  <span class="tk-s">"ms"</span>: <span class="tk-n">600</span> }
      ]
    }
  ]
}</code></pre>

<p>Available actions: <code>click</code>, <code>fill</code>,
<code>press</code>, <code>hover</code>, <code>scroll</code>,
<code>wait</code>. See <a href="../../start/cli/#actions">CLI actions</a>.</p>

<h2>Adding overlays</h2>

<p>For typing animations and tap ripples that aren't part of the captured
HTML, add an <code>overlays</code> array to a frame — see
<a href="../overlays/">Typing &amp; tap overlays</a>.</p>

<div class="callout warn">
  <span class="icon">⚠</span>
  <div class="body">
    <p>Overlays drop the animation off the merge fast path — the SVG will be
    larger and may show a one-frame flicker on transitions. Where the overlay
    content can be part of the captured HTML instead, prefer that.</p>
  </div>
</div>

<h2 id="api">When to drop down to the API</h2>

<p>Use the JS API instead of the CLI when:</p>

<ul>
  <li>You need a custom interaction the JSON action vocabulary can't express
    (drag-and-drop, multi-step flows where each action depends on a captured
    value).</li>
  <li>You're composing frames programmatically — e.g. one frame per row of a
    database query.</li>
  <li>You're integrating capture into an existing test harness and want to
    share the browser context.</li>
</ul>

<p>The API equivalent of the JSON config is a loop over
<code>captureElementTree</code> + <code>elementTreeToSvg</code> calls passed
to <code>generateAnimatedSvg</code>:</p>

<pre><code><span class="tk-k">import</span> { writeFileSync } <span class="tk-k">from</span> <span class="tk-s">"node:fs"</span>;
<span class="tk-k">import</span> {
  captureElementTree, elementTreeToSvg,
  generateAnimatedSvg, optimizeSvg, launchChromium,
  <span class="tk-k">type</span> AnimationFrame,
} <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-k">const</span> WIDTH = <span class="tk-n">600</span>, HEIGHT = <span class="tk-n">240</span>;
<span class="tk-k">const</span> stages = [<span class="tk-s">"./frames/step-1.html"</span>, <span class="tk-s">"./frames/step-2.html"</span>, <span class="tk-s">"./frames/step-3.html"</span>];

<span class="tk-k">const</span> browser = <span class="tk-k">await</span> <span class="tk-f">launchChromium</span>();
<span class="tk-k">const</span> context = <span class="tk-k">await</span> browser.<span class="tk-f">newContext</span>({ viewport: { width: WIDTH, height: HEIGHT } });
<span class="tk-k">const</span> page    = <span class="tk-k">await</span> context.<span class="tk-f">newPage</span>();

<span class="tk-k">const</span> frames: <span class="tk-t">AnimationFrame</span>[] = [];
<span class="tk-k">for</span> (<span class="tk-k">let</span> i = <span class="tk-n">0</span>; i &lt; stages.length; i++) {
  <span class="tk-k">await</span> page.<span class="tk-f">goto</span>(<span class="tk-s">\`file://\${process.cwd()}/\${stages[i]}\`</span>);
  <span class="tk-k">await</span> page.<span class="tk-f">evaluate</span>(() =&gt; document.fonts.ready);
  <span class="tk-k">const</span> tree = <span class="tk-k">await</span> <span class="tk-f">captureElementTree</span>(page, <span class="tk-s">"body"</span>, { x: <span class="tk-n">0</span>, y: <span class="tk-n">0</span>, width: WIDTH, height: HEIGHT });
  frames.<span class="tk-f">push</span>({
    svgContent: <span class="tk-f">elementTreeToSvg</span>(tree, WIDTH, HEIGHT, <span class="tk-s">\`f\${i}-\`</span>),
    duration: <span class="tk-n">2000</span>,
    transition: { type: <span class="tk-s">"crossfade"</span>, duration: <span class="tk-n">300</span> },
  });
}

<span class="tk-k">const</span> svg = <span class="tk-f">optimizeSvg</span>(<span class="tk-f">generateAnimatedSvg</span>({ width: WIDTH, height: HEIGHT, frames }));
<span class="tk-f">writeFileSync</span>(<span class="tk-s">"steps.svg"</span>, svg);
<span class="tk-k">await</span> browser.<span class="tk-f">close</span>();</code></pre>

<p>Note the per-frame <code>idPrefix</code> (<code>\`f\${i}-\`</code>) — without
it, clip / gradient IDs from different frames would collide.</p>

<h2>See also</h2>

<ul>
  <li><a href="../../start/cli/">CLI reference</a> — every flag, every
    transition type, every action type.</li>
  <li><a href="../../api/generate-animated-svg/"><code>generateAnimatedSvg()</code></a></li>
  <li><a href="../../api/animation-config/"><code>AnimationConfig</code></a></li>
  <li><a href="../../concepts/animation/">Animation model</a></li>
</ul>
`);
