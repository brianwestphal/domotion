export const meta = {
  slug: "concepts/animation",
  title: "Animation model",
  subtitle: "Frames, transitions, overlays — how multi-frame SVGs are composed.",
};

export const content = `
<p>An animated Domotion SVG is several captured frames stitched together with
CSS keyframes. There's no JavaScript at runtime — the browser plays the
animation natively from the SVG's embedded <code>&lt;style&gt;</code>. This
page explains the model so you know what's possible and where the seams are.</p>

<h2>The frame</h2>

<p>An <em>animation frame</em> is a single capture (the <code>svgContent</code>
returned from <code>elementTreeToSvg</code>) plus timing and an optional
transition to the next frame:</p>

<pre><code><span class="tk-k">interface</span> <span class="tk-t">AnimationFrame</span> {
  svgContent: <span class="tk-t">string</span>;          <span class="tk-c">// from elementTreeToSvg()</span>
  duration: <span class="tk-t">number</span>;             <span class="tk-c">// hold time in ms</span>
  transition?: {
    type: <span class="tk-s">"crossfade"</span> | <span class="tk-s">"push-left"</span> | <span class="tk-s">"scroll"</span>;
    duration: <span class="tk-t">number</span>;
  };
  overlays?: <span class="tk-t">Overlay</span>[];        <span class="tk-c">// typing, tap ripples</span>
}</code></pre>

<p>You build a list of frames and pass them to
<code>generateAnimatedSvg(config)</code>. The result is one SVG with one
<code>@keyframes</code> rule per frame and per overlay, summed timeline,
infinite loop.</p>

<h2>Three transition types</h2>

<table>
  <thead>
    <tr><th>Type</th><th>Behaviour</th><th>Best for</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><code>crossfade</code></td>
      <td>Outgoing frame fades to 0 while incoming frame fades to 1, with overlap so shared pixels stay visible.</td>
      <td>State changes within the same screen (form being filled, list updating).</td>
    </tr>
    <tr>
      <td><code>push-left</code></td>
      <td>Outgoing frame slides off to the left, incoming slides in from the right.</td>
      <td>Stepping through a flow ("step 1 → step 2 → step 3").</td>
    </tr>
    <tr>
      <td><code>scroll</code></td>
      <td>Both frames stay visible; opacity transitions only at the very end.</td>
      <td>Scrolling content, where one frame logically continues into the next.</td>
    </tr>
  </tbody>
</table>

<h2>Crossfade is the smart path</h2>

<p>When every transition in a sequence is <code>crossfade</code> (or unset),
Domotion takes a fast path: it merges all frames into one de-duplicated
element tree with per-element <em>visibility timelines</em>. Stable elements
— a static logo, a header that doesn't change — are emitted once with
<code>opacity: 1</code> throughout. Changing elements get <code>step-end</code>
keyframes that flip them on at the right moment.</p>

<p>Two payoffs:</p>

<ol>
  <li><strong>No flicker.</strong> Without merging, naive cross-fades would
    redraw every static pixel on every transition; small CSS-paint glitches at
    the boundary cause a one-frame dark flash. Merged frames just don't redraw
    those pixels.</li>
  <li><strong>Smaller files.</strong> The text "Hello" doesn't appear five
    times in the SVG — once, with a timeline saying when it's visible.</li>
</ol>

<p><code>push-left</code> and <code>scroll</code> can't merge because the
geometry of each frame is different at every instant; they fall back to the
"emit each frame as a clipped group" path.</p>

<h2>Overlays</h2>

<p>Overlays sit on top of a frame's content for the duration of that frame.
Two kinds today:</p>

<ul>
  <li><strong><code>typing</code></strong> — animates a string being typed
    character-by-character at a given coordinate. Useful for terminal demos
    and "user types into a search box" patterns.</li>
  <li><strong><code>tap</code></strong> — a Material-style ripple at a
    coordinate, suggesting a click or tap. Useful for "user clicks here" cues
    on mobile demos.</li>
</ul>

<p>See the <a href="../../guides/overlays/">Typing &amp; tap overlays</a> guide
for working examples.</p>

<h2>Shared definitions</h2>

<p>Glyph paths, gradient defs, and clip paths can be expensive when repeated
across frames. <code>generateAnimatedSvg</code> accepts a
<code>sharedDefs</code> string — markup that gets hoisted into the top-level
<code>&lt;defs&gt;</code> so frames can reference IDs across the
animation. The simplest pattern is to capture all frames first, then pull
their glyph defs out and pass them as <code>sharedDefs</code>; the test
runners and example scripts do exactly this.</p>

<h2>Loop semantics</h2>

<p>The generated animation always loops infinitely with
<code>animation: ... infinite</code>. Single-shot playback is not supported in
SVG without scripting. If you need playback control, embed the SVG via
<code>&lt;object&gt;</code> and toggle a CSS class on the host page, or wrap
your captures in a JavaScript controller.</p>

<h2>Browser support</h2>

<p>The output uses standard CSS keyframes and SMIL-free SVG, supported in
every modern browser. The same SVG renders in WebKit (Safari, iOS), Gecko
(Firefox), and Blink (Chrome, Edge). It also renders in image contexts
(<code>&lt;img&gt;</code>, <code>background-image</code>) — though some image
contexts mute animations; embed via <code>&lt;object&gt;</code> or
<code>&lt;iframe&gt;</code> if you find an environment that does.</p>

<h2>Next</h2>
<p>That's the model. Move on to the <a href="../../guides/animated-demo/">Build
an animated demo</a> guide for a runnable end-to-end recipe.</p>
`;
