/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/single-frame",
  title: "Capture a single frame",
  subtitle: "URLs, local HTML, your own running app, third-party sites.",
};

export const content: SafeHtml = raw(`
<p>Single-frame capture is the most common use of Domotion: take a piece of
rendered HTML and turn it into a portable, self-contained SVG. This page
walks through the four scenarios you'll actually run into.</p>

<h2>Scenario 1: A site you don't control</h2>

<p>You want to capture a third-party page — a docs site, a competitor's
landing page, your client's existing site before a rebuild. You only have
the URL.</p>

<pre><code>domotion capture https://example.com -o example.svg</code></pre>

<p>Tighten the viewport, target a specific section, optimise:</p>

<pre><code>domotion capture https://example.com \\
  --width 1280 --height 720 \\
  --selector ".hero" \\
  --optimize \\
  -o hero.svg</code></pre>

<p>For pages that fetch async content, wait for a "ready" element to
appear:</p>

<pre><code>domotion capture https://example.com/dashboard \\
  --wait-for ".chart-loaded" \\
  -o dashboard.svg</code></pre>

<h2>Scenario 2: Your real product UI (running locally)</h2>

<p>The most accurate marketing demo is your real product. Run your dev
server, then capture the page just like a user would see it:</p>

<pre><code>domotion capture http://localhost:3000/pricing \\
  --width 1280 --height 720 \\
  --wait-for ".price[data-loaded='true']" \\
  --optimize \\
  -o pricing.svg</code></pre>

<p>For authenticated pages, you have a few options:</p>

<ul>
  <li><strong>Add a dev-only login route</strong> that sets a session cookie
    on GET. Then capture with the URL parameter or by visiting that route
    first via the JS API.</li>
  <li><strong>Use a magic-link / dev-token flow</strong> in the URL itself —
    the CLI will pass it through.</li>
  <li><strong>Drop down to <code>DemoRecorder</code></strong> from the JS
    API, which has explicit dev-login support
    (see <a href="../../api/demo-recorder/"><code>DemoRecorder</code></a>).</li>
</ul>

<h2>Scenario 3: HTML in your repo</h2>

<p>Best when the demo content should ship with the rest of your repo and
shouldn't depend on a server. Author plain HTML, capture, commit the SVG.</p>

<p><code>demos/hero.html</code>:</p>

<pre><code>&lt;!doctype html&gt;
&lt;html&gt;&lt;body style="margin:0;font-family:-apple-system,sans-serif;background:#0d1117;color:#e6edf3;"&gt;
  &lt;div style="padding:32px;"&gt;
    &lt;h1 style="font-size:32px;margin:0;"&gt;Hello, Domotion&lt;/h1&gt;
    &lt;p style="color:#8b949e;"&gt;Captured live from Chromium.&lt;/p&gt;
  &lt;/div&gt;
&lt;/body&gt;&lt;/html&gt;</code></pre>

<pre><code>domotion capture demos/hero.html --width 800 --height 200 --optimize -o demos/hero.svg</code></pre>

<p>Wire it into a <code>package.json</code> script so the SVG is regenerated
whenever the source changes:</p>

<pre><code>{
  "scripts": {
    "demos": "domotion capture demos/hero.html --width 800 --height 200 --optimize -o demos/hero.svg"
  }
}</code></pre>

<h2>Scenario 4: HTML produced by a build step</h2>

<p>If your demo HTML is generated (e.g. from React via SSR, from a templating
engine, or from a script), pipe stdout straight into the CLI:</p>

<pre><code>node build-demo.js | domotion capture - --width 1200 --height 600 --optimize -o demo.svg</code></pre>

<p>This is also handy for parametric demos — generate one HTML per variant,
loop the capture command:</p>

<pre><code><span class="tk-k">for</span> color <span class="tk-k">in</span> red blue green; do
  node build-card.js --color=<span class="tk-s">"\$color"</span> | domotion capture - --width 400 --height 200 -o <span class="tk-s">"card-\$color.svg"</span>
done</code></pre>

<h2>Common readiness waits</h2>

<table>
  <thead><tr><th>What you're waiting for</th><th>How</th></tr></thead>
  <tbody>
    <tr><td>HTML loaded</td><td>(default) Domotion uses <code>networkidle</code> on URLs.</td></tr>
    <tr><td>Web fonts loaded</td><td>(default) Domotion waits for <code>document.fonts.ready</code>. Disable with <code>--no-fonts-ready</code>.</td></tr>
    <tr><td>Specific element appeared</td><td><code>--wait-for ".ready"</code></td></tr>
    <tr><td>CSS transitions settled</td><td><code>--wait 500</code></td></tr>
    <tr><td>JS app idle</td><td><code>--wait-for "[data-loaded='true']"</code> on a marker element your app sets.</td></tr>
  </tbody>
</table>

<h2>Capturing just one component</h2>

<p>Use <code>--selector</code> to capture a single element. The SVG is the
size of the element's bounding box.</p>

<pre><code>domotion capture http://localhost:3000 \\
  --width 1280 --height 720 \\
  --selector ".product-card" \\
  --optimize \\
  -o card.svg</code></pre>

<p>Or use <code>--clip x,y,w,h</code> to capture an arbitrary rectangle of
the viewport — useful when no clean selector wraps the region you want.</p>

<h2>Pause running animations</h2>

<p>If your page has running CSS animations, captures will hit them at random
points. The CLI doesn't yet have a flag for this; either add a query-param
override to your dev page that pauses animations, or capture via the JS API
and inject this stylesheet:</p>

<pre><code><span class="tk-k">await</span> page.<span class="tk-f">addStyleTag</span>({
  content: <span class="tk-s">\`*, *::before, *::after {
    animation-play-state: paused !important;
    transition: none !important;
  }\`</span>,
});</code></pre>

<h2>See also</h2>

<ul>
  <li><a href="../animated-demo/">Build an animated demo</a></li>
  <li><a href="../../start/cli/">CLI reference</a></li>
  <li><a href="../../start/first-capture/">Your first capture</a> — guided
    walk of the basics.</li>
  <li><a href="../../api/demo-recorder/"><code>DemoRecorder</code></a> —
    when you need authenticated capture, a shared browser context, or
    custom interactions the CLI's action vocabulary can't express.</li>
</ul>
`);
