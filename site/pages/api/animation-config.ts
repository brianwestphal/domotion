export const meta = {
  slug: "api/animation-config",
  title: "AnimationConfig",
  subtitle: "The argument shape for generateAnimatedSvg().",
};

export const content = `
<h2>AnimationConfig</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">AnimationConfig</span> {
  width: <span class="tk-t">number</span>;
  height: <span class="tk-t">number</span>;
  frames: <span class="tk-t">AnimationFrame</span>[];
  chrome?: {
    type: <span class="tk-s">"terminal"</span> | <span class="tk-s">"browser"</span> | <span class="tk-s">"phone"</span>;
    title?: <span class="tk-t">string</span>;
    url?: <span class="tk-t">string</span>;
  };
  sharedDefs?: <span class="tk-t">string</span>;
}</pre>

<div class="params">
  <div class="row">
    <div class="name">width / height</div>
    <div class="type">number</div>
    <div class="desc">SVG <code>viewBox</code> and outer dimensions for the animated SVG.</div>
  </div>
  <div class="row">
    <div class="name">frames</div>
    <div class="type">AnimationFrame[]</div>
    <div class="desc">Ordered list of captured frames. See below.</div>
  </div>
  <div class="row">
    <div class="name">chrome</div>
    <div class="type">DeviceChromeConfig</div>
    <div class="desc">Optional device-chrome wrapper. When set, the rendered SVG grows by the chrome's outer dimensions and the captured frames are translated into the chrome's content area. <code>type</code> is one of <code>"terminal"</code> (macOS-style window with traffic lights), <code>"browser"</code> (browser window with title bar + address bar; pass <code>url</code>), or <code>"phone"</code> (iPhone-style frame with status bar and home indicator).</div>
  </div>
  <div class="row">
    <div class="name">sharedDefs</div>
    <div class="type">string</div>
    <div class="desc">SVG markup hoisted into the top-level <code>&lt;defs&gt;</code>. Frames can reference these IDs via <code>&lt;use href="#..."&gt;</code> — useful for glyph paths and other assets that repeat across frames.</div>
  </div>
</div>

<h2 id="animation-frame">AnimationFrame</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">AnimationFrame</span> {
  svgContent: <span class="tk-t">string</span>;
  duration: <span class="tk-t">number</span>;
  transition?: {
    type: <span class="tk-s">"crossfade"</span> | <span class="tk-s">"push-left"</span> | <span class="tk-s">"scroll"</span>;
    duration: <span class="tk-t">number</span>;
  };
  overlays?: <span class="tk-t">Overlay</span>[];
}</pre>

<div class="params">
  <div class="row">
    <div class="name">svgContent</div>
    <div class="type">string</div>
    <div class="desc">The output of <code>elementTreeToSvg(tree, w, h, idPrefix)</code>. <strong>Always pass a unique <code>idPrefix</code> per frame</strong> to avoid clip / gradient ID collisions.</div>
  </div>
  <div class="row">
    <div class="name">duration</div>
    <div class="type">number (ms)</div>
    <div class="desc">How long the frame is held visible at full opacity, before the transition to the next frame begins.</div>
  </div>
  <div class="row">
    <div class="name">transition</div>
    <div class="type">{ type, duration }</div>
    <div class="desc">The transition out of this frame. Defaults to <code>{ type: "crossfade", duration: 300 }</code> when omitted. The last frame's transition is to the first frame (the loop wraps).</div>
  </div>
  <div class="row">
    <div class="name">overlays</div>
    <div class="type">Overlay[]</div>
    <div class="desc">Typing or tap effects that play on top of this frame for its duration. See <a href="../overlays/">Overlay types</a>.</div>
  </div>
</div>

<h3>Transition types</h3>

<ul>
  <li><strong><code>crossfade</code></strong> — outgoing fades to 0 while incoming fades from 0; durations overlap so shared pixels stay visible. Default and recommended.</li>
  <li><strong><code>push-left</code></strong> — outgoing slides off to the left, incoming slides in from the right.</li>
  <li><strong><code>scroll</code></strong> — both frames remain visible during the transition; opacity changes only at the end.</li>
</ul>

<p>See <a href="../../concepts/animation/">Animation model</a> for the
trade-offs (especially: only all-crossfade sequences take the merge fast path).</p>

<h2>Total duration</h2>

<p>The animation's total duration is the sum of every frame's
<code>duration + transition.duration</code> (transitions default to 300&nbsp;ms
when unset). The animation runs <code>infinite</code> by default and cannot
be paused without scripting in the host page.</p>

<h2>Example</h2>

<pre><code><span class="tk-k">const</span> config: <span class="tk-t">AnimationConfig</span> = {
  width: <span class="tk-n">720</span>,
  height: <span class="tk-n">420</span>,
  frames: [
    {
      svgContent: frame0,
      duration: <span class="tk-n">1500</span>,
      transition: { type: <span class="tk-s">"push-left"</span>, duration: <span class="tk-n">400</span> },
      overlays: [{
        kind: <span class="tk-s">"typing"</span>, text: <span class="tk-s">"npm install domotion"</span>,
        x: <span class="tk-n">24</span>, y: <span class="tk-n">32</span>, fontSize: <span class="tk-n">14</span>, color: <span class="tk-s">"#e6edf3"</span>, speed: <span class="tk-n">40</span>,
      }],
    },
    { svgContent: frame1, duration: <span class="tk-n">2500</span> },
    { svgContent: frame2, duration: <span class="tk-n">3000</span> },
  ],
};</code></pre>

<h2 id="device-chrome">DeviceChromeConfig</h2>

<pre class="sig"><span class="tk-k">interface</span> <span class="tk-t">DeviceChromeConfig</span> {
  type: <span class="tk-s">"terminal"</span> | <span class="tk-s">"browser"</span> | <span class="tk-s">"phone"</span>;
  url?: <span class="tk-t">string</span>;     <span class="tk-c">// browser only — shown in the address bar</span>
  title?: <span class="tk-t">string</span>;   <span class="tk-c">// terminal/browser — shown in the title bar / tab</span>
}</pre>

<p>For single-frame captures, the same wrapper is available via
<a href="../element-tree-to-svg/#wrapsvg"><code>wrapWithChrome(inner, w, h, chrome)</code></a>
or by passing <code>--chrome &lt;kind&gt;</code> to the
<a href="../../start/cli/#capture"><code>domotion capture</code> CLI</a>.</p>

<h2>See also</h2>

<ul>
  <li><a href="../generate-animated-svg/"><code>generateAnimatedSvg()</code></a></li>
  <li><a href="../overlays/">Overlay types</a></li>
</ul>
`;
