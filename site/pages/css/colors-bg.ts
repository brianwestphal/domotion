export const meta = {
  slug: "css/colors-bg",
  title: "Colors & backgrounds",
  subtitle: "What round-trips: solid colours, layered backgrounds, modern colour spaces.",
};

export const content = `
<h2>Color formats</h2>

<p>Every colour value Chromium accepts as a computed style is honoured —
Domotion reads the resolved colour, not the source CSS, so notation differences
don't matter:</p>

<ul>
  <li>Hex: <code>#fff</code>, <code>#80c0ffaa</code></li>
  <li><code>rgb()</code>, <code>rgba()</code></li>
  <li><code>hsl()</code>, <code>hsla()</code></li>
  <li><code>hwb()</code></li>
  <li>Modern colour spaces: <code>lab()</code>, <code>lch()</code>,
    <code>oklab()</code>, <code>oklch()</code></li>
  <li><code>color()</code> with display-p3, srgb, etc.</li>
  <li><code>color-mix(...)</code></li>
  <li><code>currentColor</code> (resolves to the element's text colour)</li>
</ul>

<p>Output is always in <code>rgb()</code> / <code>rgba()</code> in the SVG —
the wider colour spaces collapse to sRGB at write time. For most marketing
use cases this is invisible; if you're working with HDR / display-P3 source
material and care about extended-gamut output, that's not yet supported.</p>

<h2>Background layers</h2>

<table>
  <thead><tr><th>Feature</th><th>Status</th></tr></thead>
  <tbody>
    <tr><td>Solid <code>background-color</code></td><td>Full</td></tr>
    <tr><td>Multiple layered backgrounds</td><td>Full — first-on-top semantics preserved.</td></tr>
    <tr><td><code>background-image: linear-gradient / radial-gradient</code> + their <code>repeating-*</code> variants</td><td>Full — see <a href="../gradients/">Gradients</a>.</td></tr>
    <tr><td><code>background-image: url(...)</code></td><td>Partial — embedded as <code>&lt;image&gt;</code> with <code>preserveAspectRatio</code> approximated from <code>background-size</code> + <code>background-position</code>.</td></tr>
    <tr><td><code>background-image: conic-gradient</code></td><td>None — no SVG equivalent. Layer skipped, warning logged.</td></tr>
    <tr><td><code>background-clip: border-box / padding-box / content-box / text</code></td><td>Full — text-clipping is rendered via SVG mask.</td></tr>
    <tr><td><code>background-origin</code>, <code>background-attachment</code></td><td>Full</td></tr>
    <tr><td><code>background-repeat: repeat / no-repeat / round / space</code></td><td>Partial — common combinations honoured for url() layers.</td></tr>
  </tbody>
</table>

<h2>Image embedding</h2>

<p>Background-image URLs and <code>&lt;img src&gt;</code> values are inlined as
base64 data URIs at capture time so the SVG remains self-contained. Supported
input formats: PNG, JPEG, GIF, WebP, AVIF, SVG. Unknown extensions pass
through with their original URL (which will break offline).</p>

<h2>Transparency &amp; opacity</h2>

<ul>
  <li>Alpha channels in colours work everywhere a colour is accepted.</li>
  <li>Element <code>opacity</code> applies to the entire subtree (matches CSS).</li>
  <li><code>opacity: 0</code> elements are skipped in the SVG output.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../gradients/">Gradients</a> — the linear / radial / repeating story in depth.</li>
  <li><a href="../borders/">Borders &amp; radius</a> — for <code>background-clip</code> interactions with corner radius.</li>
</ul>
`;
