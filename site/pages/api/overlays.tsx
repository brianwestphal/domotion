/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "api/overlays",
  title: "Overlay types",
  subtitle: "Per-frame typing and tap effects.",
};

export const content: SafeHtml = raw(`
<p>Overlays are visuals layered on top of a captured frame for the duration of
that frame. They're useful for content that wasn't in the captured DOM at all
— a fake-typed search query, a click ripple — without needing to capture
intermediate states.</p>

<pre class="sig"><span class="tk-k">type</span> <span class="tk-t">Overlay</span> = <span class="tk-t">TypingOverlay</span> | <span class="tk-t">TapOverlay</span>;</pre>

<h2 id="typing">TypingOverlay</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">TypingOverlay</span> {
  kind: <span class="tk-s">"typing"</span>;
  text: <span class="tk-t">string</span>;
  x: <span class="tk-t">number</span>;
  y: <span class="tk-t">number</span>;
  fontSize?: <span class="tk-t">number</span>;
  color?: <span class="tk-t">string</span>;
  delay?: <span class="tk-t">number</span>;
  speed?: <span class="tk-t">number</span>;
  bgColor?: <span class="tk-t">string</span>;
  bgWidth?: <span class="tk-t">number</span>;
  bgHeight?: <span class="tk-t">number</span>;
}</pre>

<div class="params">
  <div class="row">
    <div class="name">kind</div>
    <div class="type"><code>"typing"</code></div>
    <div class="desc">Discriminator.</div>
  </div>
  <div class="row">
    <div class="name">text</div>
    <div class="type">string</div>
    <div class="desc">The string to type out, character by character.</div>
  </div>
  <div class="row">
    <div class="name">x, y</div>
    <div class="type">number</div>
    <div class="desc">Top-left coordinate (in SVG pixels) where the typed text starts. Use the captured layout's coordinates — overlays sit in the same space.</div>
  </div>
  <div class="row">
    <div class="name">fontSize</div>
    <div class="type">number (default 14)</div>
    <div class="desc">Font size in pixels.</div>
  </div>
  <div class="row">
    <div class="name">color</div>
    <div class="type">string (default <code>#e6edf3</code>)</div>
    <div class="desc">Text colour.</div>
  </div>
  <div class="row">
    <div class="name">delay</div>
    <div class="type">number (ms, default 300)</div>
    <div class="desc">Time after the frame appears before typing begins.</div>
  </div>
  <div class="row">
    <div class="name">speed</div>
    <div class="type">number (ms per char, default 60)</div>
    <div class="desc">Time per character. Lower = faster typing.</div>
  </div>
  <div class="row">
    <div class="name">bgColor</div>
    <div class="type">string</div>
    <div class="desc">Optional background rectangle behind the typed text — useful when overlaying on top of a captured input that already shows placeholder text. When set, <code>bgWidth</code> / <code>bgHeight</code> default to enclose the typed text.</div>
  </div>
  <div class="row">
    <div class="name">bgWidth, bgHeight</div>
    <div class="type">number</div>
    <div class="desc">Override the auto-sized background rectangle.</div>
  </div>
</div>

<h3>How it animates</h3>

<p>The overlay renders the full text once with an animated SVG
<code>&lt;clipPath&gt;</code> whose width grows from 0 to the full string
width over <code>text.length × speed</code> ms. After the type-out completes,
the text holds visible until the frame ends.</p>

<h3>Example</h3>

<pre><code>{
  kind: <span class="tk-s">"typing"</span>,
  text: <span class="tk-s">"sk install error-handling"</span>,
  x: <span class="tk-n">24</span>, y: <span class="tk-n">32</span>,
  fontSize: <span class="tk-n">13</span>,
  color: <span class="tk-s">"#e6edf3"</span>,
  speed: <span class="tk-n">40</span>,
  bgColor: <span class="tk-s">"#1e1e2e"</span>,
}</code></pre>

<h2 id="tap">TapOverlay</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">TapOverlay</span> {
  kind: <span class="tk-s">"tap"</span>;
  x: <span class="tk-t">number</span>;
  y: <span class="tk-t">number</span>;
  delay?: <span class="tk-t">number</span>;
}</pre>

<div class="params">
  <div class="row">
    <div class="name">kind</div>
    <div class="type"><code>"tap"</code></div>
    <div class="desc">Discriminator.</div>
  </div>
  <div class="row">
    <div class="name">x, y</div>
    <div class="type">number</div>
    <div class="desc">Centre of the ripple in SVG coordinates.</div>
  </div>
  <div class="row">
    <div class="name">delay</div>
    <div class="type">number (ms, default 50)</div>
    <div class="desc">Time after the frame appears before the tap fires.</div>
  </div>
</div>

<p>Renders a Material-style ripple: a small white-translucent dot that fades
in over 20&nbsp;ms, plus an expanding ring that grows to ~35&nbsp;px radius and
fades over 500&nbsp;ms. Useful for "user clicks here" cues, especially on
captured mobile UIs.</p>

<h3>Example</h3>

<pre><code>{ kind: <span class="tk-s">"tap"</span>, x: <span class="tk-n">320</span>, y: <span class="tk-n">220</span>, delay: <span class="tk-n">800</span> }</code></pre>

<h2>Important: overlays disable the merge fast path</h2>

<p>If <em>any</em> frame has overlays,
<a href="../generate-animated-svg/"><code>generateAnimatedSvg</code></a> falls
back to per-frame-atomic rendering. For all-crossfade sequences this typically
means a slightly larger SVG with a small risk of one-frame flicker on the
transition. Two ways to avoid it:</p>

<ul>
  <li><strong>Capture the typed state instead.</strong> If the typed text could
    just be part of the captured HTML, put it there.</li>
  <li><strong>Use overlays only on the frame that needs them.</strong>
    The fast path requires <em>all</em> transitions to be crossfade <em>and</em>
    no overlays anywhere — so even one overlay forces the fallback for the
    whole sequence.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../animation-config/"><code>AnimationConfig</code> &amp; <code>AnimationFrame</code></a></li>
  <li><a href="../../guides/overlays/">Typing &amp; tap overlays guide</a></li>
</ul>
`);
