/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "help/contributing",
  title: "Contributing",
  subtitle: "Architecture, test suites, and how to add a new CSS feature.",
};

export const content: SafeHtml = raw(`
<p>This page is for people landing on the Domotion repo who want to fix a
bug, add a CSS feature, or otherwise touch the source. Users of the library
should start at <a href="../../start/quickstart/">Quick start</a> instead.</p>

<h2>Architecture at 30,000 ft</h2>

<p>Domotion has three logical stages, all in <code>src/</code>:</p>

<table>
  <thead><tr><th>Stage</th><th>Files</th><th>What happens</th></tr></thead>
  <tbody>
    <tr>
      <td><strong>Capture</strong></td>
      <td><code>dom-to-svg.ts</code> (CAPTURE_SCRIPT), <code>capture.ts</code></td>
      <td>Playwright loads the page; an in-page script walks the DOM, recording position, computed styles, text, and per-glyph offsets into a serialisable <code>CapturedElement</code> tree.</td>
    </tr>
    <tr>
      <td><strong>Render</strong></td>
      <td><code>dom-to-svg.ts</code> (server side), <code>text-renderer.ts</code>, <code>text-to-path.ts</code>, <code>form-controls.ts</code>, <code>gradients.ts</code>, <code>chrome.ts</code></td>
      <td>Pure functions take a tree and emit SVG markup — <code>&lt;rect&gt;</code> for backgrounds, <code>&lt;path&gt;</code> for glyph outlines via fontkit, <code>&lt;linearGradient&gt;</code> for CSS gradients, etc.</td>
    </tr>
    <tr>
      <td><strong>Animate</strong></td>
      <td><code>animator.ts</code>, <code>frame-merge.ts</code></td>
      <td>Multiple captured frames get composed into one SVG with CSS keyframe transitions. The merge pipeline de-duplicates shared elements across frames and emits per-element visibility timelines for the all-crossfade fast path.</td>
    </tr>
  </tbody>
</table>

<p>The CLI (<code>src/cli/</code>) is a thin shell over the public API
(<code>src/index.ts</code>). The user manual under <code>site/</code> is a
separate static-site generator that imports types and helpers from the
library — it's a good source of \"how is this actually used\" examples.</p>

<h2>The CAPTURE_SCRIPT discipline</h2>

<p>The DOM-walking code lives as a string literal at the top of
<code>src/dom-to-svg.ts</code> and is <code>page.evaluate</code>'d into the
captured page. Two consequences:</p>

<ul>
  <li><strong>No <code>import</code> statements, no closures over module-scope
    vars.</strong> The script only sees the args passed to <code>evaluate</code>
    and globals available in the page.</li>
  <li><strong>Use <code>var</code> / function declarations or arrow functions
    that don't reference outer scope.</strong></li>
</ul>

<p>If you find yourself wanting to call a helper from CAPTURE_SCRIPT, either
inline it (small) or capture the data needed and call the helper after the
script returns (large). Anything reusable across capture and render can live
as plain TypeScript helpers in <code>src/</code> and be re-imported by the
renderer side — just don't try to call them from inside CAPTURE_SCRIPT.</p>

<p>This is also why CAPTURE_SCRIPT is tested via the test runner (capturing
real fixtures) rather than unit tests: the script only behaves correctly
when the surrounding <code>evaluate()</code> injects its arguments.</p>

<h2>Running the test suites</h2>

<table>
  <thead><tr><th>Command</th><th>What it runs</th></tr></thead>
  <tbody>
    <tr><td><code>npm test</code></td><td>Vitest unit tests under <code>src/**/*.test.ts</code> — fast, no browser.</td></tr>
    <tr><td><code>npm run demos:test</code></td><td>The feature visual-regression suite (<code>tests/features.ts</code>). One fixture per CSS feature; each is rendered both via Chromium and via Domotion's pipeline and the PNG diff thresholded at 3%.</td></tr>
    <tr><td><code>npm run demos:test:html</code></td><td>The broad-coverage sweep against <code>external/html-test/*.html</code> (a gitignored clone of <a href="https://github.com/brianwestphal/html-test">github.com/brianwestphal/html-test</a>). Clone with <code>git clone https://github.com/brianwestphal/html-test.git external/html-test</code> before first run. Some failures are pre-existing and tracked separately; new code shouldn't introduce regressions here.</td></tr>
    <tr><td><code>npm run demos:test:all</code></td><td>features + showcase + html-test-suite.</td></tr>
    <tr><td><code>npm run demos:review</code></td><td>Local web UI to compare expected / actual / diff PNGs from each suite by hand. Most useful when adding or updating fixtures.</td></tr>
  </tbody>
</table>

<h2>Adding a new CSS feature</h2>

<ol>
  <li><strong>Capture the new property</strong> in CAPTURE_SCRIPT — add it
    to the styles object that gets serialised onto each
    <code>CapturedElement</code>.</li>
  <li><strong>Plumb it through</strong> the <code>CapturedElement</code> type
    (<code>src/dom-to-svg.ts</code>, near the top).</li>
  <li><strong>Render it</strong> in the appropriate place — usually
    <code>renderElement</code> in <code>src/dom-to-svg.ts</code> for box
    properties, or <code>src/text-renderer.ts</code> for text-related ones.</li>
  <li><strong>Add a fixture</strong> to <code>tests/features.ts</code>: a
    minimal HTML snippet that exercises the feature and a single matching
    expected behavior. Run <code>npm run demos:test</code> to record the
    expected PNG.</li>
  <li><strong>Update the support matrix</strong> in
    <code>site/pages/css/&lt;area&gt;.tsx</code> (the per-area page) and the
    top-level <code>FEATURES.md</code> checklist.</li>
  <li><strong>Document any new fallback behavior</strong> in
    <code>docs/</code> — these are the contract with consumers about what
    round-trips and what doesn't.</li>
</ol>

<p>If the feature has no faithful SVG representation (e.g. complex CSS
filters), it goes through the raster-fallback path: capture
<code>page.screenshot()</code> for the affected region and emit it as an
embedded <code>&lt;image&gt;</code>. Add a capture warning so users can find
it.</p>

<h2>Where the docs live</h2>

<table>
  <thead><tr><th>Location</th><th>Audience</th></tr></thead>
  <tbody>
    <tr><td><code>docs/</code></td><td>Implementation requirements (rendering fidelity, supported CSS, known caveats). The internal contract.</td></tr>
    <tr><td><code>site/pages/</code></td><td>Public user manual. CLI- and use-case-focused.</td></tr>
    <tr><td><code>FEATURES.md</code></td><td>Per-feature support checklist with links to fixtures. Keep in sync when fixtures land.</td></tr>
    <tr><td><code>CLAUDE.md</code></td><td>Guidance for AI assistants working in the repo.</td></tr>
  </tbody>
</table>

<h2>Quality gates</h2>

<ul>
  <li><strong><code>npm run build</code></strong> must pass (TypeScript
    strict). No <code>any</code> outside the fontkit / bidi-js boundary
    types.</li>
  <li><strong><code>npm test</code></strong> must pass.</li>
  <li><strong><code>npm run demos:test</code></strong> is the primary
    regression signal — every feature has a fixture; new features need
    fixtures.</li>
</ul>

<h2>Reading list before your first PR</h2>

<ol>
  <li><a href="../../concepts/pipeline/">The capture pipeline</a> — visual
    overview of the same architecture this page lists.</li>
  <li><a href="../../concepts/element-tree/">The element tree</a> — what
    flows from capture to render.</li>
  <li><a href="../../concepts/text-rendering/">Text rendering</a> — the
    most subtle subsystem; understanding subpixel positioning and run-based
    shaping saves hours later.</li>
  <li>The top of <code>CLAUDE.md</code> — house-style invariants that
    aren't enforceable by the type-checker.</li>
</ol>
`);
