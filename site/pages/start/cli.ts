export const meta = {
  slug: "start/cli",
  title: "CLI reference",
  subtitle: "Every flag for `domotion capture` and `domotion animate`.",
};

export const content = `
<p>The <code>domotion</code> binary is installed when you
<code>npm install domotion</code>. It exposes two commands:</p>

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
    <tr><td><code>--scroll x,y</code></td><td><code>0,0</code></td><td>Scroll the page to this offset before capturing — for capturing below-the-fold content.</td></tr>
    <tr><td><code>--wait &lt;ms&gt;</code></td><td><code>200</code></td><td>Sleep this long after the page settles. Bump up if you have lazy-loaded images or CSS transitions in flight.</td></tr>
    <tr><td><code>--wait-for &lt;css&gt;</code></td><td>—</td><td>Wait for the matching element to become visible before capturing. Most reliable for SPA-driven content.</td></tr>
    <tr><td><code>--no-fonts-ready</code></td><td>off</td><td>Skip the <code>document.fonts.ready</code> wait. By default Domotion waits for web fonts.</td></tr>
    <tr><td><code>--optimize</code></td><td>off</td><td>Run output through SVGO. 30–50% smaller; reduces decimal precision so diffs get noisier.</td></tr>
    <tr><td><code>--warnings</code></td><td>off</td><td>Log capture warnings to stderr after the run (CSS features that didn't round-trip).</td></tr>
    <tr><td><code>--chrome &lt;kind&gt;</code></td><td>—</td><td>Wrap the SVG in device chrome: <code>terminal</code>, <code>browser</code>, or <code>phone</code>. Output grows by the chrome's outer dimensions.</td></tr>
    <tr><td><code>--chrome-url &lt;url&gt;</code></td><td>(input URL)</td><td>URL displayed in the browser-chrome address bar.</td></tr>
    <tr><td><code>--chrome-title &lt;t&gt;</code></td><td>—</td><td>Title shown in the terminal title bar / browser tab.</td></tr>
  </tbody>
</table>

<h3>capture examples</h3>

<pre><code><span class="tk-c"># Default: capture the whole body of example.com at 800×600.</span>
domotion capture https://example.com -o example.svg

<span class="tk-c"># Capture only the .pricing-table at retina-friendly 1280×720,</span>
<span class="tk-c"># wait for it to load, optimise.</span>
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

<span class="tk-c"># Wrap the capture in browser chrome.</span>
domotion capture https://example.com --chrome browser -o framed.svg

<span class="tk-c"># Phone frame around a mobile-shaped capture.</span>
domotion capture https://example.com \\
  --width 390 --height 844 --chrome phone -o phone.svg</code></pre>

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

<h3>Overlays</h3>

<p>Overlays draw <em>on top</em> of the captured frame so you can simulate
typing or taps without modifying the page. Two kinds:</p>

<pre><code>{ <span class="tk-s">"kind"</span>: <span class="tk-s">"typing"</span>, <span class="tk-s">"text"</span>: <span class="tk-s">"hello"</span>, <span class="tk-s">"x"</span>: <span class="tk-n">20</span>, <span class="tk-s">"y"</span>: <span class="tk-n">40</span>, <span class="tk-s">"speed"</span>: <span class="tk-n">80</span> }
{ <span class="tk-s">"kind"</span>: <span class="tk-s">"tap"</span>,    <span class="tk-s">"x"</span>: <span class="tk-n">120</span>, <span class="tk-s">"y"</span>: <span class="tk-n">90</span>, <span class="tk-s">"delay"</span>: <span class="tk-n">600</span> }</code></pre>

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
`;
