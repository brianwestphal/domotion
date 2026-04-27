export const meta = {
  slug: "start/what-is-domotion",
  title: "What is Domotion?",
  subtitle: "And when (and when not) to reach for it.",
};

export const content = `
<p>
  Domotion is a Node tool that takes a piece of HTML rendered in headless
  Chromium and converts it into a single self-contained SVG file. If you
  capture several HTML states, it can stitch them together into one SVG with
  CSS keyframe animations between frames. The output renders pixel-faithfully
  in Chromium, scales crisply at any size, and embeds without external
  assets.
</p>

<p>
  Most users start with the CLI:
</p>

<pre><code>npm install -g domotion
domotion capture https://example.com -o example.svg</code></pre>

<p>
  In practice that means you can author a marketing or documentation animation
  the same way you build the rest of your product — plain HTML, plain CSS,
  inside your real component library — and ship the result as a single
  <code>.svg</code> file that drops into an <code>&lt;img&gt;</code> tag.
  When you outgrow the CLI's vocabulary, the same engine is available as a
  TypeScript API.
</p>

<h2>The problem it solves</h2>

<p>The usual ways to put a moving demo on a marketing or docs page each have a
real cost:</p>

<table>
  <thead>
    <tr><th>Approach</th><th>Trade-off</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>MP4 / WebM video</td>
      <td>Heavy bytes, fixed resolution, awkward to lazy-load, no inline embedding, captions are extra work.</td>
    </tr>
    <tr>
      <td>Live <code>&lt;iframe&gt;</code> of the real app</td>
      <td>Slow first paint, requires the source app to be online, breaks for users on flaky networks, accessibility regressions.</td>
    </tr>
    <tr>
      <td>Hand-authored SVG / Lottie</td>
      <td>Pixel-accurate but enormously time-consuming for anything beyond a couple of frames; drifts out of sync with the real product.</td>
    </tr>
    <tr>
      <td>Animated GIF</td>
      <td>Limited colour palette, large file size, no native scaling.</td>
    </tr>
  </tbody>
</table>

<p>
  Domotion is the option you reach for when you want the fidelity of "show the
  real thing" without the runtime cost of an embed and without the authoring
  cost of hand-rolling an animation.
</p>

<h2>What you get out</h2>

<ul>
  <li><strong>One file.</strong> A self-contained SVG with text as glyph paths or
    <code>&lt;text&gt;</code> elements, backgrounds and borders as native SVG
    primitives, gradients translated to <code>&lt;linearGradient&gt;</code> /
    <code>&lt;radialGradient&gt;</code>, and any rasterised pieces (emoji,
    bitmap glyphs) embedded as base64 PNG.</li>
  <li><strong>No external dependencies at runtime.</strong> Everything the SVG
    needs to paint is inside the file.</li>
  <li><strong>Cross-browser consistency.</strong> The path-rendered text mode
    bakes glyph outlines into the SVG, so the result looks identical in
    Firefox, Safari, and Chromium even though the capture was Chromium-only.</li>
  <li><strong>Optional CSS animations</strong> — cross-fades, push-left
    transitions, scroll, and per-frame typing / tap overlays — composed across
    multiple captured frames.</li>
</ul>

<h2>When to use Domotion</h2>

<ul>
  <li>Marketing landing pages that need a polished hero animation of your product UI.</li>
  <li>Documentation walk-throughs ("here's what happens when you click X").</li>
  <li>Changelog entries showing before/after behaviour.</li>
  <li>Teaching material that needs to scale crisply on retina displays and at zoom.</li>
  <li>Anywhere you'd otherwise embed a screen recording but care about file size and embedding ergonomics.</li>
</ul>

<h2>When <em>not</em> to use Domotion</h2>

<ul>
  <li><strong>You need true 60fps motion or video playback.</strong> Domotion produces
    frame-by-frame transitions, not real-time animations. For game-feel motion or
    video content, stick with an MP4 / WebM.</li>
  <li><strong>You need cross-engine pixel matching at capture time.</strong>
    Domotion captures Chromium. If you need exactly the Firefox or Safari
    layout to be your source of truth, that engine isn't supported.</li>
  <li><strong>You need a fully interactive embed.</strong> The output is a static
    SVG. It can play CSS animations on a loop but it can't respond to clicks or
    typing.</li>
</ul>

<div class="callout note">
  <span class="icon">💡</span>
  <div class="body">
    <p><strong>Origin:</strong> Domotion was extracted from the
    <code>slicekit</code> project in 2026-04, where it had been in use as
    <code>tools/svg-demo-gen</code>. APIs may still shift while the standalone
    surface stabilises — see the API reference for the current export list.</p>
  </div>
</div>

<h2>Next</h2>
<p>
  Head to <a href="../install/">Installation</a> to set up Node and Playwright,
  then jump into the <a href="../quickstart/">Quick start</a> for a five-minute
  end-to-end capture.
</p>
`;
