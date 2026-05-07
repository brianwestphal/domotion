/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "guides/overlays",
  title: "Typing & tap overlays",
  subtitle: "Add typed strings and click ripples on top of captured frames.",
};

export const content: SafeHtml = raw(`
<p>Overlays let you show actions that aren't easy to capture as plain HTML
states — a user typing into a search box, a finger tap on a button. They sit
on top of the captured frame for the duration of that frame.</p>

<p>The two overlay kinds are <code>typing</code> (a string revealed character
by character) and <code>tap</code> (a Material-style ripple). Both are added
via the <code>overlays</code> array on an <code>AnimationFrame</code>.</p>

<h2>Recipe: terminal typing demo</h2>

<p>This builds a two-frame animation showing the user type a command, then
its output appearing.</p>

<pre><code><span class="tk-k">const</span> WIDTH = <span class="tk-n">720</span>, HEIGHT = <span class="tk-n">240</span>;

<span class="tk-c">// Frame 1 is an empty terminal prompt; the typing overlay drives the action.</span>
<span class="tk-k">const</span> emptyPrompt = <span class="tk-s">\`&lt;!doctype html&gt;
&lt;html&gt;&lt;body style="margin:0;background:#1e1e2e;font-family:'SF Mono',monospace;color:#e6edf3"&gt;
  &lt;div style="padding:18px;font-size:13px;"&gt;
    &lt;span style="color:#28c840;font-weight:700;"&gt;$&lt;/span&gt;&amp;nbsp;
  &lt;/div&gt;
&lt;/body&gt;&lt;/html&gt;\`</span>;

<span class="tk-c">// Frame 2 is the prompt with the command + output already painted.</span>
<span class="tk-k">const</span> withOutput = <span class="tk-s">\`&lt;!doctype html&gt;
&lt;html&gt;&lt;body style="margin:0;background:#1e1e2e;font-family:'SF Mono',monospace;color:#e6edf3"&gt;
  &lt;div style="padding:18px;font-size:13px;line-height:1.7;"&gt;
    &lt;div&gt;&lt;span style="color:#28c840;font-weight:700;"&gt;$&lt;/span&gt; npm install domotion&lt;/div&gt;
    &lt;div style="color:#56d364;"&gt;+ domotion@0.1.0&lt;/div&gt;
    &lt;div style="color:#8b8fa3;"&gt;added 12 packages in 1.4s&lt;/div&gt;
  &lt;/div&gt;
&lt;/body&gt;&lt;/html&gt;\`</span>;

<span class="tk-c">// Capture both as usual, then attach a typing overlay to frame 1.</span>
frames.<span class="tk-f">push</span>({
  svgContent: <span class="tk-f">elementTreeToSvg</span>(tree0, WIDTH, HEIGHT, <span class="tk-s">"f0-"</span>),
  duration: <span class="tk-n">2200</span>,
  overlays: [{
    kind: <span class="tk-s">"typing"</span>,
    text: <span class="tk-s">"npm install domotion"</span>,
    x: <span class="tk-n">36</span>, y: <span class="tk-n">35</span>,            <span class="tk-c">// just to the right of the $ prompt</span>
    fontSize: <span class="tk-n">13</span>,
    color: <span class="tk-s">"#e6edf3"</span>,
    speed: <span class="tk-n">45</span>,                  <span class="tk-c">// ms per character</span>
    delay: <span class="tk-n">300</span>,                  <span class="tk-c">// ms before typing starts</span>
  }],
  transition: { type: <span class="tk-s">"crossfade"</span>, duration: <span class="tk-n">350</span> },
});

frames.<span class="tk-f">push</span>({
  svgContent: <span class="tk-f">elementTreeToSvg</span>(tree1, WIDTH, HEIGHT, <span class="tk-s">"f1-"</span>),
  duration: <span class="tk-n">3500</span>,
});</code></pre>

<h3>Tuning the typing</h3>

<ul>
  <li><strong>x, y</strong> are the SVG coordinates where the text starts.
    Look at the captured frame's SVG to find them — typing happens in the
    same coordinate space as the captured content.</li>
  <li><strong>speed</strong> defaults to 60&nbsp;ms/char. 30–45 feels brisk
    (good for short commands); 70–90 feels deliberate (good for showing
    a longer search query).</li>
  <li><strong>delay</strong> defaults to 300&nbsp;ms. Bump it if the captured
    frame should "rest" before the typing starts.</li>
  <li><strong>bgColor</strong> lets you mask placeholder text in the
    captured input — set it to the input's background colour and pad
    <code>bgWidth</code> / <code>bgHeight</code> to cover the placeholder.</li>
</ul>

<h2>Recipe: tap ripple on mobile UI</h2>

<p>Tap overlays are a Material-style ripple — useful when the captured frame
shows a "before" state and you want to communicate "user tapped here" before
crossfading to the "after" state.</p>

<pre><code>frames.<span class="tk-f">push</span>({
  svgContent: <span class="tk-f">elementTreeToSvg</span>(beforeTree, <span class="tk-n">390</span>, <span class="tk-n">844</span>, <span class="tk-s">"a-"</span>),
  duration: <span class="tk-n">1800</span>,
  overlays: [{
    kind: <span class="tk-s">"tap"</span>,
    x: <span class="tk-n">320</span>, y: <span class="tk-n">760</span>,             <span class="tk-c">// centre of the FAB</span>
    delay: <span class="tk-n">900</span>,                  <span class="tk-c">// fire ~halfway through the frame</span>
  }],
  transition: { type: <span class="tk-s">"crossfade"</span>, duration: <span class="tk-n">280</span> },
});

frames.<span class="tk-f">push</span>({
  svgContent: <span class="tk-f">elementTreeToSvg</span>(afterTree, <span class="tk-n">390</span>, <span class="tk-n">844</span>, <span class="tk-s">"b-"</span>),
  duration: <span class="tk-n">2200</span>,
});</code></pre>

<p>The ripple is white-translucent and works against most backgrounds.
For light backgrounds, a slightly larger frame's <code>delay</code>
(~300&nbsp;ms before the crossfade starts) makes the tap feel more
intentional.</p>

<h2>Stacking overlays</h2>

<p>You can put multiple overlays on a single frame — typing in the search box,
then a tap on the suggestion that appears:</p>

<pre><code>overlays: [
  { kind: <span class="tk-s">"typing"</span>, text: <span class="tk-s">"design system"</span>, x: <span class="tk-n">100</span>, y: <span class="tk-n">80</span>, speed: <span class="tk-n">50</span> },
  { kind: <span class="tk-s">"tap"</span>, x: <span class="tk-n">140</span>, y: <span class="tk-n">160</span>, delay: <span class="tk-n">1500</span> },
]</code></pre>

<h2>When to capture state into HTML instead</h2>

<p>Overlays are convenient but they have two costs:</p>

<ol>
  <li><strong>They disable the merge fast path.</strong> Even one overlay
    forces every frame to render atomically, which inflates output size
    and may produce one-frame flicker between crossfaded frames.</li>
  <li><strong>They live in their own coordinate space.</strong> If the
    captured layout shifts (different viewport size, font metric change),
    the overlay coordinates don't move with it.</li>
</ol>

<p>Where the action you want to show could be expressed as captured HTML —
"input filled in", "button pressed" — prefer that.</p>

<h2>See also</h2>

<ul>
  <li><a href="../../api/overlays/">Overlay API reference</a></li>
  <li><a href="../animated-demo/">Build an animated demo</a></li>
</ul>
`);
