/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "api/demo-recorder",
  title: "DemoRecorder",
  subtitle: "Convenience class for capturing pages from a running server.",
};

export const content: SafeHtml = raw(`
<p><code>DemoRecorder</code> wraps Playwright bring-up and the
<code>captureElementTree</code> + <code>elementTreeToSvg</code> pair. It's
the most ergonomic way to capture pages from a running app — you give it
a base URL once and then call <code>captureUrl(path)</code> as often as you
need.</p>

<p>Using the lower-level functions directly is a fine choice when you're
capturing static HTML strings or want full control of Playwright. Reach
for <code>DemoRecorder</code> when you're sweeping a real running server
to produce a gallery of demos.</p>

<h2>Constructor</h2>

<pre class="sig"><span class="tk-k">new</span> <span class="tk-f">DemoRecorder</span>(baseUrl: <span class="tk-t">string</span>, opts: <span class="tk-t">CaptureOptions</span>)</pre>

<div class="params">
  <div class="row">
    <div class="name">baseUrl</div>
    <div class="type">string</div>
    <div class="desc">e.g. <code>"http://localhost:3000"</code>. <code>captureUrl(path)</code> resolves <code>path</code> against this.</div>
  </div>
  <div class="row">
    <div class="name">opts</div>
    <div class="type">CaptureOptions</div>
    <div class="desc">See below.</div>
  </div>
</div>

<h3>CaptureOptions</h3>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">CaptureOptions</span> {
  width: <span class="tk-t">number</span>;
  height: <span class="tk-t">number</span>;
  mobile?: <span class="tk-t">boolean</span>;
  devUser?: <span class="tk-t">string</span>;
}</pre>

<div class="params">
  <div class="row">
    <div class="name">width / height</div>
    <div class="type">number</div>
    <div class="desc">Viewport size (CSS pixels).</div>
  </div>
  <div class="row">
    <div class="name">mobile</div>
    <div class="type">boolean (default false)</div>
    <div class="desc">Sets <code>isMobile</code> on the Playwright context plus an iPhone user agent.</div>
  </div>
  <div class="row">
    <div class="name">devUser</div>
    <div class="type">string</div>
    <div class="desc">Optional username to authenticate as via a <code>POST /api/v1/auth/dev-login</code> endpoint on your server. The recorder sets the resulting cookie + a <code>localStorage.sk_token</code> entry. Tailored for the slicekit dev-login convention; ignore if your server doesn't expose it.</div>
  </div>
</div>

<h2>Methods</h2>

<h3><code>init(opts)</code></h3>

<p>Launches Chromium and creates the browser context + page. Must be called
before any capture.</p>

<pre class="sig"><span class="tk-f">init</span>(opts: <span class="tk-t">CaptureOptions</span>): <span class="tk-t">Promise</span>&lt;<span class="tk-t">void</span>&gt;</pre>

<h3><code>captureUrl(path, waitMs?, idPrefix?)</code></h3>

<p>Navigates to <code>baseUrl + path</code>, waits for <code>networkidle</code>
plus <code>waitMs</code>, captures the visible viewport, and returns the SVG
<em>fragment</em> (no outer <code>&lt;svg&gt;</code> wrapper) — same shape as
<a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a>'s
return. Wrap it for a standalone document, or feed it straight to
<a href="../generate-animated-svg/"><code>generateAnimatedSvg</code></a> as
an <code>AnimationFrame.svgContent</code>.</p>

<pre class="sig"><span class="tk-f">captureUrl</span>(
  path: <span class="tk-t">string</span>,
  waitMs?: <span class="tk-t">number</span>,
  idPrefix?: <span class="tk-t">string</span>,
): <span class="tk-t">Promise</span>&lt;<span class="tk-t">string</span>&gt;</pre>

<div class="params">
  <div class="row">
    <div class="name">path</div>
    <div class="type">string</div>
    <div class="desc">e.g. <code>"/dashboard"</code>.</div>
  </div>
  <div class="row">
    <div class="name">waitMs</div>
    <div class="type">number (default 800)</div>
    <div class="desc">Extra time after <code>networkidle</code> to let CSS transitions settle.</div>
  </div>
  <div class="row">
    <div class="name">idPrefix</div>
    <div class="type">string</div>
    <div class="desc">Prefix for clip / gradient / glyph IDs. Required if you'll combine multiple captures into one SVG.</div>
  </div>
</div>

<h3><code>captureCurrent(idPrefix?)</code></h3>

<p>Captures the current page state without navigating. Use this when you've
already brought the page to a specific state via
<code>recorder.getPage().click(...)</code>, etc.</p>

<pre class="sig"><span class="tk-f">captureCurrent</span>(idPrefix?: <span class="tk-t">string</span>): <span class="tk-t">Promise</span>&lt;<span class="tk-t">string</span>&gt;</pre>

<h3><code>captureFullPage(idPrefix?)</code></h3>

<p>Captures the entire scrollable page (viewport-wide, body's full
<code>scrollHeight</code> tall). Returns both the SVG content and the page
height so you can size the outer SVG correctly.</p>

<pre class="sig"><span class="tk-f">captureFullPage</span>(idPrefix?: <span class="tk-t">string</span>): <span class="tk-t">Promise</span>&lt;{ svgContent: <span class="tk-t">string</span>; pageHeight: <span class="tk-t">number</span> }&gt;</pre>

<h3><code>getPage()</code></h3>

<p>Returns the underlying Playwright <code>Page</code> for ad-hoc interactions
— hover, click, fill, evaluate.</p>

<pre class="sig"><span class="tk-f">getPage</span>(): <span class="tk-t">Page</span></pre>

<h3><code>getBoundingBox(selector)</code></h3>

<p>Convenience wrapper around <code>page.locator(selector).first().boundingBox()</code>.
Returns <code>null</code> when the selector matches nothing.</p>

<pre class="sig"><span class="tk-f">getBoundingBox</span>(selector: <span class="tk-t">string</span>): <span class="tk-t">Promise</span>&lt;{ x; y; width; height } | <span class="tk-t">null</span>&gt;</pre>

<h3><code>close()</code></h3>

<p>Closes the browser. Call it from your script's cleanup path — recorders
that aren't closed leak Chromium processes.</p>

<pre class="sig"><span class="tk-f">close</span>(): <span class="tk-t">Promise</span>&lt;<span class="tk-t">void</span>&gt;</pre>

<h2>Example: capture three URLs in a row</h2>

<pre><code><span class="tk-k">import</span> { DemoRecorder } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;
<span class="tk-k">import</span> { writeFileSync } <span class="tk-k">from</span> <span class="tk-s">"node:fs"</span>;

<span class="tk-k">const</span> recorder = <span class="tk-k">new</span> <span class="tk-f">DemoRecorder</span>(<span class="tk-s">"http://localhost:3000"</span>, {
  width: <span class="tk-n">1200</span>, height: <span class="tk-n">700</span>,
});
<span class="tk-k">await</span> recorder.<span class="tk-f">init</span>({ width: <span class="tk-n">1200</span>, height: <span class="tk-n">700</span> });

<span class="tk-k">for</span> (<span class="tk-k">const</span> path <span class="tk-k">of</span> [<span class="tk-s">"/"</span>, <span class="tk-s">"/dashboard"</span>, <span class="tk-s">"/settings"</span>]) {
  <span class="tk-k">const</span> inner = <span class="tk-k">await</span> recorder.<span class="tk-f">captureUrl</span>(path);
  <span class="tk-c">// captureUrl returns an SVG fragment — wrapSvg adds the outer &lt;svg&gt;.</span>
  <span class="tk-k">const</span> svg = <span class="tk-f">wrapSvg</span>(inner, <span class="tk-n">1200</span>, <span class="tk-n">700</span>);
  <span class="tk-f">writeFileSync</span>(<span class="tk-s">\`out\${path.<span class="tk-f">replace</span>(<span class="tk-s">/\\//g</span>, <span class="tk-s">"_"</span>)}.svg\`</span>, svg);
}

<span class="tk-k">await</span> recorder.<span class="tk-f">close</span>();</code></pre>

<h2>Example: drive an interaction, then capture</h2>

<pre><code><span class="tk-k">await</span> recorder.<span class="tk-f">init</span>({ width: <span class="tk-n">800</span>, height: <span class="tk-n">600</span> });
<span class="tk-k">await</span> recorder.<span class="tk-f">captureUrl</span>(<span class="tk-s">"/products/42"</span>); <span class="tk-c">// initial state</span>

<span class="tk-k">const</span> page = recorder.<span class="tk-f">getPage</span>();
<span class="tk-k">await</span> page.<span class="tk-f">click</span>(<span class="tk-s">"button.add-to-cart"</span>);
<span class="tk-k">await</span> page.<span class="tk-f">waitForSelector</span>(<span class="tk-s">".cart-badge"</span>);

<span class="tk-k">const</span> svg = <span class="tk-k">await</span> recorder.<span class="tk-f">captureCurrent</span>(); <span class="tk-c">// after-click state</span></code></pre>

<h2>See also</h2>

<ul>
  <li><a href="../capture-element-tree/"><code>captureElementTree()</code></a></li>
  <li><a href="../element-tree-to-svg/"><code>elementTreeToSvg()</code></a></li>
</ul>
`);
