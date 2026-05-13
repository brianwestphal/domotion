/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "start/cli",
  title: "CLI reference",
  subtitle: "Every flag for `domotion capture` and `domotion animate`.",
};

export const content: SafeHtml = raw(`
<p>The <code>domotion</code> binary is installed when you
<code>npm install domotion-svg</code>. It exposes two commands:</p>

<ul>
  <li><code>domotion capture &lt;input&gt; [options]</code> — single-frame SVG.</li>
  <li><code>domotion animate &lt;config.json&gt;</code> — multi-frame animated SVG.</li>
</ul>

<h2>capture</h2>

<pre><code>domotion capture &lt;input&gt; [options]</code></pre>

<p><code>&lt;input&gt;</code> is one of:</p>

<ul>
  <li>A URL — <code>https://example.com</code> or <code>http://localhost:3000/path</code>.</li>
  <li>A local HTML file path.</li>
  <li><code>-</code> to read HTML from stdin.</li>
</ul>

<table>
  <thead><tr><th>Flag</th><th>Default</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><code>-o</code>, <code>--output &lt;path&gt;</code></td><td>stdout, or <code>&lt;input&gt;.svg</code> for files</td><td>Where to write the SVG. Use <code>-o -</code> to stream to stdout explicitly.</td></tr>
    <tr><td><code>--width &lt;n&gt;</code></td><td><code>800</code></td><td>Viewport width in CSS pixels.</td></tr>
    <tr><td><code>--height &lt;n&gt;</code></td><td><code>600</code></td><td>Viewport height in CSS pixels.</td></tr>
    <tr><td><code>--selector &lt;css&gt;</code></td><td><code>"body"</code></td><td>Element to capture; the SVG will be the size of this element's bounding box (clipped by <code>--clip</code> if present).</td></tr>
    <tr><td><code>--clip x,y,w,h</code></td><td>full viewport</td><td>Capture only this rectangle. Useful for cropping just one card or section out of a larger page.</td></tr>
    <tr><td><code>--scroll-to x,y</code></td><td><code>0,0</code></td><td>Scroll the page to this offset before capturing — for capturing below-the-fold content.</td></tr>
    <tr><td><code>--scroll &lt;pattern&gt;</code></td><td>—</td><td>Generate an animated scroll demo from the page. Captures at multiple scroll positions and composes one animated SVG (DM-604). Examples: <code>"down:bottom/8s"</code>, <code>"720px,2s until bottom"</code>.</td></tr>
    <tr><td><code>--scroll-speed &lt;n&gt;</code></td><td><code>1500</code></td><td>Default scroll speed in px/s for tokens in <code>--scroll</code> that don't specify <code>/&lt;duration&gt;</code>.</td></tr>
    <tr><td><code>--scroll-selector &lt;css&gt;</code></td><td>window</td><td>Scroll a specific element instead of the window, for the <code>--scroll</code> animated-demo flow.</td></tr>
    <tr><td><code>--no-prescroll</code></td><td>off</td><td>Skip the pre-scroll-to-bottom-then-top step used to wake lazy-loaded content before the <code>--scroll</code> demo records.</td></tr>
    <tr><td><code>--wait &lt;ms&gt;</code></td><td><code>200</code></td><td>Sleep this long after the page settles. Bump up if you have lazy-loaded images or CSS transitions in flight.</td></tr>
    <tr><td><code>--wait-for &lt;css&gt;</code></td><td>—</td><td>Wait for the matching element to become visible before capturing. Most reliable for SPA-driven content.</td></tr>
    <tr><td><code>--no-fonts-ready</code></td><td>off</td><td>Skip the <code>document.fonts.ready</code> wait. By default Domotion waits for web fonts.</td></tr>
    <tr><td><code>--optimize</code></td><td>off</td><td>Run output through SVGO. 30–50% smaller; reduces decimal precision so diffs get noisier.</td></tr>
    <tr><td><code>--warnings</code></td><td>off</td><td>Log capture warnings to stderr after the run (CSS features that didn't round-trip).</td></tr>
    <tr><td><code>--mobile</code></td><td>off</td><td>Emulate a mobile device (iOS user-agent, <code>isMobile=true</code>). Sites that branch on UA or use <code>@media (hover: none)</code> render their mobile path.</td></tr>
    <tr><td><code>--color-scheme &lt;s&gt;</code></td><td>—</td><td>Sets <code>prefers-color-scheme</code>: <code>light</code>, <code>dark</code>, or <code>no-preference</code>. Pages that use <code>@media (prefers-color-scheme: dark)</code> render their dark variant.</td></tr>
  </tbody>
</table>

<h3>capture examples</h3>

<pre><code><span class="tk-c"># Default: capture the whole body of example.com at 800×600.</span>
domotion capture https://example.com -o example.svg

<span class="tk-c"># Capture only the .pricing-table at retina-friendly 1280×720,</span>
<span class="tk-c"># wait for it to load, optimize.</span>
domotion capture https://yoursite.com/pricing \\
  --width 1280 --height 720 \\
  --selector ".pricing-table" \\
  --wait-for ".pricing-table .price" \\
  --optimize \\
  -o pricing.svg

<span class="tk-c"># Capture a local HTML file, only the bottom-right 400×200 region.</span>
domotion capture ./demo.html --clip 200,200,400,200 -o slice.svg

<span class="tk-c"># Capture HTML produced by a build step, no temp file.</span>
node build-demo-html.js | domotion capture - --width 600 --height 200 -o out.svg

<span class="tk-c"># Mobile capture: iOS user-agent + isMobile.</span>
domotion capture https://example.com \\
  --width 390 --height 844 --mobile -o phone.svg

<span class="tk-c"># Capture a dark-mode-aware page in dark mode.</span>
domotion capture https://example.com --color-scheme dark -o dark.svg</code></pre>

<h2>animate</h2>

<pre><code>domotion animate &lt;config.json&gt; [-o path] [--optimize]</code></pre>

<p><code>&lt;config.json&gt;</code> describes one or more frames; each frame is
captured (optionally after running an interaction) and the result is stitched
into a single animated SVG with CSS keyframe transitions.</p>

<h3>Config schema</h3>

<pre><code>{
  <span class="tk-s">"width"</span>:  <span class="tk-n">800</span>,
  <span class="tk-s">"height"</span>: <span class="tk-n">400</span>,
  <span class="tk-s">"output"</span>: <span class="tk-s">"demo.svg"</span>,        <span class="tk-c">// optional, overridden by -o</span>
  <span class="tk-s">"optimize"</span>: <span class="tk-k">true</span>,             <span class="tk-c">// optional, --optimize on the CLI also works</span>
  <span class="tk-s">"chrome"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"browser"</span>, <span class="tk-s">"url"</span>: <span class="tk-s">"https://yoursite.com"</span> },  <span class="tk-c">// optional</span>
  <span class="tk-s">"frames"</span>: [
    {
      <span class="tk-s">"input"</span>:      <span class="tk-s">"./frames/start.html"</span>,    <span class="tk-c">// or a URL</span>
      <span class="tk-s">"duration"</span>:   <span class="tk-n">1500</span>,                     <span class="tk-c">// ms held on screen</span>
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> },
      <span class="tk-s">"selector"</span>:   <span class="tk-s">"body"</span>,                  <span class="tk-c">// optional capture root</span>
      <span class="tk-s">"wait"</span>:       <span class="tk-n">200</span>,                     <span class="tk-c">// optional ms after settle</span>
      <span class="tk-s">"waitFor"</span>:    <span class="tk-s">".ready"</span>,                <span class="tk-c">// optional CSS selector</span>
      <span class="tk-s">"scroll"</span>:     [<span class="tk-n">0</span>, <span class="tk-n">0</span>],                  <span class="tk-c">// optional [x, y]</span>
      <span class="tk-s">"actions"</span>:    [...],                    <span class="tk-c">// see "Actions" below</span>
      <span class="tk-s">"overlays"</span>:   [...]                     <span class="tk-c">// see "Overlays" below</span>
    }
  ]
}</code></pre>

<p>Paths in <code>"input"</code> resolve relative to the config file's
directory. Each frame opens its input in the same Playwright context, runs
its <code>actions</code> (if any), waits the requested time, and is captured.</p>

<h3>Transitions</h3>

<table>
  <thead><tr><th>Type</th><th>What it does</th></tr></thead>
  <tbody>
    <tr><td><code>"crossfade"</code></td><td>Old frame fades out as new frame fades in. Best for shared layouts where individual elements are crossing over.</td></tr>
    <tr><td><code>"cut"</code></td><td>Instant — the next frame replaces the current one with no fade or slide. <code>duration</code> is ignored. Best for "this just changed" beats: a progress bar resizing, a new line appearing in a terminal, a panel toggling.</td></tr>
    <tr><td><code>"push-left"</code></td><td>New frame slides in from the right, old frame slides out to the left. Best when the two frames are unrelated screens.</td></tr>
    <tr><td><code>"scroll"</code></td><td>Vertical scroll between frames; treats them as a single tall canvas. Best for "scroll through the page" demos.</td></tr>
  </tbody>
</table>

<h3>Actions</h3>

<p>Actions run in order before the frame is captured. Each is a simple object:</p>

<pre><code>{ <span class="tk-s">"type"</span>: <span class="tk-s">"click"</span>,  <span class="tk-s">"selector"</span>: <span class="tk-s">".cta"</span> }
{ <span class="tk-s">"type"</span>: <span class="tk-s">"fill"</span>,   <span class="tk-s">"selector"</span>: <span class="tk-s">"input[name=q]"</span>, <span class="tk-s">"value"</span>: <span class="tk-s">"hello"</span> }
{ <span class="tk-s">"type"</span>: <span class="tk-s">"press"</span>,  <span class="tk-s">"key"</span>: <span class="tk-s">"Enter"</span> }
{ <span class="tk-s">"type"</span>: <span class="tk-s">"hover"</span>,  <span class="tk-s">"selector"</span>: <span class="tk-s">".tooltip-trigger"</span> }
{ <span class="tk-s">"type"</span>: <span class="tk-s">"scroll"</span>, <span class="tk-s">"y"</span>: <span class="tk-n">200</span> }
{ <span class="tk-s">"type"</span>: <span class="tk-s">"wait"</span>,   <span class="tk-s">"ms"</span>: <span class="tk-n">300</span> }</code></pre>

<p>Use <code>wait</code> to give animations / async UI a chance to settle
between actions.</p>

<h3>Animations (intra-frame)</h3>

<p>Animations declared on a frame run during its hold time. Use them for
property changes that happen <em>within</em> a single frame: progress bar
filling, content scrolling, an element fading in. Each animation resolves
its <code>selector</code> against the captured DOM and tags matching elements
with a CSS class the renderer targets via keyframes.</p>

<pre><code>{ <span class="tk-s">"selector"</span>: <span class="tk-s">".bar"</span>, <span class="tk-s">"property"</span>: <span class="tk-s">"transform"</span>,
  <span class="tk-s">"from"</span>: <span class="tk-s">"scaleX(0)"</span>, <span class="tk-s">"to"</span>: <span class="tk-s">"scaleX(1)"</span>,
  <span class="tk-s">"duration"</span>: <span class="tk-n">2000</span>, <span class="tk-s">"easing"</span>: <span class="tk-s">"ease-out"</span>, <span class="tk-s">"delay"</span>: <span class="tk-n">150</span> }</code></pre>

<p>Supported <code>property</code> values: <code>transform</code>,
<code>opacity</code>, <code>width</code>, <code>height</code>,
<code>translateX</code>, <code>translateY</code>. Use full transform strings
(<code>scaleX(0.5)</code>, <code>rotate(15deg)</code>) for the
<code>transform</code> property. The <code>translateX</code> /
<code>translateY</code> shorthand expects raw values
(<code>"240px"</code>, <code>"-50%"</code>).</p>

<div class="callout note">
  <span class="icon">ⓘ</span>
  <div class="body">
    <p>For "fill from left" effects (progress bars), use
    <code>transform: scaleX(0)→scaleX(1)</code> with
    <code>transform-origin: left</code> set on the source element. CSS
    <code>width</code> animations on SVG-rendered rects don't compose
    cleanly because of how SVG percentage units work — <code>scaleX</code>
    on a wrapper group is the reliable path.</p>
  </div>
</div>

<h3>Overlays</h3>

<p>Overlays draw <em>on top</em> of the captured frame so you can simulate
typing or taps without modifying the page. Two kinds:</p>

<pre><code>{ <span class="tk-s">"kind"</span>: <span class="tk-s">"typing"</span>, <span class="tk-s">"text"</span>: <span class="tk-s">"hello"</span>, <span class="tk-s">"x"</span>: <span class="tk-n">20</span>, <span class="tk-s">"y"</span>: <span class="tk-n">40</span>, <span class="tk-s">"speed"</span>: <span class="tk-n">80</span> }
{ <span class="tk-s">"kind"</span>: <span class="tk-s">"tap"</span>,    <span class="tk-s">"x"</span>: <span class="tk-n">120</span>, <span class="tk-s">"y"</span>: <span class="tk-n">90</span>, <span class="tk-s">"delay"</span>: <span class="tk-n">600</span> }
{ <span class="tk-s">"kind"</span>: <span class="tk-s">"svg"</span>,    <span class="tk-s">"src"</span>: <span class="tk-s">"./preview.svg"</span>, <span class="tk-s">"x"</span>: <span class="tk-n">180</span>, <span class="tk-s">"y"</span>: <span class="tk-n">0</span>,
                  <span class="tk-s">"width"</span>: <span class="tk-n">280</span>, <span class="tk-s">"height"</span>: <span class="tk-n">580</span>,
                  <span class="tk-s">"enter"</span>: { <span class="tk-s">"from"</span>: <span class="tk-s">"bottom"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">600</span>, <span class="tk-s">"easing"</span>: <span class="tk-s">"ease-out"</span> } }</code></pre>

<p>The <code>svg</code> overlay inlines a separately-captured SVG file as a
picture-in-picture layer. <code>src</code> is resolved relative to the
config file's directory; ids in the embedded SVG are namespaced
automatically. Use <code>enter</code> / <code>exit</code> for slide-in
sugar — <code>from</code> is one of <code>"top"</code>, <code>"bottom"</code>,
<code>"left"</code>, <code>"right"</code>.</p>

<p>See <a href="../../api/overlays/">Overlay types</a> for the full property
list.</p>

<h2>Exit codes</h2>

<table>
  <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
  <tbody>
    <tr><td><code>0</code></td><td>Capture wrote successfully.</td></tr>
    <tr><td><code>1</code></td><td>Runtime error (browser launch failed, page navigation failed, etc).</td></tr>
    <tr><td><code>2</code></td><td>Argument / config error.</td></tr>
  </tbody>
</table>

<h2>When to drop down to the API</h2>

<ul>
  <li>You want a custom interaction loop the JSON action vocabulary can't
    express (e.g. drag-and-drop, multiple-step flows where the next action
    depends on a captured value).</li>
  <li>You want to compose frames programmatically — e.g. one frame per row
    of a database query.</li>
  <li>You're integrating capture into an existing test harness (Playwright,
    Vitest) and want to share the browser context.</li>
</ul>

<p>Otherwise, the CLI covers the common cases. See
<a href="../../api/overview/">API overview</a> when you outgrow it.</p>
`);
