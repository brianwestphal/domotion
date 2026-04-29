/** @jsxRuntime automatic */
/** @jsxImportSource #jsx */

import { raw, type SafeHtml } from "../../../src/jsx-runtime.js";

export const meta = {
  slug: "css/colors-bg",
  title: "Colors & backgrounds",
  subtitle: "Modern colour formats, layered backgrounds, image embedding — with a few caveats.",
};

export const content: SafeHtml = raw(`
<p>Every CSS colour format Chromium accepts as a computed style works —
hex, <code>rgb()</code> / <code>rgba()</code>, <code>hsl()</code> / <code>hsla()</code>,
<code>hwb()</code>, <code>lab()</code>, <code>lch()</code>, <code>oklab()</code>,
<code>oklch()</code>, <code>color()</code> with display-p3 / sRGB, <code>color-mix(...)</code>,
and <code>currentColor</code>. Domotion reads the resolved colour, not the
source CSS, so notation differences don't matter.</p>

<p>Backgrounds — solid colours, multiple stacked layers (first-on-top
semantics preserved), gradients (see <a href="../gradients/">Gradients</a>),
URL-referenced images, <code>background-clip</code> in all four flavours
including <code>text</code>, <code>background-origin</code>, and
<code>background-attachment</code> — all round-trip. Alpha channels work
everywhere a colour is accepted; <code>opacity</code> applies to the entire
subtree (matches CSS); <code>opacity: 0</code> elements are skipped from output.</p>

<h2>The exceptions</h2>

<ul>
  <li><strong>Wide-gamut colour output.</strong> Output is always <code>rgb()</code>
    / <code>rgba()</code> in the SVG — wider colour spaces collapse to sRGB at
    write time. Invisible for most marketing use cases; if you're working with
    HDR / display-P3 source material and care about extended-gamut output,
    that's not yet supported.</li>
  <li><strong><code>conic-gradient</code></strong> — no SVG equivalent in
    <code>&lt;img&gt;</code>-rendered SVG. The layer is skipped and a warning
    is logged.</li>
  <li><strong>Unknown background-image formats.</strong> PNG, JPEG, GIF, WebP,
    AVIF, and SVG are inlined as base64 data URIs at capture time. Other
    extensions pass through with their original URL (which will break offline).</li>
  <li><strong><code>background-image: url(...)</code> sizing.</strong> Common
    cases (<code>cover</code> / <code>contain</code> / explicit dimensions)
    work; some <code>background-size</code> + <code>background-position</code>
    + <code>background-repeat</code> combinations are approximated.</li>
</ul>

<h2>See also</h2>

<ul>
  <li><a href="../gradients/">Gradients</a> — the linear / radial / repeating story in depth.</li>
  <li><a href="../borders/">Borders &amp; radius</a> — for <code>background-clip</code> interactions with corner radius.</li>
</ul>
`);
