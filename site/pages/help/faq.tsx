/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "help/faq",
  title: "FAQ",
  subtitle: "Questions that come up enough to write down.",
};

export const content: SafeHtml = raw(`
<h2>Why is the output an SVG and not a PNG / WebP / WebM?</h2>

<p>Three reasons. <strong>Scaling</strong>: vector text and shapes render crisply
at retina, at zoom, and on print. <strong>File size</strong>: a 30&nbsp;KB SVG
beats an equivalent-quality video for short loops, especially after gzip.
<strong>Embedding</strong>: SVG drops into <code>&lt;img&gt;</code>, plays
without JavaScript, and works in environments that block scripts (Markdown
renderers, RSS readers, email clients in some cases).</p>

<h2>Does it work in Firefox / Safari?</h2>

<p>Yes. The SVG output uses standard CSS keyframes and SVG primitives — every
modern browser plays it identically. Capture is Chromium-only (Domotion uses
Playwright's Chromium internally), but the output is engine-agnostic.</p>

<h2>Can I capture on Linux / Windows?</h2>

<p>Yes for capture and rendering, but path-mode font fidelity is best on
macOS. The bundled font lookup table is tuned to Apple system fonts; on
Linux / Windows the path renderer falls back to native SVG
<code>&lt;text&gt;</code> when no matching font is found, which means the
output looks like whatever font the rendering browser has.</p>

<p>For cross-platform CI, a common pattern is "capture on macOS runners,
deploy the SVGs anywhere".</p>

<h2>Do I need to install Playwright separately?</h2>

<p>No. Domotion already depends on <code>@playwright/test</code> at a known
version. The Chromium binary is auto-installed on first use of
<code>launchChromium()</code> or <code>DemoRecorder</code>. You can pre-install
it explicitly if you want to:</p>

<pre><code>npx playwright install chromium</code></pre>

<h2>Can the SVG respond to clicks or hover?</h2>

<p>Out of the box, no — the output is a static SVG with looping CSS
animations. If you embed via inline SVG or <code>&lt;object&gt;</code>, you
can hand-edit the markup to add <code>&lt;a&gt;</code> elements with
<code>href</code> attributes, or <code>:hover</code> styles in the embedded
<code>&lt;style&gt;</code> block. Domotion doesn't generate those for you.</p>

<h2>Can I pause the animation?</h2>

<p>Not from inside the SVG. Animations always loop. To control playback from
the host page, embed via <code>&lt;object&gt;</code> or inline SVG and use
the host's CSS to set <code>animation-play-state: paused</code> on the SVG
elements you want to pause.</p>

<h2>How do I make the animation respect <code>prefers-reduced-motion</code>?</h2>

<p>Domotion doesn't currently emit a guard for it. Wrap the embed in a
<code>&lt;picture&gt;</code> with a <code>media="(prefers-reduced-motion:
reduce)"</code> source pointing to a single-frame still SVG. See
<a href="../../guides/embedding/">Embed SVGs in your site</a>.</p>

<h2>Can I capture an iframe inside my page?</h2>

<p>Not directly. Domotion captures the visible DOM under a selector; iframe
content lives in a separate document and isn't walked. Either capture the
iframe's URL directly as its own SVG, or pre-render the iframe's content
inline.</p>

<h2>Why is my <code>backdrop-filter</code> ignored?</h2>

<p>SVG has no equivalent — the standard <code>&lt;filter&gt;</code>
primitives operate on a region's own pixels, not on what's behind it. The
backdrop-filter region is captured but not painted. A capture warning is
logged so you can find it. For a faithful result, screenshot the affected
area and inline it as an <code>&lt;image&gt;</code>.</p>

<h2>The output SVG references absolute URLs / file paths. Why?</h2>

<p>Most asset URLs (images, background-image url() values, list-style-image)
are inlined as base64 data URIs at capture time so the SVG is self-contained.
If you see a remaining external URL, it's typically because the asset was at
an <code>http://</code> / <code>https://</code> URL, which is left as-is.
Pre-fetch and inline manually if you need full self-containment for those.</p>

<h2>Can I use this for snapshot testing my UI?</h2>

<p>It's not what Domotion is optimised for, but yes — capture an HTML state,
hash the SVG output, compare. Two caveats: SVG output is sensitive to
sub-pixel layout differences, so test runs on different machines may produce
slightly different bytes; and Domotion's rendering invariants change in
patch releases as new CSS support lands. Pin Domotion to an exact version
for snapshot testing.</p>

<h2>What's the license?</h2>

<p>MIT. Commercial use, modification, and redistribution are all fine — see
the <code>LICENSE</code> file in the repo for the full text.</p>

<h2>Why "Domotion"?</h2>

<p>"DOM" + "motion". The pipeline is "DOM in, motion out".</p>

<h2>How do I report a bug or request a feature?</h2>

<p>File an issue with: the input HTML, the output SVG, what you expected,
and the output of <code>logCaptureWarnings()</code>. The
<a href="../troubleshooting/">Troubleshooting</a> page has the bug-report
template at the bottom.</p>
`);
