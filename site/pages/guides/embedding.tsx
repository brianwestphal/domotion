/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "guides/embedding",
  title: "Embed SVGs in your site",
  subtitle: "Picking the right embed mode for the playback you want.",
};

export const content: SafeHtml = raw(`
<p>Domotion outputs are standard SVG, so they embed in every browser via the
usual mechanisms. But "the usual mechanisms" each have different behaviour
around CSS animations, accessibility, and same-origin policies. This page
covers the trade-offs.</p>

<h2>The four embed modes</h2>

<table>
  <thead>
    <tr><th>Mode</th><th>Animations</th><th>Click events</th><th>Notes</th></tr>
  </thead>
  <tbody>
    <tr><td><code>&lt;img src="..."&gt;</code></td><td>Yes</td><td>No</td><td>Best default. Lazy-loadable, accessible (with <code>alt</code>), small.</td></tr>
    <tr><td><code>&lt;object data="..."&gt;</code></td><td>Yes</td><td>Yes (links inside the SVG work)</td><td>Same-origin policy applies — the SVG runs in its own context.</td></tr>
    <tr><td><code>background-image: url(...)</code></td><td>Sometimes</td><td>No</td><td>Most engines play the animation; <code>background</code> contexts can sometimes mute SVG <code>&lt;style&gt;</code>.</td></tr>
    <tr><td>Inline <code>&lt;svg&gt;</code></td><td>Yes</td><td>Yes (CSS reaches in)</td><td>No extra request. The SVG's IDs share scope with the host page — you'll need to namespace them.</td></tr>
  </tbody>
</table>

<h2>Recommended: &lt;img&gt; with lazy loading</h2>

<pre><code>&lt;img
  src="/assets/hero.svg"
  alt="Animated demo of installing the package and capturing a frame."
  width="800"
  height="320"
  loading="lazy"
  decoding="async"
/&gt;</code></pre>

<p>Specifying <code>width</code> and <code>height</code> attributes prevents
content-shift while the image loads. <code>loading="lazy"</code> defers the
fetch until the image is near the viewport — important for marketing pages
that ship several SVG demos.</p>

<h2>Inline SVG — when you need CSS to reach in</h2>

<p>If you want to style the SVG from the host page (e.g. swap colours via CSS
custom properties), inline it:</p>

<pre><code>&lt;figure&gt;
  &lt;!-- raw SVG markup pasted in here --&gt;
  &lt;svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg"&gt;...&lt;/svg&gt;
  &lt;figcaption&gt;Capture pipeline overview&lt;/figcaption&gt;
&lt;/figure&gt;</code></pre>

<p>You'll want to:</p>

<ul>
  <li>Pass an <code>idPrefix</code> at capture time (or post-process the SVG)
    so its IDs don't collide with other SVGs on the page.</li>
  <li>Strip the XML prologue (<code>&lt;?xml ...?&gt;</code>) — inline SVG
    doesn't need it.</li>
</ul>

<h2>Picking dimensions</h2>

<p>Domotion writes <code>width</code>, <code>height</code>, and
<code>viewBox</code> attributes on the root <code>&lt;svg&gt;</code>. The
embed will:</p>

<ul>
  <li>Default to the <code>width</code> / <code>height</code> attributes when
    no CSS sizing is applied.</li>
  <li>Scale to whatever <code>width</code> / <code>height</code> the host
    page sets via CSS or the <code>&lt;img&gt;</code> attributes — the
    <code>viewBox</code> ensures the content scales without distortion.</li>
</ul>

<p>For responsive embedding, set <code>width</code> in CSS and let the SVG
scale:</p>

<pre><code>img.hero {
  width: 100%;
  max-width: 800px;
  height: auto;
}</code></pre>

<h2>Accessibility</h2>

<ul>
  <li><strong>Provide an <code>alt</code></strong> on <code>&lt;img&gt;</code>
    embeds. Describe what the animation shows; screen readers won't otherwise
    surface the SVG content.</li>
  <li><strong>For inline SVG</strong>, add <code>role="img"</code> and an
    <code>&lt;title&gt;</code> child element near the top of the SVG.</li>
  <li><strong>Respect <code>prefers-reduced-motion</code>.</strong> Domotion's
    animations don't currently emit a guard for this — wrap your embed in a
    media query and serve a still SVG (a single captured frame) when motion
    should be reduced.</li>
</ul>

<h3>Reduced-motion fallback</h3>

<pre><code>&lt;picture&gt;
  &lt;source media="(prefers-reduced-motion: reduce)" srcset="hero-still.svg" /&gt;
  &lt;img src="hero-animated.svg" alt="..." /&gt;
&lt;/picture&gt;</code></pre>

<h2>Caching</h2>

<p>Treat the SVG like any other static asset: long cache headers (a year),
content-hash the filename when it changes. Because the SVG is self-contained,
swapping it is one HTTP fetch — no orphan font / image dependencies.</p>

<h2>See also</h2>

<ul>
  <li><a href="../optimization/">Optimize output size</a></li>
  <li><a href="../animated-demo/">Build an animated demo</a></li>
</ul>
`);
