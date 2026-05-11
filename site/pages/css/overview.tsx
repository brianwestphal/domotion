/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */

import { raw, type SafeHtml } from "kerfjs";

export const meta = {
  slug: "css/overview",
  title: "CSS support overview",
  subtitle: "Modern HTML and CSS round-trip faithfully — these are the exceptions.",
};

export const content: SafeHtml = raw(`
<p>Domotion's goal is sub-3% pixel-diff fidelity against Chromium on the host
platform. Treat that as the default: anything in modern HTML and CSS that
Chromium paints, Domotion captures and re-emits as native SVG primitives. The
per-area pages in this section exist for the few features that have caveats
or aren't yet covered.</p>

<h2>The exceptions, by area</h2>

<p>Click through for the details and any workarounds.</p>

<ul>
  <li><a href="../layout/"><strong>Layout</strong></a> — <code>position: fixed</code>
    and <code>sticky</code> render at the captured position with no scroll-following
    (the SVG is one static frame). Native scrollbar chrome on
    <code>overflow: scroll / auto</code> isn't drawn yet — the visible scroll
    region renders correctly.</li>
  <li><a href="../colors-bg/"><strong>Colors &amp; backgrounds</strong></a> —
    output is sRGB; widely-separated stops in OKLCH-interpolated gradients drift
    slightly. <code>background-image: url(...)</code> embeds inlined PNG / JPEG /
    GIF / WebP / AVIF / SVG; other formats pass through with their original URL.</li>
  <li><a href="../gradients/"><strong>Gradients</strong></a> —
    <code>conic-gradient</code> has no SVG equivalent and is skipped (warning
    logged). Linear, radial, and both <code>repeating-*</code> variants are
    full-fidelity.</li>
  <li><a href="../borders/"><strong>Borders &amp; effects</strong></a> —
    <code>border-image</code> is not yet implemented. <code>backdrop-filter</code>
    has no SVG equivalent in <code>&lt;img&gt;</code>-rendered SVG. <code>clip-path:
    path()</code> isn't emitted yet (warning logged); <code>mask</code> is captured
    but not yet emitted.</li>
  <li><a href="../transforms/"><strong>Transforms</strong></a> — currently the
    largest gap. Only <code>translate</code> round-trips faithfully; <code>rotate</code>,
    <code>scale</code>, <code>skew</code>, <code>matrix</code>, and 3D transforms
    render as the un-transformed bounding box. Workarounds on the page.</li>
  <li><a href="../text-and-fonts/"><strong>Text &amp; fonts</strong></a> —
    <code>text-align: justify</code> doesn't space-stretch (left-aligned in the
    output, warning logged). Wavy underline falls back to a straight line. Web
    fonts that aren't in the bundled mapping fall back to <code>&lt;text&gt;</code>
    instead of path-mode glyphs. <code>::selection</code> isn't captured.</li>
  <li><a href="../writing-mode/"><strong>Writing mode</strong></a> — RTL (Arabic,
    Hebrew, etc.) is fully supported. Vertical writing modes (<code>vertical-rl</code>
    / <code>vertical-lr</code> / <code>sideways-*</code>) currently render as
    horizontal (warning logged); rasterized fallback is on the roadmap.</li>
  <li><a href="../form-controls/"><strong>Form controls</strong></a> —
    <code>&lt;input type=file&gt;</code> renders the button chrome only. Bare
    <code>&lt;button&gt;</code> / <code>&lt;select&gt;</code> with no author CSS
    only partially synthesizes the UA chrome. Open <code>&lt;select&gt;</code>
    dropdowns can't be captured (they live in OS chrome). <code>&lt;textarea&gt;</code>
    content is rasterized for pixel-perfect Chromium word-wrap.</li>
</ul>

<h2>Out of scope</h2>

<p>These aren't bugs — they're outside what a static SVG snapshot can reasonably
represent:</p>

<ul>
  <li><code>&lt;canvas&gt;</code>, <code>&lt;video&gt;</code>,
    <code>&lt;iframe&gt;</code>, <code>&lt;object&gt;</code>,
    <code>&lt;embed&gt;</code> — bodies aren't rendered (warning logged).
    Capture a poster frame or screenshot instead.</li>
  <li>CSS animations and transitions — Domotion captures one static frame.
    Multi-frame animation is composed at a higher layer
    (<a href="../../api/generate-animated-svg/"><code>generateAnimatedSvg</code></a>).</li>
  <li><code>@page</code> rules — print-media only.</li>
  <li>Live focus / hover / selection state — set the desired state in
    Playwright before capturing.</li>
</ul>

<h2>Capture warnings</h2>

<p>When a capture hits a feature that doesn't round-trip fully, Domotion records
a structured warning so you can find what was skipped. Helpers are exported
from the package root:</p>

<pre><code><span class="tk-k">import</span> { getLastCaptureWarnings, logCaptureWarnings } <span class="tk-k">from</span> <span class="tk-s">"domotion"</span>;

<span class="tk-f">logCaptureWarnings</span>();                  <span class="tk-c">// to stderr</span>
<span class="tk-k">const</span> warnings = <span class="tk-f">getLastCaptureWarnings</span>(); <span class="tk-c">// or programmatic</span></code></pre>

<p>Each warning carries a <code>selector</code> (short ancestor-path identifier),
a <code>feature</code> name, and a one-sentence <code>detail</code>. Warnings
are deduped by <code>(feature, selector)</code> per capture.</p>

<h2>Cross-platform note</h2>

<p>Domotion targets pixel-faithful Chromium output <em>on the host platform</em>.
Today the rendering pipeline is fully calibrated against Chromium-on-macOS
(CoreText fallback chain). Linux (fontconfig — Noto / DejaVu / Liberation) and
Windows (DirectWrite — Segoe UI / Consolas / Cambria Math / Yu Gothic)
calibration is roadmap work; non-macOS captures will run but font fallback
matching may diverge from Chromium until that's complete.</p>
`);
