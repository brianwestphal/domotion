export const meta = {
  slug: "start/first-capture",
  title: "Your first capture",
  subtitle: "A guided walk through the knobs that matter on a real capture.",
};

export const content = `
<p>The <a href="../quickstart/">Quick start</a> got you a working SVG with one
command. This page slows down and explains each knob you'll reach for on a
real capture: viewport sizing, ready-state waits, subtree targeting, and how
to inspect what came out.</p>

<h2>The CLI in one line</h2>

<pre><code>domotion capture &lt;input&gt; [options] -o out.svg</code></pre>

<p><code>&lt;input&gt;</code> is a URL, a local HTML file, or <code>-</code>
to read HTML from stdin. The flags below shape what gets captured.</p>

<h2>Picking a viewport size</h2>

<p>The viewport is what Chromium thinks the browser window is. It controls
media queries, layout flow, and where breakpoints kick in. For a marketing
hero you probably want a fixed width that matches your final embed:</p>

<pre><code>domotion capture https://example.com \\
  --width 1200 --height 600 \\
  -o hero.svg</code></pre>

<p>For a mobile-style screen, just pass a phone-shaped viewport:</p>

<pre><code>domotion capture https://example.com \\
  --width 390 --height 844 \\
  -o phone.svg</code></pre>

<div class="callout tip">
  <span class="icon">✓</span>
  <div class="body">
    <p>Viewport is a layout concern, not a rendering one. The output SVG
    is exactly the size of the captured rectangle (full viewport by default,
    or whatever you pass to <code>--clip</code>). Mobile-vs-desktop is just
    "what the page thought the window was when it laid itself out".</p>
  </div>
</div>

<h2>Waiting for the page to be ready</h2>

<p>Captures are computed-style snapshots — whatever Chromium has painted
<em>at the moment of capture</em> is what ends up in the SVG. If your page
loads fonts, fetches data, or runs entry animations, you need to wait for
them to finish first.</p>

<table>
  <thead><tr><th>Flag</th><th>What it waits for</th></tr></thead>
  <tbody>
    <tr><td>(default)</td><td><code>networkidle</code> + <code>document.fonts.ready</code> + 200&nbsp;ms settle.</td></tr>
    <tr><td><code>--wait &lt;ms&gt;</code></td><td>An explicit settle delay. Bump up if you have CSS transitions in flight.</td></tr>
    <tr><td><code>--wait-for "&lt;css&gt;"</code></td><td>An element to become visible. Most reliable for SPA-driven content.</td></tr>
    <tr><td><code>--no-fonts-ready</code></td><td>Disable the font wait when you want to capture a fallback face on purpose.</td></tr>
  </tbody>
</table>

<p>The <code>--wait-for</code> flag is the one to reach for first whenever a
capture is "almost right but missing the last bit":</p>

<pre><code>domotion capture http://localhost:3000/dashboard \\
  --wait-for ".chart .data-loaded" \\
  -o dashboard.svg</code></pre>

<h3>Pausing running animations</h3>

<p>Page-level CSS animations make captures non-deterministic. Pause them
deterministically by injecting a tiny stylesheet — most easily via the
<a href="../../api/overview/">JS API</a> if you control the page, or by
adding a one-off <code>animation-play-state: paused</code> rule to the page
itself. The CLI doesn't (yet) have a flag for this.</p>

<h2>Capturing a specific subtree</h2>

<p>You don't have to capture the whole body. Two ways to scope:</p>

<h3><code>--selector</code> — only this element</h3>

<pre><code>domotion capture https://example.com \\
  --selector ".hero-card" \\
  --width 1200 --height 800 \\
  -o hero.svg</code></pre>

<p>The SVG is the size of the matched element's bounding box. Surrounding
chrome is excluded.</p>

<h3><code>--clip</code> — a rectangle of the viewport</h3>

<pre><code>domotion capture https://example.com \\
  --width 1200 --height 800 \\
  --clip 40,200,400,200 \\
  -o slice.svg</code></pre>

<p>Capture only the rectangle <code>(x=40, y=200, w=400, h=200)</code> within
the rendered viewport. Useful for cropping out a single card from a busy
layout.</p>

<h2>Capturing scrolled content</h2>

<p>If the content you want is below the fold, scroll first:</p>

<pre><code>domotion capture https://example.com \\
  --scroll 0,800 \\
  -o below-the-fold.svg</code></pre>

<p>The viewport rectangle is captured at its post-scroll position.</p>

<h2>Capturing a local HTML file</h2>

<p>Already have HTML in your repo? Pass the path. Domotion serves it via a
<code>file://</code> URL so relative <code>&lt;img src="..."&gt;</code> and
stylesheet links keep working:</p>

<pre><code>domotion capture ./demo.html -o demo.svg</code></pre>

<p>Or pipe HTML on stdin — useful when an upstream build step generates the
markup:</p>

<pre><code>node build-card.js | domotion capture - --width 600 --height 200 -o card.svg</code></pre>

<h2>Inspecting capture warnings</h2>

<p>Some CSS features fall back to a rasterised tile when there's no faithful
SVG representation (<code>backdrop-filter</code>, complex
<code>clip-path: path(...)</code>, certain blend modes,
<code>writing-mode: vertical-rl</code> for now). Domotion records a warning
when this happens; pass <code>--warnings</code> to see them:</p>

<pre><code>domotion capture https://example.com --warnings -o site.svg</code></pre>

<p>Each warning identifies the offending selector and feature. The SVG still
renders — the affected region just falls back to an embedded raster image.
See <a href="../../css/overview/">CSS Support</a> for the full list of
raster-fallback features.</p>

<h2>Saving and inspecting the output</h2>

<p>Open the SVG in any browser to verify, or in your editor to see the
structure. Domotion's output is human-readable — element groups, named clip
paths, glyph defs at the top — so it's straightforward to diff between
captures.</p>

<p>For a smaller production build, run with <code>--optimize</code>:</p>

<pre><code>domotion capture ./demo.html --optimize -o demo.svg</code></pre>

<p>SVGO trims whitespace and reduces decimal precision. Skip it while
iterating (you'll want diff-friendly output) and turn it on for the final
artefact.</p>

<h2>Next steps</h2>

<ul>
  <li><a href="../cli/">CLI reference</a> — every flag, every action,
    every transition type.</li>
  <li><a href="../../guides/single-frame/">Capture your real product UI</a>
    — drive a running dev server, log in, capture an authenticated screen.</li>
  <li><a href="../../guides/animated-demo/">Build an animated demo</a> — the
    multi-frame story with the <code>animate</code> command.</li>
  <li><a href="../../api/overview/">JS API</a> — for when you outgrow the
    CLI's action vocabulary or want to compose frames programmatically.</li>
</ul>
`;
