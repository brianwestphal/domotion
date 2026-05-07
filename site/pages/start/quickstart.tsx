/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "start/quickstart",
  title: "Quick start",
  subtitle: "From npm install to a rendered SVG in one command.",
};

export const content: SafeHtml = raw(`
<p>The fastest way to capture an SVG is the <code>domotion</code> CLI. No
TypeScript, no Playwright bring-up — point it at a URL or HTML file and it
writes the SVG.</p>

<h2>1. Install</h2>

<pre><code>npm install -g domotion</code></pre>

<p>(Or <code>npm install domotion</code> in a project and use
<code>npx domotion</code>.) Chromium auto-installs the first time you run a
capture; nothing else to set up.</p>

<h2>2. Capture your first SVG</h2>

<p>Capture a real URL straight to disk:</p>

<pre><code>domotion capture https://example.com -o example.svg</code></pre>

<p>Open <code>example.svg</code> in any browser. Zoom in: every glyph and
border stays crisp because it's a vector, not a screenshot. The file is
self-contained — no external CSS, no font requests, no JavaScript runtime.</p>

<h2>3. Resize, clip, target a region</h2>

<p>Capture only a piece of a page at a tighter viewport:</p>

<pre><code>domotion capture https://example.com \\
  --width 1280 --height 720 \\
  --selector ".hero" \\
  --optimize \\
  -o hero.svg</code></pre>

<table>
  <thead><tr><th>Flag</th><th>Effect</th></tr></thead>
  <tbody>
    <tr><td><code>--width</code> / <code>--height</code></td><td>Viewport size in CSS pixels.</td></tr>
    <tr><td><code>--selector</code></td><td>Capture only the matching element (default <code>body</code>).</td></tr>
    <tr><td><code>--clip</code> <code>x,y,w,h</code></td><td>Capture a rectangle within the viewport.</td></tr>
    <tr><td><code>--scroll</code> <code>x,y</code></td><td>Scroll the page before capture.</td></tr>
    <tr><td><code>--wait-for</code> <code>".ready"</code></td><td>Wait for a selector to appear.</td></tr>
    <tr><td><code>--optimize</code></td><td>Run output through SVGO (typically 30–50% smaller).</td></tr>
  </tbody>
</table>

<p>Run <code>domotion --help</code> for the full list, or see
<a href="../cli/">the CLI reference</a>.</p>

<h2>4. Capture a local HTML file</h2>

<p>Already have HTML on disk? Pass the path. Domotion serves it via a
<code>file://</code> URL so relative assets keep working:</p>

<pre><code>domotion capture ./demo.html -o demo.svg</code></pre>

<p>Or stream HTML on stdin — handy in shell pipelines:</p>

<pre><code>cat demo.html | domotion capture - -o demo.svg</code></pre>

<h2>5. Animate multiple frames</h2>

<p>For a multi-frame animated SVG, write a small JSON config and run
<code>domotion animate</code>:</p>

<pre><code><span class="tk-c">// demo.json</span>
{
  <span class="tk-s">"width"</span>: <span class="tk-n">800</span>,
  <span class="tk-s">"height"</span>: <span class="tk-n">400</span>,
  <span class="tk-s">"output"</span>: <span class="tk-s">"demo.svg"</span>,
  <span class="tk-s">"optimize"</span>: <span class="tk-k">true</span>,
  <span class="tk-s">"frames"</span>: [
    {
      <span class="tk-s">"input"</span>: <span class="tk-s">"./step-1.html"</span>,
      <span class="tk-s">"duration"</span>: <span class="tk-n">1500</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"crossfade"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">300</span> }
    },
    {
      <span class="tk-s">"input"</span>: <span class="tk-s">"https://example.com/step-2"</span>,
      <span class="tk-s">"duration"</span>: <span class="tk-n">2000</span>,
      <span class="tk-s">"transition"</span>: { <span class="tk-s">"type"</span>: <span class="tk-s">"push-left"</span>, <span class="tk-s">"duration"</span>: <span class="tk-n">400</span> },
      <span class="tk-s">"actions"</span>: [
        { <span class="tk-s">"type"</span>: <span class="tk-s">"click"</span>, <span class="tk-s">"selector"</span>: <span class="tk-s">".btn-next"</span> },
        { <span class="tk-s">"type"</span>: <span class="tk-s">"wait"</span>,  <span class="tk-s">"ms"</span>: <span class="tk-n">300</span> }
      ]
    }
  ]
}</code></pre>

<pre><code>domotion animate demo.json</code></pre>

<p>Each frame can come from a local file or a URL. <code>actions</code> drive
the page (click, fill, scroll, hover, press) before the frame is captured —
so you can record before/after states of a real interaction. See
<a href="../../guides/animated-demo/">Build an animated demo</a> for the full
recipe.</p>

<h2>What's next</h2>

<ul>
  <li><a href="../first-capture/">Your first capture</a> — a longer
    walk-through with screenshots and the most common gotchas.</li>
  <li><a href="../cli/">CLI reference</a> — every flag, every action,
    every transition type.</li>
  <li><a href="../../guides/single-frame/">Capturing your real product UI</a>
    — drive a running dev server, log in, navigate, capture.</li>
  <li><a href="../../api/overview/">JS API</a> — when you outgrow the CLI
    (custom interaction loops, programmatic frame composition, custom
    overlays).</li>
</ul>
`);
